/**
 * Outcome Tracker — records whether retrieved knowledge actually helped.
 *
 * Closes the learning feedback loop: pattern injected → work done → outcome recorded.
 * Effectiveness scores are Bayesian: (successes + 1) / (total + 2).
 * Patterns with high effectiveness are prioritized in future retrieval.
 *
 * Inspired by MemoryGraph's effectiveness tracking + Ori Mnemos Q-values.
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

export type OutcomeType = 'success' | 'failure' | 'partial' | 'unknown';

export interface SolutionOutcome {
  sessionId: string;
  project: string;
  patternId?: string;
  artifactId?: number;
  approach: string;
  outcome: OutcomeType;
  impact?: string;
}

/**
 * Record the outcome of an approach that was influenced by retrieved knowledge.
 */
export function recordOutcome(db: Database, outcome: SolutionOutcome): number {
  try {
    const result = cachedPrepare(db,
      `INSERT INTO solution_outcomes (session_id, project, pattern_id, artifact_id, approach, outcome, impact)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      outcome.sessionId, outcome.project,
      outcome.patternId ?? null, outcome.artifactId ?? null,
      outcome.approach, outcome.outcome, outcome.impact ?? null,
    );

    // Update effectiveness score on the pattern if linked
    if (outcome.patternId) {
      updatePatternEffectiveness(db, outcome.patternId);
    }

    return Number(result.lastInsertRowid);
  } catch {
    return 0;
  }
}

/**
 * Recompute a pattern's effectiveness score from all recorded outcomes.
 * Bayesian: (successes + 1) / (total + 2) — smoothed to avoid extremes.
 */
function updatePatternEffectiveness(db: Database, patternId: string): void {
  try {
    const stats = cachedPrepare(db,
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
         SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures
       FROM solution_outcomes WHERE pattern_id = ?`
    ).get(patternId) as { total: number; successes: number; failures: number };

    const effectiveness = (stats.successes + 1) / (stats.total + 2);

    // Update the pattern's confidence to reflect effectiveness
    // Blend: 50% existing confidence (from helpful/harmful) + 50% outcome effectiveness
    // reads pre-Phase-4 experience_patterns table — write surface deleted, no
    // new INSERTs (V28 trigger blocks them). Rows persist for as long as their
    // content is useful. See .planning/reframes/2026-05-05-multi-handle-kill.md.
    cachedPrepare(db,
      `UPDATE experience_patterns
       SET confidence = (confidence + ?) / 2.0
       WHERE id = ?`
    ).run(effectiveness, patternId);
  } catch { /* non-throwing */ }
}

/**
 * Get effectiveness scores for patterns, enabling effectiveness-weighted retrieval.
 */
export function getPatternEffectiveness(
  db: Database,
  patternIds: string[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (patternIds.length === 0) return result;

  try {
    for (const id of patternIds) {
      const row = cachedPrepare(db,
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes
         FROM solution_outcomes WHERE pattern_id = ?`
      ).get(id) as { total: number; successes: number } | undefined;

      if (row && row.total > 0) {
        result.set(id, (row.successes + 1) / (row.total + 2));
      }
    }
  } catch { /* non-throwing */ }

  return result;
}

/**
 * Auto-detect outcome from session context.
 * Called by the stop hook — infers outcome from what happened after pattern injection.
 *
 * Heuristics:
 *   - Tests passing after fix → success
 *   - User correction after injection → failure
 *   - Build succeeding → partial success
 *   - No signal → unknown
 */
export function inferOutcomeFromSession(
  db: Database,
  sessionId: string,
  project: string,
  injectedPatternIds: string[],
  correctionDetected: boolean,
  buildSucceeded: boolean,
  testsPasssed: boolean,
): void {
  if (injectedPatternIds.length === 0) return;

  try {
    let outcome: OutcomeType = 'unknown';
    let impact: string | undefined;

    if (correctionDetected) {
      outcome = 'failure';
      impact = 'User corrected after pattern injection';
    } else if (testsPasssed) {
      outcome = 'success';
      impact = 'Tests passed after applying pattern';
    } else if (buildSucceeded) {
      outcome = 'partial';
      impact = 'Build succeeded but tests not confirmed';
    }

    for (const patternId of injectedPatternIds) {
      recordOutcome(db, {
        sessionId,
        project,
        patternId,
        approach: 'pattern-guided',
        outcome,
        impact,
      });
    }
  } catch { /* non-throwing */ }
}
