/**
 * Phase 6 EBD-04 — re-open branch tests.
 *
 *   1. Within T_reopen + fresh JSONL → re_opened env event + status='active' +
 *      cursor.last_close_event_id = NULL.
 *   2. Beyond T_reopen → episode_reopen_anomaly telemetry; status unchanged.
 *   3. Re-open then re-close: both episode_closed rows present, append-only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { LOCKED_DEFAULTS } from '../../../angel/boundary/thresholds.js';
import { runBoundaryTick } from '../../../angel/boundary/boundary-detector.js';

function plantClosedSession(db: Database.Database, opts: {
  sessionId: string; project: string; closeAt: number;
}): number {
  db.prepare(
    `INSERT INTO sessions
       (session_id, project, status, created_at_epoch, ended_at_epoch,
        last_heartbeat_ts, last_jsonl_write_ts)
     VALUES (?, ?, 'completed', ?, ?, ?, ?)`
  ).run(opts.sessionId, opts.project, opts.closeAt - 1000, opts.closeAt, opts.closeAt, opts.closeAt);

  db.prepare(
    `INSERT INTO episodic_events
       (session_id, project, turn_number, type, source, content,
        provenance, parent_event_id, content_hash, metadata_json)
     VALUES (?, ?, NULL, 'environmental_event', 'angel-boundary',
             ?, 'environmental', NULL, ?,
             json_object('episode_closed', json('true'), 'close_reason', 'idle_timeout'))`
  ).run(opts.sessionId, opts.project, `Episode closed: idle_timeout`, `h-${opts.sessionId}-${opts.closeAt}`);
  const ev = db.prepare(
    `SELECT id FROM episodic_events WHERE session_id = ? ORDER BY id DESC LIMIT 1`
  ).get(opts.sessionId) as { id: number };

  db.prepare(
    `INSERT INTO episode_boundary_cursor
       (project, session_id, last_processed_jsonl_offset,
        last_processed_event_ts_epoch, last_close_event_id)
     VALUES (?, ?, 0, ?, ?)`
  ).run(opts.project, opts.sessionId, opts.closeAt, ev.id);

  return ev.id;
}

describe('boundary detector re-open branches', () => {
  let db: Database.Database;
  let tmp: string;
  const t = LOCKED_DEFAULTS;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-reopen-'));
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it('within T_reopen + fresh JSONL → emit re_opened event, status=active, original close untouched', () => {
    const closeAt = 100_000;
    const priorEvId = plantClosedSession(db, {
      sessionId: 'sess-r', project: 'proj-a', closeAt,
    });
    // JSONL 30min after close (T_reopen=60min)
    const reopenTs = closeAt + 30 * 60;
    db.prepare(`UPDATE sessions SET last_jsonl_write_ts = ? WHERE session_id = 'sess-r'`).run(reopenTs);

    const NOW = reopenTs + 60;
    const r = runBoundaryTick(db, t, { now: NOW, projectsRoot: tmp, resolvePid: () => null });

    expect(r.reopensEmitted).toBe(1);
    expect(r.reopensAnomalous).toBe(0);

    const sess = db.prepare(`SELECT status, ended_at_epoch FROM sessions WHERE session_id='sess-r'`)
      .get() as { status: string; ended_at_epoch: number | null };
    expect(sess.status).toBe('active');
    expect(sess.ended_at_epoch).toBeNull();

    const cur = db.prepare(`SELECT last_close_event_id FROM episode_boundary_cursor WHERE session_id='sess-r'`)
      .get() as { last_close_event_id: number | null };
    expect(cur.last_close_event_id).toBeNull();

    const reopenEv = db.prepare(
      `SELECT metadata_json FROM episodic_events
        WHERE session_id = 'sess-r' AND metadata_json LIKE '%re_opened%'`
    ).get() as { metadata_json: string } | undefined;
    expect(reopenEv).toBeDefined();
    expect(reopenEv!.metadata_json).toContain('"gap_seconds"');

    // Original close row UNTOUCHED — still present + same id.
    const origCloseRow = db.prepare(
      `SELECT id, metadata_json FROM episodic_events WHERE id = ?`
    ).get(priorEvId) as { id: number; metadata_json: string };
    expect(origCloseRow).toBeDefined();
    expect(origCloseRow.metadata_json).toContain('idle_timeout');
  });

  it('beyond T_reopen → episode_reopen_anomaly telemetry, status unchanged', () => {
    const closeAt = 100_000;
    plantClosedSession(db, { sessionId: 'sess-anom', project: 'proj-a', closeAt });
    // JSONL 90min after close (> T_reopen=60min)
    const reopenTs = closeAt + 90 * 60;
    db.prepare(`UPDATE sessions SET last_jsonl_write_ts = ? WHERE session_id = 'sess-anom'`).run(reopenTs);

    const NOW = reopenTs + 60;
    const r = runBoundaryTick(db, t, { now: NOW, projectsRoot: tmp, resolvePid: () => null });

    expect(r.reopensEmitted).toBe(0);
    expect(r.reopensAnomalous).toBe(1);

    const sess = db.prepare(`SELECT status FROM sessions WHERE session_id='sess-anom'`)
      .get() as { status: string };
    expect(sess.status).toBe('completed');

    const cur = db.prepare(
      `SELECT last_close_event_id FROM episode_boundary_cursor WHERE session_id='sess-anom'`
    ).get() as { last_close_event_id: number | null };
    expect(cur.last_close_event_id).not.toBeNull();
  });

  it('re-open then re-close cycle: both episode_closed rows exist (append-only)', () => {
    const closeAt = 100_000;
    plantClosedSession(db, { sessionId: 'sess-cycle', project: 'proj-a', closeAt });
    const reopenTs = closeAt + 30 * 60;
    db.prepare(`UPDATE sessions SET last_jsonl_write_ts = ?, last_heartbeat_ts = ? WHERE session_id = 'sess-cycle'`)
      .run(reopenTs, reopenTs);

    const NOW1 = reopenTs + 60;
    runBoundaryTick(db, t, { now: NOW1, projectsRoot: tmp, resolvePid: () => null });

    // Now wait 35 min → idle again
    const idleTs = reopenTs + 35 * 60;
    const NOW2 = idleTs + 60;
    runBoundaryTick(db, t, { now: NOW2, projectsRoot: tmp, resolvePid: () => null });

    const closeRows = db.prepare(
      `SELECT id, metadata_json FROM episodic_events
        WHERE session_id = 'sess-cycle'
          AND metadata_json LIKE '%episode_closed%'
        ORDER BY id ASC`
    ).all() as Array<{ id: number; metadata_json: string }>;
    expect(closeRows.length).toBe(2);
    expect(closeRows[0]!.metadata_json).toContain('idle_timeout');
    expect(closeRows[1]!.metadata_json).toContain('idle_timeout');
    expect(closeRows[0]!.id).not.toBe(closeRows[1]!.id);
  });
});
