import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { sendMessage, getPendingMessages, markMessagesDelivered, sendIdleWarning } from '../../angel/message-sender.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

describe('Angel Message Sender', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('sendMessage', () => {
    it('inserts a message into session_messages', () => {
      const result = sendMessage(db, 'session-1', 'Hello from Angel');
      expect(result).toBe(true);

      const row = db.prepare('SELECT * FROM session_messages WHERE target_session = ?').get('session-1') as Record<string, unknown>;
      expect(row.content).toBe('Hello from Angel');
      expect(row.sender).toBe('angel');
      expect(row.message_type).toBe('advisory');
      expect(row.priority).toBe('normal');
      expect(row.delivered_at_epoch).toBeNull();
    });

    it('supports different message types and priorities', () => {
      sendMessage(db, 'session-1', 'urgent msg', 'command', 'urgent');
      const row = db.prepare('SELECT * FROM session_messages WHERE target_session = ?').get('session-1') as Record<string, unknown>;
      expect(row.message_type).toBe('command');
      expect(row.priority).toBe('urgent');
    });
  });

  describe('getPendingMessages', () => {
    it('returns undelivered messages ordered by priority', () => {
      sendMessage(db, 'session-1', 'normal msg', 'advisory', 'normal');
      sendMessage(db, 'session-1', 'urgent msg', 'advisory', 'urgent');

      const pending = getPendingMessages(db, 'session-1');
      expect(pending.length).toBe(2);
      expect(pending[0].content).toBe('urgent msg'); // urgent first
      expect(pending[1].content).toBe('normal msg');
    });

    it('returns empty for non-existent session', () => {
      expect(getPendingMessages(db, 'nonexistent')).toEqual([]);
    });

    it('excludes already delivered messages', () => {
      sendMessage(db, 'session-1', 'msg 1');
      sendMessage(db, 'session-1', 'msg 2');

      const pending = getPendingMessages(db, 'session-1');
      markMessagesDelivered(db, [pending[0].id]);

      const remaining = getPendingMessages(db, 'session-1');
      expect(remaining.length).toBe(1);
      expect(remaining[0].content).toBe('msg 2');
    });
  });

  describe('markMessagesDelivered', () => {
    it('sets delivered_at_epoch on messages', () => {
      sendMessage(db, 'session-1', 'msg 1');
      const pending = getPendingMessages(db, 'session-1');
      markMessagesDelivered(db, [pending[0].id]);

      const row = db.prepare('SELECT delivered_at_epoch FROM session_messages WHERE id = ?').get(pending[0].id) as Record<string, unknown>;
      expect(row.delivered_at_epoch).toBeGreaterThan(0);
    });

    it('handles empty array gracefully', () => {
      markMessagesDelivered(db, []);
      // No error thrown
    });
  });

  describe('sendIdleWarning', () => {
    it('sends a formatted idle warning', () => {
      const result = sendIdleWarning(db, 'session-1', 45, 'building Angel');
      expect(result).toBe(true);

      const pending = getPendingMessages(db, 'session-1');
      expect(pending.length).toBe(1);
      expect(pending[0].content).toContain('45 minutes');
      expect(pending[0].content).toContain('building Angel');
      expect(pending[0].content).toContain('/endsession');
    });
  });
});
