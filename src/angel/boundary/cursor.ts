/**
 * Phase 6 EBD-04 — atomic cursor advance + (optional) close-marker emission.
 *
 * Two main exports:
 *   - loadCursor(db, project, sessionId)
 *   - commitBoundaryTick(db, payload)
 *   - resetCursor(db, project, sessionId) — for offset-overflow recovery
 *
 * commitBoundaryTick wraps cursor advance + close-marker writes in a single
 * SQLite transaction with a heartbeat-compare-before-cleanup guard. If the
 * session became fresh between detection and commit (Session-Amnesia race),
 * the close is aborted and `close_aborted_stale_check_failed` telemetry is
 * written INSIDE the transaction so the cursor still advances and we don't
 * re-detect the same window next tick.
 */

import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface BoundaryCursorRow {
  project: string;
  session_id: string;
  last_processed_jsonl_offset: number;
  last_processed_event_ts_epoch: number;
  last_close_event_id: number | null;
}

export type DetectorCloseReason = 'idle_timeout' | 'jsonl_silent' | 'pid_dead';

export interface BoundaryTickPayload {
  project: string;
  sessionId: string;
  jsonlOffset: number;
  lastEventTsEpoch: number;
  closeMarker?: {
    reason: DetectorCloseReason;
    detectionSnapshot: {
      last_heartbeat_ts: number | null;
      last_jsonl_write_ts: number | null;
    };
    metadata: {
      duration_seconds: number;
      event_count: number;
      pid_alive: boolean;
      last_heartbeat_ts: number | null;
      last_jsonl_write_ts: number | null;
    };
  };
}

export interface BoundaryTickOutcome {
  closeEmitted: boolean;
  closeAborted: boolean;
  closeEventId: number | null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function loadCursor(
  db: Database,
  project: string,
  sessionId: string,
): BoundaryCursorRow | null {
  const row = db.prepare(
    `SELECT project, session_id, last_processed_jsonl_offset,
            last_processed_event_ts_epoch, last_close_event_id
       FROM episode_boundary_cursor
      WHERE project = ? AND session_id = ?`
  ).get(project, sessionId) as BoundaryCursorRow | undefined;
  return row ?? null;
}

/**
 * Reset cursor offset to 0 + write `boundary_cursor_replay` telemetry.
 * Called by the boundary detector when it observes
 * `cursor.last_processed_jsonl_offset > fs.statSync(jsonlPath).size`
 * (file rotation / truncation race — Pitfall 3 in 06-RESEARCH.md).
 */
export function resetCursor(
  db: Database,
  project: string,
  sessionId: string,
  reason: 'offset_overflow' | 'file_missing',
): void {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE episode_boundary_cursor
          SET last_processed_jsonl_offset = 0
        WHERE project = ? AND session_id = ?`
    ).run(project, sessionId);
    try {
      db.prepare(
        `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
         VALUES (?, 'boundary_cursor_replay',
                 json_object('project', ?, 'reason', ?),
                 'angel-boundary')`
      ).run(sessionId, project, reason);
    } catch { /* CHECK enum may not admit; swallow */ }
  });
  tx();
}

export function commitBoundaryTick(
  db: Database,
  payload: BoundaryTickPayload,
): BoundaryTickOutcome {
  let closeEmitted = false;
  let closeAborted = false;
  let closeEventId: number | null = null;

  const tx = db.transaction(() => {
    if (payload.closeMarker) {
      const fresh = db.prepare(
        `SELECT last_heartbeat_ts, last_jsonl_write_ts
           FROM sessions WHERE session_id = ?`
      ).get(payload.sessionId) as
        { last_heartbeat_ts: number | null; last_jsonl_write_ts: number | null } | undefined;

      const snap = payload.closeMarker.detectionSnapshot;
      const heartbeatWentFresh = !!(fresh && fresh.last_heartbeat_ts !== snap.last_heartbeat_ts);
      const jsonlWentFresh     = !!(fresh && fresh.last_jsonl_write_ts !== snap.last_jsonl_write_ts);

      if (heartbeatWentFresh || jsonlWentFresh) {
        closeAborted = true;
        try {
          db.prepare(
            `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
             VALUES (?, 'close_aborted_stale_check_failed',
                     json_object(
                       'project', ?,
                       'detection_heartbeat_ts', ?,
                       'detection_jsonl_write_ts', ?,
                       'fresh_heartbeat_ts', ?,
                       'fresh_jsonl_write_ts', ?,
                       'close_reason_attempted', ?
                     ),
                     'angel-boundary')`
          ).run(
            payload.sessionId,
            payload.project,
            snap.last_heartbeat_ts,
            snap.last_jsonl_write_ts,
            fresh?.last_heartbeat_ts ?? null,
            fresh?.last_jsonl_write_ts ?? null,
            payload.closeMarker.reason,
          );
        } catch { /* CHECK enum may not admit; swallow */ }
        // Fall through to cursor advance below.
      } else {
        const content = `Episode closed: ${payload.closeMarker.reason}`;
        const contentHash = sha256(
          `${content}:${payload.sessionId}:${payload.lastEventTsEpoch}`,
        );

        const ev = db.prepare(
          `INSERT INTO episodic_events
             (session_id, project, turn_number, type, source, content,
              provenance, parent_event_id, content_hash, metadata_json)
           VALUES (?, ?, NULL, 'environmental_event', 'angel-boundary', ?,
                   'environmental', NULL, ?,
                   json_object(
                     'episode_closed',     json('true'),
                     'close_reason',       ?,
                     'duration_seconds',   ?,
                     'event_count',        ?,
                     'pid_alive',          json(?),
                     'last_heartbeat_ts',  ?,
                     'last_jsonl_write_ts',?
                   ))
           RETURNING id`
        ).get(
          payload.sessionId,
          payload.project,
          content,
          contentHash,
          payload.closeMarker.reason,
          payload.closeMarker.metadata.duration_seconds,
          payload.closeMarker.metadata.event_count,
          payload.closeMarker.metadata.pid_alive ? 'true' : 'false',
          payload.closeMarker.metadata.last_heartbeat_ts,
          payload.closeMarker.metadata.last_jsonl_write_ts,
        ) as { id: number } | undefined;
        closeEventId = ev?.id ?? null;
        closeEmitted = true;

        db.prepare(
          `UPDATE sessions
              SET status = 'completed',
                  ended_at_epoch_ms = COALESCE(ended_at_epoch_ms, ?)
            WHERE session_id = ?`
        ).run(payload.lastEventTsEpoch * 1000, payload.sessionId);

        db.prepare(
          `INSERT INTO episode_boundary_cursor
             (project, session_id, last_processed_jsonl_offset,
              last_processed_event_ts_epoch, last_close_event_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project, session_id) DO UPDATE SET
             last_processed_jsonl_offset   = excluded.last_processed_jsonl_offset,
             last_processed_event_ts_epoch = excluded.last_processed_event_ts_epoch,
             last_close_event_id           = excluded.last_close_event_id`
        ).run(
          payload.project, payload.sessionId,
          payload.jsonlOffset, payload.lastEventTsEpoch,
          closeEventId,
        );
        return; // skip cursor-only branch below
      }
    }

    // No close marker (or aborted) → cursor advance only (preserves last_close_event_id)
    db.prepare(
      `INSERT INTO episode_boundary_cursor
         (project, session_id, last_processed_jsonl_offset, last_processed_event_ts_epoch)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project, session_id) DO UPDATE SET
         last_processed_jsonl_offset   = excluded.last_processed_jsonl_offset,
         last_processed_event_ts_epoch = excluded.last_processed_event_ts_epoch`
    ).run(payload.project, payload.sessionId, payload.jsonlOffset, payload.lastEventTsEpoch);
  });
  tx();

  // Telemetry write OUTSIDE the transaction so a CHECK violation on
  // 'episode_close_emitted' (CHECK enum doesn't admit it yet) does not
  // roll back the close.
  if (closeEmitted && payload.closeMarker) {
    try {
      db.prepare(
        `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
         VALUES (?, 'episode_close_emitted',
                 json_object('close_reason', ?, 'close_event_id', ?),
                 'angel-boundary')`
      ).run(payload.sessionId, payload.closeMarker.reason, closeEventId);
    } catch { /* swallow */ }
  }

  return { closeEmitted, closeAborted, closeEventId };
}
