/**
 * Retrieval feedback — implicit scoring of injected context quality.
 *
 * Tracks which artifacts were injected each turn, then at Stop hook
 * compares assistant output against injected content to determine
 * if the context was useful.
 *
 * No "Ignored" penalty — preventative patterns succeed precisely
 * when their keywords DON'T appear in the output.
 *
 * Part 5.2: retrieval_score is now a multiplier in the three-factor formula.
 * getRetrievalScoreMultiplier() returns the score for use in hybrid-retrieval.
 *
 * All functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { tokenizeQuery } from '../shared/search-utils.js';

/** Score deltas for each signal type (additive). */
const SCORE_REFERENCED = 0.1;
const SCORE_CORRECTION = -0.2;
const SCORE_SESSION_SUCCESS = 0.05;
/** Penalty for artifacts never referenced after N retrievals. */
const SCORE_NEVER_REFERENCED = -0.05;
/** Number of unreferenced retrievals before penalty applies. */
const UNREFERENCED_THRESHOLD = 3;

/** Clamp bounds. */
const MIN_SCORE = 0.1;
const MAX_SCORE = 3.0;

/**
 * Updates retrieval_score for an artifact based on a feedback signal.
 * Uses exponential moving average: score = score * decay + signal * (1 - decay).
 * Non-throwing.
 */
export function updateRetrievalScore(
  db: Database,
  artifactId: number,
  signal: number,
): void {
  try {
    const row = cachedPrepare(db,
      `SELECT retrieval_score FROM artifacts WHERE id = ?`
    ).get(artifactId) as { retrieval_score: number } | undefined;

    if (!row) return;

    let newScore = row.retrieval_score + signal;
    newScore = Math.max(MIN_SCORE, Math.min(MAX_SCORE, newScore));

    cachedPrepare(db,
      `UPDATE artifacts SET retrieval_score = ? WHERE id = ?`
    ).run(newScore, artifactId);
  } catch {
    // Non-throwing
  }
}

/**
 * Detects whether the assistant's response references injected artifact content.
 * Two strategies:
 * 1. File path match — if artifact summary contains a file path, check if assistant mentions it
 * 2. Jaccard similarity — keyword overlap on first 500 tokens
 * Returns true if either strategy matches.
 */
export function wasArtifactReferenced(
  assistantOutput: string,
  artifactSummary: string,
  threshold: number = 0.15,
): boolean {
  try {
    const outputLower = assistantOutput.slice(0, 2000).toLowerCase();

    // Strategy 1: File path extraction — observation summaries are "Edit: stop.ts" format
    const pathMatch = artifactSummary.match(/(?:Edit|Read|Write|Grep|Glob|Bash):\s*(.+)/);
    if (pathMatch) {
      const filePart = pathMatch[1].trim().toLowerCase();
      // Check if assistant mentions the file name (basename)
      const basename = filePart.split(/[/\\]/).pop() ?? filePart;
      if (basename.length >= 3 && outputLower.includes(basename)) return true;
    }

    // Strategy 2: Jaccard similarity on keywords
    const outputTokens = new Set(tokenizeQuery(assistantOutput.slice(0, 2000), 50));
    const artifactTokens = new Set(tokenizeQuery(artifactSummary, 20));

    if (outputTokens.size === 0 || artifactTokens.size === 0) return false;

    let intersection = 0;
    for (const token of artifactTokens) {
      if (outputTokens.has(token)) intersection++;
    }

    const jaccard = intersection / artifactTokens.size;
    return jaccard >= threshold;
  } catch {
    return false;
  }
}

/**
 * Processes feedback for all artifacts injected in a turn.
 * Called at Stop hook.
 *
 * Updates retrieval_score on artifacts AND outcome fields on retrieval_events.
 *
 * @param injectedArtifactIds - IDs of artifacts injected this turn
 * @param assistantOutput - the assistant's response text
 * @param correctionDetected - whether a user correction was detected
 * @param artifactSummaries - map of artifact ID → summary text
 * @param sessionId - session ID for updating retrieval_events outcomes
 */
export function processRetrievalFeedback(
  db: Database,
  injectedArtifactIds: number[],
  assistantOutput: string,
  correctionDetected: boolean,
  artifactSummaries: Map<number, string>,
  sessionId?: string,
): void {
  try {
    const referencedIds = new Set<number>();

    for (const id of injectedArtifactIds) {
      const summary = artifactSummaries.get(id);
      if (!summary) continue;

      if (correctionDetected) {
        // Check if the correction is topically related to this artifact
        if (wasArtifactReferenced(assistantOutput, summary, 0.1)) {
          updateRetrievalScore(db, id, SCORE_CORRECTION);
        }
        // No penalty for unrelated artifacts during correction
      } else if (wasArtifactReferenced(assistantOutput, summary)) {
        updateRetrievalScore(db, id, SCORE_REFERENCED);
        referencedIds.add(id);
      }
      // No "Ignored" penalty — preventative patterns succeed silently
    }

    // 5.1: Update retrieval_events with outcome data
    if (sessionId) {
      updateRetrievalEventOutcomes(db, sessionId, referencedIds, correctionDetected);
    }
  } catch {
    // Non-throwing
  }
}

/**
 * Applies session-success bonus to all recently injected artifacts.
 * Called when a session ends without corrections.
 * Non-throwing.
 */
export function applySessionSuccessBonus(
  db: Database,
  artifactIds: number[],
): void {
  try {
    for (const id of artifactIds) {
      updateRetrievalScore(db, id, SCORE_SESSION_SUCCESS);
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Part 5.1: Retrieval Event Recording
// ---------------------------------------------------------------------------

/**
 * Records a retrieval event when an artifact is materialized (selected for injection).
 * Called at assembly time. The was_referenced and correction_followed fields
 * are updated later at Stop hook via updateRetrievalEventOutcomes().
 * Non-throwing.
 */
export function recordRetrievalEvent(
  db: Database,
  artifactId: number,
  sessionId: string,
  queryText?: string,
): void {
  try {
    cachedPrepare(db,
      `INSERT INTO retrieval_events (artifact_id, session_id, query_text)
       VALUES (?, ?, ?)`
    ).run(artifactId, sessionId, queryText ?? null);
  } catch {
    // Non-throwing — table may not exist on older schemas
  }
}

/**
 * Updates retrieval_events for the current session with outcome data.
 * Called at Stop hook after processRetrievalFeedback determines which
 * artifacts were referenced and whether corrections occurred.
 * Non-throwing.
 */
export function updateRetrievalEventOutcomes(
  db: Database,
  sessionId: string,
  referencedArtifactIds: Set<number>,
  correctionDetected: boolean,
): void {
  try {
    // Get all retrieval events for this session that haven't been scored yet
    const events = cachedPrepare(db,
      `SELECT id, artifact_id FROM retrieval_events
       WHERE session_id = ? AND was_referenced IS NULL`
    ).all(sessionId) as Array<{ id: number; artifact_id: number }>;

    for (const event of events) {
      const wasReferenced = referencedArtifactIds.has(event.artifact_id) ? 1 : 0;
      const correctionFollowed = correctionDetected ? 1 : 0;

      cachedPrepare(db,
        `UPDATE retrieval_events
         SET was_referenced = ?, correction_followed = ?
         WHERE id = ?`
      ).run(wasReferenced, correctionFollowed, event.id);
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Part 5.2: Retrieval Score as Multiplier
// ---------------------------------------------------------------------------

/**
 * Returns the retrieval_score for an artifact, to be used as a multiplier
 * in the three-factor scoring formula: final_score = base_score * retrieval_score.
 *
 * The retrieval_score is an EMA of past retrieval outcomes:
 * - Referenced: +0.1
 * - Correction after retrieval: -0.2
 * - Session success (no corrections, artifact injected): +0.05
 * - Never referenced after 3 retrievals: -0.05
 *
 * Returns 1.0 (neutral) if the artifact is not found or on error.
 * Non-throwing.
 */
export function getRetrievalScoreMultiplier(
  db: Database,
  artifactId: number,
): number {
  try {
    const row = cachedPrepare(db,
      `SELECT retrieval_score FROM artifacts WHERE id = ?`
    ).get(artifactId) as { retrieval_score: number } | undefined;

    return row?.retrieval_score ?? 1.0;
  } catch {
    return 1.0;
  }
}

/**
 * Penalizes artifacts that have been retrieved multiple times but never referenced.
 * Queries retrieval_events for artifacts with >= UNREFERENCED_THRESHOLD retrievals
 * where was_referenced is always 0.
 * Non-throwing.
 */
export function penalizeUnreferencedArtifacts(
  db: Database,
  project: string,
): void {
  try {
    // Find artifacts with N+ retrievals that were NEVER referenced
    const candidates = cachedPrepare(db,
      `SELECT re.artifact_id, COUNT(*) as total_retrievals,
              SUM(CASE WHEN re.was_referenced = 1 THEN 1 ELSE 0 END) as referenced_count
       FROM retrieval_events re
       JOIN artifacts a ON a.id = re.artifact_id
       WHERE a.project = ? AND re.was_referenced IS NOT NULL
       GROUP BY re.artifact_id
       HAVING total_retrievals >= ? AND referenced_count = 0`
    ).all(project, UNREFERENCED_THRESHOLD) as Array<{
      artifact_id: number;
      total_retrievals: number;
      referenced_count: number;
    }>;

    for (const c of candidates) {
      updateRetrievalScore(db, c.artifact_id, SCORE_NEVER_REFERENCED);
    }
  } catch {
    // Non-throwing
  }
}
