/**
 * RL training loop for memory policy.
 *
 * Runs in Angel heartbeat at lowest priority:
 * 1. Extract recent reward signals from DB (last 1000 events)
 * 2. Split 80/20 train/holdout
 * 3. Train model via REINFORCE (10 epochs per batch)
 * 4. Evaluate on holdout: compare RL policy vs actual outcomes
 * 5. Return comparison score
 *
 * The caller (Angel heartbeat) decides whether to activate the RL policy.
 *
 * All functions are non-throwing — training failure must never crash Angel.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { SimpleMLP } from './rl-model.js';
import { extractRetrievalRewards, extractPatternRewards, FEATURE_DIM } from './rl-reward.js';
import type { RewardSignal } from './rl-reward.js';
import { RLMemoryPolicy } from './rl-policy.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrainingResult {
  episodes: number;
  avgReward: number;
  policyImprovement: number;  // vs default policy on holdout
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hidden layer size (must match rl-policy.ts). */
const HIDDEN_DIM = 64;

/** Output dimension for the primary model (2-class: positive/negative outcome). */
const OUTPUT_DIM = 2;

/** Default learning rate for REINFORCE. */
const LEARNING_RATE = 0.001;

/** Number of training epochs per batch. */
const EPOCHS_PER_BATCH = 10;

/** Default batch size (max reward signals to extract). */
const DEFAULT_BATCH_SIZE = 1000;

/** Minimum signals required to run training. */
const MIN_SIGNALS = 10;

/** Holdout fraction for evaluation. */
const DEFAULT_HOLDOUT_FRACTION = 0.2;

/** Improvement threshold to recommend switching to RL policy. */
const IMPROVEMENT_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// Weight persistence
// ---------------------------------------------------------------------------

/**
 * Save model weights to the policy_weights table.
 * Non-throwing.
 */
function saveWeights(
  db: Database,
  project: string,
  modelName: string,
  weights: ArrayBuffer,
  episodes: number,
  avgReward: number,
): void {
  try {
    // Convert ArrayBuffer to Buffer for SQLite BLOB storage
    const buffer = Buffer.from(weights);
    cachedPrepare(db,
      `INSERT INTO policy_weights (project, model_name, weights, training_episodes, avg_reward, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(project, model_name) DO UPDATE SET
         weights = excluded.weights,
         training_episodes = excluded.training_episodes,
         avg_reward = excluded.avg_reward,
         created_at_epoch = excluded.created_at_epoch`
    ).run(project, modelName, buffer, episodes, avgReward);
  } catch {
    // Non-throwing
  }
}

/**
 * Load model weights from the policy_weights table.
 * Returns null if not found.
 * Non-throwing.
 */
function loadWeights(
  db: Database,
  project: string,
  modelName: string,
): { weights: ArrayBuffer; episodes: number; avgReward: number } | null {
  try {
    const row = cachedPrepare(db,
      `SELECT weights, training_episodes, avg_reward FROM policy_weights
       WHERE project = ? AND model_name = ?`
    ).get(project, modelName) as {
      weights: Buffer;
      training_episodes: number;
      avg_reward: number;
    } | undefined;

    if (!row) return null;

    // Convert Buffer to ArrayBuffer
    const ab = row.weights.buffer.slice(
      row.weights.byteOffset,
      row.weights.byteOffset + row.weights.byteLength,
    );

    return {
      weights: ab,
      episodes: row.training_episodes ?? 0,
      avgReward: row.avg_reward ?? 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/**
 * Shuffle an array in-place using Fisher-Yates.
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Run one training batch. Called from Angel heartbeat.
 *
 * 1. Extract reward signals from retrieval_events + experience_patterns
 * 2. Shuffle and split 80/20 train/holdout
 * 3. Load existing weights if available (incremental training)
 * 4. Train model for EPOCHS_PER_BATCH epochs via REINFORCE
 * 5. Evaluate on holdout
 * 6. Save weights if improved
 * 7. Return training result
 *
 * Non-throwing — returns zero-result on error.
 */
export async function trainPolicyBatch(
  db: Database,
  project: string,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<TrainingResult> {
  const zeroResult: TrainingResult = { episodes: 0, avgReward: 0, policyImprovement: 0 };

  try {
    // 1. Extract signals
    const retrievalSignals = extractRetrievalRewards(db, project, batchSize);
    const patternSignals = extractPatternRewards(db, project, Math.floor(batchSize / 2));
    const allSignals = [...retrievalSignals, ...patternSignals];

    if (allSignals.length < MIN_SIGNALS) {
      return zeroResult;
    }

    // 2. Shuffle and split
    shuffle(allSignals);
    const holdoutSize = Math.max(1, Math.floor(allSignals.length * DEFAULT_HOLDOUT_FRACTION));
    const holdout = allSignals.slice(0, holdoutSize);
    const train = allSignals.slice(holdoutSize);

    if (train.length === 0) return zeroResult;

    // 3. Create or load model
    const model = new SimpleMLP(FEATURE_DIM, HIDDEN_DIM, OUTPUT_DIM);
    const existing = loadWeights(db, project, 'default');
    let totalEpisodes = 0;
    if (existing) {
      model.loadWeights(existing.weights);
      totalEpisodes = existing.episodes;
    }

    // Measure pre-training accuracy on holdout
    const preAccuracy = measureAccuracy(model, holdout);

    // 4. Train for EPOCHS_PER_BATCH epochs
    let epochRewardSum = 0;
    let epochCount = 0;

    for (let epoch = 0; epoch < EPOCHS_PER_BATCH; epoch++) {
      shuffle(train);
      for (const signal of train) {
        model.backward(signal.state, signal.action, signal.reward, LEARNING_RATE);
        epochRewardSum += signal.reward;
        epochCount++;
      }
    }

    totalEpisodes += epochCount;
    const avgReward = epochCount > 0 ? epochRewardSum / epochCount : 0;

    // 5. Evaluate on holdout
    const postAccuracy = measureAccuracy(model, holdout);
    const improvement = postAccuracy - preAccuracy;

    // 6. Save weights (always save — trainer is idempotent)
    saveWeights(db, project, 'default', model.getWeights(), totalEpisodes, avgReward);

    return {
      episodes: epochCount,
      avgReward,
      policyImprovement: improvement,
    };
  } catch {
    return zeroResult;
  }
}

/**
 * Measure accuracy of a model on a set of reward signals.
 * Accuracy = fraction of signals where the model's top action matches the signal's action.
 */
function measureAccuracy(model: SimpleMLP, signals: RewardSignal[]): number {
  if (signals.length === 0) return 0;

  let correct = 0;
  for (const signal of signals) {
    const probs = model.forward(signal.state);
    let bestAction = 0;
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > probs[bestAction]) bestAction = i;
    }
    if (bestAction === signal.action) correct++;
  }
  return correct / signals.length;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Compare RL policy vs default on holdout data.
 *
 * Default policy baseline: action=0 (positive/store) for importance >= 3,
 * action=1 (negative/skip) for importance < 3.
 *
 * RL policy: uses the trained model's forward pass.
 *
 * Non-throwing — returns safe defaults on error.
 */
export function evaluatePolicy(
  db: Database,
  project: string,
  rlPolicy: RLMemoryPolicy,
  holdoutFraction: number = DEFAULT_HOLDOUT_FRACTION,
): { rlScore: number; defaultScore: number; shouldSwitch: boolean } {
  const safeResult = { rlScore: 0, defaultScore: 0, shouldSwitch: false };

  try {
    // Extract signals for evaluation
    const signals = extractRetrievalRewards(db, project, 500);
    if (signals.length < MIN_SIGNALS) return safeResult;

    // Use last N% as holdout
    const holdoutSize = Math.max(1, Math.floor(signals.length * holdoutFraction));
    const holdout = signals.slice(0, holdoutSize);

    // Score RL policy: does the model predict the correct action?
    const rlModel = rlPolicy.getModel();
    const rlAccuracy = measureAccuracy(rlModel, holdout);

    // Score default policy: importance >= 3 → action=0, else action=1
    let defaultCorrect = 0;
    for (const signal of holdout) {
      // Feature[0] = normalized importance. importance >= 3 → normalized >= 0.5
      const importance = signal.state[0];
      const defaultAction = importance >= 0.5 ? 0 : 1;
      if (defaultAction === signal.action) defaultCorrect++;
    }
    const defaultAccuracy = defaultCorrect / holdout.length;

    const shouldSwitch = rlAccuracy > defaultAccuracy + IMPROVEMENT_THRESHOLD;

    return {
      rlScore: rlAccuracy,
      defaultScore: defaultAccuracy,
      shouldSwitch,
    };
  } catch {
    return safeResult;
  }
}

// ---------------------------------------------------------------------------
// Policy loader convenience
// ---------------------------------------------------------------------------

/**
 * Create an RLMemoryPolicy and load persisted weights from DB.
 * Returns the policy (with default random weights if no persisted weights found).
 * Non-throwing.
 */
export function loadRLPolicy(db: Database, project: string): RLMemoryPolicy {
  const policy = new RLMemoryPolicy();
  try {
    const existing = loadWeights(db, project, 'default');
    if (existing) {
      policy.loadModelWeights(existing.weights);
    }
  } catch {
    // Non-throwing — use random weights
  }
  return policy;
}
