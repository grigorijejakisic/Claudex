/**
 * Phase 6 EBD-04 — crash-mid-tick cursor replay test.
 *
 * Load-bearing proof of the "cursor + env event in single transaction"
 * CONTEXT decision. We can't easily mock commitBoundaryTick mid-flight
 * (vi.spyOn doesn't intercept dynamic imports cleanly), but we can prove
 * the same property: if the per-session loop throws on session 2, sessions
 * 1 and 3 still close correctly, and session 2 closes on the next tick
 * with no duplicate for session 1 (cursor short-circuit).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { LOCKED_DEFAULTS } from '../../../angel/boundary/thresholds.js';
import { runBoundaryTick } from '../../../angel/boundary/boundary-detector.js';

describe('Phase 6 cursor replay across simulated mid-tick fault', () => {
  let db: Database.Database;
  let tmp: string;
  const t = LOCKED_DEFAULTS;
  const NOW = 100_000;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-replay-'));
    for (const sid of ['s1', 's2', 's3']) {
      db.prepare(
        `INSERT INTO sessions (session_id, project, status, created_at_epoch,
                               last_heartbeat_ts, last_jsonl_write_ts)
         VALUES (?, 'proj-a', 'active', ?, ?, ?)`
      ).run(sid, NOW - 1000, NOW - 35 * 60, NOW - 35 * 60);
    }
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it('per-session error on s2 doesn\'t block s1/s3; restart closes s2 with no s1 duplicate', () => {
    // Tick 1 with a PID resolver that throws ONLY for s2 — boundary-detector's
    // per-session try/catch swallows the throw and records episodic_write_failure.
    const r1 = runBoundaryTick(db, t, {
      now: NOW, projectsRoot: tmp,
      resolvePid: ({ session_id }) => {
        if (session_id === 's2') throw new Error('simulated mid-tick fault');
        return null;
      },
    });
    expect(r1.candidates).toBe(3);
    expect(r1.closesEmitted).toBe(2);
    expect(r1.perSessionErrors).toBe(1);

    const tick1Closes = db.prepare(
      `SELECT session_id FROM episodic_events
        WHERE source = 'angel-boundary' AND metadata_json LIKE '%episode_closed%'
        ORDER BY id ASC`
    ).all() as Array<{ session_id: string }>;
    expect(tick1Closes.map(r => r.session_id).sort()).toEqual(['s1', 's3']);

    // Episodic_write_failure telemetry attempted (CHECK enum admits this kind on V20)
    const failRow = db.prepare(
      `SELECT detail FROM telemetry WHERE event_kind = 'episodic_write_failure' AND session_id = 's2'`
    ).get() as { detail: string } | undefined;
    expect(failRow).toBeDefined();
    expect(failRow!.detail).toContain('simulated mid-tick fault');

    // Tick 2: no fault. s2 closes; s1/s3 already closed → cursor short-circuit, no duplicates.
    const r2 = runBoundaryTick(db, t, {
      now: NOW + 60, projectsRoot: tmp,
      resolvePid: () => null,
    });
    expect(r2.closesEmitted).toBe(1);

    const allCloses = db.prepare(
      `SELECT session_id FROM episodic_events
        WHERE source = 'angel-boundary' AND metadata_json LIKE '%episode_closed%'`
    ).all() as Array<{ session_id: string }>;
    const counts: Record<string, number> = {};
    for (const r of allCloses) counts[r.session_id] = (counts[r.session_id] ?? 0) + 1;
    expect(counts.s1).toBe(1);
    expect(counts.s2).toBe(1);
    expect(counts.s3).toBe(1);
  });
});
