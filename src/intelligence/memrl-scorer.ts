/**
 * MemRL Memory Scorer — Q-value reinforcement learning for artifact retrieval.
 *
 * Local Intelligence Amplifier Phase 2: Learn which memories actually help.
 *
 * Each artifact gets a Q-value (utility score, default 0.5):
 * - Retrieved + session succeeds (no corrections) → Q-value increases
 * - Retrieved + correction follows → Q-value decreases
 * - Bellman propagation: value spreads to semantically linked artifacts
 * - Temporal decay: unused artifacts fade 1% per day
 *
 * Integration: hybrid-retrieval.ts uses Q-values as a scoring factor.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Q-value learning rate for success */
const ALPHA_SUCCESS = 0.1;
/** Q-value learning rate for failure (higher = learn from failures faster) */
const ALPHA_FAILURE = 0.2;
/** Bellman discount factor for propagation to linked artifacts */
const GAMMA = 0.7;
/** Daily temporal decay rate (1% per day) */
const DAILY_DECAY = 0.99;
/** Maximum Q-value */
const Q_MAX = 1.0;
/** Minimum Q-value (never fully suppress) */
const Q_MIN = 0.05;

// ---------------------------------------------------------------------------
// Core Q-value operations
// ---------------------------------------------------------------------------

/**
 * Record a retrieval event and increment retrieval_count.
 * Called when an artifact is materialized into a session's context.
 */
export function recordRetrieval(db: Database, artifactId: number): void {
  try {
    cachedPrepare(db,
      `UPDATE artifacts SET retrieval_count = COALESCE(retrieval_count, 0) + 1 WHERE id = ?`
    ).run(artifactId);
  } catch { /* non-throwing */ }
}

/**
 * Record a successful retrieval outcome.
 * Called when a session completes WITHOUT corrections after this artifact was injected.
 */
export function recordSuccess(db: Database, artifactId: number): void {
  try {
    const row = cachedPrepare(db,
      `SELECT q_value FROM artifacts WHERE id = ?`
    ).get(artifactId) as { q_value: number | null } | undefined;

    const currentQ = row?.q_value ?? 0.5;
    const newQ = Math.min(Q_MAX, currentQ + ALPHA_SUCCESS * (Q_MAX - currentQ));

    cachedPrepare(db,
      `UPDATE artifacts SET q_value = ?, success_count = COALESCE(success_count, 0) + 1 WHERE id = ?`
    ).run(newQ, artifactId);
  } catch { /* non-throwing */ }
}

/**
 * Record a failed retrieval outcome.
 * Called when a correction follows after this artifact was injected.
 */
export function recordFailure(db: Database, artifactId: number): void {
  try {
    const row = cachedPrepare(db,
      `SELECT q_value FROM artifacts WHERE id = ?`
    ).get(artifactId) as { q_value: number | null } | undefined;

    const currentQ = row?.q_value ?? 0.5;
    const newQ = Math.max(Q_MIN, currentQ - ALPHA_FAILURE * currentQ);

    cachedPrepare(db,
      `UPDATE artifacts SET q_value = ? WHERE id = ?`
    ).run(newQ, artifactId);
  } catch { /* non-throwing */ }
}

/** Link types that carry meaningful causal signal for Q-value propagation. */
const PROPAGATION_LINK_TYPES = new Set(['caused_by', 'supports', 'supersedes']);

/**
 * Bellman propagation: spread Q-value rewards to linked artifacts.
 * High-Q artifacts boost their neighbors; low-Q artifacts suppress theirs.
 *
 * Only propagates through meaningful link types (caused_by, supports, supersedes).
 * 'related' links are too uniform — propagating through them dilutes signal.
 * Falls back to direct neighbors if no typed links exist but limits discount.
 */
export function propagateQValues(db: Database, artifactId: number): void {
  try {
    const source = cachedPrepare(db,
      `SELECT q_value FROM artifacts WHERE id = ?`
    ).get(artifactId) as { q_value: number | null } | undefined;

    if (!source) return;
    const sourceQ = source.q_value ?? 0.5;

    // Find linked artifacts — prefer typed links (causal signal)
    const typedLinks = cachedPrepare(db,
      `SELECT target_id, link_type FROM artifact_links
       WHERE source_id = ? AND link_type IN ('caused_by', 'supports', 'supersedes')
       LIMIT 10`
    ).all(artifactId) as Array<{ target_id: number; link_type: string }>;

    // If no typed links, use 'related' links with reduced discount (exclude contradicts)
    const links = typedLinks.length > 0 ? typedLinks : cachedPrepare(db,
      `SELECT target_id, link_type FROM artifact_links
       WHERE source_id = ? AND link_type != 'contradicts'
       LIMIT 5`
    ).all(artifactId) as Array<{ target_id: number; link_type: string }>;

    for (const link of links) {
      const target = cachedPrepare(db,
        `SELECT q_value FROM artifacts WHERE id = ?`
      ).get(link.target_id) as { q_value: number | null } | undefined;

      if (!target) continue;
      const targetQ = target.q_value ?? 0.5;

      // Typed links get full discount, 'related' links get half
      const effectiveGamma = PROPAGATION_LINK_TYPES.has(link.link_type) ? GAMMA : GAMMA * 0.3;

      // Bellman update: target Q-value moves toward discounted source Q-value
      const bellmanTarget = effectiveGamma * sourceQ;
      const newQ = targetQ + ALPHA_SUCCESS * (bellmanTarget - targetQ);
      const clampedQ = Math.max(Q_MIN, Math.min(Q_MAX, newQ));

      cachedPrepare(db,
        `UPDATE artifacts SET q_value = ? WHERE id = ?`
      ).run(clampedQ, link.target_id);
    }
  } catch { /* non-throwing */ }
}

/**
 * Apply temporal decay to all artifact Q-values.
 * Unused artifacts fade toward Q_MIN at 1% per day.
 * Called once per Angel heartbeat cycle.
 */
export function applyTemporalDecay(db: Database, daysSinceLastDecay: number = 1): void {
  try {
    const decayFactor = Math.pow(DAILY_DECAY, daysSinceLastDecay);
    // Only decay artifacts that haven't been retrieved recently (7+ days)
    cachedPrepare(db,
      `UPDATE artifacts SET q_value = MAX(?, q_value * ?)
       WHERE q_value > ? AND (retrieval_count = 0 OR timestamp_epoch < unixepoch() - 604800)`
    ).run(Q_MIN, decayFactor, Q_MIN);
  } catch { /* non-throwing */ }
}

/**
 * Get the Q-value retrieval multiplier for an artifact.
 * Used by hybrid-retrieval.ts to rerank results.
 * Returns 0.05-1.0 (Q_MIN to Q_MAX).
 */
export function getQValueMultiplier(db: Database, artifactId: number): number {
  try {
    const row = cachedPrepare(db,
      `SELECT q_value FROM artifacts WHERE id = ?`
    ).get(artifactId) as { q_value: number | null } | undefined;
    return row?.q_value ?? 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * Process all retrieval outcomes for a completed session.
 * Called from stop.ts after session feedback is processed.
 */
export function processSessionQValues(
  db: Database,
  sessionId: string,
  hadCorrections: boolean,
): void {
  try {
    // Find all artifacts that were retrieved this session
    const retrieved = cachedPrepare(db,
      `SELECT DISTINCT artifact_id FROM retrieval_events WHERE session_id = ?`
    ).all(sessionId) as Array<{ artifact_id: number }>;

    for (const { artifact_id } of retrieved) {
      if (hadCorrections) {
        recordFailure(db, artifact_id);
      } else {
        recordSuccess(db, artifact_id);
      }
      // Propagate Q-values through the graph
      propagateQValues(db, artifact_id);
    }
  } catch { /* non-throwing */ }
}
