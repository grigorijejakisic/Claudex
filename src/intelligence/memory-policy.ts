/**
 * Memory Policy Interface — pluggable memory management rules.
 *
 * Extracts all hard-coded memory management constants and decision logic
 * into a swappable policy interface. The default implementation preserves
 * current behavior exactly (zero behavior change).
 *
 * Level 1 of the RL Memory Policy spec.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

/** Result of shouldStore: add a new observation, update an existing one, or skip. */
export type StoreAction =
  | { action: 'add' }
  | { action: 'update'; targetId: number }
  | { action: 'skip'; reason: string };

/** Result of shouldConsolidate: merge the cluster, keep as-is, or skip. */
export type ConsolidateAction = 'merge' | 'keep' | 'skip';

/** Result of evaluatePattern: promote, demote, invert, or keep unchanged. */
export type PatternAction = 'promote' | 'demote' | 'invert' | 'keep';

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Observation candidate for shouldStore decisions. */
export interface ObservationCandidate {
  /** Title + content text used for embedding similarity. */
  textToEmbed: string;
  /** Session ID of the new observation. */
  sessionId: string;
  /** Project scope. */
  project: string;
  /** Best match cosine similarity score (0-1). 0 if no match found. */
  bestMatchScore: number;
  /** Session ID of the best matching existing observation. */
  bestMatchSessionId?: string;
  /** Observation ID of the best match. */
  bestMatchObsId?: number;
}

/** Context available to policy decisions. */
export interface PolicyContext {
  sessionId: string;
  project: string;
  hourOfDay: number;
  dayOfWeek: number;
  hoursSinceLastSession: number;
  activeThreadTopic?: string;
  recentIntentType?: string;
}

// ---------------------------------------------------------------------------
// Policy interface
// ---------------------------------------------------------------------------

export interface MemoryPolicy {
  /**
   * Should this observation be stored?
   * Decides based on cosine similarity to existing observations.
   * Returns add (new insert), update (cross-session dup), or skip (same-session dup).
   */
  shouldStore(obs: ObservationCandidate, context: PolicyContext): StoreAction;

  /**
   * Score an artifact for retrieval given negative learning signals.
   * Incorporates unreferenced retrieval count suppression.
   * Returns the final multiplier (>= 0.5 floor).
   */
  scoreForRetrieval(artifactId: number, baseScore: number, context: PolicyContext, db: Database): number;

  /**
   * Should this cluster of observations be consolidated?
   * Decides based on cluster size and average similarity.
   */
  shouldConsolidate(clusterSize: number, avgSimilarity: number): ConsolidateAction;

  /**
   * What confidence threshold for proactive intent injection?
   * Predictions below this threshold are not auto-injected.
   */
  getPredictionThreshold(context: PolicyContext): number;

  /**
   * Evaluate a pattern after feedback signals.
   * Decides promote, demote, invert, or keep based on helpful/harmful counts.
   */
  evaluatePattern(
    helpful: number,
    harmful: number,
    triggered: number,
    verified: number,
    maturity: string,
  ): PatternAction;

  /**
   * Get decay half-life in days for an observation.
   * Uses stability class (transient/standard/stable/permanent) and importance level.
   */
  getHalfLife(category: string, importance: number, stabilityClass: string): number;

  /**
   * Should RIF (retrieval-induced forgetting) be applied to this non-selected candidate?
   * Candidates above the RRF threshold that weren't selected get activation decay.
   */
  shouldSuppressCandidate(rrfScore: number): boolean;
}
