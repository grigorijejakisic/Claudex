import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { getIdleSessions, getUnprocessedSessions, hasIdleWarning } from '../../angel/session-monitor.js';
import { cachedPrepare } from '../../core/stmt-cache.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

describe('Angel Session Monitor', () => {
  let db: Database.Database;
  // Use ms precision — _epoch_ms columns store milliseconds.
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000); // seconds, for threshold comparisons

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('getIdleSessions', () => {
    it('returns empty array when no sessions exist', () => {
      expect(getIdleSessions(db, 1800)).toEqual([]);
    });

    it('returns idle active sessions', () => {
      // Create an active session with old observations
      const twoHoursAgoMs = nowMs - 7200_000;
      db.prepare(`INSERT INTO sessions (session_id, project, status, created_at_epoch_ms) VALUES (?, ?, 'active', ?)`).run('idle-1', 'test-proj', twoHoursAgoMs);
      db.prepare(`INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, timestamp_epoch_ms) VALUES (?, ?, 'Read', 'code', 'test', 'test', 3, ?)`).run('idle-1', 'test-proj', twoHoursAgoMs);

      const idle = getIdleSessions(db, 1800); // 30 min threshold
      expect(idle.length).toBe(1);
      expect(idle[0].session_id).toBe('idle-1');
      expect(idle[0].idle_minutes).toBeGreaterThan(60);
    });

    it('excludes recently active sessions', () => {
      db.prepare(`INSERT INTO sessions (session_id, project, status, created_at_epoch_ms) VALUES (?, ?, 'active', ?)`).run('active-1', 'test-proj', nowMs);
      db.prepare(`INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, timestamp_epoch_ms) VALUES (?, ?, 'Read', 'code', 'test', 'test', 3, ?)`).run('active-1', 'test-proj', nowMs);

      const idle = getIdleSessions(db, 1800);
      expect(idle.length).toBe(0);
    });

    it('excludes completed sessions', () => {
      const twoHoursAgoMs = nowMs - 7200_000;
      db.prepare(`INSERT INTO sessions (session_id, project, status, created_at_epoch_ms, ended_at_epoch_ms) VALUES (?, ?, 'completed', ?, ?)`).run('done-1', 'test-proj', twoHoursAgoMs, twoHoursAgoMs + 3600_000);

      const idle = getIdleSessions(db, 1800);
      expect(idle.length).toBe(0);
    });
  });

  describe('getUnprocessedSessions', () => {
    it('returns completed sessions without angel_processed event', () => {
      const oneHourAgoMs = nowMs - 3600_000;
      db.prepare(`INSERT INTO sessions (session_id, project, status, created_at_epoch_ms, ended_at_epoch_ms) VALUES (?, ?, 'completed', ?, ?)`).run('completed-1', 'test-proj', oneHourAgoMs, nowMs);
      db.prepare(`INSERT INTO conversation_turns (session_id, project, turn_number, user_text) VALUES (?, ?, 1, 'hello')`).run('completed-1', 'test-proj');

      const unprocessed = getUnprocessedSessions(db);
      expect(unprocessed.length).toBe(1);
      expect(unprocessed[0].session_id).toBe('completed-1');
    });

    it('excludes sessions already processed by Angel', () => {
      const oneHourAgoMs = nowMs - 3600_000;
      db.prepare(`INSERT INTO sessions (session_id, project, status, created_at_epoch_ms, ended_at_epoch_ms) VALUES (?, ?, 'completed', ?, ?)`).run('processed-1', 'test-proj', oneHourAgoMs, nowMs);
      db.prepare(`INSERT INTO conversation_turns (session_id, project, turn_number, user_text) VALUES (?, ?, 1, 'hello')`).run('processed-1', 'test-proj');

      // Mark as processed via raw INSERT (markSessionProcessed was deleted
      // in Phase 4 Plan 09 — the helper had zero surviving production callers).
      db.prepare(
        `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
         VALUES (?, ?, 'angel_processed', 'angel', 'processed', NULL)`,
      ).run('processed-1', 'test-proj');

      const unprocessed = getUnprocessedSessions(db);
      expect(unprocessed.length).toBe(0);
    });

    it('excludes sessions with no conversation turns', () => {
      const oneHourAgoMs = nowMs - 3600_000;
      db.prepare(`INSERT INTO sessions (session_id, project, status, created_at_epoch_ms, ended_at_epoch_ms) VALUES (?, ?, 'completed', ?, ?)`).run('empty-1', 'test-proj', oneHourAgoMs, nowMs);

      const unprocessed = getUnprocessedSessions(db);
      expect(unprocessed.length).toBe(0);
    });
  });

  describe('hasIdleWarning', () => {
    it('returns false when no warnings exist', () => {
      expect(hasIdleWarning(db, 'session-1')).toBe(false);
    });

    it('returns true when idle warning was sent', () => {
      db.prepare(
        `INSERT INTO session_messages (target_session, sender, message_type, content, priority) VALUES (?, 'angel', 'advisory', 'Session has been idle for 30 minutes', 'advisory')`
      ).run('session-1');

      expect(hasIdleWarning(db, 'session-1')).toBe(true);
    });
  });
});
