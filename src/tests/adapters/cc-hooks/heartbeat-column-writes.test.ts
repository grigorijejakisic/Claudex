/**
 * Phase 6 EBD-02 regression test: heartbeat column writes + clean_endsession
 * close marker emission.
 *
 * Tests the SQL surfaces the 5 hooks (UserPromptSubmit / PreToolUse /
 * PostToolUse / Stop / SessionEnd) execute, NOT the wrapHook entry points
 * themselves (those read stdin and would hang in test contexts).
 *
 * Coverage:
 *   1-4: each non-terminal hook's UPDATE runs and bumps last_heartbeat_ts.
 *     5: emitCleanEndsessionClose() — heartbeat bump + status='completed'
 *        + episodic_events row + cursor advance, all in one transaction.
 *     6: atomicity — when a transactional INSERT throws (FK / CHECK / lock),
 *        no partial state remains; the helper does NOT throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { cachedPrepare } from '../../../core/stmt-cache.js';
import { emitCleanEndsessionClose } from '../../../adapters/cc-hooks/session-end-close-marker.js';

function bumpHeartbeat(db: Database.Database, sessionId: string): void {
  const now = Math.floor(Date.now() / 1000);
  cachedPrepare(db,
    `UPDATE sessions SET last_heartbeat_ts = ? WHERE session_id = ?`
  ).run(now, sessionId);
}

describe('Phase 6 EBD-02 — heartbeat column writes', () => {
  let db: Database.Database;
  const sessionId = 'sess-phase6';
  const project = 'proj-a';

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    db.prepare(
      `INSERT INTO sessions (session_id, project, status, created_at_epoch_ms)
       VALUES (?, ?, 'active', ?)`
    ).run(sessionId, project, Math.floor(Date.now() / 1000) - 100);
  });

  afterEach(() => { db.close(); });

  it('UserPromptSubmit-style heartbeat write bumps last_heartbeat_ts', () => {
    const before = (db.prepare(
      `SELECT last_heartbeat_ts FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { last_heartbeat_ts: number | null }).last_heartbeat_ts;
    expect(before).toBeNull();
    bumpHeartbeat(db, sessionId);
    const after = (db.prepare(
      `SELECT last_heartbeat_ts FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { last_heartbeat_ts: number }).last_heartbeat_ts;
    expect(after).toBeGreaterThan(0);
  });

  it('PreToolUse-style heartbeat write bumps last_heartbeat_ts', () => {
    bumpHeartbeat(db, sessionId);
    const ts = (db.prepare(
      `SELECT last_heartbeat_ts FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { last_heartbeat_ts: number }).last_heartbeat_ts;
    expect(ts).toBeGreaterThan(0);
  });

  it('PostToolUse-style heartbeat write bumps last_heartbeat_ts', () => {
    bumpHeartbeat(db, sessionId);
    const ts = (db.prepare(
      `SELECT last_heartbeat_ts FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { last_heartbeat_ts: number }).last_heartbeat_ts;
    expect(ts).toBeGreaterThan(0);
  });

  it('Stop-style heartbeat write bumps last_heartbeat_ts', () => {
    bumpHeartbeat(db, sessionId);
    const ts = (db.prepare(
      `SELECT last_heartbeat_ts FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { last_heartbeat_ts: number }).last_heartbeat_ts;
    expect(ts).toBeGreaterThan(0);
  });

  describe('SessionEnd / emitCleanEndsessionClose', () => {
    it('emits clean_endsession close marker, advances cursor, updates heartbeat + status', () => {
      emitCleanEndsessionClose(db, sessionId, project);

      const sess = db.prepare(
        `SELECT last_heartbeat_ts, status, ended_at_epoch_ms FROM sessions WHERE session_id = ?`
      ).get(sessionId) as { last_heartbeat_ts: number; status: string; ended_at_epoch_ms: number };
      expect(sess.last_heartbeat_ts).toBeGreaterThan(0);
      expect(sess.status).toBe('completed');
      expect(sess.ended_at_epoch_ms).toBeGreaterThan(0);

      const ev = db.prepare(
        `SELECT id, type, source, provenance, metadata_json
           FROM episodic_events
          WHERE session_id = ? AND source = 'angel-boundary'`
      ).get(sessionId) as { id: number; type: string; source: string; provenance: string; metadata_json: string };
      expect(ev).toBeDefined();
      expect(ev.type).toBe('environmental_event');
      expect(ev.provenance).toBe('environmental');
      expect(ev.metadata_json).toContain('clean_endsession');

      const cur = db.prepare(
        `SELECT last_close_event_id, last_processed_event_ts_epoch
           FROM episode_boundary_cursor
          WHERE project = ? AND session_id = ?`
      ).get(project, sessionId) as { last_close_event_id: number; last_processed_event_ts_epoch: number };
      expect(cur).toBeDefined();
      expect(cur.last_close_event_id).toBe(ev.id);
      expect(cur.last_processed_event_ts_epoch).toBeGreaterThan(0);
    });

    it('atomicity — transaction failure leaves NO partial state and helper does NOT throw', () => {
      // Force the episodic_events INSERT to fail by violating the
      // provenance CHECK constraint. We do this by replacing the
      // episodic_events table with one that rejects 'environmental'.
      // Simpler: drop the table mid-write — the transaction will throw
      // because the cached prepared statement references a now-missing
      // table. The outer try/catch must swallow + record telemetry.
      db.exec(`DROP TABLE episodic_events`);

      // Pre-state: heartbeat null, status active.
      const beforeStatus = (db.prepare(
        `SELECT status FROM sessions WHERE session_id = ?`
      ).get(sessionId) as { status: string }).status;
      expect(beforeStatus).toBe('active');

      // Act: helper must not throw.
      expect(() => emitCleanEndsessionClose(db, sessionId, project)).not.toThrow();

      // Post-state: transaction rolled back. status still 'active',
      // last_heartbeat_ts still null, NO cursor row.
      const sess = db.prepare(
        `SELECT last_heartbeat_ts, status FROM sessions WHERE session_id = ?`
      ).get(sessionId) as { last_heartbeat_ts: number | null; status: string };
      expect(sess.status).toBe('active');
      expect(sess.last_heartbeat_ts).toBeNull();

      const cur = db.prepare(
        `SELECT 1 FROM episode_boundary_cursor WHERE project = ? AND session_id = ?`
      ).get(project, sessionId);
      expect(cur).toBeUndefined();
    });
  });
});
