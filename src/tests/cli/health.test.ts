/**
 * Tests for claudex health CLI.
 * Uses in-memory databases to validate each check independently.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  checkTables,
  checkColumns,
  checkWriteRead,
  checkFts5,
  checkTelemetry,
  checkScope,
  checkSessions,
  checkStats,
  runHealthCheck,
  formatReport,
} from '../../cli/health.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-health-test-'));
}

/** Creates a fully-initialized in-memory DB with v3 schema. */
function createHealthyDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

/** Creates a DB file on disk with v3 schema. Returns the path. */
function createHealthyDbFile(dir: string): string {
  const dbPath = path.join(dir, 'test-health.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  db.close();
  return dbPath;
}

// ── checkTables ─────────────────────────────────────────────────────

describe('checkTables', () => {
  it('passes on a healthy v3 database', () => {
    const db = createHealthyDb();
    try {
      const result = checkTables(db);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('22/22');
    } finally {
      db.close();
    }
  });

  it('fails when a table is missing', () => {
    const db = createHealthyDb();
    try {
      db.exec('DROP TABLE verified_facts');
      const result = checkTables(db);
      expect(result.status).toBe('fail');
      expect(result.message).toContain('verified_facts');
    } finally {
      db.close();
    }
  });

  it('reports count of present tables', () => {
    const db = new Database(':memory:');
    try {
      // Empty DB — no tables
      const result = checkTables(db);
      expect(result.status).toBe('fail');
      expect(result.message).toContain('0/22');
    } finally {
      db.close();
    }
  });
});

// ── checkColumns ────────────────────────────────────────────────────

describe('checkColumns', () => {
  it('passes on a healthy v3 database', () => {
    const db = createHealthyDb();
    try {
      const result = checkColumns(db);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('All expected columns found');
    } finally {
      db.close();
    }
  });

  it('fails when a column is missing from a table', () => {
    const db = createHealthyDb();
    try {
      // Re-create sessions without 'adapter' column to simulate missing column.
      // We can't ALTER TABLE DROP COLUMN in older SQLite, so we rebuild the table.
      db.exec(`
        CREATE TABLE sessions_backup AS SELECT session_id, scope, project, cwd, source, status, observation_count, created_at_epoch_ms, ended_at_epoch_ms FROM sessions;
        DROP TABLE sessions;
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          scope TEXT,
          project TEXT,
          cwd TEXT,
          source TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          observation_count INTEGER NOT NULL DEFAULT 0,
          created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch()),
          ended_at_epoch_ms INTEGER
        );
        INSERT INTO sessions SELECT * FROM sessions_backup;
        DROP TABLE sessions_backup;
      `);
      const result = checkColumns(db);
      expect(result.status).toBe('fail');
      expect(result.message).toContain('sessions.adapter');
    } finally {
      db.close();
    }
  });
});

// ── checkWriteRead ──────────────────────────────────────────────────

describe('checkWriteRead', () => {
  it('passes on a healthy v3 database', () => {
    const db = createHealthyDb();
    try {
      const result = checkWriteRead(db);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('All tables accept v3 inserts');
    } finally {
      db.close();
    }
  });

  it('does not leave test data behind', () => {
    const db = createHealthyDb();
    try {
      checkWriteRead(db);
      const obs = (db.prepare("SELECT COUNT(*) as cnt FROM observations WHERE session_id = '__health_check__'").get() as { cnt: number }).cnt;
      expect(obs).toBe(0);
      const sess = (db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE session_id = '__health_check__'").get() as { cnt: number }).cnt;
      expect(sess).toBe(0);
    } finally {
      db.close();
    }
  });

  it('fails when a table has incompatible constraints', () => {
    const db = new Database(':memory:');
    try {
      // Create a minimal observations table with a constraint that rejects our test insert
      db.exec(`
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('code')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          importance INTEGER NOT NULL,
          files_modified TEXT NOT NULL DEFAULT '[]',
          consumed INTEGER NOT NULL DEFAULT 0,
          timestamp_epoch_ms INTEGER NOT NULL DEFAULT 0,
          access_count INTEGER NOT NULL DEFAULT 0,
          deleted_at_epoch_ms INTEGER,
          last_accessed_at_epoch_ms INTEGER,
          obs_type TEXT,
          project TEXT
        );
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', observation_count INTEGER NOT NULL DEFAULT 0, created_at_epoch_ms INTEGER NOT NULL DEFAULT 0, ended_at_epoch_ms INTEGER, scope TEXT, project TEXT, cwd TEXT, source TEXT, adapter TEXT);
        CREATE TABLE pressure_scores (file_path TEXT NOT NULL, project TEXT NOT NULL, raw_pressure REAL NOT NULL DEFAULT 0.0, temperature TEXT NOT NULL DEFAULT 'COLD', last_touched_epoch INTEGER NOT NULL DEFAULT 0, decay_rate REAL NOT NULL DEFAULT 0.1, PRIMARY KEY (file_path, project));
        CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL DEFAULT '__global__', agent_id TEXT NOT NULL DEFAULT 'default', fingerprint TEXT NOT NULL, content TEXT NOT NULL, promotion_count INTEGER NOT NULL DEFAULT 1, first_seen_epoch INTEGER NOT NULL DEFAULT 0, last_promoted_epoch INTEGER NOT NULL DEFAULT 0, updated_at_epoch_ms INTEGER NOT NULL DEFAULT 0, UNIQUE(project, agent_id, fingerprint));
        CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL DEFAULT '__global__', content TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('confirmation', 'direction', 'rejection', 'explicit')), fingerprint TEXT NOT NULL, timestamp_epoch_ms INTEGER NOT NULL DEFAULT 0, updated_at_epoch_ms INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id, fingerprint));
        CREATE TABLE thread_state (session_id TEXT PRIMARY KEY, topic TEXT, summary TEXT, key_exchanges TEXT NOT NULL DEFAULT '[]', updated_at_epoch_ms INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE checkpoint_tracking (session_id TEXT PRIMARY KEY, last_checkpoint_epoch INTEGER, thresholds_hit TEXT NOT NULL DEFAULT '[]', observation_count INTEGER NOT NULL DEFAULT 0, post_compact_pending INTEGER NOT NULL DEFAULT 0, updated_at_epoch_ms INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE checkpoint_meta (checkpoint_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, trigger TEXT NOT NULL CHECK (trigger IN ('threshold', 'compaction', 'session_end')), status TEXT NOT NULL DEFAULT 'pending', data TEXT, mirror_path TEXT, error TEXT, created_at_epoch_ms INTEGER NOT NULL DEFAULT 0, updated_at_epoch_ms INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE session_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, entry_type TEXT NOT NULL CHECK (entry_type IN ('flow', 'milestone', 'summary')), content TEXT NOT NULL, timestamp_epoch_ms INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, artifact_type TEXT NOT NULL CHECK (artifact_type IN ('observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone')), artifact_ref TEXT, summary TEXT NOT NULL, content TEXT, state TEXT NOT NULL DEFAULT 'fresh', ttl INTEGER NOT NULL DEFAULT 3, importance INTEGER NOT NULL DEFAULT 3, timestamp_epoch_ms INTEGER NOT NULL DEFAULT 0, last_materialized_epoch_ms INTEGER);
        CREATE TABLE verified_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, fact TEXT NOT NULL, created_at_epoch_ms INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event_kind TEXT NOT NULL CHECK (event_kind IN ('hook_invocation', 'injection', 'observation_capture', 'decision_capture', 'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error')), detail TEXT NOT NULL DEFAULT '{}', latency_ms REAL, timestamp_epoch_ms INTEGER NOT NULL DEFAULT 0, adapter TEXT);
        CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at_epoch_ms INTEGER NOT NULL DEFAULT 0);
      `);

      const result = checkWriteRead(db);
      // observations insert should fail because category='other' is not in the restricted CHECK
      expect(result.status).toBe('fail');
      expect(result.message).toContain('observations');
    } finally {
      db.close();
    }
  });
});

// ── checkFts5 ───────────────────────────────────────────────────────

describe('checkFts5', () => {
  it('passes on a healthy v3 database', () => {
    const db = createHealthyDb();
    try {
      const result = checkFts5(db);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('2-column');
    } finally {
      db.close();
    }
  });

  it('fails when observations_fts does not exist', () => {
    const db = createHealthyDb();
    try {
      db.exec('DROP TABLE observations_fts');
      const result = checkFts5(db);
      expect(result.status).toBe('fail');
      expect(result.message).toContain('does not exist');
    } finally {
      db.close();
    }
  });
});

// ── checkTelemetry ──────────────────────────────────────────────────

describe('checkTelemetry', () => {
  it('passes when no errors exist', () => {
    const db = createHealthyDb();
    try {
      const result = checkTelemetry(db);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('0 errors (5m)');
    } finally {
      db.close();
    }
  });

  it('warns when recent errors exist', () => {
    const db = createHealthyDb();
    try {
      const now = Date.now(); // ms
      db.prepare(
        "INSERT INTO telemetry (session_id, event_kind, detail, timestamp_epoch_ms) VALUES (?, 'error', ?, ?)"
      ).run('test-session', '{"message":"test error"}', now);

      const result = checkTelemetry(db);
      expect(result.status).toBe('warn');
      expect(result.message).toContain('1 errors (5m)');
    } finally {
      db.close();
    }
  });
});

// ── checkScope ──────────────────────────────────────────────────────

describe('checkScope', () => {
  it('returns pass or warn without crashing', () => {
    const result = checkScope(process.cwd());
    // Should be warn (no projects.json in test env) or pass
    expect(['pass', 'warn']).toContain(result.status);
  });

  it('never throws', () => {
    expect(() => checkScope('/nonexistent/path')).not.toThrow();
  });
});

// ── checkSessions ───────────────────────────────────────────────────

describe('checkSessions', () => {
  it('passes when no orphaned sessions', () => {
    const db = createHealthyDb();
    try {
      const result = checkSessions(db);
      expect(result.status).toBe('pass');
    } finally {
      db.close();
    }
  });

  it('warns on orphaned sessions', () => {
    const db = createHealthyDb();
    try {
      const oldEpoch = Math.floor(Date.now() / 1000) - 100000; // > 24h ago
      db.prepare(
        "INSERT INTO sessions (session_id, status, observation_count, created_at_epoch_ms) VALUES (?, 'active', 0, ?)"
      ).run('orphan-1', oldEpoch);

      const result = checkSessions(db);
      expect(result.status).toBe('warn');
      expect(result.message).toContain('orphaned');
    } finally {
      db.close();
    }
  });
});

// ── checkStats ──────────────────────────────────────────────────────

describe('checkStats', () => {
  it('returns stats on healthy DB', () => {
    const db = createHealthyDb();
    try {
      const result = checkStats(db);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('observations');
      expect(result.message).toContain('artifacts');
    } finally {
      db.close();
    }
  });
});

// ── checkStats V17 ──────────────────────────────────────────────────

describe('checkStats V17', () => {
  it('includes artifacts (legacy) label in stats message', () => {
    const db = createHealthyDb();
    try {
      const result = checkStats(db);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('artifacts (legacy)');
    } finally {
      db.close();
    }
  });

  it('includes artifacts (V17) label in stats message', () => {
    const db = createHealthyDb();
    try {
      const result = checkStats(db);
      expect(result.status).toBe('pass');
      expect(result.message).toContain('artifacts (V17)');
    } finally {
      db.close();
    }
  });
});

// ── checkWriteRead V17 artifact ─────────────────────────────────────

describe('checkWriteRead V17 artifact', () => {
  it('passes when artifact (V17) table is present', () => {
    const db = createHealthyDb();
    try {
      const result = checkWriteRead(db);
      expect(result.status).toBe('pass');
    } finally {
      db.close();
    }
  });

  it('does not leave V17 test artifact behind', () => {
    const db = createHealthyDb();
    try {
      checkWriteRead(db);
      const v17 = (db.prepare(
        "SELECT COUNT(*) as cnt FROM artifact WHERE id = '__health_check_v17__'"
      ).get() as { cnt: number }).cnt;
      expect(v17).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ── runHealthCheck (integration) ────────────────────────────────────

describe('runHealthCheck', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns healthy report for a valid v3 database file', () => {
    const dbPath = createHealthyDbFile(tmpDir);
    const report = runHealthCheck(dbPath, process.cwd());

    expect(report.failures).toBe(0);
    // Scope may warn (no projects.json) — that's ok
    expect(report.checks.length).toBeGreaterThanOrEqual(8);

    // Schema and write checks should pass
    const schema = report.checks.find(c => c.label === 'Schema');
    expect(schema?.status).toBe('pass');
    const write = report.checks.find(c => c.label === 'Write test');
    expect(write?.status).toBe('pass');
  });

  it('reports failure when database path is invalid', () => {
    // Use a path that can't be created (nested inside a non-existent dir)
    const report = runHealthCheck(path.join(tmpDir, 'no', 'such', 'dir', 'test.db'), process.cwd());
    expect(report.failures).toBe(1);
    expect(report.checks[0].label).toBe('Database');
    expect(report.checks[0].status).toBe('fail');
  });

  it('reports failure for empty database (no tables)', () => {
    const emptyDbPath = path.join(tmpDir, 'empty.db');
    const emptyDb = new Database(emptyDbPath);
    emptyDb.close();

    const report = runHealthCheck(emptyDbPath, process.cwd());
    expect(report.failures).toBeGreaterThan(0);
  });
});

// ── formatReport ────────────────────────────────────────────────────

describe('formatReport', () => {
  it('formats a healthy report', () => {
    const output = formatReport({
      checks: [
        { label: 'Schema', status: 'pass', message: '21/21 tables present' },
        { label: 'Write test', status: 'pass', message: 'All tables accept v3 inserts' },
      ],
      failures: 0,
      warnings: 0,
    });

    expect(output).toContain('=== Claudex Health Check ===');
    expect(output).toContain('\u2713');
    expect(output).toContain('HEALTHY');
    expect(output).not.toContain('UNHEALTHY');
  });

  it('formats a report with failures', () => {
    const output = formatReport({
      checks: [
        { label: 'Schema', status: 'fail', message: 'Missing tables: foo' },
      ],
      failures: 1,
      warnings: 0,
    });

    expect(output).toContain('UNHEALTHY');
    expect(output).toContain('\u2717');
  });

  it('formats a report with warnings', () => {
    const output = formatReport({
      checks: [
        { label: 'Sessions', status: 'warn', message: '3 orphaned sessions' },
      ],
      failures: 0,
      warnings: 1,
    });

    expect(output).toContain('HEALTHY');
    expect(output).toContain('1 warning');
    expect(output).toContain('\u26A0');
  });
});
