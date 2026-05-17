/**
 * Checkpoint tracking lifecycle — thresholds, observation counts, post-compact flags.
 * Plain functions with `db: Database` as first param.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { hasFields } from '../shared/db-utils.js';

export interface CheckpointTrackingRow {
  session_id: string;
  last_checkpoint_epoch_ms: number | null;
  thresholds_hit: number[];
  observation_count: number;
  post_compact_pending: number;
  updated_at_epoch_ms: number;
}

interface RawCheckpointTrackingRow {
  session_id: string;
  last_checkpoint_epoch_ms: number | null;
  thresholds_hit: string;
  observation_count: number;
  post_compact_pending: number;
  updated_at_epoch_ms: number;
}

/**
 * Retrieves checkpoint tracking state for a session, parsing thresholds_hit JSON.
 */
export function getCheckpointTracking(
  db: Database,
  sessionId: string
): CheckpointTrackingRow | undefined {
  const row = cachedPrepare(db, 'SELECT * FROM checkpoint_tracking WHERE session_id = ?')
    .get(sessionId);

  if (!row || !hasFields(row, ['session_id', 'thresholds_hit', 'observation_count', 'post_compact_pending', 'updated_at_epoch_ms'])) {
    return undefined;
  }

  const raw = row as RawCheckpointTrackingRow;

  let thresholds: number[];
  try {
    const parsed = JSON.parse(raw.thresholds_hit);
    thresholds = Array.isArray(parsed) ? parsed : [];
  } catch {
    thresholds = [];
  }

  return {
    ...raw,
    thresholds_hit: thresholds,
  };
}

/**
 * Sets the post_compact_pending flag for a session.
 * Creates the row if it does not exist.
 */
export function markPostCompactPending(
  db: Database,
  sessionId: string
): void {
  cachedPrepare(db,
    `INSERT INTO checkpoint_tracking (session_id, post_compact_pending, updated_at_epoch_ms)
     VALUES (?, 1, unixepoch() * 1000)
     ON CONFLICT(session_id) DO UPDATE SET
       post_compact_pending = 1,
       updated_at_epoch_ms = unixepoch() * 1000`
  ).run(sessionId);
}

/**
 * Clears the post_compact_pending flag for a session.
 */
export function clearPostCompactPending(
  db: Database,
  sessionId: string
): void {
  cachedPrepare(db,
    `UPDATE checkpoint_tracking SET post_compact_pending = 0, updated_at_epoch = unixepoch()
     WHERE session_id = ?`
  ).run(sessionId);
}

/**
 * Appends a threshold value to the thresholds_hit JSON array for a session.
 * Creates the row if it does not exist.
 */
export function recordThresholdHit(
  db: Database,
  sessionId: string,
  threshold: number
): void {
  const doRecordThreshold = db.transaction(() => {
    const existing = cachedPrepare(db,
      'SELECT thresholds_hit FROM checkpoint_tracking WHERE session_id = ?'
    ).get(sessionId) as { thresholds_hit: string } | undefined;

    if (existing) {
      const thresholds: number[] = JSON.parse(existing.thresholds_hit);
      thresholds.push(threshold);
      cachedPrepare(db,
        `UPDATE checkpoint_tracking
         SET thresholds_hit = ?, updated_at_epoch = unixepoch()
         WHERE session_id = ?`
      ).run(JSON.stringify(thresholds), sessionId);
    } else {
      cachedPrepare(db,
        `INSERT INTO checkpoint_tracking (session_id, thresholds_hit, updated_at_epoch)
         VALUES (?, ?, unixepoch())`
      ).run(sessionId, JSON.stringify([threshold]));
    }
  });

  doRecordThreshold();
}
