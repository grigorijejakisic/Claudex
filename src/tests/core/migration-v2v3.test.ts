/**
 * Tests for the v2→v3 migration (artifact_type CHECK constraint extension).
 * Creates a DB with the old CHECK constraint, runs migration, verifies
 * new types can be inserted and user_version is correct.
 */

import Database from 'better-sqlite3';
import { runMigrations, initializeSchema } from '../../core/migrations.js';
import { addJournalEntry, searchJournalFTS } from '../../core/journal.js';

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

  it('sets user_version to latest after successful migration', () => {
    const db = createV2ArtifactsDb();
    try {
      runMigrations(db);
      const row = db.pragma('user_version') as Array<{ user_version: number }>;
      // v2→v3→...→v8 (latest)
      expect(row[0].user_version).toBe(8);
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

describe('migrateV7toV8 (Evolved Flow)', () => {
  it('adds recall_text column to session_journal', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('journal_mode = WAL');
      initializeSchema(db);

      const cols = db.pragma('table_info(session_journal)') as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain('recall_text');
    } finally {
      db.close();
    }
  });

  it('creates session_journal_fts virtual table', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('journal_mode = WAL');
      initializeSchema(db);

      const fts = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_journal_fts'"
      ).get() as { name: string } | undefined;
      expect(fts).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('FTS5 sync triggers index new entries with recall_text', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('journal_mode = WAL');
      initializeSchema(db);

      // Insert with recall_text
      addJournalEntry(db, 's1', 'proj', 'flow',
        'Designed recall metadata system',
        undefined,
        'how I remember vs how you remember | upgrade flow | recall aliases',
      );

      // FTS5 should find it by recall_text content
      const results = searchJournalFTS(db, 'upgrade flow');
      expect(results.length).toBe(1);
      expect(results[0].recall_text).toContain('upgrade flow');
    } finally {
      db.close();
    }
  });

  it('FTS5 finds entries by content even without recall_text', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('journal_mode = WAL');
      initializeSchema(db);

      addJournalEntry(db, 's1', 'proj', 'flow', 'Pivoted from REST to gRPC after performance analysis');

      const results = searchJournalFTS(db, 'REST gRPC performance');
      expect(results.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('recall_text gives higher relevance than content-only match', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('journal_mode = WAL');
      initializeSchema(db);

      // Entry 1: keyword only in content
      addJournalEntry(db, 's1', 'proj', 'flow',
        'Worked on the openclaw gateway startup script VBS deprecation',
      );

      // Entry 2: keyword in recall_text (human recall cue)
      addJournalEntry(db, 's2', 'proj', 'flow',
        'Fixed Windows Script Host error by replacing VBS with BAT',
        undefined,
        'openclaw script problem | that annoying startup popup | vbs deprecation fix',
      );

      // Search with human recall cue
      const results = searchJournalFTS(db, 'openclaw script problem');
      expect(results.length).toBe(2);
      // recall_text match should rank first (BM25 weight 2.0 vs 1.0)
      expect(results[0].recall_text).toContain('openclaw script problem');
    } finally {
      db.close();
    }
  });

  it('searchJournalFTS filters by project when specified', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('journal_mode = WAL');
      initializeSchema(db);

      addJournalEntry(db, 's1', 'proj-a', 'flow', 'alpha work', undefined, 'alpha recall');
      addJournalEntry(db, 's2', 'proj-b', 'flow', 'beta work', undefined, 'beta recall');

      const results = searchJournalFTS(db, 'work recall', 'proj-a');
      expect(results.length).toBe(1);
      expect(results[0].project).toBe('proj-a');
    } finally {
      db.close();
    }
  });

  it('V7 DB migrates to V8 with recall_text + FTS5', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('journal_mode = WAL');

      // Simulate V7 state: session_journal exists without recall_text
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'active',
          observation_count INTEGER NOT NULL DEFAULT 0,
          created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
          project TEXT NOT NULL DEFAULT '__global__',
          scope TEXT NOT NULL DEFAULT 'unknown',
          cwd TEXT NOT NULL DEFAULT '.',
          source TEXT, adapter TEXT, session_summary TEXT, ended_at_epoch INTEGER
        );
        CREATE TABLE session_journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          entry_type TEXT NOT NULL CHECK (entry_type IN ('flow', 'milestone', 'summary')),
          content TEXT NOT NULL,
          metadata TEXT,
          timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_versions (version, applied_at) VALUES (300, datetime());
      `);
      db.pragma('user_version = 7');

      // Insert pre-migration data
      db.prepare(
        "INSERT INTO session_journal (session_id, project, entry_type, content) VALUES (?, ?, 'flow', ?)"
      ).run('old-session', 'proj', 'Old flow entry without recall_text');

      // Run migration
      runMigrations(db);

      // Verify V8 schema
      const version = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
      expect(version).toBe(8);

      // Verify recall_text column exists
      const cols = db.pragma('table_info(session_journal)') as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain('recall_text');

      // Verify FTS5 table exists
      const fts = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_journal_fts'"
      ).get();
      expect(fts).toBeDefined();

      // Verify old data is searchable via FTS5
      const results = searchJournalFTS(db, 'old flow recall');
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Old flow entry');
    } finally {
      db.close();
    }
  });
});
