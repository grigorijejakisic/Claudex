/**
 * RL-trained memory policy.
 *
 * Uses SimpleMLP to make policy decisions by encoding the current situation
 * as a feature vector, running a forward pass, and returning the action
 * with the highest probability.
 *
 * Implements the canonical MemoryPolicy interface from memory-policy.ts.
 *
 * The RL policy is NOT activated by default — it must prove itself vs the
 * default policy on holdout data before the caller switches to it.
 *
 * All methods are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { SimpleMLP } from './rl-model.js';
import { buildFeatureVector, FEATURE_DIM } from './rl-reward.js';
import type {
  MemoryPolicy,
  ObservationCandidate,
  PolicyContext,
  StoreAction,
  ConsolidateAction,
  PatternAction,
} from './memory-policy.js';

// ---------------------------------------------------------------------------
// Action space definitions
// ---------------------------------------------------------------------------

/** shouldStore: 0=add, 1=skip */
const STORE_OUTPUT_DIM = 2;

/** scoreForRetrieval: outputs a single score (we use 3 bins: low/medium/high) */
const RETRIEVAL_OUTPUT_DIM = 3;

/** shouldConsolidate: 0=merge, 1=keep, 2=skip */
const CONSOLIDATE_OUTPUT_DIM = 3;

/** getPredictionThreshold: 0=low(0.3), 1=medium(0.4), 2=high(0.5) */
const THRESHOLD_OUTPUT_DIM = 3;

/** evaluatePattern: 0=promote, 1=demote, 2=invert, 3=keep */
const PATTERN_OUTPUT_DIM = 4;

/** shouldSuppressCandidate: 0=keep, 1=suppress */
const SUPPRESS_OUTPUT_DIM = 2;

// ---------------------------------------------------------------------------
// RLMemoryPolicy
// ---------------------------------------------------------------------------

/** Hidden layer size for all sub-models. */
const HIDDEN_DIM = 64;

export class RLMemoryPolicy implements MemoryPolicy {
  /** Primary model used for store/retrieval decisions. */
  private model: SimpleMLP;

  /** Separate lightweight models per decision type. */
  private storeModel: SimpleMLP;
  private retrievalModel: SimpleMLP;
  private consolidateModel: SimpleMLP;
  private thresholdModel: SimpleMLP;
  private patternModel: SimpleMLP;
  private suppressModel: SimpleMLP;

  constructor() {
    // Main model (same dimensions as training — 2-class store/retrieve)
    this.model = new SimpleMLP(FEATURE_DIM, HIDDEN_DIM, STORE_OUTPUT_DIM);

    // Per-decision sub-models
    this.storeModel = new SimpleMLP(FEATURE_DIM, HIDDEN_DIM, STORE_OUTPUT_DIM);
    this.retrievalModel = new SimpleMLP(FEATURE_DIM, HIDDEN_DIM, RETRIEVAL_OUTPUT_DIM);
    this.consolidateModel = new SimpleMLP(FEATURE_DIM, HIDDEN_DIM, CONSOLIDATE_OUTPUT_DIM);
    this.thresholdModel = new SimpleMLP(FEATURE_DIM, HIDDEN_DIM, THRESHOLD_OUTPUT_DIM);
    this.patternModel = new SimpleMLP(FEATURE_DIM, HIDDEN_DIM, PATTERN_OUTPUT_DIM);
    this.suppressModel = new SimpleMLP(FEATURE_DIM, HIDDEN_DIM, SUPPRESS_OUTPUT_DIM);
  }

  /** Get the primary model (for training / weight persistence). */
  getModel(): SimpleMLP {
    return this.model;
  }

  /** Load weights into the primary model. */
  loadModelWeights(buffer: ArrayBuffer): void {
    this.model.loadWeights(buffer);
    // Also sync to store and retrieval sub-models (they share the same architecture)
    this.storeModel.loadWeights(buffer);
  }

  /**
   * Should this observation be stored?
   * Encodes the observation as features, runs forward pass on store model.
   * action=0 → add, action=1 → skip.
   */
  shouldStore(obs: ObservationCandidate, context: PolicyContext): StoreAction {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: 3, // default importance for new observations
          timestamp_epoch: now,
          stability_class: 'standard',
          artifact_type: 'observation',
          confidence: obs.bestMatchScore,
        },
        {
          now,
          hourOfDay: context.hourOfDay,
          dayOfWeek: context.dayOfWeek,
          hoursSinceLastSession: context.hoursSinceLastSession,
        },
      );

      const probs = this.storeModel.forward(features);
      const action = probs[0] >= probs[1] ? 0 : 1;

      if (action === 0) {
        return { action: 'add' };
      }
      return { action: 'skip', reason: 'RL policy: low predicted value' };
    } catch {
      return { action: 'add' }; // safe default: always store
    }
  }

  /**
   * Score an artifact for retrieval.
   * Matches canonical signature: (artifactId, baseScore, context, db).
   * Returns a score in [0.5, baseScore] range (matching DefaultMemoryPolicy floor).
   * 3 bins: action=0 → 0.3 (low), action=1 → 0.6 (medium), action=2 → 1.0 (high).
   */
  scoreForRetrieval(artifactId: number, baseScore: number, context: PolicyContext, _db: Database): number {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: 3, // neutral importance as default
          timestamp_epoch: now,
          retrieval_score: baseScore,
        },
        {
          now,
          hourOfDay: context.hourOfDay,
          dayOfWeek: context.dayOfWeek,
          hoursSinceLastSession: context.hoursSinceLastSession,
        },
      );

      const probs = this.retrievalModel.forward(features);
      // Weighted sum of bin scores: 0.3, 0.6, 1.0
      const rlScore = probs[0] * 0.3 + probs[1] * 0.6 + probs[2] * 1.0;
      // Apply as multiplier to baseScore, with 0.5 floor (matching DefaultMemoryPolicy)
      return Math.max(0.5, baseScore * rlScore);
    } catch {
      return baseScore; // neutral default: pass through base score
    }
  }

  /**
   * Should this cluster be consolidated?
   * Matches canonical signature: (clusterSize, avgSimilarity).
   * action=0 → merge, action=1 → keep, action=2 → skip.
   */
  shouldConsolidate(clusterSize: number, avgSimilarity: number): ConsolidateAction {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: Math.min(5, clusterSize), // encode cluster size as importance proxy
          timestamp_epoch: now,
          access_count: clusterSize,
          confidence: avgSimilarity,
        },
        { now },
      );

      const probs = this.consolidateModel.forward(features);
      const actions: ConsolidateAction[] = ['merge', 'keep', 'skip'];
      let maxIdx = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[maxIdx]) maxIdx = i;
      }
      return actions[maxIdx];
    } catch {
      return 'keep'; // safe default
    }
  }

  /**
   * Prediction threshold for proactive injection.
   * action=0 → 0.3, action=1 → 0.4, action=2 → 0.5.
   */
  getPredictionThreshold(context: PolicyContext): number {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: 3,
          timestamp_epoch: now,
        },
        {
          now,
          hourOfDay: context.hourOfDay,
          dayOfWeek: context.dayOfWeek,
          hoursSinceLastSession: context.hoursSinceLastSession,
        },
      );

      const probs = this.thresholdModel.forward(features);
      const thresholds = [0.3, 0.4, 0.5];
      let maxIdx = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[maxIdx]) maxIdx = i;
      }
      return thresholds[maxIdx];
    } catch {
      return 0.4; // default threshold
    }
  }

  /**
   * Evaluate pattern feedback.
   * Matches canonical signature: (helpful, harmful, triggered, verified, maturity).
   * action=0 → promote, action=1 → demote, action=2 → invert, action=3 → keep.
   */
  evaluatePattern(
    helpful: number,
    harmful: number,
    triggered: number,
    verified: number,
    maturity: string,
  ): PatternAction {
    try {
      const now = Math.floor(Date.now() / 1000);
      const total = helpful + harmful;
      const helpfulRatio = total > 0 ? helpful / total : 0.5;
      const features = buildFeatureVector(
        {
          importance: Math.max(1, Math.min(5, Math.round(helpfulRatio * 5))),
          timestamp_epoch: now,
          access_count: triggered,
          confidence: helpfulRatio,
          activation_score: verified,
          stability_class: maturity === 'proven' ? 'stable' : maturity === 'established' ? 'standard' : 'transient',
        },
        { now },
      );

      const probs = this.patternModel.forward(features);
      const actions: PatternAction[] = ['promote', 'demote', 'invert', 'keep'];
      let maxIdx = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[maxIdx]) maxIdx = i;
      }
      return actions[maxIdx];
    } catch {
      return 'keep'; // safe default
    }
  }

  /**
   * Half-life for observation decay.
   * Uses category + importance + stability as features, maps to discrete buckets.
   * Returns DAYS (not seconds) — callers use this in Math.pow(2, -ageDays / halfLife).
   */
  getHalfLife(category: string, importance: number, stabilityClass: string): number {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance,
          timestamp_epoch: now,
          stability_class: stabilityClass,
        },
        { now },
      );

      // Use the primary model as a rough proxy. Higher positive probability → longer half-life.
      const probs = this.model.forward(features);
      // Map probability to half-life range: [1 day, 90 days]
      const baseDays = 1 + probs[0] * 89;
      return baseDays; // return days, NOT seconds
    } catch {
      // Default half-lives by stability class (in DAYS)
      const defaults: Record<string, number> = {
        transient: 1,     // 1 day
        standard: 7,      // 7 days
        stable: 30,       // 30 days
        permanent: 90,    // 90 days
      };
      return defaults[stabilityClass] ?? 7;
    }
  }

  /**
   * Should this candidate be suppressed via RIF?
   * Matches canonical signature: (rrfScore).
   * action=0 → keep, action=1 → suppress.
   */
  shouldSuppressCandidate(rrfScore: number): boolean {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: 3,
          timestamp_epoch: now,
          retrieval_score: rrfScore, // use RRF score as retrieval_score feature
        },
        { now },
      );

      const probs = this.suppressModel.forward(features);
      return probs[1] > probs[0]; // suppress if action=1 is more probable
    } catch {
      return false; // safe default: don't suppress
    }
  }
}
