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
import { getPolicy } from './policy-registry.js';

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
    // 14-07b: migrated from legacy artifacts — retrieval_score lives in data JSON on V17
    const row = cachedPrepare(db,
      `SELECT COALESCE(json_extract(data, '$.retrieval_score'), 1.0) AS retrieval_score
       FROM artifact WHERE rowid = ?`
    ).get(artifactId) as { retrieval_score: number } | undefined;

    if (!row) return;

    let newScore = row.retrieval_score + signal;
    newScore = Math.max(MIN_SCORE, Math.min(MAX_SCORE, newScore));

    // 14-07b: migrated from legacy artifacts — write retrieval_score into data JSON
    cachedPrepare(db,
      `UPDATE artifact SET data = json_set(data, '$.retrieval_score', ?) WHERE rowid = ?`
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
// Part 5.2: Retrieval Score as Multiplier (with negative learning)
// ---------------------------------------------------------------------------

/** Minimum unreferenced retrievals before suppression kicks in.
 * @deprecated Use getPolicy().scoreForRetrieval() instead. Kept for test compatibility. */
export const NEGATIVE_LEARNING_THRESHOLD = 3;

/** Maximum suppression magnitude (never suppress more than 50%).
 * @deprecated Use getPolicy().scoreForRetrieval() instead. Kept for test compatibility. */
export const MAX_SUPPRESSION = -0.5;

/** Per-unreferenced suppression step beyond threshold.
 * @deprecated Use getPolicy().scoreForRetrieval() instead. Kept for test compatibility. */
export const SUPPRESSION_STEP = -0.1;

/** Floor multiplier — never fully suppress an artifact.
 * @deprecated Use getPolicy().scoreForRetrieval() instead. Kept for test compatibility. */
export const MULTIPLIER_FLOOR = 0.5;

/**
 * Returns the retrieval score multiplier for an artifact, incorporating
 * negative learning from unreferenced retrievals.
 *
 * Delegates to MemoryPolicy.scoreForRetrieval() for the suppression logic.
 *
 * Base multiplier: retrieval_score from artifacts table (EMA of past outcomes).
 *
 * Negative learning overlay:
 * - Queries retrieval_events for referenced/unreferenced counts
 * - If unreferenced_count >= 3: suppression = max(-0.5, -0.1 * (unreferenced - 2))
 * - Positive signals reduce suppression: suppression *= unreferenced / (unreferenced + referenced)
 * - Applied as: baseMultiplier * (1.0 + suppression)
 * - Recovery: as referenced count grows, ratio shrinks and suppression lifts
 * - Floor: never below 0.5×
 *
 * Returns 1.0 (neutral) if the artifact is not found or on error.
 * Non-throwing.
 */
export function getRetrievalScoreMultiplier(
  db: Database,
  artifactId: number,
): number {
  try {
    // 14-07b: migrated from legacy artifacts — retrieval_score lives in data JSON on V17
    const row = cachedPrepare(db,
      `SELECT COALESCE(json_extract(data, '$.retrieval_score'), 1.0) AS retrieval_score
       FROM artifact WHERE rowid = ?`
    ).get(artifactId) as { retrieval_score: number } | undefined;

    if (!row) return 1.0;

    const baseMultiplier = row.retrieval_score;

    const policy = getPolicy();

    // Build context with real temporal data for RL policy learning
    const now = new Date();
    let hoursSinceLastSession = 0;
    try {
      const prev = cachedPrepare(db,
        `SELECT ended_at_epoch_ms FROM sessions WHERE status != 'active' ORDER BY ended_at_epoch_ms DESC LIMIT 1`
      ).get() as { ended_at_epoch_ms: number } | undefined;
      if (prev?.ended_at_epoch_ms) {
        hoursSinceLastSession = (Date.now() - prev.ended_at_epoch_ms) / 3600000;
      }
    } catch { /* non-critical */ }
    const context = {
      sessionId: '',
      project: '',
      hourOfDay: now.getHours(),
      dayOfWeek: now.getDay(),
      hoursSinceLastSession,
    };

    return policy.scoreForRetrieval(artifactId, baseMultiplier, context, db);
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
      // Idempotence guard: only penalize if score is still above MIN_SCORE floor.
      // Old guard checked > SCORE_NEVER_REFERENCED (-0.05) which is always true
      // since MIN_SCORE (0.1) clamps scores above that — compounding penalty endlessly.
      const current = cachedPrepare(db,
        `SELECT retrieval_score FROM artifacts WHERE id = ?`
      ).get(c.artifact_id) as { retrieval_score: number } | undefined;
      if (current && current.retrieval_score > MIN_SCORE) {
        updateRetrievalScore(db, c.artifact_id, SCORE_NEVER_REFERENCED);
      }
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Phase 14: was_referenced recording at session end
// ---------------------------------------------------------------------------

/**
 * Records was_referenced for retrieval_events that haven't been scored yet.
 *
 * For each unscored retrieval_event in this session:
 * - Looks up the artifact's summary
 * - Tokenizes the summary into keywords
 * - Checks if 2+ keywords appear in the combined assistant text from this session
 * - Sets was_referenced = 1 if matched, 0 if not
 *
 * Called in the stop hook after conversation turns are stored.
 * Non-throwing.
 */
export function recordWasReferenced(
  db: Database,
  sessionId: string,
): void {
  try {
    // Get unscored retrieval events for this session
    const unscoredEvents = cachedPrepare(db,
      `SELECT re.id, re.artifact_id
       FROM retrieval_events re
       WHERE re.session_id = ? AND re.was_referenced IS NULL`
    ).all(sessionId) as Array<{ id: number; artifact_id: number }>;

    if (unscoredEvents.length === 0) return;

    // Collect all assistant text from this session's conversation turns
    const turns = cachedPrepare(db,
      `SELECT assistant_text FROM conversation_turns
       WHERE session_id = ? AND assistant_text IS NOT NULL`
    ).all(sessionId) as Array<{ assistant_text: string }>;

    const combinedAssistantText = turns.map(t => t.assistant_text).join(' ').toLowerCase();

    if (combinedAssistantText.length === 0) {
      // No assistant text — mark all as unreferenced
      const updateStmt = cachedPrepare(db,
        `UPDATE retrieval_events SET was_referenced = 0 WHERE id = ?`
      );
      for (const event of unscoredEvents) {
        updateStmt.run(event.id);
      }
      return;
    }

    // Cache artifact summaries to avoid repeated lookups
    const artifactIds = [...new Set(unscoredEvents.map(e => e.artifact_id))];
    const summaryMap = new Map<number, string>();
    for (const aid of artifactIds) {
      const row = cachedPrepare(db,
        `SELECT summary FROM artifacts WHERE id = ?`
      ).get(aid) as { summary: string } | undefined;
      if (row) summaryMap.set(aid, row.summary);
    }

    const updateStmt = cachedPrepare(db,
      `UPDATE retrieval_events SET was_referenced = ? WHERE id = ?`
    );

    for (const event of unscoredEvents) {
      const summary = summaryMap.get(event.artifact_id);
      if (!summary) {
        updateStmt.run(0, event.id);
        continue;
      }

      // Tokenize summary and check for matching tokens in assistant text.
      // Use prefix matching (5+ chars) with word boundary to catch stemming variants:
      // "embedding" matches "embed", "modification" matches "modif"
      const summaryTokens = tokenizeQuery(summary, 20);
      let matchCount = 0;
      for (const token of summaryTokens) {
        if (token.length < 3) continue;
        // Exact match
        if (combinedAssistantText.includes(token)) {
          matchCount++;
        } else if (token.length >= 5) {
          // Prefix match: check if the first 5 chars appear as a word boundary prefix.
          // Use regex word boundary to prevent "edit" matching "credit".
          const prefix = token.substring(0, 5);
          const prefixRe = new RegExp(`\\b${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
          if (prefixRe.test(combinedAssistantText)) {
            matchCount += 0.5; // Half-credit for prefix match
          }
        }
        if (matchCount >= 1.5) break; // Early exit — 2 exact or 1 exact + 1 prefix
      }

      // Threshold: 1 exact match + 1 prefix, or 2 exact matches, or
      // for short summaries (≤5 tokens), 1 exact match suffices
      const threshold = summaryTokens.length <= 5 ? 1 : 1.5;
      updateStmt.run(matchCount >= threshold ? 1 : 0, event.id);
    }
  } catch {
    // Non-throwing
  }
}
