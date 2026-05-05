/**
 * Phase 6 EBD-04 — single-process end-to-end integration test.
 *
 * Exercises the full pipeline: V29 schema → seed sessions → runBoundaryTick
 * → assert close markers + reopen handling + cursor short-circuit on second
 * tick.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { LOCKED_DEFAULTS } from '../../../angel/boundary/thresholds.js';
import { runBoundaryTick } from '../../../angel/boundary/boundary-detector.js';

describe('Phase 6 boundary detector — single-process integration', () => {
  let db: Database.Database;
  let tmp: string;
  const t = LOCKED_DEFAULTS;
  const NOW = 100_000;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-int-'));
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  function seed(sessionId: string, hbAge: number, jsonlAge: number, status: string = 'active') {
    db.prepare(
      `INSERT INTO sessions (session_id, project, status, created_at_epoch,
                             last_heartbeat_ts, last_jsonl_write_ts)
       VALUES (?, 'proj-a', ?, ?, ?, ?)`
    ).run(sessionId, status, NOW - 1000, NOW - hbAge, NOW - jsonlAge);
  }

  function seedClosedClean(sessionId: string): number {
    db.prepare(
      `INSERT INTO sessions (session_id, project, status, created_at_epoch,
                             ended_at_epoch, last_heartbeat_ts, last_jsonl_write_ts)
       VALUES (?, 'proj-a', 'completed', ?, ?, ?, ?)`
    ).run(sessionId, NOW - 1000, NOW - 60, NOW - 60, NOW - 60);
    db.prepare(
      `INSERT INTO episodic_events
         (session_id, project, turn_number, type, source, content,
          provenance, parent_event_id, content_hash, metadata_json)
       VALUES (?, 'proj-a', NULL, 'environmental_event', 'angel-boundary',
               'Episode closed: clean_endsession', 'environmental', NULL, ?,
               json_object('episode_closed', json('true'), 'close_reason', 'clean_endsession'))`
    ).run(sessionId, `h-${sessionId}-clean`);
    const ev = db.prepare(`SELECT id FROM episodic_events WHERE session_id = ?`).get(sessionId) as { id: number };
    db.prepare(
      `INSERT INTO episode_boundary_cursor
         (project, session_id, last_processed_jsonl_offset,
          last_processed_event_ts_epoch, last_close_event_id)
       VALUES ('proj-a', ?, 0, ?, ?)`
    ).run(sessionId, NOW - 60, ev.id);
    return ev.id;
  }

  it('full pipeline: idle_timeout + jsonl_silent close, then second tick is no-op, then JSONL bump triggers reopen', () => {
    seed('fresh', 60, 60);                         // ALIVE
    seed('idle', 35 * 60, 35 * 60);                // → idle_timeout
    seed('pid-dead', 16 * 60, 16 * 60);            // → jsonl_silent (no PID resolver = pid_alive=false)
    const cleanEvId = seedClosedClean('clean');    // skipped

    // Tick 1
    const r1 = runBoundaryTick(db, t, {
      now: NOW, projectsRoot: tmp,
      resolvePid: ({ session_id }) => session_id === 'fresh' ? process.pid : null,
    });
    expect(r1.closesEmitted).toBe(2);
    expect(r1.reopensEmitted).toBe(0);
    expect(r1.reopensAnomalous).toBe(0);

    const closeRows = db.prepare(
      `SELECT session_id, metadata_json FROM episodic_events
        WHERE source = 'angel-boundary' AND metadata_json LIKE '%episode_closed%'
        ORDER BY id ASC`
    ).all() as Array<{ session_id: string; metadata_json: string }>;
    expect(closeRows.length).toBe(3); // 2 from tick + 1 from clean planted
    const reasons = closeRows.map(r => r.metadata_json.match(/"close_reason":\s*"(\w+)"/)?.[1]);
    expect(reasons).toContain('idle_timeout');
    expect(reasons).toContain('clean_endsession');

    // Tick 2: clean session skipped, idle/pid-dead already closed → no new closes
    const r2 = runBoundaryTick(db, t, {
      now: NOW + 60, projectsRoot: tmp,
      resolvePid: ({ session_id }) => session_id === 'fresh' ? process.pid : null,
    });
    expect(r2.closesEmitted).toBe(0);

    // Bump JSONL on idle session — fresher than its close ts (which was NOW)
    const reopenTs = NOW + 30 * 60; // within T_reopen=60min
    db.prepare(`UPDATE sessions SET last_jsonl_write_ts = ? WHERE session_id = 'idle'`).run(reopenTs);

    // Tick 3: should reopen idle
    const r3 = runBoundaryTick(db, t, {
      now: reopenTs + 60, projectsRoot: tmp,
      resolvePid: ({ session_id }) => session_id === 'fresh' ? process.pid : null,
    });
    expect(r3.reopensEmitted).toBe(1);

    const idleSess = db.prepare(`SELECT status FROM sessions WHERE session_id = 'idle'`).get() as { status: string };
    expect(idleSess.status).toBe('active');
    const idleCur = db.prepare(`SELECT last_close_event_id FROM episode_boundary_cursor WHERE session_id = 'idle'`).get() as { last_close_event_id: number | null };
    expect(idleCur.last_close_event_id).toBeNull();

    // Clean session's close event id is preserved (untouched)
    const cleanCur = db.prepare(`SELECT last_close_event_id FROM episode_boundary_cursor WHERE session_id = 'clean'`).get() as { last_close_event_id: number };
    expect(cleanCur.last_close_event_id).toBe(cleanEvId);
  });
});
