/**
 * Phase 7 plan 04 — VAL-04 substrate test (deferred from Phase 6).
 *
 * Phase 6 (2026-05-05) shipped the substrate (composition rule + boundary
 * detector + JSONL watcher + V29 schema) plus 55 vitest regression tests.
 * The Vesna probe form was deferred to Phase 7 because Phase 6's substrate
 * has no consumer surface for behavioral assertion — Vesna's regex-over-
 * agent_text contract requires assembled output, and there is none until
 * episode_closed markers feed a user-visible recall surface (v6+).
 *
 * This test covers the SC-V5-4 ship gate at substrate level: kill -9
 * simulation, clock advance past T_jsonl + T_grace, runBoundaryTick,
 * assert close marker fires with close_reason='idle_timeout' (NOT
 * 'clean_endsession', which is the SessionEnd-hook path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDbWithSession } from '../helpers/test-db.js';
import { runBoundaryTick } from '../../angel/boundary/boundary-detector.js';
import { LOCKED_DEFAULTS } from '../../angel/boundary/thresholds.js';

interface CloseEventRow {
  id: number;
  type: string;
  source: string;
  metadata_json: string;
}

function getCloseMarker(db: Database.Database, sessionId: string): CloseEventRow | undefined {
  return db.prepare(
    `SELECT id, type, source, metadata_json
       FROM episodic_events
      WHERE session_id = ?
        AND type = 'environmental_event'
        AND source = 'angel-boundary'
      ORDER BY id DESC
      LIMIT 1`
  ).get(sessionId) as CloseEventRow | undefined;
}

describe('Phase 6 crash resilience — VAL-04 substrate gate', () => {
  let db: Database.Database;
  let sessionId: string;
  let project: string;

  beforeEach(() => {
    const t = createTestDbWithSession();
    db = t.db;
    sessionId = t.sessionId;
    project = t.project;
  });

  afterEach(() => {
    db.close();
  });

  it('idle session with no clean endsession produces a close marker with close_reason=idle_timeout', () => {
    // Simulate kill -9: session is 'active', last_heartbeat_ts is OLD,
    // last_jsonl_write_ts is OLD enough to exceed T_jsonl + T_grace, NO
    // SessionEnd hook ever wrote a clean_endsession close marker.
    const now = Math.floor(Date.now() / 1000);
    const idleStart = now - (LOCKED_DEFAULTS.tJsonl + LOCKED_DEFAULTS.tGrace + 60);
    db.prepare(
      `UPDATE sessions
          SET status = 'active',
              last_heartbeat_ts = ?,
              last_jsonl_write_ts = ?
        WHERE session_id = ?`
    ).run(idleStart, idleStart, sessionId);

    // Resolve PID as not alive — the session's process is gone (kill -9).
    const ev = runBoundaryTick(db, LOCKED_DEFAULTS, {
      now,
      resolvePid: () => null,
    });

    // The detector should have emitted at least one close.
    expect(ev.closesEmitted).toBeGreaterThanOrEqual(1);

    const marker = getCloseMarker(db, sessionId);
    expect(marker).toBeDefined();
    expect(marker!.metadata_json).toContain('"close_reason":"idle_timeout"');
    // CRITICAL: must NOT be the clean_endsession path (which is the
    // SessionEnd-hook contract — different code path, different reason).
    expect(marker!.metadata_json).not.toContain('"close_reason":"clean_endsession"');
  });

  it('session with stale heartbeat AND fresh JSONL writes does NOT emit idle_timeout', () => {
    // Negative case: if jsonl_write_ts is still fresh, the session is still
    // alive even if last_heartbeat_ts is stale (composition rule guard).
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `UPDATE sessions
          SET status = 'active',
              last_heartbeat_ts = ?,
              last_jsonl_write_ts = ?
        WHERE session_id = ?`
    ).run(now - (LOCKED_DEFAULTS.tHeartbeat + 60), now, sessionId);

    runBoundaryTick(db, LOCKED_DEFAULTS, {
      now,
      resolvePid: () => 12345,
    });

    const marker = getCloseMarker(db, sessionId);
    if (marker) {
      expect(marker.metadata_json).not.toContain('"close_reason":"idle_timeout"');
    }
  });

  it('cursor row materializes after idle_timeout close', () => {
    const now = Math.floor(Date.now() / 1000);
    const idleStart = now - (LOCKED_DEFAULTS.tJsonl + LOCKED_DEFAULTS.tGrace + 60);
    db.prepare(
      `UPDATE sessions
          SET status = 'active',
              last_heartbeat_ts = ?,
              last_jsonl_write_ts = ?
        WHERE session_id = ?`
    ).run(idleStart, idleStart, sessionId);

    runBoundaryTick(db, LOCKED_DEFAULTS, {
      now,
      resolvePid: () => null,
    });

    const cursor = db.prepare(
      `SELECT last_close_event_id FROM episode_boundary_cursor WHERE project = ? AND session_id = ?`
    ).get(project, sessionId) as { last_close_event_id: number | null } | undefined;
    expect(cursor).toBeDefined();
    expect(cursor!.last_close_event_id).not.toBeNull();
  });

  it('session.status flips to completed after close marker fires', () => {
    const now = Math.floor(Date.now() / 1000);
    const idleStart = now - (LOCKED_DEFAULTS.tJsonl + LOCKED_DEFAULTS.tGrace + 60);
    db.prepare(
      `UPDATE sessions
          SET status = 'active',
              last_heartbeat_ts = ?,
              last_jsonl_write_ts = ?
        WHERE session_id = ?`
    ).run(idleStart, idleStart, sessionId);

    runBoundaryTick(db, LOCKED_DEFAULTS, {
      now,
      resolvePid: () => null,
    });

    const session = db.prepare(
      `SELECT status FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { status: string };
    expect(session.status).toBe('completed');
  });
});
