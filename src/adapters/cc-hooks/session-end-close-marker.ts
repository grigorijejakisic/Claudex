/**
 * Phase 6 EBD-02: clean_endsession close marker emission.
 *
 * Extracted from session-end.ts so plan 03's regression test (and Plan 04's
 * boundary detector tests) can exercise the same code path without
 * triggering session-end.ts's `main()` call (which reads stdin and would
 * hang in test contexts).
 *
 * Atomic transaction wrapping (1) heartbeat bump + status='completed',
 * (2) episode_closed env event row, (3) cursor advance, (4) telemetry.
 * Prevents a duplicate-close race (Pitfall 2 in 06-RESEARCH.md): if any
 * write throws, all roll back so the boundary detector either sees no
 * close at all (and may emit `idle_timeout` later) or sees the consistent
 * close marker that short-circuits it.
 *
 * NEVER throws — failures recorded as `episodic_write_failure` telemetry
 * (mirrors episodic-events.ts captureError pattern).
 */

import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { cachedPrepare } from '../../core/stmt-cache.js';

export function emitCleanEndsessionClose(
  db: Database,
  sessionId: string,
  project: string,
): void {
  try {
    const now = Math.floor(Date.now() / 1000);

    const sessRow = cachedPrepare(db,
      `SELECT created_at_epoch FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { created_at_epoch: number | null } | undefined;
    const durationSeconds = sessRow?.created_at_epoch
      ? Math.max(0, now - sessRow.created_at_epoch)
      : 0;

    const content = `Episode closed: clean_endsession`;
    const contentHash = createHash('sha256')
      .update(`${content}:${sessionId}`, 'utf8')
      .digest('hex');

    let closeEventId: number | null = null;

    const tx = db.transaction(() => {
      cachedPrepare(db,
        `UPDATE sessions
            SET last_heartbeat_ts = ?,
                status = 'completed',
                ended_at_epoch = COALESCE(ended_at_epoch, ?)
          WHERE session_id = ?`
      ).run(now, now, sessionId);

      const ev = cachedPrepare(db,
        `INSERT INTO episodic_events
           (session_id, project, turn_number, type, source, content,
            provenance, parent_event_id, content_hash, metadata_json)
         VALUES (?, ?, NULL, 'environmental_event', 'angel-boundary', ?,
                 'environmental', NULL, ?,
                 json_object(
                   'episode_closed',     json('true'),
                   'close_reason',       'clean_endsession',
                   'last_heartbeat_ts',  ?,
                   'duration_seconds',   ?
                 ))
         RETURNING id`
      ).get(sessionId, project, content, contentHash, now, durationSeconds) as
        { id: number } | undefined;
      closeEventId = ev?.id ?? null;

      cachedPrepare(db,
        `INSERT INTO episode_boundary_cursor
           (project, session_id, last_processed_jsonl_offset,
            last_processed_event_ts_epoch, last_close_event_id)
         VALUES (
           ?, ?,
           COALESCE((SELECT last_processed_jsonl_offset
                       FROM episode_boundary_cursor
                      WHERE project = ? AND session_id = ?), 0),
           ?, ?
         )
         ON CONFLICT(project, session_id) DO UPDATE SET
           last_processed_event_ts_epoch = excluded.last_processed_event_ts_epoch,
           last_close_event_id           = excluded.last_close_event_id`
      ).run(project, sessionId, project, sessionId, now, closeEventId);
    });
    tx();

    // Telemetry write OUTSIDE the transaction. The telemetry CHECK enum
    // does not yet admit 'episode_close_emitted' (extension deferred to
    // a future migration); putting the INSERT inside the tx would roll
    // back the close marker on CHECK violation. Outside, the swallow
    // pattern matches telemetry-counters.ts.
    try {
      cachedPrepare(db,
        `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
         VALUES (?, 'episode_close_emitted',
                 json_object('close_reason', 'clean_endsession',
                             'close_event_id', ?),
                 'angel-boundary')`
      ).run(sessionId, closeEventId);
    } catch { /* CHECK enum may not admit yet — swallow */ }
  } catch (err) {
    try {
      const message = err instanceof Error ? err.message : String(err);
      cachedPrepare(db,
        `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
         VALUES (?, 'episodic_write_failure',
                 json_object('hook', 'session-end',
                             'phase6', 'close-marker',
                             'error_message', ?),
                 'session-end')`
      ).run(sessionId, message.slice(0, 500));
    } catch { /* last-resort: never let telemetry mask the failure */ }
  }
}
