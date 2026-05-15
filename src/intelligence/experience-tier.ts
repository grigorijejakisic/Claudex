/**
 * Phase 6.5 — Experience Tier scorer (Architecture B partner of CR Tier).
 *
 * Surfaces top-K cross-project lessons as observational context at session-
 * start. Reads `artifact_task_pattern` (Plan 01 sidecar), JOINs to `artifacts`,
 * scores against incoming-task handles, applies budget cap and per-session
 * dedup, renders in advisory voice (Phase 7 alignment).
 *
 * Architecture B principles:
 *   - Parallel scorer to Critical Reminders (`critical-reminders.ts`)
 *   - Shared infrastructure via `tier-utils.ts` (TTL, decay, jitter)
 *   - Different inputs: rules vs episodes
 *   - Different budget: 200 tokens (≤ CR's 300) so behavioral rules win on
 *     collision-shaped scoring
 *   - K=3 top-K (CR uses 5; episodes are denser per item)
 *
 * Cache stability: scoring is deterministic — no clocks except `unixepoch()`
 * SQL recency band, no Math.random; tiebreaker is `(score DESC, id ASC)`.
 * Two runs with identical inputs produce identical outputs (CACH-02).
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { estimateTokens } from '../shared/text-utils.js';
import { scaleBudget } from '../shared/constants.js';
import { stageOneHandleOverlap, type HandleSet } from '../core/cross-project-equivalence.js';
import { formatExperienceTierSection, type ExperienceTierItem } from '../assembly/sections.js';

export const TIER_BUDGET = 200;
export const TOP_K = 3;
export const RECENCY_DAYS = 14;
export const STAGE1_OVERLAP_BOOST_THRESHOLD = 3;
const ALREADY_INJECTED_PENALTY = -10;

export interface ExperienceTierResult {
  section: string;
  tokenCost: number;
  injectedArtifactIds: number[];
  applyEffects: () => void;
}

interface CandidateRow {
  artifact_id: number;
  project: string;
  summary: string;
  content: string | null;
  task_pattern: string;
  classifier_confidence: number;
  timestamp_epoch_ms: number;
  recent: 0 | 1;
  helpful_yn: number | null;
  artifact_kind: string;       // 'artifact' or 'lesson_pointer' (for diagnostics)
  // Reconstructed handles populated post-query.
  handles?: HandleSet;
  // Lazy-resolved score (populated by scorer).
  _score?: number;
}

/**
 * Synthesize a HandleSet from artifact summary + content via cheap regex.
 * Mirrors the heartbeat-backfill synthesis in task-pattern-classifier.ts.
 */
function synthesizeHandlesFromArtifact(summary: string, content: string | null): HandleSet {
  const text = `${summary || ''}\n${content || ''}`;
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(t => t.length > 1);
  return {
    tools_used: [],
    files_touched: [],
    user_framing_tokens: tokens,
    errors_encountered: tokens,
  };
}

/**
 * Pull cross-project candidates: artifacts of relevant kinds with a
 * task_pattern fingerprint, in projects OTHER than the current one.
 *
 * Bounded candidate pool (200) ordered by recency. Scoring narrows further.
 */
function fetchCandidatePool(
  db: Database,
  currentProject: string,
  poolLimit: number = 200,
): CandidateRow[] {
  return cachedPrepare(db,
    `SELECT a.id AS artifact_id,
            a.project AS project,
            a.summary AS summary,
            a.content AS content,
            atp.task_pattern AS task_pattern,
            atp.classifier_confidence AS classifier_confidence,
            a.timestamp_epoch_ms AS timestamp_epoch_ms,
            CASE WHEN a.timestamp_epoch_ms >= (unixepoch('now', '-' || ? || ' days') * 1000) THEN 1 ELSE 0 END AS recent,
            NULL AS helpful_yn,
            'artifact' AS artifact_kind
       FROM artifacts a
       INNER JOIN artifact_task_pattern atp ON atp.artifact_id = a.id
      WHERE atp.task_pattern != '__abstain__'
        AND a.project != ?
        AND a.artifact_type IN ('learning', 'observation', 'memory_file', 'flow', 'milestone')
      ORDER BY a.timestamp_epoch_ms DESC
      LIMIT ?`
  ).all(RECENCY_DAYS, currentProject, poolLimit) as CandidateRow[];
}

/**
 * Pull session-events rows that mark previously injected artifact_ids for
 * this session, returning a Set of int IDs.
 */
function fetchInjectedSet(db: Database, sessionId: string): Set<number> {
  try {
    const rows = cachedPrepare(db,
      `SELECT entity FROM session_events
        WHERE session_id = ? AND event_type = 'experience_tier_injected'`
    ).all(sessionId) as Array<{ entity: string }>;
    const out = new Set<number>();
    for (const r of rows) {
      const n = Number(r.entity);
      if (Number.isFinite(n)) out.add(n);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Resolve the inferred incoming task_pattern (when known) to score against
 * candidate task_patterns. Returns null when no clear inference.
 *
 * For Phase 6.5 v1: caller passes the inferred shape via incomingHandles
 * tokens (synthesized in assembler.ts:synthesizeIncomingHandles or in a
 * Vesna probe). We don't re-classify here; we just check whether any
 * canonical task_shape vocab value appears as a token in the framing tokens.
 */
function inferIncomingPattern(db: Database, incoming: HandleSet): string | null {
  try {
    const rows = cachedPrepare(db,
      `SELECT value FROM shape_vocabulary WHERE field = 'task_shape'`
    ).all() as Array<{ value: string }>;
    const framingSet = new Set((incoming.user_framing_tokens ?? []).map(t => t.toLowerCase()));
    for (const r of rows) {
      // Match if any canonical value's tokenization is fully contained in framing.
      const canonicalTokens = r.value.toLowerCase().split(/[-_\s]+/).filter(t => t.length > 0);
      if (canonicalTokens.length === 0) continue;
      let allFound = true;
      for (const ct of canonicalTokens) {
        if (!framingSet.has(ct)) { allFound = false; break; }
      }
      if (allFound) return r.value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Score a single candidate against the incoming task handles per the LOCKED
 * weight matrix (CONTEXT.md):
 *
 * | Signal                                          | Weight |
 * |-------------------------------------------------|--------|
 * | Stage-1 telemetry-handle overlap ≥3 with current| +5     |
 * | Shape-vocab task_pattern match with inferred    | +4     |
 * | Recent (within 14 days)                         | +2     |
 * | Helpful (Phase 5.5 helpful_yn = 1)              | +2     |
 * | Cross-project (always +1 — kid-stove signal)    | +1     |
 * | Already injected this session                   | -10    |
 */
function scoreCandidate(
  cand: CandidateRow,
  incoming: HandleSet,
  inferredPattern: string | null,
  injectedSet: Set<number>,
): number {
  let score = 0;
  // Stage-1 overlap bonus.
  const handles = cand.handles ?? synthesizeHandlesFromArtifact(cand.summary, cand.content);
  cand.handles = handles;
  const overlap = stageOneHandleOverlap(handles, incoming);
  if (overlap >= STAGE1_OVERLAP_BOOST_THRESHOLD) score += 5;

  // Shape-vocab match.
  if (inferredPattern && cand.task_pattern === inferredPattern) score += 4;

  // Recency.
  if (cand.recent === 1) score += 2;

  // Helpful (Phase 5.5).
  if (cand.helpful_yn === 1) score += 2;

  // Cross-project (always true — pool is project-filtered).
  score += 1;

  // Already-injected penalty.
  if (injectedSet.has(cand.artifact_id)) score += ALREADY_INJECTED_PENALTY;

  return score;
}

/**
 * Assemble the Experience Tier. Returns null when no candidate scores
 * positively or even one candidate exceeds the budget cap.
 *
 * Side effects (`session_events` writes recording injection) are deferred
 * to `applyEffects()` — match the Critical Reminders pattern.
 */
export function assembleExperienceTier(
  db: Database,
  sessionId: string,
  _turnNumber: number,
  currentProject: string,
  incomingHandles: HandleSet,
  contextWindowTokens?: number,
): ExperienceTierResult | null {
  try {
    const pool = fetchCandidatePool(db, currentProject);
    if (pool.length === 0) return null;

    const injectedSet = fetchInjectedSet(db, sessionId);
    const inferredPattern = inferIncomingPattern(db, incomingHandles);

    // Score every candidate.
    for (const c of pool) {
      c._score = scoreCandidate(c, incomingHandles, inferredPattern, injectedSet);
    }

    // Drop non-positive scores (a candidate can't be selected unless it
    // signals at least cross-project + one other dimension).
    const positives = pool.filter(c => (c._score ?? 0) > 1);
    if (positives.length === 0) return null;

    // Sort: score DESC, id ASC for deterministic tie-break (cache stability).
    positives.sort((a, b) => {
      if ((b._score ?? 0) !== (a._score ?? 0)) return (b._score ?? 0) - (a._score ?? 0);
      return a.artifact_id - b.artifact_id;
    });

    let selected = positives.slice(0, TOP_K);

    // Render and budget-trim.
    const renderItems = (items: CandidateRow[]): ExperienceTierItem[] =>
      items.map(c => ({ project: c.project, summary: c.summary, content: c.content }));

    let section = formatExperienceTierSection(renderItems(selected));
    let tokenCost = estimateTokens(section);
    const budget = scaleBudget(TIER_BUDGET, contextWindowTokens);

    while (tokenCost > budget && selected.length > 1) {
      selected = selected.slice(0, -1);
      section = formatExperienceTierSection(renderItems(selected));
      tokenCost = estimateTokens(section);
    }
    if (tokenCost > budget) return null;

    const injectedArtifactIds = selected.map(c => c.artifact_id);

    return {
      section,
      tokenCost,
      injectedArtifactIds,
      applyEffects: () => {
        try {
          const stmt = cachedPrepare(db,
            `INSERT INTO session_events (session_id, project, event_type, entity, action)
               VALUES (?, ?, 'experience_tier_injected', ?, 'inject')`
          );
          for (const id of injectedArtifactIds) {
            try { stmt.run(sessionId, currentProject, String(id)); } catch { /* per-row non-fatal */ }
          }
        } catch { /* non-fatal */ }
      },
    };
  } catch {
    return null;
  }
}
