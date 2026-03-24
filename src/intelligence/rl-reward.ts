/**
 * Reward signal extraction from existing DB data.
 *
 * Computes feature vectors (~20 dimensions) and reward signals from:
 * - retrieval_events (was_referenced → +1 / -1)
 * - experience_patterns (helpful_count / harmful_count → +1 / -1)
 *
 * Feature vector layout (20 features):
 *   [0]    importance (1-5, normalized 0-1)
 *   [1]    artifact age in days (log-scaled)
 *   [2]    access_count (log-scaled, from observation if linked)
 *   [3]    activation_score
 *   [4]    confidence
 *   [5]    retrieval_score
 *   [6]    novelty_score
 *   [7-10] stability_class one-hot (transient, standard, stable, permanent)
 *   [11-12] hour_of_day sin/cos encoded
 *   [13-14] day_of_week sin/cos encoded
 *   [15]   hours_since_last_session (log-scaled)
 *   [16-19] artifact_type one-hot (top 4: observation, learning, decision, hot_file)
 *
 * All functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RewardSignal {
  state: Float32Array;    // feature vector (~20 features)
  action: number;         // action index (0 = positive outcome, 1 = negative outcome)
  reward: number;         // +1 or -1
  timestamp: number;      // epoch seconds
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Feature vector dimensionality. */
export const FEATURE_DIM = 20;

/** Stability class indices for one-hot encoding. */
const STABILITY_CLASSES: Record<string, number> = {
  transient: 0,
  standard: 1,
  stable: 2,
  permanent: 3,
};

/** Top 4 artifact types for one-hot encoding. */
const ARTIFACT_TYPES: Record<string, number> = {
  observation: 0,
  learning: 1,
  decision: 2,
  hot_file: 3,
};

// ---------------------------------------------------------------------------
// Feature extraction helpers
// ---------------------------------------------------------------------------

/** Log-scale a non-negative value: log(1 + x). */
function logScale(x: number): number {
  return Math.log1p(Math.max(0, x));
}

/** Normalize importance from [1,5] to [0,1]. */
function normalizeImportance(importance: number): number {
  return Math.max(0, Math.min(1, (importance - 1) / 4));
}

/** Sin/cos encode a cyclical value. */
function cyclicalEncode(value: number, period: number): [number, number] {
  const angle = (2 * Math.PI * value) / period;
  return [Math.sin(angle), Math.cos(angle)];
}

/**
 * Build a feature vector from an artifact row + context.
 * Returns a Float32Array of length FEATURE_DIM.
 */
export function buildFeatureVector(artifact: {
  importance: number;
  timestamp_epoch: number;
  access_count?: number;
  activation_score?: number;
  confidence?: number;
  retrieval_score?: number;
  novelty_score?: number;
  stability_class?: string;
  artifact_type?: string;
}, context: {
  now?: number;
  hourOfDay?: number;
  dayOfWeek?: number;
  hoursSinceLastSession?: number;
}): Float32Array {
  const features = new Float32Array(FEATURE_DIM);
  const now = context.now ?? Math.floor(Date.now() / 1000);

  // [0] importance normalized
  features[0] = normalizeImportance(artifact.importance ?? 3);

  // [1] age in days, log-scaled
  const ageDays = Math.max(0, (now - (artifact.timestamp_epoch ?? now)) / 86400);
  features[1] = logScale(ageDays);

  // [2] access_count, log-scaled
  features[2] = logScale(artifact.access_count ?? 0);

  // [3] activation_score (0-2 typical range, use as-is clamped)
  features[3] = Math.max(0, Math.min(2, artifact.activation_score ?? 1.0));

  // [4] confidence (0-1)
  features[4] = Math.max(0, Math.min(1, artifact.confidence ?? 1.0));

  // [5] retrieval_score (0.1-3.0 typical, normalize to ~0-1)
  features[5] = Math.max(0, Math.min(1, (artifact.retrieval_score ?? 1.0) / 3.0));

  // [6] novelty_score (0-1)
  features[6] = Math.max(0, Math.min(1, artifact.novelty_score ?? 0.5));

  // [7-10] stability_class one-hot
  const stabIdx = STABILITY_CLASSES[artifact.stability_class ?? 'standard'] ?? 1;
  features[7 + stabIdx] = 1.0;

  // [11-12] hour_of_day sin/cos
  const [hSin, hCos] = cyclicalEncode(context.hourOfDay ?? 12, 24);
  features[11] = hSin;
  features[12] = hCos;

  // [13-14] day_of_week sin/cos
  const [dSin, dCos] = cyclicalEncode(context.dayOfWeek ?? 3, 7);
  features[13] = dSin;
  features[14] = dCos;

  // [15] hours_since_last_session, log-scaled
  features[15] = logScale(context.hoursSinceLastSession ?? 0);

  // [16-19] artifact_type one-hot (top 4)
  const typeIdx = ARTIFACT_TYPES[artifact.artifact_type ?? ''];
  if (typeIdx !== undefined) {
    features[16 + typeIdx] = 1.0;
  }

  return features;
}

// ---------------------------------------------------------------------------
// Retrieval reward extraction
// ---------------------------------------------------------------------------

interface RetrievalRow {
  artifact_id: number;
  was_referenced: number;
  timestamp_epoch: number;
  importance: number;
  retrieval_score: number;
  activation_score: number | null;
  confidence: number | null;
  novelty_score: number | null;
  artifact_type: string;
  art_timestamp: number;
}

/**
 * Extract reward signals from retrieval_events.
 * was_referenced=1 → action=0, reward=+1 (positive outcome)
 * was_referenced=0 → action=1, reward=-1 (negative outcome)
 *
 * Non-throwing — returns [] on error.
 */
export function extractRetrievalRewards(
  db: Database,
  project: string,
  limit: number = 1000,
): RewardSignal[] {
  try {
    const rows = cachedPrepare(db,
      `SELECT
         re.artifact_id,
         re.was_referenced,
         re.timestamp_epoch,
         a.importance,
         a.retrieval_score,
         a.activation_score,
         a.confidence,
         a.novelty_score,
         a.artifact_type,
         a.timestamp_epoch AS art_timestamp
       FROM retrieval_events re
       JOIN artifacts a ON a.id = re.artifact_id
       WHERE a.project = ? AND re.was_referenced IS NOT NULL
       ORDER BY re.timestamp_epoch DESC
       LIMIT ?`
    ).all(project, limit) as RetrievalRow[];

    // Get last session time for context
    const lastSessionRow = cachedPrepare(db,
      `SELECT MAX(created_at_epoch) AS last_epoch FROM sessions WHERE project = ?`
    ).get(project) as { last_epoch: number | null } | undefined;
    const lastSessionEpoch = lastSessionRow?.last_epoch ?? 0;

    const signals: RewardSignal[] = [];

    for (const row of rows) {
      const eventDate = new Date(row.timestamp_epoch * 1000);
      const hoursSinceLastSession = lastSessionEpoch > 0
        ? Math.max(0, (row.timestamp_epoch - lastSessionEpoch) / 3600)
        : 0;

      const state = buildFeatureVector(
        {
          importance: row.importance ?? 3,
          timestamp_epoch: row.art_timestamp ?? row.timestamp_epoch,
          activation_score: row.activation_score ?? 1.0,
          confidence: row.confidence ?? 1.0,
          retrieval_score: row.retrieval_score ?? 1.0,
          novelty_score: row.novelty_score ?? 0.5,
          artifact_type: row.artifact_type ?? 'observation',
        },
        {
          now: row.timestamp_epoch,
          hourOfDay: eventDate.getHours(),
          dayOfWeek: eventDate.getDay(),
          hoursSinceLastSession,
        },
      );

      signals.push({
        state,
        action: row.was_referenced === 1 ? 0 : 1,
        reward: row.was_referenced === 1 ? 1 : -1,
        timestamp: row.timestamp_epoch,
      });
    }

    return signals;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pattern reward extraction
// ---------------------------------------------------------------------------

interface PatternRow {
  id: string;
  helpful_count: number;
  harmful_count: number;
  score: number;
  times_triggered: number;
  created_at_epoch: number;
  confidence: number | null;
  maturity: string | null;
}

/**
 * Extract reward signals from experience_patterns feedback.
 * Net helpful (helpful > harmful) → action=0, reward=+1
 * Net harmful (harmful >= helpful) → action=1, reward=-1
 *
 * Non-throwing — returns [] on error.
 */
export function extractPatternRewards(
  db: Database,
  project: string,
  limit: number = 500,
): RewardSignal[] {
  try {
    const rows = cachedPrepare(db,
      `SELECT id, helpful_count, harmful_count, score, times_triggered,
              created_at_epoch, confidence, maturity
       FROM experience_patterns
       WHERE source_project = ?
         AND (helpful_count > 0 OR harmful_count > 0)
       ORDER BY created_at_epoch DESC
       LIMIT ?`
    ).all(project, limit) as PatternRow[];

    const now = Math.floor(Date.now() / 1000);
    const signals: RewardSignal[] = [];

    for (const row of rows) {
      const netHelpful = row.helpful_count - row.harmful_count;

      // Build a simplified feature vector for patterns:
      // Use score as proxy for importance, age, trigger count as access_count
      const state = buildFeatureVector(
        {
          importance: Math.max(1, Math.min(5, row.score)),
          timestamp_epoch: row.created_at_epoch ?? now,
          access_count: row.times_triggered ?? 0,
          activation_score: 1.0,
          confidence: row.confidence ?? 0.5,
          retrieval_score: 1.0,
          novelty_score: 0.5,
          stability_class: row.maturity === 'proven' ? 'stable' : 'standard',
          artifact_type: 'learning', // patterns are most like learnings
        },
        {
          now,
          hourOfDay: new Date(row.created_at_epoch * 1000).getHours(),
          dayOfWeek: new Date(row.created_at_epoch * 1000).getDay(),
          hoursSinceLastSession: 0,
        },
      );

      signals.push({
        state,
        action: netHelpful > 0 ? 0 : 1,
        reward: netHelpful > 0 ? 1 : -1,
        timestamp: row.created_at_epoch,
      });
    }

    return signals;
  } catch {
    return [];
  }
}
