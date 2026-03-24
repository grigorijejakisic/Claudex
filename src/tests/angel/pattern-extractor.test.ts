import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { getSessionTurns } from '../../angel/pattern-extractor.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

describe('Angel Pattern Extractor', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('getSessionTurns', () => {
    it('returns empty array for non-existent session', () => {
      expect(getSessionTurns(db, 'nonexistent')).toEqual([]);
    });

    it('returns turns ordered by turn_number', () => {
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text) VALUES (?, ?, ?, ?, ?)`
      ).run('s1', 'proj', 2, 'second user msg', 'second assistant msg');
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text) VALUES (?, ?, ?, ?, ?)`
      ).run('s1', 'proj', 1, 'first user msg', 'first assistant msg');

      const turns = getSessionTurns(db, 's1');
      expect(turns.length).toBe(2);
      expect(turns[0].turn_number).toBe(1);
      expect(turns[0].user_text).toBe('first user msg');
      expect(turns[1].turn_number).toBe(2);
    });

    it('returns only turns for the requested session', () => {
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text) VALUES (?, ?, ?, ?)`
      ).run('s1', 'proj', 1, 'session 1');
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text) VALUES (?, ?, ?, ?)`
      ).run('s2', 'proj', 1, 'session 2');

      const turns = getSessionTurns(db, 's1');
      expect(turns.length).toBe(1);
      expect(turns[0].user_text).toBe('session 1');
    });
  });
});
