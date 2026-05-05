/**
 * Phase 6 EBD-04 / EBD-06 — boundary-detector sweep tests.
 *
 * End-to-end happy paths: idle/dead session closes, clean_endsession skip,
 * cursor offset overflow recovery, PID-resolution fallback, bounded LIMIT,
 * per-session error isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { LOCKED_DEFAULTS } from '../../../angel/boundary/thresholds.js';
import { runBoundaryTick } from '../../../angel/boundary/boundary-detector.js';

function insertSession(db: Database.Database, opts: {
  sessionId: string; project: string; status?: string;
  createdAt?: number;
  lastHeartbeat?: number | null;
  lastJsonl?: number | null;
}) {
  db.prepare(
    `INSERT INTO sessions
       (session_id, project, status, created_at_epoch,
        last_heartbeat_ts, last_jsonl_write_ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    opts.sessionId, opts.project,
    opts.status ?? 'active',
    opts.createdAt ?? 1000,
    opts.lastHeartbeat ?? null,
    opts.lastJsonl ?? null,
  );
}

describe('runBoundaryTick sweep', () => {
  let db: Database.Database;
  let tmp: string;
  const NOW = 100_000; // epoch
  const t = LOCKED_DEFAULTS;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-detector-'));
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it('emits 1 idle_timeout close for the dead session, leaves fresh + dormant alone', () => {
    // Fresh: jsonl 1min ago, heartbeat 1min ago, alive PID → ALIVE → no close
    insertSession(db, {
      sessionId: 'fresh', project: 'proj-a',
      lastHeartbeat: NOW - 60, lastJsonl: NOW - 60,
    });
    // Idle: jsonl 35min ago → idle_timeout
    insertSession(db, {
      sessionId: 'idle', project: 'proj-a',
      lastHeartbeat: NOW - 35 * 60, lastJsonl: NOW - 35 * 60,
    });
    // Dormant: jsonl 16min ago, heartbeat 1min ago, alive PID → DORMANT (skip)
    insertSession(db, {
      sessionId: 'dorm', project: 'proj-a',
      lastHeartbeat: NOW - 60, lastJsonl: NOW - 16 * 60,
    });

    const r = runBoundaryTick(db, t, {
      now: NOW, projectsRoot: tmp,
      resolvePid: ({ session_id }) => session_id === 'idle' ? null : process.pid,
    });

    expect(r.candidates).toBe(3);
    expect(r.closesEmitted).toBe(1);
    expect(r.closesAborted).toBe(0);

    const idleRow = db.prepare(
      `SELECT status FROM sessions WHERE session_id = 'idle'`
    ).get() as { status: string };
    expect(idleRow.status).toBe('completed');
    const freshRow = db.prepare(
      `SELECT status FROM sessions WHERE session_id = 'fresh'`
    ).get() as { status: string };
    expect(freshRow.status).toBe('active');
  });

  it('skips a session whose cursor.last_close_event_id is a clean_endsession marker', () => {
    insertSession(db, {
      sessionId: 'closed', project: 'proj-a', status: 'completed',
      lastHeartbeat: NOW - 60, lastJsonl: NOW - 60,
    });
    // Plant a clean_endsession close marker as the prior close
    db.prepare(
      `INSERT INTO episodic_events
         (session_id, project, turn_number, type, source, content,
          provenance, parent_event_id, content_hash, metadata_json)
       VALUES ('closed', 'proj-a', NULL, 'environmental_event', 'angel-boundary',
               'Episode closed: clean_endsession', 'environmental', NULL, 'h1',
               json_object('episode_closed', json('true'), 'close_reason', 'clean_endsession'))`
    ).run();
    const ev = db.prepare(`SELECT id FROM episodic_events WHERE session_id='closed'`).get() as { id: number };
    db.prepare(
      `INSERT INTO episode_boundary_cursor
         (project, session_id, last_processed_jsonl_offset,
          last_processed_event_ts_epoch, last_close_event_id)
       VALUES ('proj-a', 'closed', 0, ?, ?)`
    ).run(NOW - 60, ev.id);

    const r = runBoundaryTick(db, t, { now: NOW, projectsRoot: tmp });

    expect(r.closesEmitted).toBe(0);
    expect(r.reopensEmitted).toBe(0);
  });

  it('cursor offset overflow → resetCursor + boundary_cursor_replay (telemetry attempted)', () => {
    insertSession(db, {
      sessionId: 'oversess', project: 'proj-a',
      lastHeartbeat: NOW - 60, lastJsonl: NOW - 60,
    });
    fs.mkdirSync(path.join(tmp, 'proj-a'), { recursive: true });
    const jsonl = path.join(tmp, 'proj-a', 'oversess.jsonl');
    fs.writeFileSync(jsonl, 'x'.repeat(100));
    db.prepare(
      `INSERT INTO episode_boundary_cursor
         (project, session_id, last_processed_jsonl_offset,
          last_processed_event_ts_epoch, last_close_event_id)
       VALUES ('proj-a', 'oversess', 1000000, ?, NULL)`
    ).run(NOW - 60);

    const r = runBoundaryTick(db, t, {
      now: NOW, projectsRoot: tmp,
      resolvePid: () => process.pid,
    });

    expect(r.cursorReplays).toBe(1);
    const cur = db.prepare(
      `SELECT last_processed_jsonl_offset FROM episode_boundary_cursor WHERE session_id = 'oversess'`
    ).get() as { last_processed_jsonl_offset: number };
    expect(cur.last_processed_jsonl_offset).toBe(0);
  });

  it('PID-resolution fallback: no PID resolver → pid_alive=false; corroborated jsonl_silent or pid_dead', () => {
    insertSession(db, {
      sessionId: 'noPid', project: 'proj-a',
      lastHeartbeat: NOW - 16 * 60, lastJsonl: NOW - 16 * 60,
    });

    const r = runBoundaryTick(db, t, { now: NOW, projectsRoot: tmp });
    // jsonl 16min ≥ 15 + jsonl < 30, heartbeat 16min ≥ 5, pid_alive=false → jsonl_silent
    expect(r.closesEmitted).toBe(1);

    const sess = db.prepare(`SELECT status FROM sessions WHERE session_id='noPid'`).get() as { status: string };
    expect(sess.status).toBe('completed');
    const ev = db.prepare(
      `SELECT metadata_json FROM episodic_events WHERE session_id = 'noPid'`
    ).get() as { metadata_json: string };
    expect(ev.metadata_json).toContain('jsonl_silent');
  });

  it('bounded sweep: 30 candidates with limit=25 processes only 25', () => {
    for (let i = 0; i < 30; i += 1) {
      insertSession(db, {
        sessionId: `idle-${i}`, project: 'proj-a',
        lastHeartbeat: NOW - 35 * 60, lastJsonl: NOW - 35 * 60 - i,
      });
    }
    const r = runBoundaryTick(db, t, {
      now: NOW, projectsRoot: tmp, limit: 25,
      resolvePid: () => null,
    });
    expect(r.candidates).toBe(25);
    expect(r.closesEmitted).toBe(25);

    const left = db.prepare(`SELECT COUNT(*) as cnt FROM sessions WHERE status='active'`)
      .get() as { cnt: number };
    expect(left.cnt).toBe(5);
  });

  it('per-session error isolation: bad PID resolver throws for one session; others still close', () => {
    insertSession(db, {
      sessionId: 'good1', project: 'proj-a',
      lastHeartbeat: NOW - 35 * 60, lastJsonl: NOW - 35 * 60,
    });
    insertSession(db, {
      sessionId: 'bad', project: 'proj-a',
      lastHeartbeat: NOW - 35 * 60, lastJsonl: NOW - 35 * 60,
    });
    insertSession(db, {
      sessionId: 'good2', project: 'proj-a',
      lastHeartbeat: NOW - 35 * 60, lastJsonl: NOW - 35 * 60,
    });
    const r = runBoundaryTick(db, t, {
      now: NOW, projectsRoot: tmp,
      resolvePid: ({ session_id }) => {
        if (session_id === 'bad') throw new Error('boom');
        return null;
      },
    });
    expect(r.candidates).toBe(3);
    expect(r.closesEmitted).toBe(2);
    expect(r.perSessionErrors).toBe(1);
  });
});
