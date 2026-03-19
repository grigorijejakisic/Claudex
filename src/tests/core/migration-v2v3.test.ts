/**
 * Tests for the v2→v3 migration (artifact_type CHECK constraint extension).
 * Creates a DB with the old CHECK constraint, runs migration, verifies
 * new types can be inserted and user_version is correct.
 */

import Database from 'better-sqlite3';
import { runMigrations } from '../../core/migrations.js';

/** Creates a DB with v2-era artifacts table (old CHECK constraint). */
function createV2ArtifactsDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Minimal schema with old CHECK constraint
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      observation_count INTEGER NOT NULL DEFAULT 0,
      created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      source TEXT,
      adapter TEXT
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT,
      tool_name TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      files_modified TEXT NOT NULL DEFAULT '[]',
      timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at_epoch INTEGER,
      deleted_at_epoch INTEGER,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, content, content=observations, content_rowid=id
    );
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      artifact_type TEXT NOT NULL CHECK (artifact_type IN (
        'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone'
      )),
      artifact_ref TEXT,
      summary TEXT NOT NULL,
      content TEXT,
      state TEXT NOT NULL DEFAULT 'fresh'
        CHECK (state IN ('fresh', 'packed', 'materialized')),
      ttl INTEGER NOT NULL DEFAULT 3,
      importance INTEGER NOT NULL DEFAULT 3,
      timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      last_materialized_epoch INTEGER
    );
    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '__global__',
      source_type TEXT,
      source_ref TEXT,
      promotion_count INTEGER NOT NULL DEFAULT 1,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE pressure_scores (
      file_path TEXT NOT NULL,
      project TEXT NOT NULL,
      raw_pressure REAL NOT NULL DEFAULT 0.0,
      temperature TEXT NOT NULL DEFAULT 'COLD',
      last_touched_epoch INTEGER NOT NULL DEFAULT 0,
      decay_rate REAL NOT NULL DEFAULT 0.1,
      PRIMARY KEY (file_path, project)
    );
    CREATE TABLE thread_state (
      session_id TEXT PRIMARY KEY,
      topic TEXT,
      summary TEXT,
      key_exchanges TEXT NOT NULL DEFAULT '[]',
      updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT,
      latency_ms INTEGER,
      timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      adapter TEXT
    );
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT
    );
    INSERT INTO schema_versions (version, applied_at) VALUES (300, datetime());
  `);

  // Set user_version to 2 (pre-migration)
  db.pragma('user_version = 2');

  // Insert some existing artifacts to verify data preservation
  db.prepare(
    `INSERT INTO sessions (session_id) VALUES (?)`
  ).run('test-session');

  db.prepare(
    `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance)
     VALUES (?, ?, ?, ?, 'fresh', 4, 3)`
  ).run('test-session', 'test-project', 'observation', 'existing artifact');

  return db;
}

describe('migrateV2toV3', () => {
  it('extends CHECK constraint to allow new artifact types', () => {
    const db = createV2ArtifactsDb();
    try {
      // Before migration: new types should fail
      expect(() => {
        db.prepare(
          `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance)
           VALUES ('s', 'p', 'memory_file', 'test', 'packed', 0, 3)`
        ).run();
      }).toThrow();

      // Run migration
      runMigrations(db);

      // After migration: new types should succeed
      expect(() => {
        db.prepare(
          `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance)
           VALUES ('s', 'p', 'memory_file', 'test memory', 'packed', 0, 3)`
        ).run();
      }).not.toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance)
           VALUES ('s', 'p', 'session_log', 'test session', 'packed', 0, 3)`
        ).run();
      }).not.toThrow();

      expect(() => {
        db.prepare(
          `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance)
           VALUES ('s', 'p', 'handoff', 'test handoff', 'packed', 0, 3)`
        ).run();
      }).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('sets user_version to 3 after successful migration', () => {
    const db = createV2ArtifactsDb();
    try {
      runMigrations(db);
      const row = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(row[0].user_version).toBe(3);
    } finally {
      db.close();
    }
  });

  it('preserves existing artifacts during table rebuild', () => {
    const db = createV2ArtifactsDb();
    try {
      // Verify existing data before migration
      const before = db.prepare(`SELECT COUNT(*) as c FROM artifacts`).get() as { c: number };
      expect(before.c).toBe(1);

      runMigrations(db);

      // Verify existing data preserved after migration
      const after = db.prepare(`SELECT * FROM artifacts WHERE summary = 'existing artifact'`).get() as { summary: string; artifact_type: string } | undefined;
      expect(after).toBeDefined();
      expect(after!.artifact_type).toBe('observation');
    } finally {
      db.close();
    }
  });

  it('is idempotent — running on already-migrated DB is a no-op', () => {
    const db = createV2ArtifactsDb();
    try {
      runMigrations(db);
      // Insert a new-type artifact
      db.prepare(
        `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance)
         VALUES ('s', 'p', 'memory_file', 'after first migration', 'packed', 0, 3)`
      ).run();

      // Run migration again — should not throw or lose data
      runMigrations(db);

      const count = db.prepare(`SELECT COUNT(*) as c FROM artifacts`).get() as { c: number };
      expect(count.c).toBe(2); // original + memory_file
    } finally {
      db.close();
    }
  });
});
