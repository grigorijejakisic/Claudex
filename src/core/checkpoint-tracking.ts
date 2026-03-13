/**
 * Checkpoint tracking lifecycle — thresholds, observation counts, post-compact flags.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 4.2 (checkpoint_tracking table)
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export interface CheckpointTrackingRow {
  session_id: string;
  last_checkpoint_epoch: number | null;
  thresholds_hit: number[];
  observation_count: number;
  post_compact_pending: number;
  updated_at_epoch: number;
}

interface RawCheckpointTrackingRow {
  session_id: string;
  last_checkpoint_epoch: number | null;
  thresholds_hit: string;
  observation_count: number;
  post_compact_pending: number;
  updated_at_epoch: number;
}

/**
 * Retrieves checkpoint tracking state for a session, parsing thresholds_hit JSON.
 */
export function getCheckpointTracking(
  db: Database,
  sessionId: string
): CheckpointTrackingRow | undefined {
  const row = cachedPrepare(db, 'SELECT * FROM checkpoint_tracking WHERE session_id = ?')
    .get(sessionId) as RawCheckpointTrackingRow | undefined;

  if (!row) return undefined;

  return {
    ...row,
    thresholds_hit: JSON.parse(row.thresholds_hit),
  };
}

/**
 * Creates or replaces checkpoint tracking state for a session.
 */
export function updateCheckpointTracking(
  db: Database,
  sessionId: string,
  observationCount: number
): void {
  cachedPrepare(db,
    `INSERT INTO checkpoint_tracking (session_id, observation_count, last_checkpoint_epoch, updated_at_epoch)
     VALUES (?, ?, unixepoch(), unixepoch())
     ON CONFLICT(session_id) DO UPDATE SET
       observation_count = ?,
       last_checkpoint_epoch = unixepoch(),
       updated_at_epoch = unixepoch()`
  ).run(sessionId, observationCount, observationCount);
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
    `INSERT INTO checkpoint_tracking (session_id, post_compact_pending, updated_at_epoch)
     VALUES (?, 1, unixepoch())
     ON CONFLICT(session_id) DO UPDATE SET
       post_compact_pending = 1,
       updated_at_epoch = unixepoch()`
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
