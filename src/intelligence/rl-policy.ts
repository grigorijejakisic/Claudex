/**
 * RL-trained memory policy.
 *
 * Uses SimpleMLP to make policy decisions by encoding the current situation
 * as a feature vector, running a forward pass, and returning the action
 * with the highest probability.
 *
 * Implements the MemoryPolicy interface (defined locally since the canonical
 * interface is being created by another worker — shapes are compatible).
 *
 * The RL policy is NOT activated by default — it must prove itself vs the
 * default policy on holdout data before the caller switches to it.
 *
 * All methods are non-throwing with safe defaults.
 */

import { SimpleMLP } from './rl-model.js';
import { buildFeatureVector, FEATURE_DIM } from './rl-reward.js';

// ---------------------------------------------------------------------------
// Local MemoryPolicy interface (compatible with memory-policy.ts when it exists)
// ---------------------------------------------------------------------------

export interface ObservationCandidate {
  title: string;
  content: string;
  category: string;
  importance: number;
  tool_name: string;
}

export interface PolicyContext {
  sessionId: string;
  project: string;
  hourOfDay: number;
  dayOfWeek: number;
  hoursSinceLastSession: number;
  activeThreadTopic?: string;
  recentIntentType?: string;
}

export type StoreAction =
  | { action: 'add' }
  | { action: 'update'; targetId: number }
  | { action: 'skip'; reason: string };

export type ConsolidateAction = 'merge' | 'keep' | 'skip';
export type PatternAction = 'promote' | 'demote' | 'invert' | 'keep';

export interface ArtifactForPolicy {
  id: number;
  importance: number;
  timestamp_epoch: number;
  activation_score?: number;
  confidence?: number;
  retrieval_score?: number;
  novelty_score?: number;
  stability_class?: string;
  artifact_type?: string;
  access_count?: number;
}

export interface ObservationCluster {
  ids: number[];
  category: string;
  averageImportance: number;
  size: number;
}

export interface PatternFeedback {
  patternId: string;
  helpfulCount: number;
  harmfulCount: number;
  timesTriggered: number;
  score: number;
}

export interface MemoryPolicy {
  shouldStore(obs: ObservationCandidate, context: PolicyContext): StoreAction;
  scoreForRetrieval(artifact: ArtifactForPolicy, query: string, context: PolicyContext): number;
  shouldConsolidate(cluster: ObservationCluster): ConsolidateAction;
  getPredictionThreshold(context: PolicyContext): number;
  evaluatePattern(pattern: PatternFeedback): PatternAction;
  getHalfLife(category: string, importance: number, stabilityClass: string): number;
  shouldSuppressCandidate(artifact: ArtifactForPolicy, rrfScore: number): boolean;
}

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
          importance: obs.importance,
          timestamp_epoch: now,
          stability_class: 'standard',
          artifact_type: 'observation',
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
   * Returns a score in [0, 1] range.
   * 3 bins: action=0 → 0.3 (low), action=1 → 0.6 (medium), action=2 → 1.0 (high).
   */
  scoreForRetrieval(artifact: ArtifactForPolicy, _query: string, context: PolicyContext): number {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: artifact.importance,
          timestamp_epoch: artifact.timestamp_epoch,
          access_count: artifact.access_count,
          activation_score: artifact.activation_score,
          confidence: artifact.confidence,
          retrieval_score: artifact.retrieval_score,
          novelty_score: artifact.novelty_score,
          stability_class: artifact.stability_class,
          artifact_type: artifact.artifact_type,
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
      return probs[0] * 0.3 + probs[1] * 0.6 + probs[2] * 1.0;
    } catch {
      return 0.5; // neutral default
    }
  }

  /**
   * Should this cluster be consolidated?
   * action=0 → merge, action=1 → keep, action=2 → skip.
   */
  shouldConsolidate(cluster: ObservationCluster): ConsolidateAction {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: cluster.averageImportance,
          timestamp_epoch: now,
          access_count: cluster.size,
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
   * action=0 → promote, action=1 → demote, action=2 → invert, action=3 → keep.
   */
  evaluatePattern(pattern: PatternFeedback): PatternAction {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: Math.max(1, Math.min(5, pattern.score)),
          timestamp_epoch: now,
          access_count: pattern.timesTriggered,
          confidence: pattern.helpfulCount / Math.max(1, pattern.helpfulCount + pattern.harmfulCount),
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
      return baseDays * 86400; // convert to seconds
    } catch {
      // Default half-lives by stability class
      const defaults: Record<string, number> = {
        transient: 86400,    // 1 day
        standard: 604800,    // 7 days
        stable: 2592000,     // 30 days
        permanent: 7776000,  // 90 days
      };
      return defaults[stabilityClass] ?? 604800;
    }
  }

  /**
   * Should this candidate be suppressed via RIF?
   * action=0 → keep, action=1 → suppress.
   */
  shouldSuppressCandidate(artifact: ArtifactForPolicy, rrfScore: number): boolean {
    try {
      const now = Math.floor(Date.now() / 1000);
      const features = buildFeatureVector(
        {
          importance: artifact.importance,
          timestamp_epoch: artifact.timestamp_epoch,
          activation_score: artifact.activation_score,
          confidence: artifact.confidence,
          retrieval_score: rrfScore, // use RRF score as retrieval_score feature
          novelty_score: artifact.novelty_score,
          stability_class: artifact.stability_class,
          artifact_type: artifact.artifact_type,
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
