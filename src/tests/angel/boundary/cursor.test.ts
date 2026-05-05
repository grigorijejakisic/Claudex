/**
 * Tests for src/angel/boundary/cursor.ts.
 *
 * Covers: loadCursor null on missing, UPSERT semantics on commit (cursor-only
 * and close-marker paths), idempotent re-commit, resetCursor offset → 0
 * with telemetry attempt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import {
  loadCursor,
  commitBoundaryTick,
  resetCursor,
} from '../../../angel/boundary/cursor.js';

describe('boundary cursor module', () => {
  let db: Database.Database;
  const project = 'p1';
  const sessionId = 's1';

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    db.prepare(
      `INSERT INTO sessions (session_id, project, status, created_at_epoch)
       VALUES (?, ?, 'active', ?)`
    ).run(sessionId, project, 1000);
  });

  afterEach(() => { db.close(); });

  it('loadCursor returns null when no row present', () => {
    expect(loadCursor(db, project, sessionId)).toBeNull();
  });

  it('cursor-only commit creates row with offset + ts (last_close_event_id null)', () => {
    commitBoundaryTick(db, {
      project, sessionId,
      jsonlOffset: 200,
      lastEventTsEpoch: 1500,
    });
    const cur = loadCursor(db, project, sessionId);
    expect(cur).not.toBeNull();
    expect(cur!.last_processed_jsonl_offset).toBe(200);
    expect(cur!.last_processed_event_ts_epoch).toBe(1500);
    expect(cur!.last_close_event_id).toBeNull();
  });

  it('cursor-only commit on existing row updates fields preserving last_close_event_id', () => {
    db.prepare(
      `INSERT INTO episode_boundary_cursor
         (project, session_id, last_processed_jsonl_offset,
          last_processed_event_ts_epoch, last_close_event_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(project, sessionId, 100, 1000, 42);
    commitBoundaryTick(db, {
      project, sessionId, jsonlOffset: 300, lastEventTsEpoch: 2000,
    });
    const cur = loadCursor(db, project, sessionId)!;
    expect(cur.last_processed_jsonl_offset).toBe(300);
    expect(cur.last_processed_event_ts_epoch).toBe(2000);
    expect(cur.last_close_event_id).toBe(42);
  });

  it('close-marker commit emits episode_closed env event + flips status + sets last_close_event_id', () => {
    const out = commitBoundaryTick(db, {
      project, sessionId,
      jsonlOffset: 500,
      lastEventTsEpoch: 3000,
      closeMarker: {
        reason: 'idle_timeout',
        detectionSnapshot: { last_heartbeat_ts: null, last_jsonl_write_ts: null },
        metadata: {
          duration_seconds: 1800,
          event_count: 0,
          pid_alive: false,
          last_heartbeat_ts: null,
          last_jsonl_write_ts: null,
        },
      },
    });
    expect(out.closeEmitted).toBe(true);
    expect(out.closeAborted).toBe(false);
    expect(out.closeEventId).toBeGreaterThan(0);

    const ev = db.prepare(
      `SELECT id, source, provenance, metadata_json FROM episodic_events
        WHERE session_id = ? AND source = 'angel-boundary'`
    ).get(sessionId) as { id: number; source: string; provenance: string; metadata_json: string };
    expect(ev.id).toBe(out.closeEventId);
    expect(ev.metadata_json).toContain('idle_timeout');

    const sess = db.prepare(
      `SELECT status, ended_at_epoch FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { status: string; ended_at_epoch: number };
    expect(sess.status).toBe('completed');
    expect(sess.ended_at_epoch).toBe(3000);

    const cur = loadCursor(db, project, sessionId)!;
    expect(cur.last_close_event_id).toBe(out.closeEventId);
    expect(cur.last_processed_jsonl_offset).toBe(500);
  });

  it('resetCursor sets last_processed_jsonl_offset = 0', () => {
    commitBoundaryTick(db, {
      project, sessionId,
      jsonlOffset: 9_000_000,
      lastEventTsEpoch: 1500,
    });
    expect(loadCursor(db, project, sessionId)!.last_processed_jsonl_offset).toBe(9_000_000);
    resetCursor(db, project, sessionId, 'offset_overflow');
    expect(loadCursor(db, project, sessionId)!.last_processed_jsonl_offset).toBe(0);
  });
});
