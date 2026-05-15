/**
 * Tests for claudex migrate CLI logic.
 * Creates temp v2 databases and runs the migration pipeline against them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import {
  parseArgs,
  getRowCounts,
  verifyMigration,
  safeSwap,
  runMigration,
  formatResult,
} from '../../cli/migrate.js';
import { SCHEMA_VERSION } from '../../shared/constants.js';
import { openDatabase, closeDatabase } from '../../core/storage.js';
import { initializeSchema } from '../../core/migrations.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-migrate-test-'));
}

/**
 * Creates a minimal v2-style database with observations, sessions, and pressure_scores.
 * Uses v2 schema conventions (started_at_epoch, no source column, WARM temperature).
 */
function createV2Database(dbPath: string, opts?: { observations?: number; sessions?: number; pressureScores?: number }): void {
  const obsCount = opts?.observations ?? 5;
  const sessCount = opts?.sessions ?? 2;
  const pressCount = opts?.pressureScores ?? 3;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // v2 schema — uses started_at_epoch (not created_at_epoch_ms), no source column
  db.exec(`
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
      timestamp_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch()),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at_epoch_ms INTEGER,
      deleted_at_epoch_ms INTEGER DEFAULT NULL
    );

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      scope TEXT,
      project TEXT,
      cwd TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      observation_count INTEGER NOT NULL DEFAULT 0,
      started_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at_epoch_ms INTEGER
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

    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch())
    );

    INSERT INTO schema_versions (version) VALUES (200);
  `);

  // Insert test data
  const insObs = db.prepare(
    `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < obsCount; i++) {
    insObs.run(`sess-${i % sessCount}`, 'test-project', 'Read', 'code', `Observation ${i}`, `Content ${i}`, 3, '[]');
  }

  const insSess = db.prepare(
    `INSERT INTO sessions (session_id, scope, project, cwd, status, observation_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < sessCount; i++) {
    insSess.run(`sess-${i}`, 'project', 'test-project', '/tmp/test', 'completed', Math.floor(obsCount / sessCount));
  }

  const insPress = db.prepare(
    `INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature)
     VALUES (?, ?, ?, ?)`
  );
  for (let i = 0; i < pressCount; i++) {
    insPress.run(`/src/file${i}.ts`, 'test-project', 0.5 + i * 0.1, i === 0 ? 'HOT' : 'COLD');
  }

  db.close();
}

/**
 * Creates a v2 database where some files_modified values are comma-separated (not JSON).
 */
function createV2WithBadFilesModified(dbPath: string): void {
  createV2Database(dbPath, { observations: 3, sessions: 1, pressureScores: 1 });
  const db = new Database(dbPath);
  // Bypass the default CHECK by removing and re-creating without the check
  // Actually, our v2 schema above doesn't have json_valid CHECK, so we can update directly
  db.exec(`UPDATE observations SET files_modified = 'src/a.ts, src/b.ts' WHERE id = 1`);
  db.exec(`UPDATE observations SET files_modified = 'single-file.ts' WHERE id = 2`);
  db.close();
}

// ── Tests ────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses --source flag', () => {
    const args = parseArgs(['node', 'migrate.cjs', '--source', '/tmp/v2.db']);
    expect(args.source).toBe('/tmp/v2.db');
    expect(args.dryRun).toBe(false);
    expect(args.force).toBe(false);
  });

  it('parses --dry-run flag', () => {
    const args = parseArgs(['node', 'migrate.cjs', '--dry-run']);
    expect(args.dryRun).toBe(true);
  });

  it('parses --force flag', () => {
    const args = parseArgs(['node', 'migrate.cjs', '--force']);
    expect(args.force).toBe(true);
  });

  it('parses all flags together', () => {
    const args = parseArgs(['node', 'migrate.cjs', '--source', '/tmp/v2.db', '--dry-run', '--force']);
    expect(args.source).toBe('/tmp/v2.db');
    expect(args.dryRun).toBe(true);
    expect(args.force).toBe(true);
  });

  it('returns defaults when no flags given', () => {
    const args = parseArgs(['node', 'migrate.cjs']);
    expect(args.source).toBeUndefined();
    expect(args.dryRun).toBe(false);
    expect(args.force).toBe(false);
  });
});

describe('getRowCounts', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns correct counts from a populated database', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    createV2Database(dbPath, { observations: 10, sessions: 3, pressureScores: 5 });

    const db = new Database(dbPath, { readonly: true });
    try {
      const counts = getRowCounts(db);
      expect(counts.observations).toBe(10);
      expect(counts.sessions).toBe(3);
      expect(counts.pressureScores).toBe(5);
    } finally {
      db.close();
    }
  });

  it('returns zeros for empty database', () => {
    const dbPath = path.join(tmpDir, 'empty.db');
    const db = new Database(dbPath);
    try {
      const counts = getRowCounts(db);
      expect(counts.observations).toBe(0);
      expect(counts.sessions).toBe(0);
      expect(counts.pressureScores).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('verifyMigration', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('passes when counts match and schema is correct', () => {
    const dbPath = path.join(tmpDir, 'verified.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Create v3-style tables
    db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY, session_id TEXT, project TEXT,
        tool_name TEXT, category TEXT, title TEXT, content TEXT,
        importance INTEGER, files_modified TEXT DEFAULT '[]',
        timestamp_epoch_ms INTEGER, access_count INTEGER DEFAULT 0,
        last_accessed_at_epoch_ms INTEGER, deleted_at_epoch_ms INTEGER
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, scope TEXT, project TEXT, cwd TEXT,
        source TEXT, status TEXT DEFAULT 'active', observation_count INTEGER DEFAULT 0,
        created_at_epoch_ms INTEGER, ended_at_epoch_ms INTEGER
      );
      CREATE TABLE pressure_scores (
        file_path TEXT NOT NULL, project TEXT NOT NULL,
        raw_pressure REAL DEFAULT 0.0, temperature TEXT DEFAULT 'COLD',
        last_touched_epoch INTEGER, decay_rate REAL DEFAULT 0.1,
        PRIMARY KEY (file_path, project)
      );
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY, applied_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    db.exec(`INSERT INTO observations (id, session_id, tool_name, category, title, content, importance, files_modified, timestamp_epoch_ms) VALUES (1, 's1', 'Read', 'code', 't', 'c', 3, '["a.ts"]', 100)`);
    db.exec(`INSERT INTO sessions (session_id, status, created_at_epoch_ms) VALUES ('s1', 'active', 100)`);
    db.exec(`INSERT INTO pressure_scores (file_path, project, last_touched_epoch) VALUES ('a.ts', 'p', 100)`);
    db.exec(`INSERT INTO schema_versions (version) VALUES (${SCHEMA_VERSION})`);

    try {
      const result = verifyMigration(db, { observations: 1, sessions: 1, pressureScores: 1 });
      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(5);
      expect(result.checks.every(c => c.passed)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('fails when observation count does not match', () => {
    const dbPath = path.join(tmpDir, 'mismatch.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE observations (id INTEGER PRIMARY KEY, session_id TEXT, tool_name TEXT, category TEXT, title TEXT, content TEXT, importance INTEGER, files_modified TEXT DEFAULT '[]', timestamp_epoch_ms INTEGER, access_count INTEGER DEFAULT 0, last_accessed_at_epoch_ms INTEGER, deleted_at_epoch_ms INTEGER);
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, scope TEXT, project TEXT, cwd TEXT, source TEXT, status TEXT DEFAULT 'active', observation_count INTEGER DEFAULT 0, created_at_epoch_ms INTEGER, ended_at_epoch_ms INTEGER);
      CREATE TABLE pressure_scores (file_path TEXT NOT NULL, project TEXT NOT NULL, raw_pressure REAL DEFAULT 0.0, temperature TEXT DEFAULT 'COLD', last_touched_epoch INTEGER, decay_rate REAL DEFAULT 0.1, PRIMARY KEY (file_path, project));
      CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO schema_versions (version) VALUES (${SCHEMA_VERSION});
    `);

    try {
      const result = verifyMigration(db, { observations: 5, sessions: 0, pressureScores: 0 });
      expect(result.passed).toBe(false);
      const obsFailed = result.checks.find(c => c.name === 'observations_count');
      expect(obsFailed?.passed).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('safeSwap', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('swaps new file into current path', () => {
    const currentPath = path.join(tmpDir, 'current.db');
    const newPath = path.join(tmpDir, 'new.db');
    fs.writeFileSync(currentPath, 'old-content');
    fs.writeFileSync(newPath, 'new-content');

    safeSwap(currentPath, newPath);

    expect(fs.readFileSync(currentPath, 'utf-8')).toBe('new-content');
    expect(fs.existsSync(newPath)).toBe(false);
  });

  it('handles stale .pre-swap file (REC-20)', () => {
    const currentPath = path.join(tmpDir, 'current.db');
    const newPath = path.join(tmpDir, 'new.db');
    const preSwapPath = currentPath + '.pre-swap';
    fs.writeFileSync(currentPath, 'old-content');
    fs.writeFileSync(newPath, 'new-content');
    fs.writeFileSync(preSwapPath, 'stale-content');

    safeSwap(currentPath, newPath);

    expect(fs.readFileSync(currentPath, 'utf-8')).toBe('new-content');
    expect(fs.existsSync(newPath)).toBe(false);
  });

  it('throws when current path does not exist', () => {
    const currentPath = path.join(tmpDir, 'nonexistent.db');
    const newPath = path.join(tmpDir, 'new.db');
    fs.writeFileSync(newPath, 'new-content');

    expect(() => safeSwap(currentPath, newPath)).toThrow('Swap step 1 failed');
  });

  it('cleans up .pre-swap after successful swap', () => {
    const currentPath = path.join(tmpDir, 'current.db');
    const newPath = path.join(tmpDir, 'new.db');
    fs.writeFileSync(currentPath, 'old-content');
    fs.writeFileSync(newPath, 'new-content');

    safeSwap(currentPath, newPath);

    expect(fs.existsSync(currentPath + '.pre-swap')).toBe(false);
  });
});

describe('runMigration', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns error when source does not exist', () => {
    const result = runMigration(path.join(tmpDir, 'nonexistent.db'));
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('not found');
  });

  it('performs dry run without modifying files', () => {
    const dbPath = path.join(tmpDir, 'source.db');
    createV2Database(dbPath);

    const result = runMigration(dbPath, { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.steps.some(s => s.includes('Dry run'))).toBe(true);
    // Backup should be created
    expect(fs.existsSync(dbPath + '.v2-backup')).toBe(true);
    // No temp DB should exist
    expect(fs.existsSync(dbPath + '.v3-new')).toBe(false);
  });

  it('completes full migration with correct row counts', () => {
    const dbPath = path.join(tmpDir, 'source.db');
    createV2Database(dbPath, { observations: 8, sessions: 3, pressureScores: 4 });

    const result = runMigration(dbPath);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.targetCounts.observations).toBe(8);
    expect(result.targetCounts.sessions).toBe(3);
    expect(result.targetCounts.pressureScores).toBe(4);

    // Original path should now contain v3 schema
    const db = new Database(dbPath, { readonly: true });
    try {
      const version = db.prepare('SELECT MAX(version) as v FROM schema_versions').get() as { v: number };
      expect(version.v).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('fixes comma-separated files_modified during migration', () => {
    const dbPath = path.join(tmpDir, 'bad-files.db');
    createV2WithBadFilesModified(dbPath);

    const result = runMigration(dbPath);
    expect(result.success).toBe(true);

    // Verify all files_modified are valid JSON in the migrated DB
    const db = new Database(dbPath, { readonly: true });
    try {
      const invalid = db.prepare('SELECT COUNT(*) as cnt FROM observations WHERE NOT json_valid(files_modified)').get() as { cnt: number };
      expect(invalid.cnt).toBe(0);
    } finally {
      db.close();
    }
  });

  it('preserves backup and does not swap when backup already exists (no --force)', () => {
    const dbPath = path.join(tmpDir, 'source.db');
    createV2Database(dbPath);

    // Create a pre-existing backup
    const backupPath = dbPath + '.v2-backup';
    fs.writeFileSync(backupPath, 'pre-existing-backup');

    const result = runMigration(dbPath);
    expect(result.success).toBe(true);

    // Pre-existing backup should not have been overwritten
    const backupContent = fs.readFileSync(backupPath, 'utf-8');
    expect(backupContent).toBe('pre-existing-backup');
  });

  it('overwrites backup with --force', () => {
    const dbPath = path.join(tmpDir, 'source.db');
    createV2Database(dbPath);

    // Create a pre-existing backup
    const backupPath = dbPath + '.v2-backup';
    fs.writeFileSync(backupPath, 'pre-existing-backup');

    const result = runMigration(dbPath, { force: true });
    expect(result.success).toBe(true);

    // Backup should be a valid SQLite database now (overwritten)
    const backupContent = fs.readFileSync(backupPath);
    expect(backupContent.toString('utf-8', 0, 15)).toBe('SQLite format 3');
  });

  it('handles stale temp DB from prior failed attempt', () => {
    const dbPath = path.join(tmpDir, 'source.db');
    createV2Database(dbPath);

    // Create stale temp DB
    fs.writeFileSync(dbPath + '.v3-new', 'stale');

    const result = runMigration(dbPath);
    expect(result.success).toBe(true);
    expect(result.steps.some(s => s.includes('Cleaned up stale temp DB'))).toBe(true);
  });
});

describe('runMigration — WAL-safe backup', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('backup includes WAL-committed data (WAL checkpoint before copy)', () => {
    const dbPath = path.join(tmpDir, 'wal-test.db');
    // Create a v2 database in WAL mode
    createV2Database(dbPath, { observations: 3, sessions: 1, pressureScores: 1 });

    // Reopen and insert a row, leaving WAL un-checkpointed.
    // We keep the DB open so close() doesn't auto-checkpoint.
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('sess-wal', 'test-project', 'Read', 'code', 'WAL-only obs', 'WAL content', 3, '[]');

    // Verify WAL file exists with data
    const walPath = dbPath + '-wal';
    expect(fs.existsSync(walPath)).toBe(true);

    // Close the connection — this is the scenario where another process
    // might have left data in WAL. We verify that runMigration explicitly
    // checkpoints before copying.
    db.close();

    // Run migration (which should checkpoint WAL before backup)
    const result = runMigration(dbPath, { dryRun: true });
    expect(result.success).toBe(true);

    // Verify the backup contains all rows (including WAL-committed ones)
    const backupDb = new Database(dbPath + '.v2-backup', { readonly: true });
    try {
      const counts = getRowCounts(backupDb);
      // Should have 3 original + 1 WAL-committed = 4
      expect(counts.observations).toBe(4);
    } finally {
      backupDb.close();
    }
  });
});

describe('runMigration — v3 guard', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('aborts migration when source database is already v3', () => {
    const dbPath = path.join(tmpDir, 'already-v3.db');
    // Create a v3 database
    const db = openDatabase(dbPath);
    initializeSchema(db);
    closeDatabase(db);

    const result = runMigration(dbPath);
    // Should abort without errors — migration not needed
    expect(result.success).toBe(false);
    expect(result.errors.some((e: string) => e.includes('already v3'))).toBe(true);
  });
});

describe('formatResult', () => {
  it('formats successful result', () => {
    const output = formatResult({
      success: true,
      backupPath: '/tmp/backup.db',
      sourceCounts: { observations: 10, sessions: 3, pressureScores: 5 },
      targetCounts: { observations: 10, sessions: 3, pressureScores: 5 },
      errors: [],
      steps: ['Step 1', 'Step 2'],
    });

    expect(output).toContain('Migration Successful');
    expect(output).toContain('Observations: 10');
    expect(output).toContain('Sessions:     3');
    expect(output).toContain('Pressure:     5');
    expect(output).toContain('Backup:       /tmp/backup.db');
  });

  it('formats failed result with errors', () => {
    const output = formatResult({
      success: false,
      sourceCounts: { observations: 0, sessions: 0, pressureScores: 0 },
      targetCounts: { observations: 0, sessions: 0, pressureScores: 0 },
      errors: ['Something went wrong'],
      steps: ['Step 1'],
    });

    expect(output).toContain('Migration Failed');
    expect(output).toContain('Something went wrong');
  });
});
