/**
 * Experience Patterns — cross-session failure pattern memory with ExpeL scoring.
 *
 * Patterns are created when correction signals are detected, matched via FTS5
 * on every user prompt, and scored based on usefulness feedback:
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
import { isLocalOrPrivateUrl } from '../embeddings/embedding-provider.js';
import { fetchJsonWithTimeout } from '../shared/fetch-utils.js';
import type { EnrichmentProvider } from './enrichment.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';
import { SECRET_CONTENT_PATTERNS } from './behavioral-signals.js';

/** Global-flag version for use in .replace() — the exported constant is for .test() only. */
const SECRET_CONTENT_PATTERNS_RE = new RegExp(SECRET_CONTENT_PATTERNS.source, 'g');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatternType = 'correction' | 'behavioral' | 'discovery';
export type Severity = 'critical' | 'important' | 'minor';

export type AbstractionLevel = 'tip' | 'strategy';

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
    // Only promote if the pattern belongs to a different real project
    // (not already global, not already in the current project).
    // Only promote discovery patterns to global — correction and behavioral
    // patterns are project-specific by nature (C6).
    cachedPrepare(db,
      `UPDATE experience_patterns
       SET source_project = ?
       WHERE id = ?
         AND pattern_type = 'discovery'
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
      // Dedup check — if a similar pattern exists in the same project/type scope,
      // reinforce it instead of creating a cross-project contamination or
      // reviving a pruned pattern from another project.
      const existing = deduplicateCheck(db, sanitized.trigger_context, project, sanitized.pattern_type);
      if (existing !== null) {
        updatePatternScore(db, existing.id, 1);
        return existing.id;
      }

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
      import('../../embeddings/embed-pipeline.js').then(({ embedPattern: ep }) => {
        ep(db, resultId, sanitized.trigger_context, sanitized.lesson, {
          project,
          pattern_type: sanitized.pattern_type,
          severity: sanitized.severity ?? 'important',
          score: 2,
        }).catch(() => {}); // swallow — non-critical
      }).catch(() => {}); // dynamic import failure — non-critical
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
    const rows = cachedPrepare(db,
      `SELECT ep.*
       FROM experience_patterns ep
       JOIN experience_patterns_fts fts ON fts.rowid = ep.rowid
       WHERE experience_patterns_fts MATCH ?
         AND ep.score >= 2
         AND (ep.source_project = ? OR ep.source_project = ?)
       ORDER BY
         CASE WHEN ep.source_project = ? THEN 0 ELSE 1 END,
         CASE ep.severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
         fts.rank,
         ep.score DESC
       LIMIT ?`
    ).all(ftsQuery, project, GLOBAL_PROJECT_SCOPE, project, safeLimit) as ExperiencePattern[];

    return rows;
  } catch {
    // FTS query may fail on invalid syntax — try keyword LIKE fallback
    return findMatchingPatternsFallback(db, prompt, project, safeLimit);
  }
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
      `SELECT * FROM experience_patterns
       WHERE score >= 2
         AND (source_project = ? OR source_project = ?)
         AND (${conditions})
       ORDER BY
         CASE WHEN source_project = ? THEN 0 ELSE 1 END,
         CASE severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
         score DESC
       LIMIT ?`
    ).all(project, GLOBAL_PROJECT_SCOPE, ...likeParams, project, limit) as ExperiencePattern[];
  } catch {
    return [];
  }
}

/**
 * Adjusts a pattern's score by delta (+1 or -1).
 * Score is clamped at a minimum of 0 — pruning removes patterns at or below 0
 * via pruneDeadPatterns, which callers should invoke periodically.
 * Non-throwing.
 */
export function updatePatternScore(db: Database, id: string, delta: number): void {
  try {
    cachedPrepare(db,
      `UPDATE experience_patterns
       SET score = MAX(0, score + ?)
       WHERE id = ?`
    ).run(delta, id);
  } catch {
    // Non-throwing
  }
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

    const row = cachedPrepare(db,
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
 * Returns whether a pattern is verified.
 * Non-throwing.
 */
export function isPatternVerified(db: Database, id: string): boolean {
  try {
    const row = cachedPrepare(db,
      `SELECT verified FROM experience_patterns WHERE id = ?`
    ).get(id) as { verified: number } | undefined;
    return row?.verified === 1;
  } catch {
    return false;
  }
}

/**
 * Returns patterns that have been triggered 3+ times without verification.
 * These are candidates for review — may be noise.
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
