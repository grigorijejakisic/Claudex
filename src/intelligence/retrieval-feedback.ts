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
 * All functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { tokenizeQuery } from '../shared/search-utils.js';

/** Score deltas for each signal type (additive). */
const SCORE_REFERENCED = 0.1;
const SCORE_CORRECTION = -0.2;
const SCORE_SESSION_SUCCESS = 0.05;

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
 * Uses Jaccard similarity on the first 500 tokens of output.
 * Returns true if overlap exceeds threshold.
 */
export function wasArtifactReferenced(
  assistantOutput: string,
  artifactSummary: string,
  threshold: number = 0.15,
): boolean {
  try {
    // Cap to first ~2000 chars (roughly 500 tokens)
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
 * @param injectedArtifactIds - IDs of artifacts injected this turn
 * @param assistantOutput - the assistant's response text
 * @param correctionDetected - whether a user correction was detected
 * @param artifactSummaries - map of artifact ID → summary text
 */
export function processRetrievalFeedback(
  db: Database,
  injectedArtifactIds: number[],
  assistantOutput: string,
  correctionDetected: boolean,
  artifactSummaries: Map<number, string>,
): void {
  try {
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
      }
      // No "Ignored" penalty — preventative patterns succeed silently
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
