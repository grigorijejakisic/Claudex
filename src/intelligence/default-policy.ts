/**
 * Default Memory Policy — extracts all current hard-coded values.
 *
 * This is a zero-behavior-change refactoring. Every value returned by this
 * implementation matches the previously hard-coded constants exactly.
 *
 * Constants are kept as named exports for tests that reference them directly.
 */

import type { Database } from 'better-sqlite3';
import type {
  MemoryPolicy,
  ObservationCandidate,
  PolicyContext,
  StoreAction,
  ConsolidateAction,
  PatternAction,
} from './memory-policy.js';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Extracted constants (kept as named exports for test compatibility)
// ---------------------------------------------------------------------------

/** Cosine similarity threshold for observation dedup. Above this = duplicate. */
export const DEDUP_COSINE_THRESHOLD = 0.85;

/** Number of unreferenced retrievals before negative learning suppression. */
export const NEGATIVE_LEARNING_THRESHOLD = 3;

/** Maximum suppression magnitude (never suppress more than 50%). */
export const MAX_SUPPRESSION = -0.5;

/** Per-unreferenced suppression step beyond threshold. */
export const SUPPRESSION_STEP = -0.1;

/** Floor multiplier — never fully suppress an artifact. */
export const MULTIPLIER_FLOOR = 0.5;

/** Cosine similarity threshold for consolidation clustering. */
export const CLUSTER_COSINE_THRESHOLD = 0.8;

/** Minimum confidence for auto-injection into assembly. */
export const PREDICTION_CONFIDENCE_THRESHOLD = 0.4;

/** Harmful multiplier applied when correction detected after pattern injection. */
export const HARMFUL_MULTIPLIER = 4;

/** Minimum RRF score for a candidate to be subject to RIF suppression. */
export const RIF_MIN_RRF = 0.01;

/**
 * Stability-aware half-lives in days, keyed by stability class and importance level.
 * Infinity means the observation never auto-decays.
 */
export const STABILITY_HALF_LIVES: Record<string, Record<number, number>> = {
  transient:  { 1: 3,        2: 7,        3: 14,       4: 30,       5: 90 },
  standard:   { 1: 7,        2: 14,       3: 30,       4: 60,       5: 365 },
  stable:     { 1: 14,       2: 30,       3: 90,       4: 180,      5: Infinity },
  permanent:  { 1: Infinity, 2: Infinity, 3: Infinity, 4: Infinity, 5: Infinity },
};

/** Flat half-lives fallback (legacy, used for 'standard' when stability unavailable). */
export const HALF_LIVES: Record<number, number> = { 1: 7, 2: 14, 3: 60, 4: 90, 5: 365 };

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

export class DefaultMemoryPolicy implements MemoryPolicy {
  /**
   * Dedup-aware storage decision.
   *
   * - No match (score <= 0.85) -> add
   * - Match but no valid observation ID -> add (artifact_ref missing or observation deleted)
   * - Match in same session with valid obs ID -> skip
   * - Match in different session with valid obs ID -> update existing
   */
  shouldStore(obs: ObservationCandidate, _context: PolicyContext): StoreAction {
    if (obs.bestMatchScore <= DEDUP_COSINE_THRESHOLD) {
      return { action: 'add' };
    }

    // Above threshold but no valid observation to skip/update — add anyway
    if (!obs.bestMatchObsId || obs.bestMatchObsId <= 0) {
      return { action: 'add' };
    }

    // Above threshold with valid observation — duplicate detected
    if (obs.bestMatchSessionId === obs.sessionId) {
      return { action: 'skip', reason: 'same-session duplicate' };
    }

    return { action: 'update', targetId: obs.bestMatchObsId };
  }

  /**
   * Negative learning multiplier for retrieval scoring.
   *
   * - unreferenced < 3 -> baseScore unchanged
   * - unreferenced >= 3 -> suppression = max(-0.5, -0.1 * (unreferenced - 2))
   * - Positive signals scale suppression: suppression *= unreferenced / (unreferenced + referenced)
   * - Applied as: baseScore * (1.0 + suppression)
   * - Floor: 0.5
   */
  scoreForRetrieval(artifactId: number, baseScore: number, _context: PolicyContext, db: Database): number {
    const counts = cachedPrepare(db,
      `SELECT
         SUM(CASE WHEN was_referenced = 0 THEN 1 ELSE 0 END) AS unreferenced,
         SUM(CASE WHEN was_referenced = 1 THEN 1 ELSE 0 END) AS referenced,
         SUM(CASE WHEN correction_followed = 1 THEN 1 ELSE 0 END) AS correction_count
       FROM retrieval_events
       WHERE artifact_id = ? AND was_referenced IS NOT NULL`
    ).get(artifactId) as { unreferenced: number | null; referenced: number | null; correction_count: number | null } | undefined;

    const unreferenced = counts?.unreferenced ?? 0;
    const referenced = counts?.referenced ?? 0;
    const correctionCount = counts?.correction_count ?? 0;

    // Correction penalty: artifacts where BOTH was_referenced=1 AND correction_followed=1
    // are more severely suppressed — they were actively used AND caused problems.
    // Artifacts that were merely present (unreferenced) during a correction aren't penalized
    // here — they weren't the cause.
    if (correctionCount > 0 && (counts?.referenced ?? 0) > 0) {
      const correctionPenalty = Math.max(-0.8, -0.2 * correctionCount);
      return Math.max(MULTIPLIER_FLOOR * 0.5, baseScore * (1.0 + correctionPenalty));
    }

    // No suppression if below threshold
    if (unreferenced < NEGATIVE_LEARNING_THRESHOLD) {
      return baseScore;
    }

    // Compute raw suppression: -0.1 per unreferenced beyond 2, capped at -0.5
    let suppression = Math.max(MAX_SUPPRESSION, SUPPRESSION_STEP * (unreferenced - 2));

    // Scale by unreferenced ratio — positive signals reduce suppression
    if (referenced > 0) {
      suppression *= unreferenced / (unreferenced + referenced);
    }

    // Apply suppression to base multiplier
    const multiplier = baseScore * (1.0 + suppression);

    // Floor: never below 0.5x
    return Math.max(MULTIPLIER_FLOOR, multiplier);
  }

  /**
   * Consolidation decision.
   *
   * - cluster >= 3 -> merge (LLM consolidation)
   * - cluster == 2 -> merge (direct pair merge)
   * - singleton (1) -> skip
   */
  shouldConsolidate(clusterSize: number, _avgSimilarity: number): ConsolidateAction {
    if (clusterSize >= 2) return 'merge';
    return 'skip';
  }

  /**
   * Prediction confidence threshold for auto-injection.
   * Returns 0.4 — predictions below this are available via MCP recall only.
   */
  getPredictionThreshold(_context: PolicyContext): number {
    return PREDICTION_CONFIDENCE_THRESHOLD;
  }

  /**
   * Evaluate pattern based on feedback.
   *
   * Score delta:
   * - helpful (no correction): +1
   * - harmful (correction detected): -4 (4x harmful multiplier)
   *
   * Maturity promotion:
   * - candidate -> established: triggered >= 2
   * - established -> proven: helpful >= 3 AND verified >= 2
   *
   * Inversion:
   * - harmful > helpful + 3 -> invert to warning
   */
  evaluatePattern(
    helpful: number,
    harmful: number,
    triggered: number,
    verified: number,
    maturity: string,
  ): PatternAction {
    // Check anti-pattern inversion first (highest priority action)
    if (harmful > helpful + 3) {
      return 'invert';
    }

    // Check maturity promotion
    const mat = maturity || 'candidate';
    if (mat === 'candidate' && triggered >= 2) {
      return 'promote';
    }
    if (mat === 'established' && helpful >= 3 && verified >= 2) {
      return 'promote';
    }

    // Check demotion (harmful > helpful suggests pattern is not useful)
    if (harmful > helpful && harmful >= 2) {
      return 'demote';
    }

    return 'keep';
  }

  /**
   * Get decay half-life in days.
   * Uses the full STABILITY_HALF_LIVES table.
   */
  getHalfLife(_category: string, importance: number, stabilityClass: string): number {
    const stability = stabilityClass || 'standard';
    const hlTable = STABILITY_HALF_LIVES[stability] ?? STABILITY_HALF_LIVES['standard'];
    return hlTable[importance] ?? HALF_LIVES[importance] ?? 7;
  }

  /**
   * RIF suppression decision.
   * Candidates with rrfScore >= 0.01 that weren't selected get suppressed.
   */
  shouldSuppressCandidate(rrfScore: number): boolean {
    return rrfScore >= RIF_MIN_RRF;
  }
}
