/**
 * Retrieval RL — Q-value reinforcement learning for memory retrieval.
 *
 * Patterns and artifacts earn Q-values from session outcomes via exponential
 * moving average. Higher Q-value = more likely to help in future sessions.
 * UCB-Tuned exploration bonus for under-retrieved items.
 *
 * Q(pattern) = EMA of outcomes: success=1.0, partial=0.5, failure=0.0, unknown=0.3
 * UCB bonus = sqrt(2 * ln(total_retrievals) / pattern_retrievals)
 * Final score = Q + exploration_weight * UCB
 *
 * Inspired by Ori Mnemos (90% Recall@5 on HotpotQA vs Mem0's 29%).
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

const EMA_ALPHA = 0.3; // Learning rate for exponential moving average
const EXPLORATION_WEIGHT = 0.1; // UCB exploration bonus weight
const DEFAULT_Q = 0.5; // Prior Q-value for unobserved patterns

/** Outcome to reward mapping. */
const OUTCOME_REWARDS: Record<string, number> = {
  success: 1.0,
  partial: 0.5,
  failure: 0.0,
  unknown: 0.3,
};

/**
 * Compute Q-value for a pattern from its outcome history.
 * Uses exponential moving average — recent outcomes weigh more.
 */
export function computeQValue(
  db: Database,
  patternId: string,
): number {
  try {
    const outcomes = cachedPrepare(db,
      `SELECT outcome, created_at_epoch FROM solution_outcomes
       WHERE pattern_id = ?
       ORDER BY created_at_epoch ASC`
    ).all(patternId) as Array<{ outcome: string; created_at_epoch: number }>;

    if (outcomes.length === 0) return DEFAULT_Q;

    let q = DEFAULT_Q;
    for (const o of outcomes) {
      const reward = OUTCOME_REWARDS[o.outcome] ?? 0.3;
      q = q * (1 - EMA_ALPHA) + reward * EMA_ALPHA;
    }

    return q;
  } catch {
    return DEFAULT_Q;
  }
}

/**
 * Compute UCB exploration bonus for a pattern.
 * Encourages retrieval of under-explored patterns.
 */
function computeUCB(
  totalRetrievals: number,
  patternRetrievals: number,
): number {
  if (patternRetrievals === 0 || totalRetrievals === 0) return 1.0; // Max exploration for unseen
  return Math.sqrt(2 * Math.log(totalRetrievals) / patternRetrievals);
}

/**
 * Get Q-value boosted scores for a set of pattern IDs.
 * Returns a map of patternId → boost multiplier (0.5 to 2.0).
 *
 * Used by hybrid retrieval to rerank results by learned effectiveness.
 */
export function getQValueBoosts(
  db: Database,
  patternIds: string[],
): Map<string, number> {
  const boosts = new Map<string, number>();
  if (patternIds.length === 0) return boosts;

  try {
    // Total retrieval count across all patterns (for UCB)
    const totalRow = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM solution_outcomes`
    ).get() as { c: number };
    const totalRetrievals = totalRow.c;

    for (const id of patternIds) {
      const q = computeQValue(db, id);

      // Count retrievals for this pattern
      const patternRow = cachedPrepare(db,
        `SELECT COUNT(*) as c FROM solution_outcomes WHERE pattern_id = ?`
      ).get(id) as { c: number };

      const ucb = computeUCB(totalRetrievals, patternRow.c);
      const combined = q + EXPLORATION_WEIGHT * ucb;

      // Normalize to a boost multiplier (0.5 to 2.0)
      // Q=0 + no exploration → 0.5x (halved)
      // Q=1 + exploration → 2.0x (doubled)
      const boost = Math.max(0.5, Math.min(2.0, combined * 1.5));
      boosts.set(id, boost);
    }
  } catch { /* non-throwing */ }

  return boosts;
}

/**
 * Apply Q-value boosts to experience pattern scores during retrieval.
 * Called after FTS5/vector matching, before final ranking.
 */
export function applyQValueReranking(
  db: Database,
  patterns: Array<{ id: string; score: number }>,
): Array<{ id: string; score: number }> {
  if (patterns.length === 0) return patterns;

  try {
    const boosts = getQValueBoosts(db, patterns.map(p => p.id));
    if (boosts.size === 0) return patterns;

    return patterns
      .map(p => ({
        id: p.id,
        score: p.score * (boosts.get(p.id) ?? 1.0),
      }))
      .sort((a, b) => b.score - a.score);
  } catch {
    return patterns;
  }
}

/**
 * Update Q-values in batch after a session ends.
 * Recomputes Q for all patterns that had outcomes this session.
 * Stores the computed Q-value in the pattern's confidence field
 * (blended 50/50 with existing confidence).
 */
export function updateSessionQValues(
  db: Database,
  sessionId: string,
): number {
  try {
    const sessionOutcomes = cachedPrepare(db,
      `SELECT DISTINCT pattern_id FROM solution_outcomes
       WHERE session_id = ? AND pattern_id IS NOT NULL`
    ).all(sessionId) as Array<{ pattern_id: string }>;

    let updated = 0;
    for (const { pattern_id } of sessionOutcomes) {
      const q = computeQValue(db, pattern_id);

      // Blend Q-value with existing confidence (50/50)
      cachedPrepare(db,
        `UPDATE experience_patterns
         SET confidence = (confidence + ?) / 2.0
         WHERE id = ?`
      ).run(q, pattern_id);
      updated++;
    }

    return updated;
  } catch {
    return 0;
  }
}
