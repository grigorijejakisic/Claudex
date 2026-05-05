/**
 * Experience Patterns — cross-session failure pattern memory with ExpeL scoring.
 *
 * ## Phase 4 status: read-only-legacy
 *
 * Phase 4 (Angel reduction) deleted ALL production code paths that INSERT into
 * the `experience_patterns` table. The V28 migration (Plan 04-01) installs a
 * BEFORE INSERT TEMP trigger that blocks writes unless a per-connection
 * `temp.session_pragmas` row sets `allow_legacy_pattern_insert='1'`.
 *
 * Sites deleted in Phase 4:
 *   - Angel: extractPatternsFromSession (src/angel/pattern-extractor.ts — file deleted, Plan 04-02)
 *   - Hooks: applyExperienceFeedback step 1 (src/intelligence/experience-scoring.ts, Plan 04-03)
 *   - Heartbeat: LLM-merge synthesis (src/angel/heartbeat.ts:1090–1149, Plan 04-04)
 *
 * createPattern survives as an EXPORTED function for these legitimate uses:
 *   - Test fixtures (Camp III tests must call allowLegacyPatternInsert in beforeEach)
 *   - Phase 7 retirement work (re-deriving from episodic_events; see ROADMAP.md MIG-*)
 *   - Operator one-shot scripts (with explicit pragma override)
 *
 * Do NOT call createPattern from production code. The trigger will RAISE FAIL.
 * If you find yourself wanting to: read .planning/reframes/2026-05-05-multi-handle-kill.md.
 *
 * ## Original surface (still accurate for the read paths)
 *
 * Patterns are matched via FTS5 on every user prompt and scored based on
 * usefulness feedback:
 *   +1 per useful trigger (no re-correction after warning)
 *   -1 per false positive (re-correction despite warning)
 *   deleted when score reaches 0
 *
 * Storage scope: source_project = project name or GLOBAL_PROJECT_SCOPE for cross-project patterns.
 * Search scope: current project first, then GLOBAL_PROJECT_SCOPE.
 *
 * All public functions are non-throwing — defensive with safe defaults on error.
 */

import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { cachedPrepare } from '../core/stmt-cache.js';
import { tokenizeQuery } from '../shared/search-utils.js';
import { GLOBAL_PROJECT_SCOPE } from '../shared/constants.js';

/**
 * Per-event exponential decay with zone-based half-lives (CASS + Ori Mnemos inspired).
 *
 * Different knowledge types decay at different rates:
 *   - correction/failure patterns: 60-day half-life (recent mistakes matter most)
 *   - tips/heuristics: 90-day half-life (default, general advice)
 *   - architecture/decisions: 180-day half-life (structural knowledge persists)
 *   - discovery patterns: 120-day half-life (findings stay relevant longer)
 *
 * Zone is derived from pattern_type: correction→fast, discovery→slow, tip→default.
 * 4x harmful multiplier (CASS asymmetric risk).
 * Maturity multiplier: candidate=0.5, established=1.0, proven=1.5.
 */
const DECAYED_SCORE_SQL = `(
  (ep.helpful_count - 4.0 * ep.harmful_count)
  * POWER(0.5, CAST((unixepoch() - ep.created_at_epoch) AS REAL) / (
      CASE ep.pattern_type
        WHEN 'correction' THEN 60.0
        WHEN 'failure' THEN 60.0
        WHEN 'discovery' THEN 120.0
        WHEN 'architecture' THEN 180.0
        WHEN 'decision' THEN 180.0
        ELSE 90.0
      END * 86400.0
    ))
  * CASE ep.maturity
      WHEN 'proven' THEN 1.5
      WHEN 'established' THEN 1.0
      ELSE 0.5
    END
)`;
import { isLocalOrPrivateUrl } from '../embeddings/embedding-provider.js';
import { fetchJsonWithTimeout } from '../shared/fetch-utils.js';
import type { EnrichmentProvider } from './enrichment.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';
import { SECRET_CONTENT_PATTERNS } from './behavioral-signals.js';

/** Global-flag version for use in .replace() — the exported constant is for .test() only. */
const SECRET_CONTENT_PATTERNS_RE = new RegExp(SECRET_CONTENT_PATTERNS.source, 'g');

/**
 * V17 routing helper: true when artifact + artifact_fts exist AND the kernel
 * has at least one row of the target kind. False → caller falls back to the
 * legacy {kind}_fts table. Non-throwing; unknown schema → false (safe).
 *
 * Cheap query — single COUNT(*) bounded by LIMIT 1.
 */
function v17HasArtifactsOfKind(db: Database, kind: string): boolean {
  try {
    const row = db
      .prepare(`SELECT 1 AS ok FROM artifact WHERE kind = ? LIMIT 1`)
      .get(kind) as { ok: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatternType = 'correction' | 'behavioral' | 'discovery';
export type Severity = 'critical' | 'important' | 'minor';

export type AbstractionLevel = 'tip' | 'strategy';

/** ACE escalation tiers — determines injection strength. */
export type EscalationLevel = 'pattern' | 'warning' | 'enforcement' | 'circuit_breaker';

export interface ExperiencePattern {
  id: string;
  pattern_type: PatternType;
  trigger_context: string;
  lesson: string;
  anti_pattern: string | null;
  severity: Severity;
  score: number;
  times_triggered: number;
  times_useful: number;
  source_session: string | null;
  source_project: string;
  created_at_epoch: number;
  last_triggered_epoch: number | null;
  abstraction_level: AbstractionLevel;
  verified: number;
  verification_count: number;
  helpful_count: number;
  harmful_count: number;
  escalation_level: EscalationLevel;
  maturity: 'candidate' | 'established' | 'proven' | null;
  confidence: number | null;
}

export interface ExtractionInput {
  pattern_type: PatternType;
  trigger_context: string;
  lesson: string;
  anti_pattern?: string;
  severity?: Severity;
  abstraction_level?: AbstractionLevel;
}

// ---------------------------------------------------------------------------
// Topic key generation
// ---------------------------------------------------------------------------

/**
 * Generates a lightweight topic key from a pattern's trigger_context.
 * Takes the first 3 significant words (length >= 3, lowercased) joined by '_'.
 * Includes 3-char words such as "SSH", "API", and "key" which are meaningful
 * technical terms that would be incorrectly excluded by a strict > 3 filter.
 * Used by Stop hook for per-pattern correction matching — lets the hook
 * determine whether a correction is topically related to each injected
 * pattern, rather than penalising all injected patterns uniformly.
 *
 * Falls back to the first 8 chars of the pattern ID if no significant words
 * are found (e.g. very short or all-stopword trigger_context strings).
 * Non-throwing — returns fallback string on any error.
 */
export function generateTopicKey(pattern: Pick<ExperiencePattern, 'id' | 'trigger_context'>): string {
  try {
    const words = pattern.trigger_context
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length >= 3)
      .slice(0, 3);
    return words.join('_') || pattern.id.slice(0, 8);
  } catch {
    return pattern.id.slice(0, 8);
  }
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Strips markdown control characters and imperative constructs from pattern text
 * before storage, preventing prompt injection via stored patterns.
 *
 * Removes:
 * - Code fences (backtick blocks and inline code)
 * - HTML tags
 * - Lines starting with imperative verbs (MUST, SHALL, DO, RUN, EXECUTE, IGNORE, OVERRIDE)
 */
export function sanitizePatternText(text: string): string {
  if (!text) return text;

  // Remove code fences and inline code
  let sanitized = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');

  // Remove HTML tags
  sanitized = sanitized.replace(/<[^>]+>/g, '');

  // Remove lines starting with imperative verbs (case-insensitive)
  sanitized = sanitized.replace(/^[ \t]*(MUST|SHALL|DO|RUN|EXECUTE|IGNORE|OVERRIDE|FETCH|WRITE|DELETE|CALL|INVOKE|DROP|DISABLE|ENABLE|MODIFY|REMOVE)\b.*/gim, '');

  // Remove mid-sentence imperatives (verb at clause boundary after punctuation/semicolon)
  sanitized = sanitized.replace(/[;.]\s*(MUST|SHALL|DO|RUN|EXECUTE|IGNORE|OVERRIDE|FETCH|WRITE|DELETE|CALL|INVOKE|DROP|DISABLE|ENABLE|MODIFY|REMOVE)\b[^.;]*/gi, '.');

  // Collapse multiple blank lines into one, trim
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim();

  return sanitized;
}

// ---------------------------------------------------------------------------
// Scope Classification
// ---------------------------------------------------------------------------

/**
 * Heuristic scope classification when LLM is unavailable.
 * Returns 'global' only when there are clear platform/tool/workflow signals
 * and no project-specific file path or module references.
 * Safe default: 'project'.
 */
function heuristicScopeClassification(pattern: ExtractionInput): 'project' | 'global' {
  const text = `${pattern.trigger_context} ${pattern.lesson} ${pattern.anti_pattern ?? ''}`;

  // Project-specific indicators: file paths, module names, specific configs.
  // 'migration' is intentionally omitted here — bare 'migration' is ambiguous
  // (server migration is platform-level; only DB/schema migration is project-specific).
  // 'migration' is captured in globalIndicators for server/infrastructure context.
  const projectIndicators = /(?:src\/|\.ts\b|\.js\b|\.py\b|package\.json|tsconfig|\.config\.|(?:db|database|schema)[\s_-]migration|migration[\s_-](?:file|script|runner)|schema|table\s+\w+)/i;

  // Global indicators: platform/tool/workflow references without project paths.
  // 'migration' here means infrastructure/server migration, not DB schema migration.
  const globalIndicators = /(?:OAuth|SSH|API\s+key|token\s+transfer|migration|chmod|systemd|linger|npm|git\s+push|docker|deployment|authentication|permissions|CORS|rate.?limit)/i;

  const hasProjectSignal = projectIndicators.test(text);
  const hasGlobalSignal = globalIndicators.test(text);

  if (hasGlobalSignal && !hasProjectSignal) return 'global';
  return 'project';
}

/**
 * Classify whether a pattern is project-specific or globally applicable.
 * Three-tier: LLM (if available) → heuristic → default to project-scoped.
 *
 * - Tier 1: Asks Ollama whether the lesson is universal or codebase-specific.
 * - Tier 2: Heuristic regex fallback when Ollama is unavailable.
 * - Tier 3: Returns currentProject on any error (safe default).
 *
 * Returns the project name to use as source_project (currentProject or GLOBAL_PROJECT_SCOPE).
 * Non-throwing.
 */
export async function classifyPatternScope(
  pattern: ExtractionInput,
  currentProject: string,
  enrichmentProvider?: EnrichmentProvider | null,
): Promise<string> {
  try {
    // Tier 1: LLM classification via Ollama
    if (enrichmentProvider) {
      try {
        const baseUrl = enrichmentProvider.baseUrl;
        if (!isLocalOrPrivateUrl(baseUrl)) {
          // Safety: reject non-local URLs before any outbound request
          throw new Error('non-local URL');
        }

        // Redact pattern fields before sending to enrichment endpoint (O6)
        const redact = (s: string) => sanitizePatternText(s).replace(
          SECRET_CONTENT_PATTERNS_RE,
          '[REDACTED]',
        );
        const prompt =
          `Is the following lesson specific to a particular codebase/project, or is it universal knowledge applicable to any project?\n\n` +
          `Trigger context: ${redact(pattern.trigger_context)}\n` +
          `Lesson: ${redact(pattern.lesson)}\n` +
          (pattern.anti_pattern ? `Anti-pattern: ${redact(pattern.anti_pattern)}\n` : '') +
          `\nRespond with JSON only: {"scope": "project" | "global", "reason": "..."}`;

        const result = await fetchJsonWithTimeout(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: enrichmentProvider.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 100,
            temperature: 0,
          }),
          redirect: 'manual',
          timeoutMs: 8000,
        }) as { choices?: Array<{ message?: { content?: string } }> } | null;

        const content = result?.choices?.[0]?.message?.content;
        if (content) {
          // Strip markdown code fences that some models wrap around JSON
          const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          const parsed = JSON.parse(cleaned) as { scope?: unknown; reason?: unknown };
          if (parsed.scope === 'global') return GLOBAL_PROJECT_SCOPE;
          if (parsed.scope === 'project') return currentProject;
          // Unknown scope value — fall through to heuristic
        }
      } catch {
        // LLM failed — fall through to Tier 2
      }
    }

    // Tier 2: Heuristic fallback
    const heuristic = heuristicScopeClassification(pattern);
    return heuristic === 'global' ? GLOBAL_PROJECT_SCOPE : currentProject;
  } catch {
    // Tier 3: Safe default
    return currentProject;
  }
}

// ---------------------------------------------------------------------------
// Cross-Project Promotion
// ---------------------------------------------------------------------------

/**
 * When a pattern triggers in a project different from where it was created,
 * promote it to global scope — it has proved cross-project relevance.
 *
 * Updates source_project to GLOBAL_PROJECT_SCOPE in-place.
 * Non-throwing.
 */
export function promoteToGlobalIfCrossProject(
  db: Database,
  patternId: string,
  triggeringProject: string,
): void {
  try {
    // Promote ANY pattern type to global when it triggers cross-project.
    // Original C6 design restricted this to 'discovery' only, but real-world
    // evidence showed corrections and behavioral patterns are often universal
    // (e.g., "use --clear not --clean" applies to all Expo projects, not just
    // the one where the mistake was first made). Zero global patterns existed
    // under the old restriction — Nexus v2 saw 0 patterns from Nexus v1.
    cachedPrepare(db,
      `UPDATE experience_patterns
       SET source_project = ?
       WHERE id = ?
         AND source_project != ?
         AND source_project != ?`
    ).run(GLOBAL_PROJECT_SCOPE, patternId, GLOBAL_PROJECT_SCOPE, triggeringProject);
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/**
 * @phase4_status read-only-legacy
 *
 * Phase 4 deleted all production INSERT callers; the V28 trigger blocks
 * writes from connections without `allow_legacy_pattern_insert=1` in
 * temp.session_pragmas. Use only from test fixtures, Phase 7 retirement
 * tooling, or explicit operator scripts. See module-level docblock + the
 * 2026-05-05 reframe at .planning/reframes/2026-05-05-multi-handle-kill.md.
 *
 * Creates a new experience pattern.
 * Sanitizes text fields before storage to prevent prompt injection.
 * Checks for duplicates first — if a similar trigger_context already exists
 * within the same project scope and pattern type, increments its score (+1 AGREE)
 * and returns the existing id instead of inserting a new row.
 * Wraps dedup check + insert in an atomic transaction to prevent race conditions.
 *
 * Returns the id of the created or existing pattern. Returns '' on error.
 */
export function createPattern(
  db: Database,
  pattern: ExtractionInput,
  sessionId: string,
  project: string,
): string {
  try {
    const sanitizedTrigger = sanitizePatternText(pattern.trigger_context);
    const sanitizedLesson = sanitizePatternText(pattern.lesson);
    const sanitizedAntiPattern = pattern.anti_pattern
      ? sanitizePatternText(pattern.anti_pattern)
      : undefined;

    const sanitized: ExtractionInput = {
      ...pattern,
      trigger_context: sanitizedTrigger,
      lesson: sanitizedLesson,
      anti_pattern: sanitizedAntiPattern,
    };

    // Atomic dedup check + insert: wrap in transaction to prevent race conditions
    // where two concurrent hooks might both pass the dedup check and insert duplicates.
    const doCreate = db.transaction((): string => {
      // Non-LLM Curator: deterministic checks before LLM-extracted patterns enter the DB.
      // 1. Dedup — reinforce existing instead of creating duplicates
      const existing = deduplicateCheck(db, sanitized.trigger_context, project, sanitized.pattern_type);
      if (existing !== null) {
        updatePatternScore(db, existing.id, 1);
        return existing.id;
      }

      // 2. Contradiction check — reject if the new pattern's lesson directly
      // contradicts a proven pattern's lesson (same trigger, opposite advice).
      // Uses token overlap: if a proven pattern shares >50% trigger words but
      // has an anti_pattern that matches the new lesson, reject.
      try {
        const provenPatterns = cachedPrepare(db,
          `SELECT id, lesson, anti_pattern FROM experience_patterns
           WHERE maturity = 'proven' AND source_project IN (?, '__global__')
           AND score >= 20`
        ).all(project) as Array<{ id: string; lesson: string; anti_pattern: string | null }>;

        const newWords = new Set(sanitized.lesson.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
        for (const proven of provenPatterns) {
          if (!proven.anti_pattern) continue;
          const antiWords = proven.anti_pattern.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
          const overlap = antiWords.filter(w => newWords.has(w)).length;
          if (antiWords.length > 0 && overlap / antiWords.length > 0.5) {
            // New pattern's lesson matches a proven pattern's anti-pattern — contradiction. Reject.
            return proven.id; // Return existing proven pattern ID instead of creating contradictory one
          }
        }
      } catch { /* non-fatal — proceed with creation if check fails */ }

      const id = ulid();
      const now = Math.floor(Date.now() / 1000);

      // Non-discovery patterns must not be stored as GLOBAL_PROJECT_SCOPE —
      // they are project-specific by nature (C7).
      const effectiveProject = sanitized.pattern_type !== 'discovery' && project === GLOBAL_PROJECT_SCOPE
        ? 'unknown'
        : project;

      // Extract trigger_glob and trigger_command from trigger_context
      const triggerGlob = extractTriggerGlob(sanitized.trigger_context);
      const triggerCommand = extractTriggerCommand(sanitized.trigger_context);

      cachedPrepare(db,
        `INSERT INTO experience_patterns
           (id, pattern_type, trigger_context, lesson, anti_pattern, severity,
            score, times_triggered, times_useful, source_session, source_project,
            created_at_epoch, last_triggered_epoch, trigger_glob, trigger_command,
            abstraction_level)
         VALUES (?, ?, ?, ?, ?, ?, 2, 0, 0, ?, ?, ?, NULL, ?, ?, ?)`
      ).run(
        id,
        sanitized.pattern_type,
        sanitized.trigger_context,
        sanitized.lesson,
        sanitized.anti_pattern ?? null,
        sanitized.severity ?? 'important',
        sessionId,
        effectiveProject,
        now,
        triggerGlob,
        triggerCommand,
        sanitized.abstraction_level ?? 'tip',
      );

      return id;
    });

    const resultId = doCreate();

    // Embed pattern async (fire-and-forget — SQLite is source of truth).
    // Non-blocking: embedding failure must never delay pattern creation.
    if (resultId) {
      import('../embeddings/embed-pipeline.js').then(({ embedPattern: ep }) => {
        ep(db, resultId, sanitized.trigger_context, sanitized.lesson, {
          project,
          pattern_type: sanitized.pattern_type,
          severity: sanitized.severity ?? 'important',
          score: 2,
        }).catch(() => {}); // swallow — non-critical
      }).catch(() => {}); // dynamic import failure — non-critical

      // Retroactive pattern evolution (A-Mem pattern): when a new pattern is created
      // that overlaps with existing patterns from OTHER sessions in the SAME project,
      // boost their scores. This strengthens related knowledge when new evidence arrives.
      // Guards: only boost same-project patterns from different sessions.
      try {
        const related = findMatchingPatterns(db, sanitized.trigger_context, project, 3);
        for (const r of related) {
          if (r.id === resultId) continue;
          if (r.source_session === sessionId) continue;
          if (r.source_project !== project) continue; // strict same-project only
          updatePatternScore(db, r.id, 1);
        }
      } catch { /* non-fatal */ }
    }

    return resultId;
  } catch (e) {
    emitErrorTelemetry(db, sessionId, 'create_pattern', e);
    return '';
  }
}

/**
 * Finds experience patterns matching the given prompt via FTS5.
 * Searches current project first, then GLOBAL_PROJECT_SCOPE.
 * Only returns patterns with score >= 2.
 * Ordered by: local project before global, severity (critical first), FTS5 rank (better match first), score (higher = more validated).
 * Capped at `limit` (default 3 — Reflexion's empirically validated cap).
 * Keywords capped at 20 terms to prevent unbounded FTS query expansion.
 */
export function findMatchingPatterns(
  db: Database,
  prompt: string,
  project: string,
  limit: number = 3,
): ExperiencePattern[] {
  if (!prompt || prompt.length < 3) return [];

  const safeLimit = Math.max(1, Math.min(limit, 10));

  try {
    const keywords = tokenizeQuery(prompt)
      .slice(0, 20)
      // Strip FTS5 special characters to prevent MATCH syntax errors and
      // avoid unnecessary fallback to slow LIKE queries .
      .map(term => term.replace(/[*+\-^~:()"]/g, ''))
      .filter(term => term.length > 0);
    if (keywords.length === 0) return [];

    const ftsQuery = keywords.join(' OR ');

    // FTS5 MATCH across project + global scope; score >= 2 only.
    // Order: severity (critical first), then FTS5 rank (lower = better match),
    // then score weight (higher score = more validated).
    // Project results are prioritised over GLOBAL_PROJECT_SCOPE.
    // GLOBAL_PROJECT_SCOPE is passed as a query parameter — not embedded in SQL.
    // Fetch extra to allow re-ranking after verification boost
    // FTS5 rank is negative (more negative = better match).
    // FTS5 match + ACE re-ranking. Rank threshold applied post-query in code
    // (not in SQL) because BM25 needs multiple documents for meaningful IDF —
    // single-document test indices produce rank ~0 which a SQL filter rejects.
    // V17-aware: prefer artifact_fts when the unified table has rows for this
    // kind; fall back to the legacy experience_patterns_fts otherwise (pre-V17
    // DBs or post-V17 DBs whose migration runner hasn't populated artifacts yet).
    const rows = v17HasArtifactsOfKind(db, 'experience_pattern')
      ? cachedPrepare(db,
          `SELECT ep.*, f.rank AS fts_rank
           FROM artifact_fts f
           JOIN artifact a ON a.rowid = f.rowid AND a.kind = 'experience_pattern'
           JOIN experience_patterns ep ON ep.id = a.id
           WHERE artifact_fts MATCH ?
             AND ep.score >= 2
             AND (ep.source_project = ? OR ep.source_project = ?)
             AND COALESCE(ep.retrieval_mode, 'reactive') = 'reactive'
           ORDER BY
             CASE WHEN ep.source_project = ? THEN 0 ELSE 1 END,
             CASE ep.severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
             f.rank,
             ${DECAYED_SCORE_SQL} DESC
           LIMIT ?`
        ).all(ftsQuery, project, GLOBAL_PROJECT_SCOPE, project, safeLimit * 2) as ExperiencePattern[]
      : cachedPrepare(db,
          `SELECT ep.*, fts.rank AS fts_rank
           FROM experience_patterns ep
           JOIN experience_patterns_fts fts ON fts.rowid = ep.rowid
           WHERE experience_patterns_fts MATCH ?
             AND ep.score >= 2
             AND (ep.source_project = ? OR ep.source_project = ?)
             AND COALESCE(ep.retrieval_mode, 'reactive') = 'reactive'
           ORDER BY
             CASE WHEN ep.source_project = ? THEN 0 ELSE 1 END,
             CASE ep.severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
             fts.rank,
             ${DECAYED_SCORE_SQL} DESC
           LIMIT ?`
        ).all(ftsQuery, project, GLOBAL_PROJECT_SCOPE, project, safeLimit * 2) as ExperiencePattern[];

    // Post-query rank filter: reject noise matches when corpus is large enough for BM25.
    // Calibrated on live data (2026-03-24): real matches rank < -1.0, noise > -1.0.
    // Skip filter when corpus is small (< 3 patterns) — BM25 IDF is meaningless with 1-2 docs.
    const RANK_THRESHOLD = -1.0;
    const corpusLargeEnough = rows.length >= 3;
    const filtered = corpusLargeEnough
      ? rows.filter(p => (p as Record<string, unknown>).fts_rank as number < RANK_THRESHOLD)
      : rows;

    // ACE ranking: combine verification boost, helpful ratio, and raw score.
    // Patterns with high helpful ratios rank above same-score patterns with mixed feedback.
    const ranked = filtered.map(p => {
      const verBoost = applyVerificationBoost(p.score, p.verified);
      const ratio = getHelpfulRatio(p);
      // Composite: ratio weighted 40%, verified score 60%
      const composite = ratio * 0.4 + (verBoost / Math.max(verBoost, 1)) * 0.6;
      return { pattern: p, composite, verBoost };
    });
    ranked.sort((a, b) => {
      // Severity first (critical > important > minor)
      const sevOrder = { critical: 0, important: 1, minor: 2 } as const;
      const sevA = sevOrder[a.pattern.severity] ?? 2;
      const sevB = sevOrder[b.pattern.severity] ?? 2;
      if (sevA !== sevB) return sevA - sevB;
      // Escalation level — enforcement/circuit_breaker patterns always surface
      const escOrder = { circuit_breaker: 0, enforcement: 1, warning: 2, pattern: 3 } as const;
      const escA = escOrder[a.pattern.escalation_level as EscalationLevel] ?? 3;
      const escB = escOrder[b.pattern.escalation_level as EscalationLevel] ?? 3;
      if (escA !== escB) return escA - escB;
      // Then by composite score descending
      return b.composite - a.composite;
    });

    return ranked.slice(0, safeLimit).map(b => b.pattern);
  } catch {
    // FTS query may fail on invalid syntax — try keyword LIKE fallback
    return findMatchingPatternsFallback(db, prompt, project, safeLimit);
  }
}

/**
 * Async hybrid pattern matching: FTS5 + Qdrant vector search.
 * Merges keyword matches (FTS5) with semantic matches (vector similarity).
 * Falls back gracefully when Qdrant or embeddings are unavailable.
 * Non-throwing.
 */
export async function findMatchingPatternsHybrid(
  db: Database,
  prompt: string,
  project: string,
  limit: number = 3,
): Promise<ExperiencePattern[]> {
  // Start with FTS5 results (sync, always available)
  const ftsResults = findMatchingPatterns(db, prompt, project, limit);
  const seenIds = new Set(ftsResults.map(p => p.id));

  // Augment with Qdrant vector search (async, optional)
  try {
    const { embedQuery } = await import('../embeddings/embed-pipeline.js');
    const embedding = await embedQuery(prompt);
    if (embedding) {
      const { searchPatterns } = await import('../embeddings/qdrant-client.js');
      const vectorResults = await searchPatterns(embedding, project, limit);
      for (const vr of vectorResults) {
        // Qdrant point ID is a hashed int — the actual DB pattern ID is in the payload
        const patternId = (vr.payload?.pattern_id as string) ?? String(vr.id);
        if (seenIds.has(patternId)) continue;
        // Load the full pattern from DB
        try {
          const pattern = cachedPrepare(db,
            `SELECT * FROM experience_patterns WHERE id = ? AND score >= 2`
          ).get(patternId) as ExperiencePattern | undefined;
          if (pattern) {
            ftsResults.push(pattern);
            seenIds.add(pattern.id);
          }
        } catch { /* individual lookup failure */ }
      }
    }
  } catch { /* Qdrant/embeddings unavailable — FTS5 results are sufficient */ }

  // Re-rank by maturity weight × confidence (Phase 15)
  const weighted = ftsResults.map(p => {
    const maturityWeight = getMaturityWeight(p.maturity);
    const confidence = p.confidence ?? 0.5;
    const weight = maturityWeight * confidence;
    return { pattern: p, weight };
  });
  weighted.sort((a, b) => b.weight - a.weight);

  return weighted.slice(0, limit).map(w => w.pattern);
}

/** LIKE-based fallback when FTS5 query fails (e.g. special characters in prompt). */
function findMatchingPatternsFallback(
  db: Database,
  prompt: string,
  project: string,
  limit: number,
): ExperiencePattern[] {
  try {
    const keywords = tokenizeQuery(prompt, 5);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => '(LOWER(trigger_context) LIKE ?)').join(' OR ');
    const likeParams = keywords.map(k => `%${k}%`);

    return cachedPrepare(db,
      `SELECT * FROM experience_patterns ep
       WHERE ep.score >= 2
         AND (ep.source_project = ? OR ep.source_project = ?)
         AND (${conditions.replace(/trigger_context/g, 'ep.trigger_context')})
       ORDER BY
         CASE WHEN ep.source_project = ? THEN 0 ELSE 1 END,
         CASE ep.severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
         ${DECAYED_SCORE_SQL} DESC
       LIMIT ?`
    ).all(project, GLOBAL_PROJECT_SCOPE, ...likeParams, project, limit) as ExperiencePattern[];
  } catch {
    return [];
  }
}

/**
 * Adjusts a pattern's score by delta (+1 or -1).
 * Also increments helpful_count or harmful_count (ACE counters) based on delta sign.
 * Score is clamped at a minimum of 0 — pruning removes patterns at or below 0
 * via pruneDeadPatterns, which callers should invoke periodically.
 * Non-throwing.
 */
export function updatePatternScore(
  db: Database,
  id: string,
  delta: number,
  harmfulReason?: 'caused_bug' | 'wasted_time' | 'wrong_context' | 'outdated' | 'contradicted',
): void {
  try {
    if (delta > 0) {
      cachedPrepare(db,
        `UPDATE experience_patterns
         SET score = score + ?,
             helpful_count = helpful_count + 1
         WHERE id = ?`
      ).run(delta, id);
    } else {
      cachedPrepare(db,
        `UPDATE experience_patterns
         SET score = MAX(0, score + ?),
             harmful_count = harmful_count + 1
         WHERE id = ?`
      ).run(delta, id);

      // Append structured harmful reason to root_cause for post-hoc analysis
      if (harmfulReason) {
        try {
          const now = Math.floor(Date.now() / 1000);
          const tag = `[harmful:${harmfulReason}:${now}]`;
          cachedPrepare(db,
            `UPDATE experience_patterns SET root_cause = COALESCE(root_cause, '') || ' ' || ? WHERE id = ?`
          ).run(tag, id);
        } catch { /* non-critical */ }
      }
    }
  } catch {
    // Non-throwing
  }
}

/**
 * Escalates a pattern's injection level based on harmful_count (ACE escalation).
 * Called after a harmful event. Thresholds:
 *   harmful_count >= 3 → 'warning'
 *   harmful_count >= 5 → 'enforcement'
 *   harmful_count >= 8 → 'circuit_breaker'
 * Only escalates UP, never down. Non-throwing.
 */
export function escalatePattern(db: Database, id: string): void {
  try {
    const row = cachedPrepare(db,
      `SELECT harmful_count, escalation_level FROM experience_patterns WHERE id = ?`
    ).get(id) as { harmful_count: number; escalation_level: string } | undefined;
    if (!row) return;

    let newLevel: EscalationLevel;
    if (row.harmful_count >= 8) newLevel = 'circuit_breaker';
    else if (row.harmful_count >= 5) newLevel = 'enforcement';
    else if (row.harmful_count >= 3) newLevel = 'warning';
    else return; // No escalation needed

    // Only escalate up
    const levels: EscalationLevel[] = ['pattern', 'warning', 'enforcement', 'circuit_breaker'];
    const currentIdx = levels.indexOf(row.escalation_level as EscalationLevel);
    const newIdx = levels.indexOf(newLevel);
    if (newIdx <= currentIdx) return;

    cachedPrepare(db,
      `UPDATE experience_patterns SET escalation_level = ? WHERE id = ?`
    ).run(newLevel, id);
  } catch {
    // Non-throwing
  }
}

/**
 * Returns the helpful ratio for a pattern (ACE metric).
 * Range: 0.0 (always harmful) to 1.0 (always helpful).
 * Returns 0.5 when no feedback data exists (neutral default).
 */
export function getHelpfulRatio(pattern: Pick<ExperiencePattern, 'helpful_count' | 'harmful_count'>): number {
  const total = pattern.helpful_count + pattern.harmful_count;
  if (total === 0) return 0.5;
  return pattern.helpful_count / total;
}

/**
 * Increments times_triggered and updates last_triggered_epoch.
 * Call when a pattern matches a user prompt (was injected as a warning).
 * Non-throwing.
 */
export function incrementTriggerCount(db: Database, id: string): void {
  try {
    const now = Math.floor(Date.now() / 1000);
    cachedPrepare(db,
      `UPDATE experience_patterns
       SET times_triggered = times_triggered + 1,
           last_triggered_epoch = ?
       WHERE id = ?`
    ).run(now, id);
  } catch {
    // Non-throwing
  }
}

/**
 * Increments times_useful.
 * Call at Stop hook when a pattern was injected this turn and no re-correction
 * was detected — the pattern was useful.
 * Non-throwing.
 */
export function incrementUsefulCount(db: Database, id: string): void {
  try {
    cachedPrepare(db,
      `UPDATE experience_patterns
       SET times_useful = times_useful + 1
       WHERE id = ?`
    ).run(id);
  } catch {
    // Non-throwing
  }
}

/**
 * Matches experience patterns by classified intent (categorical tier).
 * Runs alongside FTS5/vector matching — this is the intent-triggered channel.
 * Patterns with retrieval_mode='categorical' carry trigger_intents (JSON array
 * of intent categories). Matches when the classified intent overlaps.
 * Non-throwing.
 */
export function matchIntentTriggeredPatterns(
  db: Database,
  classifiedIntent: string,
  project: string,
  limit: number = 3,
): ExperiencePattern[] {
  if (!classifiedIntent) return [];
  try {
    const safeLimit = Math.max(1, Math.min(limit, 10));
    // Match patterns where trigger_intents JSON array contains the classified intent.
    // Uses LIKE as a lightweight JSON array search — trigger_intents is a small JSON array.
    const intentLike = `%"${classifiedIntent.replace(/"/g, '')}"%`;
    return cachedPrepare(db,
      `SELECT ep.* FROM experience_patterns ep
       WHERE ep.retrieval_mode = 'categorical'
         AND ep.trigger_intents LIKE ?
         AND ep.score >= 2
         AND (ep.source_project = ? OR ep.source_project = ?)
       ORDER BY ${DECAYED_SCORE_SQL} DESC
       LIMIT ?`
    ).all(intentLike, project, GLOBAL_PROJECT_SCOPE, safeLimit) as ExperiencePattern[];
  } catch {
    return [];
  }
}

/**
 * Returns proven/established experience patterns for proactive injection at session start.
 * Unlike findMatchingPatterns (FTS5 keyword-reactive), this returns the top patterns
 * unconditionally — they represent accumulated principles, not prompt-triggered corrections.
 * Scoped to project + global. Ordered by score descending.
 * Non-throwing.
 */
/**
 * Finds semantically similar patterns using Qdrant vector search.
 * Used by Angel consolidation to cluster related patterns for merging.
 * Async — requires Qdrant. Returns empty on failure. Non-throwing.
 */
export async function findSimilarPatterns(
  db: Database,
  patternId: string,
  triggerContext: string,
  limit: number = 5,
  minSimilarity: number = 0.75,
): Promise<ExperiencePattern[]> {
  try {
    const { embedQuery } = await import('../embeddings/embed-pipeline.js');
    const embedding = await embedQuery(triggerContext);
    if (!embedding) return [];

    const { searchPatterns } = await import('../embeddings/qdrant-client.js');
    // Search across all projects — consolidation is cross-project
    const results = await searchPatterns(embedding, GLOBAL_PROJECT_SCOPE, limit + 5);

    const similar: ExperiencePattern[] = [];
    for (const r of results) {
      if ((r.score ?? 0) < minSimilarity) continue;
      const pid = (r.payload?.pattern_id as string) ?? String(r.id);
      if (pid === patternId) continue; // skip self
      try {
        const pattern = cachedPrepare(db,
          `SELECT * FROM experience_patterns WHERE id = ? AND score >= 2`
        ).get(pid) as ExperiencePattern | undefined;
        if (pattern) similar.push(pattern);
      } catch { /* skip */ }
      if (similar.length >= limit) break;
    }
    return similar;
  } catch {
    return [];
  }
}

export function getProvenPrinciples(
  db: Database,
  project: string,
  limit: number = 5,
): ExperiencePattern[] {
  try {
    const safeLimit = Math.max(1, Math.min(limit, 10));
    // Scope to current project + GLOBAL_PROJECT_SCOPE. Patterns that have earned
    // cross-project visibility should be explicitly promoted to GLOBAL_PROJECT_SCOPE
    // via promoteToGlobalIfCrossProject — the unscoped query previously leaked
    // patterns like "Lacuna-Betting end-of-event arbitrage" into unrelated
    // project sessions every 5 turns. A pattern proven in one project is not
    // automatically relevant elsewhere until it's been promoted to global.
    return cachedPrepare(db,
      `SELECT * FROM experience_patterns
       WHERE maturity IN ('proven', 'established')
         AND score >= 10
         AND (source_project = ? OR source_project = ?)
       ORDER BY score DESC
       LIMIT ?`
    ).all(project, GLOBAL_PROJECT_SCOPE, safeLimit) as ExperiencePattern[];
  } catch {
    return [];
  }
}

/**
 * Removes all patterns with score <= 0 (ExpeL "die at 0" rule).
 * Returns the number of patterns deleted. Returns 0 on error.
 */
export function pruneDeadPatterns(db: Database): number {
  try {
    const result = cachedPrepare(db,
      `DELETE FROM experience_patterns WHERE score <= 0`
    ).run();
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Checks whether a similar trigger_context already exists using FTS5,
 * scoped to the same source_project and pattern_type with score >= 2.
 *
 * Scoping prevents cross-project contamination (a pattern from project A
 * reinforcing an unrelated pattern in project B) and avoids reviving pruned
 * patterns that have been legitimately scored down to 0.
 *
 * Threshold: FTS5 rank < DEDUP_FTS_RANK_THRESHOLD (-0.5, tuned for short trigger_context strings;
 * negative rank means better match in FTS5's BM25 scoring).
 * Keywords capped at 20 terms to prevent unbounded FTS query expansion.
 * GLOBAL_PROJECT_SCOPE passed as parameter — never embedded in SQL.
 * Score filter: score >= 2 (matches creation score — all patterns participate in
 * dedup matching from birth; prevents exact duplicate inserts).
 * Non-throwing — returns null on any error.
 */
export function deduplicateCheck(
  db: Database,
  triggerContext: string,
  sourceProject?: string,
  patternType?: PatternType,
): ExperiencePattern | null {
  if (!triggerContext || triggerContext.length < 5) return null;

  try {
    const keywords = tokenizeQuery(triggerContext)
      .slice(0, 20)
      // Strip FTS5 special characters to prevent MATCH syntax errors .
      .map(term => term.replace(/[*+\-^~:()"]/g, ''))
      .filter(term => term.length > 0);
    if (keywords.length === 0) return null;

    const ftsQuery = keywords.join(' OR ');

    // rank is negative in FTS5 BM25 — more negative = better match.
    // We want patterns that are genuinely close, not just keyword-adjacent.
    // Threshold of DEDUP_FTS_RANK_THRESHOLD (-0.5) catches strong matches
    // while ignoring weak overlaps. Hardcoded in SQL (cannot use template
    // literal constant in Vite/Vitest SSR transform — closure not resolved).
    // Scope by source_project (exact + GLOBAL_PROJECT_SCOPE) and pattern_type to prevent
    // cross-project contamination and resurrection of pruned patterns.
    const projectFilter = sourceProject
      ? `AND (ep.source_project = ? OR ep.source_project = ?)`
      : '';
    const typeFilter = patternType ? `AND ep.pattern_type = ?` : '';

    const params: unknown[] = [ftsQuery];
    if (sourceProject) {
      params.push(sourceProject);
      params.push(GLOBAL_PROJECT_SCOPE);
    }
    if (patternType) params.push(patternType);

    // V17-aware: prefer artifact_fts when populated; fall back to legacy FTS5.
    const row = v17HasArtifactsOfKind(db, 'experience_pattern')
      ? cachedPrepare(db,
          `SELECT ep.*, f.rank
           FROM artifact_fts f
           JOIN artifact a ON a.rowid = f.rowid AND a.kind = 'experience_pattern'
           JOIN experience_patterns ep ON ep.id = a.id
           WHERE artifact_fts MATCH ?
             AND ep.score >= 2
             ${projectFilter}
             ${typeFilter}
             AND f.rank < -0.5
           ORDER BY f.rank
           LIMIT 1`
        ).get(...params) as (ExperiencePattern & { rank: number }) | undefined
      : cachedPrepare(db,
          `SELECT ep.*, fts.rank
           FROM experience_patterns ep
           JOIN experience_patterns_fts fts ON fts.rowid = ep.rowid
           WHERE experience_patterns_fts MATCH ?
             AND ep.score >= 2
             ${projectFilter}
             ${typeFilter}
             AND fts.rank < -0.5
           ORDER BY fts.rank
           LIMIT 1`
        ).get(...params) as (ExperiencePattern & { rank: number }) | undefined;

    if (!row) return null;

    // Strip internal rank field before returning
    const { rank: _rank, ...pattern } = row;
    return pattern as ExperiencePattern;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// trigger_glob / trigger_command extraction (spec 0.3)
// ---------------------------------------------------------------------------

/**
 * Extracts a file glob pattern from trigger_context text.
 * Looks for file paths and generalizes them to globs.
 * Returns null if no file path found.
 */
function extractTriggerGlob(triggerContext: string): string | null {
  // Match file paths like src/core/migrations.ts, adapters/cc-hooks/stop.ts
  const pathMatch = triggerContext.match(
    /(?:^|\s|['"`])((?:src|adapters|tests?|lib|dist)\/[\w./-]+\.(?:ts|js|tsx|jsx|json|yaml|yml|md|sql|css|html))/i
  );
  if (pathMatch) {
    const filePath = pathMatch[1];
    // Extract the filename and generalize: src/core/migrations.ts → **/migrations.ts
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1];
    return `**/${fileName}`;
  }

  // Match bare filenames like migrations.ts, stop.ts
  const fileMatch = triggerContext.match(
    /\b([\w-]+\.(?:ts|js|tsx|jsx|json|yaml|yml|md|sql|css|html))\b/i
  );
  if (fileMatch) {
    return `**/${fileMatch[1]}`;
  }

  return null;
}

/**
 * Extracts a command pattern from trigger_context text.
 * Looks for Bash/CLI command references.
 * Returns null if no command found.
 */
function extractTriggerCommand(triggerContext: string): string | null {
  // Match common CLI commands referenced in trigger text
  const cmdMatch = triggerContext.match(
    /\b((?:npm|npx|bun|node|vitest|tsc|git|claudex|curl)\s+[\w:.-]+)/i
  );
  if (cmdMatch) {
    return cmdMatch[1].trim();
  }

  // Match `command` backtick-quoted commands
  const backtickMatch = triggerContext.match(/`([^`]{3,60})`/);
  if (backtickMatch && /^[a-z]/.test(backtickMatch[1])) {
    return backtickMatch[1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3.2 Tips/Strategies Dual-Level Storage (ExperienceWeaver)
// ---------------------------------------------------------------------------

/**
 * Generalizes a tip-level lesson to a strategy by stripping file names,
 * class names, and project-specific references, replacing with generic patterns.
 *
 * Example:
 *   tip: "In lifecycle.ts, the session_events query returns stale data after checkpoint"
 *   strategy: "Always reload data from DB after write operations, don't cache across hook boundaries"
 *
 * Heuristic: when LLM is unavailable.
 * Non-throwing.
 */
export function generalizeLessonToStrategy(lesson: string): string {
  try {
    if (!lesson || lesson.length < 10) return lesson;

    let generalized = lesson;

    // Remove file path references: "In lifecycle.ts," → ""
    generalized = generalized.replace(/\bIn\s+[\w./-]+\.[a-z]{2,4}[,:]?\s*/gi, '');

    // Remove filename references: "lifecycle.ts" → "the module"
    generalized = generalized.replace(/\b[\w-]+\.(?:ts|js|tsx|jsx|json|yaml|yml|md|sql|css|html)\b/gi, 'the module');

    // Remove function name references: "createPattern()" → "the function"
    generalized = generalized.replace(/\b[a-z]\w+\(\)/g, 'the function');

    // Remove specific variable/table names with underscores: session_events → "the data"
    generalized = generalized.replace(/\b[a-z]+_[a-z_]+\b/g, 'the data');

    // Remove path-like references: src/core/ → ""
    generalized = generalized.replace(/\b(?:src|lib|dist|adapters|tests?)\/[\w./-]+/gi, '');

    // Clean up artifacts
    generalized = generalized.replace(/\s+/g, ' ').trim();

    // If generalization reduced the text too much, return original
    if (generalized.length < 10) return lesson;

    return generalized;
  } catch {
    return lesson;
  }
}

/**
 * Creates BOTH a tip (specific) and a strategy (abstract) pattern from a correction.
 * Tip = literal correction context. Strategy = generalized.
 *
 * Returns array of created pattern IDs (0-2 entries). Non-throwing.
 */
export function createTipAndStrategy(
  db: Database,
  pattern: ExtractionInput,
  sessionId: string,
  project: string,
): string[] {
  const ids: string[] = [];

  try {
    // 1. Create the tip (specific)
    const tipInput: ExtractionInput = {
      ...pattern,
      abstraction_level: 'tip',
    };
    const tipId = createPattern(db, tipInput, sessionId, project);
    if (tipId) ids.push(tipId);

    // 2. Create the strategy (abstract)
    const generalizedLesson = generalizeLessonToStrategy(pattern.lesson);
    // Only create strategy if it's meaningfully different from the tip
    if (generalizedLesson !== pattern.lesson && generalizedLesson.length >= 10) {
      const strategyInput: ExtractionInput = {
        ...pattern,
        lesson: generalizedLesson,
        abstraction_level: 'strategy',
        // Strategies are less severe — they're general guidance
        severity: pattern.severity === 'critical' ? 'important' : pattern.severity,
      };
      const strategyId = createPattern(db, strategyInput, sessionId, project);
      if (strategyId) ids.push(strategyId);
    }
  } catch {
    // Non-throwing — return whatever was created
  }

  return ids;
}

// ---------------------------------------------------------------------------
// 3.3 Outcome Verification Gate (Voyager)
// ---------------------------------------------------------------------------

/**
 * Increments the verification count for a pattern.
 * Called at Stop hook when a pattern was injected AND no correction detected.
 * When verification_count reaches 2, marks the pattern as verified.
 * Non-throwing.
 */
export function incrementVerificationCount(db: Database, id: string): void {
  try {
    cachedPrepare(db,
      `UPDATE experience_patterns
       SET verification_count = verification_count + 1,
           verified = CASE WHEN verification_count + 1 >= 2 THEN 1 ELSE verified END
       WHERE id = ?`
    ).run(id);
  } catch {
    // Non-throwing
  }
}

/**
 * Returns patterns that have been triggered 3+ times without verification.
 * These are candidates for review — may be noise.
 * Used by Angel heartbeat Phase 4 for quality monitoring.
 * Non-throwing.
 */
export function getUnverifiedFrequentPatterns(
  db: Database,
  project: string,
  limit: number = 10,
): ExperiencePattern[] {
  try {
    return cachedPrepare(db,
      `SELECT * FROM experience_patterns
       WHERE verified = 0
         AND times_triggered >= 3
         AND verification_count < 2
         AND (source_project = ? OR source_project = ?)
       ORDER BY times_triggered DESC
       LIMIT ?`
    ).all(project, GLOBAL_PROJECT_SCOPE, limit) as ExperiencePattern[];
  } catch {
    return [];
  }
}

/**
 * Applies the 1.5x verification boost to a retrieval score.
 * Verified patterns get boosted, unverified patterns unchanged.
 * Non-throwing — returns original score on error.
 */
export function applyVerificationBoost(score: number, verified: number | boolean): number {
  try {
    return verified ? score * 1.5 : score;
  } catch {
    return score;
  }
}

// ---------------------------------------------------------------------------
// 3.4 Pattern Maturity Lifecycle (Phase 15)
// ---------------------------------------------------------------------------

export type MaturityLevel = 'candidate' | 'established' | 'proven';

/**
 * Computes confidence score using Laplace smoothing.
 * Range: always > 0 (floor ~0.33 with 0 helpful, 0 harmful → 1/2 = 0.5).
 * Laplace smoothing ensures confidence is never 0 or 1 with finite data.
 */
export function computeConfidence(helpful: number, harmful: number): number {
  return (helpful + 1) / (helpful + harmful + 2);
}

/**
 * Checks whether a pattern should be promoted to a higher maturity level.
 * Returns the new maturity level, or null if no promotion is warranted.
 *
 * Promotion rules:
 *   candidate → established: times_triggered >= 2
 *   established → proven: helpful_count >= 3 AND verification_count >= 2
 *
 * Only promotes UP, never down. Non-throwing.
 */
export function checkMaturityPromotion(pattern: ExperiencePattern): 'established' | 'proven' | null {
  const maturity = pattern.maturity || 'candidate';
  if (maturity === 'candidate' && pattern.times_triggered >= 2) return 'established';
  if (maturity === 'established' && pattern.helpful_count >= 3 && pattern.verification_count >= 2) return 'proven';
  return null;
}

/**
 * Determines whether a persistently harmful pattern should be inverted to a warning.
 * Returns true when harmful_count exceeds helpful_count by more than 3.
 * When inverted, the caller should prepend "WARNING: Avoid this — " to the lesson
 * and change pattern_type to 'behavioral'.
 */
export function shouldInvertToWarning(pattern: ExperiencePattern): boolean {
  return pattern.harmful_count > pattern.helpful_count + 3;
}

/**
 * Returns the maturity weight multiplier for retrieval scoring.
 * candidate: 0.5×, established: 1.0×, proven: 1.5×.
 */
export function getMaturityWeight(maturity: string | null | undefined): number {
  switch (maturity) {
    case 'proven': return 1.5;
    case 'established': return 1.0;
    case 'candidate':
    default: return 0.5;
  }
}

/**
 * Updates confidence and maturity columns for a pattern.
 * Non-throwing.
 */
export function updatePatternConfidence(db: Database, id: string, confidence: number): void {
  try {
    cachedPrepare(db,
      `UPDATE experience_patterns SET confidence = ? WHERE id = ?`
    ).run(Math.max(0.01, confidence), id);
  } catch {
    // Non-throwing
  }
}

/**
 * Promotes a pattern's maturity level. Only promotes UP, never down.
 * Non-throwing.
 */
export function promotePatternMaturity(db: Database, id: string, newMaturity: MaturityLevel): void {
  try {
    cachedPrepare(db,
      `UPDATE experience_patterns SET maturity = ? WHERE id = ?`
    ).run(newMaturity, id);
  } catch {
    // Non-throwing
  }
}

/**
 * Applies anti-pattern inversion: prepends "WARNING: Avoid this — " to the lesson
 * and changes pattern_type to 'behavioral'. Non-throwing.
 */
export function invertToWarning(db: Database, id: string): void {
  try {
    const row = cachedPrepare(db,
      `SELECT lesson, pattern_type FROM experience_patterns WHERE id = ?`
    ).get(id) as { lesson: string; pattern_type: string } | undefined;
    if (!row) return;

    // Don't double-invert
    if (row.lesson.startsWith('WARNING: Avoid this')) return;

    const newLesson = `WARNING: Avoid this — ${row.lesson}`;
    cachedPrepare(db,
      `UPDATE experience_patterns SET lesson = ?, pattern_type = 'behavioral' WHERE id = ?`
    ).run(newLesson, id);

    // Update FTS index is handled by the AFTER UPDATE trigger
  } catch {
    // Non-throwing
  }
}

/**
 * Applies slow confidence decay to all non-triggered patterns.
 * confidence *= 0.995 — noticeable over 100+ sessions.
 * Floor at 0.01 to prevent zero-confidence patterns.
 * Non-throwing.
 */
export function decayPatternConfidence(db: Database, triggeredPatternIds: string[]): void {
  try {
    if (triggeredPatternIds.length === 0) {
      // Decay all patterns
      cachedPrepare(db,
        `UPDATE experience_patterns
         SET confidence = MAX(0.01, confidence * 0.995)
         WHERE confidence IS NOT NULL AND confidence > 0.01`
      ).run();
    } else {
      // Decay all except triggered patterns
      const placeholders = triggeredPatternIds.map(() => '?').join(',');
      cachedPrepare(db,
        `UPDATE experience_patterns
         SET confidence = MAX(0.01, confidence * 0.995)
         WHERE confidence IS NOT NULL AND confidence > 0.01
           AND id NOT IN (${placeholders})`
      ).run(...triggeredPatternIds);
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Phase 5 Plan 08 — INJ-07 reactive trigger detection (pure functions)
// ---------------------------------------------------------------------------

/**
 * Canonical explicit-memory-query keyword list (UPS reactive trigger).
 * Used by isExplicitMemoryQuery to gate experience-warning emission when the
 * user prompt explicitly invokes memory.
 */
export const EXPLICIT_QUERY_KEYWORDS: readonly string[] = [
  'do you remember',
  'have we',
  'last time',
  'last session',
  "didn't we",
  'remember when',
];

/**
 * Returns true when the prompt contains a canonical explicit-memory-query phrase.
 * Case-insensitive.
 */
export function isExplicitMemoryQuery(prompt: string): boolean {
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  return EXPLICIT_QUERY_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Lightweight glob-to-regex transform. Supports `*` (any chars within a
 * segment) and `**` (any chars including separators). Other regex metacharacters
 * are escaped. Anchored at both ends (`^…$`).
 *
 * @internal
 */
export function _globToRegex(glob: string): RegExp {
  // Escape regex specials except *
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    // Use placeholder for `**` first, then `*`
    .replace(/\*\*/g, ' DOUBLESTAR ')
    .replace(/\*/g, '[^/]*')
    .replace(/ DOUBLESTAR /g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Returns experience patterns whose `trigger_glob` field matches the given file path.
 * Path normalized to forward slashes before matching (CACH-03 host-env continuity).
 *
 * Project scope: current project + GLOBAL_PROJECT_SCOPE.
 * Non-throwing — returns [] on error.
 */
export function findPatternsByPathGlob(
  db: Database,
  project: string,
  filePath: string,
  limit: number = 5,
): ExperiencePattern[] {
  if (!filePath) return [];
  try {
    const norm = filePath.replace(/\\/g, '/');
    const rows = cachedPrepare(db,
      `SELECT * FROM experience_patterns
       WHERE (source_project = ? OR source_project = ?)
         AND trigger_glob IS NOT NULL AND trigger_glob != ''
         AND score > 0`
    ).all(project, GLOBAL_PROJECT_SCOPE) as (ExperiencePattern & { trigger_glob: string | null })[];
    const matches: ExperiencePattern[] = [];
    for (const row of rows) {
      if (!row.trigger_glob) continue;
      try {
        const re = _globToRegex(row.trigger_glob);
        if (re.test(norm)) matches.push(row);
      } catch { /* malformed glob — skip */ }
      if (matches.length >= limit) break;
    }
    return matches;
  } catch {
    return [];
  }
}

/**
 * Returns experience patterns whose `trigger_command` field is a substring of
 * the given Bash command.
 *
 * Project scope: current project + GLOBAL_PROJECT_SCOPE.
 * Non-throwing — returns [] on error.
 */
export function findPatternsByCommandSubstring(
  db: Database,
  project: string,
  command: string,
  limit: number = 5,
): ExperiencePattern[] {
  if (!command) return [];
  try {
    const rows = cachedPrepare(db,
      `SELECT * FROM experience_patterns
       WHERE (source_project = ? OR source_project = ?)
         AND trigger_command IS NOT NULL AND trigger_command != ''
         AND score > 0`
    ).all(project, GLOBAL_PROJECT_SCOPE) as (ExperiencePattern & { trigger_command: string | null })[];
    const matches: ExperiencePattern[] = [];
    for (const row of rows) {
      if (!row.trigger_command) continue;
      if (command.includes(row.trigger_command)) matches.push(row);
      if (matches.length >= limit) break;
    }
    return matches;
  } catch {
    return [];
  }
}
