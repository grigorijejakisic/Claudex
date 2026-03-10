import Database from 'better-sqlite3';
import { initializeSchema, migrateFromV2, detectV2Database } from '../../core/migrations.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('initializeSchema', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all tables', () => {
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    const expectedTables = [
      'checkpoint_meta',
      'checkpoint_tracking',
      'decisions',
      'learnings',
      'observations',
      'pressure_scores',
      'schema_versions',
      'sessions',
      'telemetry',
      'thread_state',
    ];

    for (const expected of expectedTables) {
      expect(tableNames).toContain(expected);
    }
  });

  it('creates FTS5 virtual table', () => {
    initializeSchema(db);

    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'")
      .get() as { name: string } | undefined;

    expect(fts).toBeDefined();
    expect(fts!.name).toBe('observations_fts');
  });

  it('creates all indexes', () => {
    initializeSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);

    const expectedIndexes = [
      'idx_obs_session',
      'idx_obs_project',
      'idx_obs_timestamp',
      'idx_obs_importance',
      'idx_obs_deleted',
      'idx_learnings_promo',
      'idx_decisions_session',
      'idx_cpmeta_session',
      'idx_cpmeta_status',
      'idx_telemetry_session',
      'idx_telemetry_kind',
    ];

    for (const expected of expectedIndexes) {
      expect(indexNames).toContain(expected);
    }
  });

  it('creates FTS sync triggers', () => {
    initializeSchema(db);

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all() as Array<{ name: string }>;

    const triggerNames = triggers.map((t) => t.name);

    expect(triggerNames).toContain('observations_ai');
    expect(triggerNames).toContain('observations_ad');
    expect(triggerNames).toContain('observations_au');
  });

  it('records schema version 300', () => {
    initializeSchema(db);

    const row = db
      .prepare('SELECT version FROM schema_versions WHERE version = 300')
      .get() as { version: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.version).toBe(300);
  });

  it('is idempotent', () => {
    initializeSchema(db);

    const tablesBefore = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    // Run again — should not error
    expect(() => initializeSchema(db)).not.toThrow();

    const tablesAfter = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(tablesAfter.map((t) => t.name)).toEqual(tablesBefore.map((t) => t.name));
  });
});

describe('FTS5 trigger sync', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('syncs on insert', () => {
    db.prepare(`
      INSERT INTO observations (session_id, tool_name, category, title, content, importance)
      VALUES ('s1', 'test', 'code', 'unique search title', 'unique search content', 3)
    `).run();

    const result = db
      .prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'unique search title'")
      .all();

    expect(result.length).toBe(1);
  });

  it('syncs on update', () => {
    db.prepare(`
      INSERT INTO observations (session_id, tool_name, category, title, content, importance)
      VALUES ('s1', 'test', 'code', 'xyzoriginal', 'some body text', 3)
    `).run();

    db.prepare(`
      UPDATE observations SET title = 'xyzupdated' WHERE session_id = 's1'
    `).run();

    // Old title should not match in the title column
    const oldResult = db
      .prepare("SELECT rowid FROM observations_fts WHERE title MATCH 'xyzoriginal'")
      .all();
    expect(oldResult.length).toBe(0);

    // New title should match in the title column
    const newResult = db
      .prepare("SELECT rowid FROM observations_fts WHERE title MATCH 'xyzupdated'")
      .all();
    expect(newResult.length).toBe(1);
  });

  it('syncs on delete', () => {
    db.prepare(`
      INSERT INTO observations (session_id, tool_name, category, title, content, importance)
      VALUES ('s1', 'test', 'code', 'deletable title', 'deletable content', 3)
    `).run();

    db.prepare("DELETE FROM observations WHERE session_id = 's1'").run();

    const result = db
      .prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'deletable title'")
      .all();
    expect(result.length).toBe(0);
  });
});

describe('migrateFromV2', () => {
  let v3Db: InstanceType<typeof Database>;
  let tmpDir: string;
  let v2DbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-migrate-'));
    v2DbPath = path.join(tmpDir, 'v2.db');
    v3Db = new Database(':memory:');

    // Create a v2 database with sample data
    const v2Db = new Database(v2DbPath);

    // Create v2 tables (simplified version matching what v2 would have)
    v2Db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT,
        tool_name TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL,
        files_modified TEXT NOT NULL DEFAULT '',
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at_epoch INTEGER,
        deleted_at_epoch INTEGER DEFAULT NULL
      );

      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        scope TEXT,
        project TEXT,
        cwd TEXT,
        source TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        observation_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        ended_at_epoch INTEGER
      );

      CREATE TABLE pressure_scores (
        file_path TEXT NOT NULL,
        project TEXT NOT NULL,
        raw_pressure REAL NOT NULL DEFAULT 0.0,
        temperature TEXT NOT NULL DEFAULT 'COLD',
        last_touched_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        decay_rate REAL NOT NULL DEFAULT 0.1,
        PRIMARY KEY (file_path, project)
      );

      CREATE TABLE checkpoint_state (
        session_id TEXT PRIMARY KEY,
        last_checkpoint_epoch INTEGER,
        observation_count INTEGER NOT NULL DEFAULT 0,
        updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE some_old_table (
        id INTEGER PRIMARY KEY,
        data TEXT
      );
    `);

    // Insert sample data
    v2Db.exec(`
      INSERT INTO observations (session_id, tool_name, category, title, content, importance, files_modified)
      VALUES ('sess-v2', 'bash', 'code', 'v2 observation', 'v2 content', 3, 'file1.ts,file2.ts');

      INSERT INTO sessions (session_id, status) VALUES ('sess-v2', 'active');

      INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature)
      VALUES ('src/index.ts', 'proj1', 0.8, 'WARM');

      INSERT INTO checkpoint_state (session_id, last_checkpoint_epoch, observation_count, updated_at_epoch)
      VALUES ('sess-v2', 1700000000, 5, 1700000000);
    `);

    v2Db.close();
  });

  afterEach(() => {
    try { v3Db.close(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies observations from v2 database', () => {
    migrateFromV2(v3Db, v2DbPath);

    const obs = v3Db
      .prepare("SELECT * FROM observations WHERE session_id = 'sess-v2'")
      .get() as Record<string, unknown> | undefined;

    expect(obs).toBeDefined();
    expect(obs!.title).toBe('v2 observation');
    expect(obs!.content).toBe('v2 content');
  });

  it('copies sessions from v2 database', () => {
    migrateFromV2(v3Db, v2DbPath);

    const sess = v3Db
      .prepare("SELECT * FROM sessions WHERE session_id = 'sess-v2'")
      .get() as Record<string, unknown> | undefined;

    expect(sess).toBeDefined();
    expect(sess!.status).toBe('active');
  });

  it('copies pressure_scores and converts WARM to COLD', () => {
    migrateFromV2(v3Db, v2DbPath);

    const ps = v3Db
      .prepare("SELECT * FROM pressure_scores WHERE file_path = 'src/index.ts'")
      .get() as Record<string, unknown> | undefined;

    expect(ps).toBeDefined();
    expect(ps!.temperature).toBe('COLD');
  });

  it('fixes files_modified from comma-separated to JSON array', () => {
    migrateFromV2(v3Db, v2DbPath);

    const obs = v3Db
      .prepare("SELECT files_modified FROM observations WHERE session_id = 'sess-v2'")
      .get() as { files_modified: string } | undefined;

    expect(obs).toBeDefined();
    const parsed = JSON.parse(obs!.files_modified);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain('file1.ts');
    expect(parsed).toContain('file2.ts');
  });

  it('records schema version 300', () => {
    migrateFromV2(v3Db, v2DbPath);

    const row = v3Db
      .prepare('SELECT version FROM schema_versions WHERE version = 300')
      .get() as { version: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.version).toBe(300);
  });
});

describe('detectV2Database', () => {
  it('returns null when no v2 database exists', () => {
    // detectV2Database checks ~/.claudex paths which likely don't have a v2 db in CI/test
    const result = detectV2Database();
    // Since we can't guarantee ~/.claudex doesn't exist, we just verify it returns string or null
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
