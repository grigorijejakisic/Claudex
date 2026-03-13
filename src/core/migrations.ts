/**
 * Schema DDL for fresh install + v2 migration SQL functions.
 * @see Architecture Section 4.2 (Schema), Section 4.3.2 (Migration), Section 10c (Telemetry)
 */

import type { Database } from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { SCHEMA_VERSION } from '../shared/constants.js';
import { getClaudexHome } from '../shared/paths.js';

/**
 * Complete v3 schema DDL — 9 tables + FTS5 virtual table + triggers + indexes.
 * All CREATE statements use IF NOT EXISTS for idempotency.
 * @see Architecture Section 4.2
 */
const SCHEMA_V3 = `
-- observations: core data table
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
  deleted_at_epoch INTEGER DEFAULT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  obs_type TEXT
);

-- FTS5 virtual table for full-text search on observations
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, content,
  content=observations,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- FTS sync trigger: after insert
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

-- FTS sync trigger: after delete
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
END;

-- FTS sync trigger: after update
CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO observations_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

-- Observation indexes (single-column)
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC);
CREATE INDEX IF NOT EXISTS idx_obs_deleted ON observations(deleted_at_epoch);

-- Composite indexes for hot query paths
-- Dedup query in extraction dispatcher: WHERE tool_name=? AND category=? AND project=? AND session_id=? AND timestamp_epoch>?
CREATE INDEX IF NOT EXISTS idx_obs_dedup
  ON observations(tool_name, category, project, session_id, timestamp_epoch DESC);

-- getObservationsByProject + pruneObservations: WHERE project=? AND deleted_at_epoch IS NULL ORDER BY timestamp_epoch DESC
CREATE INDEX IF NOT EXISTS idx_obs_project_active
  ON observations(project, deleted_at_epoch, timestamp_epoch DESC);

-- pruneObservations candidate selection + applyRetentionPolicy: WHERE project=? AND deleted_at_epoch IS NULL AND importance<?
CREATE INDEX IF NOT EXISTS idx_obs_project_importance
  ON observations(project, deleted_at_epoch, importance);

-- markObservationsConsumed: WHERE project=? AND consumed=? ORDER BY timestamp_epoch DESC
CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC);

-- sessions
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

-- getActiveSession: WHERE status='active' AND project=? ORDER BY created_at_epoch DESC
CREATE INDEX IF NOT EXISTS idx_sessions_active
  ON sessions(status, project, created_at_epoch DESC);

-- pressure_scores
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

-- getHotFiles: WHERE project=? AND temperature='HOT' ORDER BY raw_pressure DESC
CREATE INDEX IF NOT EXISTS idx_pressure_project_temp
  ON pressure_scores(project, temperature, raw_pressure DESC);

-- learnings
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL DEFAULT '__global__',
  agent_id TEXT NOT NULL DEFAULT 'default',
  fingerprint TEXT NOT NULL,
  content TEXT NOT NULL,
  promotion_count INTEGER NOT NULL DEFAULT 1,
  first_seen_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  last_promoted_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, agent_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_learnings_promo
  ON learnings(project, agent_id, promotion_count DESC);

-- decisions
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '__global__',
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'confirmation', 'direction', 'rejection', 'explicit'
  )),
  fingerprint TEXT NOT NULL,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_decisions_session
  ON decisions(session_id, timestamp_epoch DESC);

-- getDecisionsByProject: WHERE project=? ORDER BY timestamp_epoch DESC
CREATE INDEX IF NOT EXISTS idx_decisions_project
  ON decisions(project, timestamp_epoch DESC);

-- thread_state
CREATE TABLE IF NOT EXISTS thread_state (
  session_id TEXT PRIMARY KEY,
  topic TEXT,
  summary TEXT,
  key_exchanges TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(key_exchanges)),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- checkpoint_tracking
CREATE TABLE IF NOT EXISTS checkpoint_tracking (
  session_id TEXT PRIMARY KEY,
  last_checkpoint_epoch INTEGER,
  thresholds_hit TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(thresholds_hit)),
  observation_count INTEGER NOT NULL DEFAULT 0,
  post_compact_pending INTEGER NOT NULL DEFAULT 0,
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- schema_versions
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- checkpoint_meta
CREATE TABLE IF NOT EXISTS checkpoint_meta (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('threshold', 'compaction', 'session_end')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'committed', 'mirrored')),
  data TEXT,
  mirror_path TEXT,
  error TEXT,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_cpmeta_session
  ON checkpoint_meta(session_id, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_cpmeta_status
  ON checkpoint_meta(status, updated_at_epoch);

-- verified_facts: facts verified during session, included in checkpoints (Upgrade 12)
CREATE TABLE IF NOT EXISTS verified_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_verified_facts_session
  ON verified_facts(session_id, created_at_epoch DESC);
`;

/**
 * Telemetry table DDL — separate constant for clarity.
 * @see Architecture Section 10c
 */
const TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
    'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error'
  )),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  latency_ms REAL,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch DESC);
`;

/**
 * Upgrades v2 tables in-place when v3 opens the same database file.
 * Adds missing columns and renames changed ones so CREATE INDEX succeeds.
 * Idempotent — safe to call on a fresh or already-upgraded DB.
 */
function upgradeV2SchemaInPlace(db: Database): void {
  // Check if sessions table exists with v2 schema (has started_at_epoch, lacks created_at_epoch)
  const sessionCols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  if (sessionCols.length === 0) return; // Table doesn't exist yet — fresh install

  const colNames = new Set(sessionCols.map(c => c.name));

  // sessions: v2 has started_at_epoch, v3 expects created_at_epoch
  if (colNames.has('started_at_epoch') && !colNames.has('created_at_epoch')) {
    db.exec('ALTER TABLE sessions RENAME COLUMN started_at_epoch TO created_at_epoch');
  }
  // sessions: v3 needs 'source' column
  if (!colNames.has('source')) {
    db.exec("ALTER TABLE sessions ADD COLUMN source TEXT");
  }

  // pressure_scores: check for v2 WARM temperature values
  try {
    db.exec("UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature NOT IN ('HOT', 'COLD')");
  } catch { /* table may not exist */ }

  // observations: v3.1 adds consumed column for observation masking (Upgrade 6)
  // and obs_type column for Type Prior classification (Upgrade 8)
  const obsCols = db.pragma('table_info(observations)') as Array<{ name: string }>;
  const obsColNames = new Set(obsCols.map(c => c.name));
  if (!obsColNames.has('consumed')) {
    db.exec('ALTER TABLE observations ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0');
  }
  if (!obsColNames.has('obs_type')) {
    db.exec('ALTER TABLE observations ADD COLUMN obs_type TEXT');
  }
}

/**
 * Initializes the complete v3 schema: 9 tables + telemetry + FTS5 + triggers + indexes.
 * Records schema version 300. Idempotent (all IF NOT EXISTS).
 * Handles in-place upgrade when opening an existing v2 database at the same path.
 */
export function initializeSchema(db: Database): void {
  upgradeV2SchemaInPlace(db);
  db.exec(SCHEMA_V3);
  db.exec(TELEMETRY_SCHEMA);

  db.prepare('INSERT OR IGNORE INTO schema_versions (version) VALUES (?)').run(
    SCHEMA_VERSION
  );
}

/**
 * Migrates data from a v2 database into the current v3 database.
 * Wraps entire migration in a transaction for atomicity.
 * @see Architecture Section 4.3.2
 */
export function migrateFromV2(db: Database, v2DbPath: string): void {
  // Guard: prevent same-database source/target
  const targetPath = (db.name && db.name !== ':memory:' && db.name !== '')
    ? path.resolve(db.name)
    : null;
  const sourcePath = path.resolve(v2DbPath);
  if (targetPath && sourcePath === targetPath) {
    throw new Error(
      `migrateFromV2: source and target are the same database (${sourcePath})`
    );
  }

  // 1. ATTACH v2 database (must be outside transaction)
  // Escape single quotes in path to prevent SQL injection
  const escapedPath = v2DbPath.replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${escapedPath}' AS v2`);

  try {
    const migrate = db.transaction(() => {
      // 2. Create new v3 tables (IF NOT EXISTS — safe re-run)
      db.exec(SCHEMA_V3);
      db.exec(TELEMETRY_SCHEMA);

      // 3. Copy observations, sessions, pressure_scores from v2
      // Note: files_modified may be comma-separated in v2, which fails json_valid CHECK.
      // We copy with files_modified defaulting to '[]' and fix in step 7.
      db.exec(`
        INSERT OR IGNORE INTO observations (id, session_id, project, tool_name, category, title, content, importance, files_modified, timestamp_epoch, access_count, last_accessed_at_epoch, deleted_at_epoch)
        SELECT id, session_id, project, tool_name, category, title, content, importance,
          CASE WHEN json_valid(files_modified) THEN files_modified ELSE '[]' END,
          timestamp_epoch, access_count, last_accessed_at_epoch, deleted_at_epoch
        FROM v2.observations
      `);

      db.exec(`
        INSERT OR IGNORE INTO sessions (session_id, scope, project, cwd, source, status, observation_count, created_at_epoch, ended_at_epoch)
        SELECT session_id, scope, project, cwd, source, status, observation_count, created_at_epoch, ended_at_epoch
        FROM v2.sessions
      `);

      // Convert WARM -> COLD during copy (v3 only allows HOT/COLD)
      db.exec(`
        INSERT OR IGNORE INTO pressure_scores (file_path, project, raw_pressure, temperature, last_touched_epoch, decay_rate)
        SELECT file_path, project, raw_pressure,
          CASE WHEN temperature IN ('HOT', 'COLD') THEN temperature ELSE 'COLD' END,
          last_touched_epoch, decay_rate
        FROM v2.pressure_scores
      `);

      // 4. Archive unused v2 tables
      const v2Tables = db
        .prepare(
          "SELECT name FROM v2.sqlite_master WHERE type='table' AND name NOT IN ('observations', 'sessions', 'pressure_scores', 'sqlite_sequence')"
        )
        .all() as Array<{ name: string }>;

      for (const { name } of v2Tables) {
        // Skip internal SQLite tables and already-archived tables
        if (name.startsWith('_archived_') || name.startsWith('sqlite_')) continue;
        try {
          // Escape double quotes in identifiers to prevent SQL injection
          const escapedName = name.replace(/"/g, '""');
          const escapedArchived = `_archived_${name}`.replace(/"/g, '""');
          db.exec(`ALTER TABLE v2."${escapedName}" RENAME TO "${escapedArchived}"`);
        } catch {
          // Table may already be archived or not renameable — skip
        }
      }

      // 5. Simplify pressure_scores (WARM -> COLD)
      db.exec(`UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature = 'WARM'`);

      // 6. Migrate checkpoint_state -> checkpoint_tracking
      try {
        db.exec(`
          INSERT OR IGNORE INTO checkpoint_tracking (session_id, last_checkpoint_epoch, observation_count, updated_at_epoch)
          SELECT session_id, last_checkpoint_epoch, observation_count, updated_at_epoch
          FROM v2._archived_checkpoint_state
        `);
      } catch {
        // checkpoint_state may not exist in v2 — skip
      }

      // 7. Fix files_modified from comma-separated to JSON array
      // Read original non-JSON values from v2 and convert to JSON arrays in v3
      const rows = db
        .prepare(
          "SELECT id, files_modified FROM v2.observations WHERE NOT json_valid(files_modified)"
        )
        .all() as Array<{ id: number; files_modified: string }>;

      const updateStmt = db.prepare(
        'UPDATE observations SET files_modified = ? WHERE id = ?'
      );
      for (const row of rows) {
        const files = row.files_modified
          .split(',')
          .map((f) => f.trim())
          .filter((f) => f.length > 0);
        updateStmt.run(JSON.stringify(files), row.id);
      }

      // 8. Record schema version 300
      db.prepare(
        'INSERT OR IGNORE INTO schema_versions (version) VALUES (?)'
      ).run(SCHEMA_VERSION);
    });

    migrate();
  } finally {
    // 9. DETACH v2 database (must be outside transaction)
    db.exec('DETACH DATABASE v2');
  }
}

/**
 * Detects an existing v2 database by checking known paths.
 * Returns path if found and schema version < 300, otherwise null.
 * Non-throwing — wraps in try/catch.
 */
export function detectV2Database(): string | null {
  try {
    const home = getClaudexHome();
    const candidates = [
      path.join(home, 'claudex.db'),
      path.join(home, 'db', 'claudex.db'),
    ];

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;

      // Check if it's actually a v2 database (schema version < 300)
      try {
        const testDb = new DatabaseConstructor(candidate, { readonly: true });
        try {
          const row = testDb
            .prepare(
              'SELECT MAX(version) as version FROM schema_versions'
            )
            .get() as { version: number } | undefined;

          if (!row || row.version < SCHEMA_VERSION) {
            testDb.close();
            return candidate;
          }
          testDb.close();
        } catch {
          // No schema_versions table — this is a v2 database
          testDb.close();
          return candidate;
        }
      } catch {
        // Can't open database — skip this candidate
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}
