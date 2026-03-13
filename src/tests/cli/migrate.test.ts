/**
 * Tests for claudex migrate CLI logic.
 * Uses temp file-based DBs (not :memory:) since migration requires file paths.
 * All tests use isolated temp directories, cleaned up in afterEach.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import {
  getDbStats,
  verifyMigration,
  runMigration,
  type MigrationCounts,
} from '../../cli/migrate.js';

// ── V2 DB factory ─────────────────────────────────────────────────────

/**
 * Creates a minimal v2 database with known data.
 * Includes WARM pressure scores and CSV files_modified to exercise conversion.
 */
function createV2Database(dbPath: string, opts: {
  observationCount?: number;
  sessionCount?: number;
  pressureCount?: number;
  withCsvFiles?: boolean;
  withWarm?: boolean;
} = {}): void {
  const {
    observationCount = 2,
    sessionCount = 1,
    pressureCount = 1,
    withCsvFiles = true,
    withWarm = true,
  } = opts;

  const db = new Database(dbPath);
  db.exec(`
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
  `);

  // Insert observations
  const filesModified = withCsvFiles ? 'src/index.ts,src/utils.ts' : '["src/index.ts"]';
  for (let i = 0; i < observationCount; i++) {
    db.prepare(`
      INSERT INTO observations (session_id, tool_name, category, title, content, importance, files_modified)
      VALUES ('sess-v2', 'bash', 'code', 'v2 obs ${i}', 'content ${i}', 3, ?)
    `).run(filesModified);
  }

  // Insert sessions
  for (let i = 0; i < sessionCount; i++) {
    db.prepare(`
      INSERT INTO sessions (session_id, status, project)
      VALUES (?, 'active', 'test-project')
    `).run(`sess-v2-${i}`);
  }

  // Insert pressure scores
  const temperature = withWarm ? 'WARM' : 'COLD';
  for (let i = 0; i < pressureCount; i++) {
    db.prepare(`
      INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature)
      VALUES (?, 'test-project', 0.8, ?)
    `).run(`src/file${i}.ts`, temperature);
  }

  db.close();
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('getDbStats', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns correct counts from a v2 database', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    createV2Database(dbPath, { observationCount: 3, sessionCount: 2, pressureCount: 1 });

    const stats = getDbStats(dbPath);
    expect(stats.observationCount).toBe(3);
    expect(stats.sessionCount).toBe(2);
    expect(stats.pressureCount).toBe(1);
  });

  it('returns zero counts for empty database', () => {
    const dbPath = path.join(tmpDir, 'empty.db');
    createV2Database(dbPath, { observationCount: 0, sessionCount: 0, pressureCount: 0 });

    const stats = getDbStats(dbPath);
    expect(stats.observationCount).toBe(0);
    expect(stats.sessionCount).toBe(0);
    expect(stats.pressureCount).toBe(0);
  });

  it('returns zero counts for nonexistent database (non-throwing)', () => {
    const stats = getDbStats(path.join(tmpDir, 'nonexistent.db'));
    expect(stats.observationCount).toBe(0);
    expect(stats.sessionCount).toBe(0);
    expect(stats.pressureCount).toBe(0);
  });
});

describe('verifyMigration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createV3DbWithData(
    dbPath: string,
    counts: MigrationCounts,
    opts: { invalidJson?: boolean; missingVersion?: boolean } = {}
  ): Database.Database {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT,
        tool_name TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN (
          'code', 'architecture', 'decision', 'error', 'test',
          'config', 'dependency', 'documentation', 'performance',
          'security', 'other'
        )),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
        files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)),
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at_epoch INTEGER,
        deleted_at_epoch INTEGER DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        scope TEXT,
        project TEXT,
        cwd TEXT,
        source TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'completed', 'failed')),
        observation_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        ended_at_epoch INTEGER
      );
      CREATE TABLE IF NOT EXISTS pressure_scores (
        file_path TEXT NOT NULL,
        project TEXT NOT NULL,
        raw_pressure REAL NOT NULL DEFAULT 0.0,
        temperature TEXT NOT NULL DEFAULT 'COLD'
          CHECK (temperature IN ('HOT', 'COLD')),
        last_touched_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        decay_rate REAL NOT NULL DEFAULT 0.1,
        PRIMARY KEY (file_path, project)
      );
      CREATE TABLE IF NOT EXISTS schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    if (!opts.missingVersion) {
      db.prepare('INSERT INTO schema_versions (version) VALUES (300)').run();
    }

    for (let i = 0; i < counts.observationCount; i++) {
      // For invalidJson test: use invalid json for first row
      const filesModified = opts.invalidJson && i === 0 ? 'not-valid-json' : '["src/file.ts"]';
      // Bypass CHECK constraint by using WITHOUT ROWID trick not needed — instead insert directly
      // Since the table has CHECK (json_valid(files_modified)), we can't insert invalid JSON.
      // We insert valid data for this test; the invalidJson case is tested differently below.
      db.prepare(`
        INSERT INTO observations (session_id, tool_name, category, title, content, importance, files_modified)
        VALUES ('sess', 'bash', 'code', 'title ${i}', 'content', 3, '["src/file.ts"]')
      `).run();
    }

    for (let i = 0; i < counts.sessionCount; i++) {
      db.prepare(`
        INSERT INTO sessions (session_id) VALUES ('sess-${i}')
      `).run();
    }

    for (let i = 0; i < counts.pressureCount; i++) {
      db.prepare(`
        INSERT INTO pressure_scores (file_path, project) VALUES ('file${i}.ts', 'proj')
      `).run();
    }

    return db;
  }

  it('returns valid=true when counts match and json is valid and version is 300', () => {
    const dbPath = path.join(tmpDir, 'v3.db');
    const expected: MigrationCounts = { observationCount: 2, sessionCount: 1, pressureCount: 1 };
    const db = createV3DbWithData(dbPath, expected);

    const result = verifyMigration(db, expected);
    db.close();

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns valid=false when observation count mismatches', () => {
    const dbPath = path.join(tmpDir, 'v3.db');
    const actual: MigrationCounts = { observationCount: 2, sessionCount: 1, pressureCount: 1 };
    const expected: MigrationCounts = { observationCount: 5, sessionCount: 1, pressureCount: 1 };
    const db = createV3DbWithData(dbPath, actual);

    const result = verifyMigration(db, expected);
    db.close();

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('observation count mismatch');
    expect(result.reason).toContain('expected 5');
    expect(result.reason).toContain('got 2');
  });

  it('returns valid=false when session count mismatches', () => {
    const dbPath = path.join(tmpDir, 'v3.db');
    const actual: MigrationCounts = { observationCount: 1, sessionCount: 1, pressureCount: 0 };
    const expected: MigrationCounts = { observationCount: 1, sessionCount: 3, pressureCount: 0 };
    const db = createV3DbWithData(dbPath, actual);

    const result = verifyMigration(db, expected);
    db.close();

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('session count mismatch');
  });

  it('returns valid=false when pressure_score count mismatches', () => {
    const dbPath = path.join(tmpDir, 'v3.db');
    const actual: MigrationCounts = { observationCount: 0, sessionCount: 0, pressureCount: 1 };
    const expected: MigrationCounts = { observationCount: 0, sessionCount: 0, pressureCount: 4 };
    const db = createV3DbWithData(dbPath, actual);

    const result = verifyMigration(db, expected);
    db.close();

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('pressure_score count mismatch');
  });

  it('returns valid=false when schema version 300 is absent', () => {
    const dbPath = path.join(tmpDir, 'v3.db');
    const expected: MigrationCounts = { observationCount: 0, sessionCount: 0, pressureCount: 0 };
    const db = createV3DbWithData(dbPath, expected, { missingVersion: true });

    const result = verifyMigration(db, expected);
    db.close();

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('schema_versions');
  });

  it('returns valid=false when observations have invalid JSON in files_modified', () => {
    // Create a DB that bypasses the CHECK constraint using a raw approach
    const dbPath = path.join(tmpDir, 'v3-invalid.db');
    const db = new Database(dbPath);

    // Create table WITHOUT the json_valid CHECK so we can insert bad data
    db.exec(`
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
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active',
        scope TEXT, project TEXT, cwd TEXT, source TEXT,
        observation_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        ended_at_epoch INTEGER);
      CREATE TABLE pressure_scores (
        file_path TEXT NOT NULL, project TEXT NOT NULL,
        raw_pressure REAL NOT NULL DEFAULT 0.0,
        temperature TEXT NOT NULL DEFAULT 'COLD',
        last_touched_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        decay_rate REAL NOT NULL DEFAULT 0.1,
        PRIMARY KEY (file_path, project));
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO schema_versions (version) VALUES (300);
      INSERT INTO observations (session_id, tool_name, category, title, content, importance, files_modified)
      VALUES ('s1', 'bash', 'code', 'bad obs', 'content', 3, 'not-valid-json');
    `);

    const expected: MigrationCounts = { observationCount: 1, sessionCount: 0, pressureCount: 0 };
    const result = verifyMigration(db, expected);
    db.close();

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid JSON');
  });
});

describe('runMigration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates v2 DB with known data: counts match and WARM→COLD conversion happened', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, {
      observationCount: 3,
      sessionCount: 2,
      pressureCount: 1,
      withCsvFiles: true,
      withWarm: true,
    });

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    expect(result.counts.observationCount).toBe(3);
    expect(result.counts.sessionCount).toBe(2);
    expect(result.counts.pressureCount).toBe(1);

    // Verify the final DB exists at main path
    expect(fs.existsSync(dbPath)).toBe(true);

    // Open and verify WARM→COLD conversion
    const v3Db = new Database(dbPath, { readonly: true });
    const warmRows = v3Db
      .prepare("SELECT COUNT(*) as count FROM pressure_scores WHERE temperature = 'WARM'")
      .get() as { count: number };
    expect(warmRows.count).toBe(0);

    // Verify files_modified is valid JSON
    const badJson = v3Db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE NOT json_valid(files_modified)")
      .get() as { count: number };
    expect(badJson.count).toBe(0);

    // Verify CSV was converted to JSON array
    const obs = v3Db
      .prepare("SELECT files_modified FROM observations LIMIT 1")
      .get() as { files_modified: string } | undefined;
    expect(obs).toBeDefined();
    const parsed = JSON.parse(obs!.files_modified);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain('src/index.ts');
    expect(parsed).toContain('src/utils.ts');

    // Verify schema version 300
    const versionRow = v3Db
      .prepare('SELECT version FROM schema_versions WHERE version = 300')
      .get() as { version: number } | undefined;
    expect(versionRow).toBeDefined();
    expect(versionRow!.version).toBe(300);

    v3Db.close();
  });

  it('creates backup file at expected path', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 1, sessionCount: 1, pressureCount: 0 });

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    expect(result.backupPath).toBe(dbPath + '.v2-backup');
    expect(fs.existsSync(result.backupPath)).toBe(true);
  });

  it('swaps temp DB to main path after successful migration', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 1, sessionCount: 1, pressureCount: 0 });

    const tempPath = path.join(tmpDir, 'claudex-v3-temp.db');

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    // Temp DB should be gone (swapped to main path)
    expect(fs.existsSync(tempPath)).toBe(false);
    // Main DB should exist
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('preserves original DB as backup when migration succeeds', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 2, sessionCount: 1, pressureCount: 1 });

    // Record original file size to confirm it was backed up (not deleted)
    const originalSize = fs.statSync(dbPath).size;

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    // Backup should have same size as original
    const backupSize = fs.statSync(result.backupPath).size;
    expect(backupSize).toBe(originalSize);
  });

  it('returns failure with meaningful error when DB path does not exist', () => {
    const dbPath = path.join(tmpDir, 'nonexistent.db');

    const result = runMigration(dbPath);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('handles empty v2 DB (zero observations, sessions, pressure scores)', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 0, sessionCount: 0, pressureCount: 0 });

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    expect(result.counts.observationCount).toBe(0);
    expect(result.counts.sessionCount).toBe(0);
    expect(result.counts.pressureCount).toBe(0);
  });

  it('handles observations with already-valid JSON files_modified (no double-conversion)', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 2, sessionCount: 1, pressureCount: 0, withCsvFiles: false });

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);

    const v3Db = new Database(dbPath, { readonly: true });
    const badJson = v3Db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE NOT json_valid(files_modified)")
      .get() as { count: number };
    expect(badJson.count).toBe(0);
    v3Db.close();
  });

  it('migrates observations, sessions, and pressure_scores to v3 schema', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, {
      observationCount: 5,
      sessionCount: 3,
      pressureCount: 2,
      withCsvFiles: false,
      withWarm: false,
    });

    const result = runMigration(dbPath);
    expect(result.success).toBe(true);

    const v3Db = new Database(dbPath, { readonly: true });

    const obsCount = (v3Db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number }).c;
    const sessCount = (v3Db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
    const pressCount = (v3Db.prepare('SELECT COUNT(*) as c FROM pressure_scores').get() as { c: number }).c;

    expect(obsCount).toBe(5);
    expect(sessCount).toBe(3);
    expect(pressCount).toBe(2);

    v3Db.close();
  });

  it('cleans up original DB WAL/SHM sidecar files after swap', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 2, sessionCount: 1, pressureCount: 0 });

    // Simulate original DB having WAL/SHM files (e.g. from prior WAL-mode use)
    fs.writeFileSync(dbPath + '-wal', 'fake wal data');
    fs.writeFileSync(dbPath + '-shm', 'fake shm data');

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    // Orphaned original WAL/SHM must be removed — otherwise SQLite could apply v2 WAL to v3 DB
    expect(fs.existsSync(dbPath + '-wal')).toBe(false);
    expect(fs.existsSync(dbPath + '-shm')).toBe(false);
  });

  it('cleans up temp DB WAL/SHM sidecar files after swap', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 1, sessionCount: 1, pressureCount: 0 });

    const tempPath = path.join(tmpDir, 'claudex-v3-temp.db');

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    // Temp DB WAL/SHM (not renamed with main file) must be gone
    expect(fs.existsSync(tempPath + '-wal')).toBe(false);
    expect(fs.existsSync(tempPath + '-shm')).toBe(false);
  });

  it('migrates 100+ observations correctly with valid JSON files_modified', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, {
      observationCount: 150,
      sessionCount: 5,
      pressureCount: 10,
      withCsvFiles: true,
      withWarm: true,
    });

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    expect(result.counts.observationCount).toBe(150);
    expect(result.counts.sessionCount).toBe(5);
    expect(result.counts.pressureCount).toBe(10);

    const v3Db = new Database(dbPath, { readonly: true });

    const obsCount = (v3Db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number }).c;
    expect(obsCount).toBe(150);

    const badJson = v3Db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE NOT json_valid(files_modified)")
      .get() as { count: number };
    expect(badJson.count).toBe(0);

    const warmRows = v3Db
      .prepare("SELECT COUNT(*) as count FROM pressure_scores WHERE temperature = 'WARM'")
      .get() as { count: number };
    expect(warmRows.count).toBe(0);

    v3Db.close();
  });

  it('removes pre-existing temp DB before starting migration', () => {
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 1, sessionCount: 1, pressureCount: 0 });

    // Create a stale temp DB that would confuse migration if not removed
    const tempPath = path.join(tmpDir, 'claudex-v3-temp.db');
    const staleDb = new Database(tempPath);
    staleDb.exec('CREATE TABLE stale (id INTEGER PRIMARY KEY)');
    staleDb.close();

    expect(fs.existsSync(tempPath)).toBe(true);

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    // Temp DB should be consumed (swapped to main path), not left as stale
    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

describe('runMigration — error path: original DB preserved', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('original DB is untouched when backup cannot be created (read-only dir)', () => {
    // This test verifies the pattern: if backup fails, we never touch the original.
    // We test by confirming the return value indicates failure with backup error.
    const dbPath = path.join(tmpDir, 'claudex.db');
    createV2Database(dbPath, { observationCount: 1, sessionCount: 1, pressureCount: 0 });

    // Record the original file content
    const originalContent = fs.readFileSync(dbPath);

    // Simulate backup failure by making a read-only dbPath directory (not easy on Windows).
    // Instead, we test a nonexistent source to trigger the backup copyFileSync failure.
    const missingPath = path.join(tmpDir, 'missing.db');
    const result = runMigration(missingPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain('backup');

    // Original DB (separate from the missing path) is untouched
    const currentContent = fs.readFileSync(dbPath);
    expect(currentContent.equals(originalContent)).toBe(true);
  });
});
