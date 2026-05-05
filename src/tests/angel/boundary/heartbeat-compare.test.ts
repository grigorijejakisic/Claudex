/**
 * Phase 6 EBD-04 — heartbeat-compare-before-cleanup race test.
 *
 * Load-bearing proof of CONTEXT.md "heartbeat-compare-before-cleanup (SHALL)"
 * decision: when sessions.last_heartbeat_ts (or last_jsonl_write_ts) goes
 * fresh between detection and commit, the close MUST be aborted and the
 * cursor MUST still advance (so we don't re-detect on the next tick).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { commitBoundaryTick, loadCursor } from '../../../angel/boundary/cursor.js';

describe('heartbeat-compare race', () => {
  let db: Database.Database;
  const project = 'p1';
  const sessionId = 's1';

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    // Seed session with detected ages: heartbeat=100, jsonl=100
    db.prepare(
      `INSERT INTO sessions (session_id, project, status, created_at_epoch,
                             last_heartbeat_ts, last_jsonl_write_ts)
       VALUES (?, ?, 'active', ?, ?, ?)`
    ).run(sessionId, project, 50, 100, 100);
  });

  afterEach(() => { db.close(); });

  it('aborts close when heartbeat goes fresh between detection and commit', () => {
    // Race: between detection (ts=100) and commit, hook fires and bumps heartbeat to 200.
    db.prepare(
      `UPDATE sessions SET last_heartbeat_ts = 200 WHERE session_id = ?`
    ).run(sessionId);

    const out = commitBoundaryTick(db, {
      project, sessionId,
      jsonlOffset: 999,
      lastEventTsEpoch: 100,
      closeMarker: {
        reason: 'jsonl_silent',
        detectionSnapshot: { last_heartbeat_ts: 100, last_jsonl_write_ts: 100 },
        metadata: {
          duration_seconds: 50,
          event_count: 0,
          pid_alive: false,
          last_heartbeat_ts: 100,
          last_jsonl_write_ts: 100,
        },
      },
    });

    expect(out.closeEmitted).toBe(false);
    expect(out.closeAborted).toBe(true);

    // No close env event row was emitted.
    const closeEv = db.prepare(
      `SELECT 1 FROM episodic_events
        WHERE session_id = ?
          AND source = 'angel-boundary'
          AND metadata_json LIKE '%episode_closed%'`
    ).get(sessionId);
    expect(closeEv).toBeUndefined();

    // sessions.status was NOT flipped to completed.
    const sess = db.prepare(
      `SELECT status FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { status: string };
    expect(sess.status).toBe('active');

    // Cursor advanced (so detector doesn't re-detect on next tick).
    const cur = loadCursor(db, project, sessionId)!;
    expect(cur.last_processed_jsonl_offset).toBe(999);
    expect(cur.last_processed_event_ts_epoch).toBe(100);
    expect(cur.last_close_event_id).toBeNull();
  });

  it('aborts close when jsonl_write_ts goes fresh between detection and commit', () => {
    db.prepare(
      `UPDATE sessions SET last_jsonl_write_ts = 250 WHERE session_id = ?`
    ).run(sessionId);

    const out = commitBoundaryTick(db, {
      project, sessionId,
      jsonlOffset: 555,
      lastEventTsEpoch: 100,
      closeMarker: {
        reason: 'pid_dead',
        detectionSnapshot: { last_heartbeat_ts: 100, last_jsonl_write_ts: 100 },
        metadata: {
          duration_seconds: 50,
          event_count: 0,
          pid_alive: false,
          last_heartbeat_ts: 100,
          last_jsonl_write_ts: 100,
        },
      },
    });

    expect(out.closeAborted).toBe(true);
    expect(out.closeEmitted).toBe(false);

    const sess = db.prepare(
      `SELECT status FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { status: string };
    expect(sess.status).toBe('active');
  });

  it('proceeds with close when both heartbeat + jsonl unchanged from detection', () => {
    const out = commitBoundaryTick(db, {
      project, sessionId,
      jsonlOffset: 500,
      lastEventTsEpoch: 100,
      closeMarker: {
        reason: 'idle_timeout',
        detectionSnapshot: { last_heartbeat_ts: 100, last_jsonl_write_ts: 100 },
        metadata: {
          duration_seconds: 50,
          event_count: 0,
          pid_alive: false,
          last_heartbeat_ts: 100,
          last_jsonl_write_ts: 100,
        },
      },
    });

    expect(out.closeEmitted).toBe(true);
    expect(out.closeAborted).toBe(false);

    const sess = db.prepare(
      `SELECT status FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { status: string };
    expect(sess.status).toBe('completed');
  });
});
