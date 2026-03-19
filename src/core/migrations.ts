/**
 * Schema DDL for fresh install + v2 migration SQL functions.
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

-- FTS5 virtual table for full-text search on observations.
-- NOTE: FTS5 index is retained for potential future use but searchObservations()
-- is not called in production code (test-only). Triggers keep the index in sync
-- so it's ready if we wire up FTS5-based search in the assembler.
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

-- Consumed observations index (post-compaction filtering)
CREATE INDEX IF NOT EXISTS idx_obs_consumed
  ON observations(project, consumed, timestamp_epoch DESC);

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
  ended_at_epoch INTEGER,
  adapter TEXT DEFAULT 'unknown',
  session_summary TEXT
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

-- session_journal: flow breadcrumbs, milestones, session summaries
CREATE TABLE IF NOT EXISTS session_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('flow', 'milestone', 'summary')),
  content TEXT NOT NULL,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_journal_session
  ON session_journal(session_id, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_journal_project_type
  ON session_journal(project, entry_type, timestamp_epoch DESC);

-- artifacts: reference + materialization context model
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (
    'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone',
    'memory_file', 'session_log', 'handoff'
  )),
  artifact_ref TEXT,
  summary TEXT NOT NULL,
  content TEXT,
  state TEXT NOT NULL DEFAULT 'fresh'
    CHECK (state IN ('fresh', 'packed', 'materialized')),
  ttl INTEGER NOT NULL DEFAULT 3,
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  retrieval_score REAL NOT NULL DEFAULT 1.0,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  last_materialized_epoch INTEGER
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project_state
  ON artifacts(project, state, importance DESC, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_type_importance
  ON artifacts(project, artifact_type, importance DESC, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_session
  ON artifacts(session_id, timestamp_epoch DESC);

-- artifacts_fts: full-text search on artifact summary + content (Claudex Recall)
-- bm25() returns negative values (more negative = better match).
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  summary,
  content,
  content=artifacts,
  content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, summary, content)
  VALUES (new.id, new.summary, COALESCE(new.content, ''));
END;
CREATE TRIGGER IF NOT EXISTS artifacts_fts_update AFTER UPDATE OF summary, content ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
  VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
  INSERT INTO artifacts_fts(rowid, summary, content)
  VALUES (new.id, new.summary, COALESCE(new.content, ''));
END;
CREATE TRIGGER IF NOT EXISTS artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
  VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
END;

-- context_triggers: maps file globs and command patterns to knowledge domains
CREATE TABLE IF NOT EXISTS context_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glob_pattern TEXT,
  command_pattern TEXT,
  knowledge_domain TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  project TEXT NOT NULL DEFAULT '__global__'
);

-- session_events: structured events for cross-session thread reconstruction
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_session_events_session
  ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_project
  ON session_events(project, timestamp_epoch);

-- verified_facts: session-scoped facts for checkpoint inclusion
CREATE TABLE IF NOT EXISTS verified_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_verified_facts_session
  ON verified_facts(session_id, created_at_epoch DESC);

-- experience_patterns: cross-session failure pattern memory with ExpeL scoring
CREATE TABLE IF NOT EXISTS experience_patterns (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('correction', 'behavioral', 'discovery')),
  trigger_context TEXT NOT NULL,
  lesson TEXT NOT NULL,
  anti_pattern TEXT,
  severity TEXT NOT NULL DEFAULT 'important'
    CHECK (severity IN ('critical', 'important', 'minor')),
  score INTEGER NOT NULL DEFAULT 2,
  times_triggered INTEGER NOT NULL DEFAULT 0,
  times_useful INTEGER NOT NULL DEFAULT 0,
  source_session TEXT,
  source_project TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  last_triggered_epoch INTEGER,
  trigger_glob TEXT,
  trigger_command TEXT
);

CREATE INDEX IF NOT EXISTS idx_expat_project_score
  ON experience_patterns(source_project, score DESC);
CREATE INDEX IF NOT EXISTS idx_expat_score
  ON experience_patterns(score DESC, times_triggered DESC);

-- FTS5 index for trigger context matching
CREATE VIRTUAL TABLE IF NOT EXISTS experience_patterns_fts USING fts5(
  trigger_context,
  lesson,
  anti_pattern,
  content='experience_patterns',
  content_rowid='rowid'
);

-- Keep FTS in sync with experience_patterns
CREATE TRIGGER IF NOT EXISTS experience_patterns_ai AFTER INSERT ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
  VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern);
END;

CREATE TRIGGER IF NOT EXISTS experience_patterns_ad AFTER DELETE ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern)
  VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern);
END;

CREATE TRIGGER IF NOT EXISTS experience_patterns_au AFTER UPDATE ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern)
  VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern);
  INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
  VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern);
END;
`;

/**
 * Team coordination tables: file leases + artifact claims.
 * Advisory locks and retrieved-set coordination for parallel workers.
 */
const TEAM_COORDINATION_SCHEMA = `
-- file_leases: advisory file locks for parallel workers (MCP Agent Mail pattern)
CREATE TABLE IF NOT EXISTS file_leases (
  file_path TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  granted_at_epoch INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 600
);

-- artifact_claims: retrieved-set coordination to prevent duplicate worker work
CREATE TABLE IF NOT EXISTS artifact_claims (
  artifact_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  claimed_at_epoch INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 300,
  PRIMARY KEY (artifact_id)
);
`;

/**
 * Telemetry table DDL — separate constant for clarity.
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
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  adapter TEXT DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch DESC);
`;

/**
 * Checks if an SQLite error message matches a known benign pattern.
 * Used in catch blocks to distinguish expected schema-evolution errors from real failures.
 */
export function isSqliteExpectedError(msg: string): boolean {
  const BENIGN_PATTERNS = [
    'already exists',
    'no such table',
    'may not be altered',
    'already another table',
  ];
  const lower = msg.toLowerCase();
  return BENIGN_PATTERNS.some(p => lower.includes(p));
}

/**
 * Checks whether a table exists in the database.
 */
function hasTable(db: Database, table: string): boolean {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?").get(table) as { cnt: number };
  return row.cnt > 0;
}

/**
 * Checks whether a column exists on a table.
 * Uses PRAGMA table_info for reliable detection.
 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

/**
 * Ensures adapter columns exist on sessions and telemetry tables.
 * Idempotent — checks column existence before ALTER.
 * Called from migrateV1toV2 and available for any future migration path.
 */
function ensureAdapterColumns(db: Database): void {
  if (hasTable(db, 'sessions') && !hasColumn(db, 'sessions', 'adapter')) {
    db.exec("ALTER TABLE sessions ADD COLUMN adapter TEXT DEFAULT 'unknown'");
  }
  const telemetryCols = db.pragma('table_info(telemetry)') as Array<{ name: string }>;
  if (telemetryCols.length > 0 && !telemetryCols.some(c => c.name === 'adapter')) {
    db.exec("ALTER TABLE telemetry ADD COLUMN adapter TEXT DEFAULT 'unknown'");
  }
}

/**
 * Detects and drops a stale v2 FTS5 index that has the wrong column count.
 * The v2 schema had 4 FTS columns (title, content, category, tool_name) but v3
 * triggers only populate 2 (title, content). If the old 4-column FTS exists,
 * drops the table and its sync triggers so SCHEMA_V3 can recreate them correctly.
 * Idempotent — no-op if FTS5 doesn't exist or already has the correct 2-column schema.
 */
function rebuildStaleFts5(db: Database): void {
  if (!hasTable(db, 'observations_fts')) return;

  try {
    // Check 1: Column count — v2 had 4 columns, v3 needs 2.
    const ftsColInfo = db.pragma('table_info(observations_fts)') as Array<{ name: string }>;
    if (ftsColInfo.length > 2) {
      // Stale v2 FTS5 with extra columns — drop it and its triggers
      db.exec('DROP TABLE IF EXISTS observations_fts');
      db.exec('DROP TRIGGER IF EXISTS observations_ai');
      db.exec('DROP TRIGGER IF EXISTS observations_ad');
      db.exec('DROP TRIGGER IF EXISTS observations_au');
      return;
    }

    // Check 2: Row count consistency — FTS can silently desync if a trigger fails
    // (e.g., disk full mid-INSERT). If the counts diverge by >5%, force a rebuild.
    if (hasTable(db, 'observations')) {
      const obsCount = (db.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number })?.cnt ?? 0;
      const ftsCount = (db.prepare('SELECT COUNT(*) as cnt FROM observations_fts').get() as { cnt: number })?.cnt ?? 0;
      if ((obsCount === 0 && ftsCount > 0) || (obsCount > 0 && Math.abs(obsCount - ftsCount) > obsCount * 0.05)) {
        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
      }
    }
  } catch {
    // If anything goes wrong (e.g., corrupted FTS), drop and let SCHEMA_V3 recreate
    try {
      db.exec('DROP TABLE IF EXISTS observations_fts');
      db.exec('DROP TRIGGER IF EXISTS observations_ai');
      db.exec('DROP TRIGGER IF EXISTS observations_ad');
      db.exec('DROP TRIGGER IF EXISTS observations_au');
    } catch { /* truly broken — initializeSchema will attempt CREATE anyway */ }
  }
}

/**
 * Migrates a V1 (legacy, pre-versioning) database to V2 schema.
 * All operations are idempotent — checks column existence before ALTER.
 *
 * Steps:
 * 1. pressure_scores: last_accessed_epoch → last_touched_epoch
 * 2. observations.consumed (INTEGER NOT NULL DEFAULT 0)
 * 3. observations.obs_type (TEXT)
 * 4. sessions.adapter + telemetry.adapter (via ensureAdapterColumns)
 * 5. idx_obs_consumed index
 */
function migrateV1toV2(db: Database): void {
  // 1. pressure_scores: rename last_accessed_epoch → last_touched_epoch
  if (hasTable(db, 'pressure_scores') && hasColumn(db, 'pressure_scores', 'last_accessed_epoch') && !hasColumn(db, 'pressure_scores', 'last_touched_epoch')) {
    db.exec('ALTER TABLE pressure_scores ADD COLUMN last_touched_epoch INTEGER');
    db.exec('UPDATE pressure_scores SET last_touched_epoch = last_accessed_epoch');
  }

  // 2. observations.consumed
  if (!hasColumn(db, 'observations', 'consumed')) {
    db.exec('ALTER TABLE observations ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0');
  }

  // 3. observations.obs_type
  if (!hasColumn(db, 'observations', 'obs_type')) {
    db.exec('ALTER TABLE observations ADD COLUMN obs_type TEXT');
  }

  // 4. sessions.adapter + telemetry.adapter
  ensureAdapterColumns(db);

  // 5. idx_obs_consumed index
  db.exec('CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC)');
}

/**
 * Migration: schema correctness and performance fixes.
 * Applies 6 changes in a single transaction:
 *   C4+A1: Recreate artifact_claims — single-owner PK, artifact_id INTEGER
 *   C9+A4: Recreate experience_patterns_fts — porter stemmer + scoped UPDATE trigger
 *   A2:    Add worker_id index on file_leases
 *   A3:    Add learnings_fts FTS5 table + sync triggers + backfill
 *
 * Idempotent — safe to run on databases that already have the new schema.
 * Called from initializeSchema() after base DDL has been applied.
 */
function migrateSchemaFixes(db: Database): void {
  // Guard: only run once. Check if artifact_claims already has INTEGER type
  // AND learnings_fts exists. Both conditions mean migration was already applied.
  if (hasTable(db, 'learnings_fts') && hasTable(db, 'artifact_claims')) {
    try {
      const cols = db.pragma('table_info(artifact_claims)') as Array<{ name: string; type: string }>;
      const artCol = cols.find(c => c.name === 'artifact_id');
      if (artCol?.type === 'INTEGER') return; // Already migrated
    } catch { /* proceed with migration */ }
  }

  const migrate = db.transaction(() => {
    // C4 + A1: Recreate artifact_claims with single-owner PK and correct types.
    // Claims are advisory TTL-based data — safe to lose on migration.
    if (hasTable(db, 'artifact_claims')) {
      db.exec('DROP TABLE artifact_claims');
    }
    db.exec(`
      CREATE TABLE artifact_claims (
        artifact_id INTEGER PRIMARY KEY,
        worker_id TEXT NOT NULL,
        claimed_at_epoch INTEGER NOT NULL,
        ttl_seconds INTEGER NOT NULL DEFAULT 300
      )
    `);

    // A4 + C9: Recreate experience_patterns_fts with porter stemmer.
    // Also recreates all three sync triggers — UPDATE trigger scoped to text columns only.
    if (hasTable(db, 'experience_patterns_fts')) {
      db.exec('DROP TABLE experience_patterns_fts');
    }
    db.exec('DROP TRIGGER IF EXISTS experience_patterns_ai');
    db.exec('DROP TRIGGER IF EXISTS experience_patterns_ad');
    db.exec('DROP TRIGGER IF EXISTS experience_patterns_au');

    db.exec(`
      CREATE VIRTUAL TABLE experience_patterns_fts USING fts5(
        trigger_context, lesson, anti_pattern,
        tokenize='porter unicode61',
        content=experience_patterns,
        content_rowid=rowid
      )
    `);

    db.exec(`
      CREATE TRIGGER experience_patterns_ai AFTER INSERT ON experience_patterns BEGIN
        INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
        VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern);
      END
    `);

    db.exec(`
      CREATE TRIGGER experience_patterns_ad AFTER DELETE ON experience_patterns BEGIN
        INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern)
        VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern);
      END
    `);

    db.exec(`
      CREATE TRIGGER experience_patterns_au AFTER UPDATE OF trigger_context, lesson, anti_pattern ON experience_patterns BEGIN
        INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern)
        VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern);
        INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
        VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern);
      END
    `);

    // Backfill experience_patterns_fts from existing data
    if (hasTable(db, 'experience_patterns')) {
      db.exec(`
        INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
          SELECT rowid, trigger_context, lesson, COALESCE(anti_pattern, '') FROM experience_patterns
      `);
    }

    // A2: Add worker_id index on file_leases
    if (hasTable(db, 'file_leases')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_file_leases_worker ON file_leases(worker_id)');
    }

    // A3: Add learnings FTS5 table + sync triggers
    if (!hasTable(db, 'learnings_fts')) {
      db.exec(`
        CREATE VIRTUAL TABLE learnings_fts USING fts5(
          content,
          tokenize='porter unicode61',
          content=learnings,
          content_rowid=id
        )
      `);

      db.exec(`
        CREATE TRIGGER learnings_fts_ai AFTER INSERT ON learnings BEGIN
          INSERT INTO learnings_fts(rowid, content) VALUES(new.id, new.content);
        END
      `);

      db.exec(`
        CREATE TRIGGER learnings_fts_ad AFTER DELETE ON learnings BEGIN
          INSERT INTO learnings_fts(learnings_fts, rowid, content) VALUES('delete', old.id, old.content);
        END
      `);

      db.exec(`
        CREATE TRIGGER learnings_fts_au AFTER UPDATE OF content ON learnings BEGIN
          INSERT INTO learnings_fts(learnings_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO learnings_fts(rowid, content) VALUES(new.id, new.content);
        END
      `);

      // Backfill learnings_fts from existing data
      if (hasTable(db, 'learnings')) {
        db.exec('INSERT INTO learnings_fts(rowid, content) SELECT id, content FROM learnings');
      }
    }
  });

  migrate();
}

/**
 * PRAGMA user_version migration runner.
 * Detects DB version and applies incremental migrations.
 * Called by openDatabase() (hot path) and initializeSchema() (CLI/test path).
 *
 * Version map:
 *   0 — fresh DB (no tables) or legacy DB (pre-versioning, has tables)
 *   1 — reserved (unused currently)
 *   2 — current (all migrations applied)
 *
 * Dual version tracking:
 * Both `PRAGMA user_version` and `schema_versions` table are needed:
 *   - `PRAGMA user_version = 3` — fast O(1) check on every DB open (runMigrations hot path)
 *   - `schema_versions.version = 300` — semantic version for cross-version detection
 *     (detectV2Database, verifyMigration, migrateFromV2)
 * user_version gates incremental ALTER migrations; schema_versions gates data migrations
 * and cross-install compatibility checks.
 */
export function runMigrations(db: Database): void {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  const version = row[0]?.user_version ?? 0;

  if (version >= 4) {
    return; // Already current — no-op
  }

  if (version === 3) {
    migrateV3toV4(db);
    db.pragma('user_version = 4');
    return;
  }

  if (version === 2) {
    if (migrateV2toV3(db)) {
      migrateV3toV4(db);
      db.pragma('user_version = 4');
    }
    return;
  }

  if (version === 0) {
    // Could be fresh DB or legacy DB created before versioning
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);

    if (tables.includes('observations')) {
      // Legacy DB — run all migrations from V1
      migrateV1toV2(db);
      if (migrateV2toV3(db)) {
        migrateV3toV4(db);
        db.pragma('user_version = 4');
      } else {
        db.pragma('user_version = 2');
      }
    }
    return;
  }

  if (version === 1) {
    migrateV1toV2(db);
    if (migrateV2toV3(db)) {
      migrateV3toV4(db);
      db.pragma('user_version = 4');
    } else {
      db.pragma('user_version = 2');
    }
  }
}

/**
 * Extends artifact_type CHECK constraint to include file-based types
 * (memory_file, session_log, handoff) for Claudex Recall.
 * SQLite doesn't support ALTER CHECK — must rebuild the table.
 * Idempotent — safe to call on DBs that already have the new types.
 */
function migrateV2toV3(db: Database): boolean {
  try {
    // Check if artifacts table exists
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    if (!tables.includes('artifacts')) return true; // Fresh DB — DDL will create correct table

    // Check if the CHECK constraint already allows new types via SAVEPOINT (no data risk)
    try {
      db.exec(`SAVEPOINT v3_probe`);
      db.exec(`INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, state, ttl, importance)
        VALUES ('__v3_probe__', '__v3_probe__', 'memory_file', NULL, '__v3_probe__', 'packed', 0, 1)`);
      db.exec(`ROLLBACK TO v3_probe`);
      db.exec(`RELEASE v3_probe`);
      return true; // Constraint already allows new types
    } catch {
      try { db.exec('ROLLBACK TO v3_probe'); } catch { /* */ }
      try { db.exec('RELEASE v3_probe'); } catch { /* */ }
    }

    // Rebuild table with extended CHECK constraint (in a transaction)
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE artifacts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN (
            'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone',
            'memory_file', 'session_log', 'handoff'
          )),
          artifact_ref TEXT,
          summary TEXT NOT NULL,
          content TEXT,
          state TEXT NOT NULL DEFAULT 'fresh'
            CHECK (state IN ('fresh', 'packed', 'materialized')),
          ttl INTEGER NOT NULL DEFAULT 3,
          importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
          timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
          last_materialized_epoch INTEGER
        );
        INSERT INTO artifacts_new (id, session_id, project, artifact_type, artifact_ref,
        summary, content, state, ttl, importance, timestamp_epoch, last_materialized_epoch)
      SELECT id, session_id, project, artifact_type, artifact_ref,
        summary, content, state, ttl, importance, timestamp_epoch, last_materialized_epoch
      FROM artifacts;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_new RENAME TO artifacts;
        CREATE INDEX IF NOT EXISTS idx_artifacts_project_state ON artifacts(project, state);
        CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);
      `);
      db.exec('COMMIT');
      return true;
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* */ }
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Adds artifacts_fts, context_triggers, session_events tables,
 * retrieval_score column, and trigger_glob/trigger_command columns.
 * Backfills artifacts_fts from existing artifacts.
 * Idempotent — safe to call on DBs that already have these.
 */
function migrateV3toV4(db: Database): void {
  try {
    // artifacts_fts virtual table
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map(t => t.name);

    if (!tables.includes('artifacts_fts')) {
      db.exec(`
        CREATE VIRTUAL TABLE artifacts_fts USING fts5(
          summary, content, content=artifacts, content_rowid=id,
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
          INSERT INTO artifacts_fts(rowid, summary, content)
          VALUES (new.id, new.summary, COALESCE(new.content, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_update AFTER UPDATE OF summary, content ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
          VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
          INSERT INTO artifacts_fts(rowid, summary, content)
          VALUES (new.id, new.summary, COALESCE(new.content, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
          VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
        END;
      `);
      // Backfill existing artifacts
      db.exec(`INSERT INTO artifacts_fts(rowid, summary, content) SELECT id, summary, COALESCE(content, '') FROM artifacts`);
    }

    // context_triggers table
    if (!tables.includes('context_triggers')) {
      db.exec(`
        CREATE TABLE context_triggers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          glob_pattern TEXT,
          command_pattern TEXT,
          knowledge_domain TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 5,
          project TEXT NOT NULL DEFAULT '__global__'
        );
      `);
    }

    // session_events table
    if (!tables.includes('session_events')) {
      db.exec(`
        CREATE TABLE session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          event_type TEXT NOT NULL,
          entity TEXT NOT NULL,
          action TEXT NOT NULL,
          detail TEXT,
          timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(project, timestamp_epoch);
      `);
    }

    // Unique index for file artifact dedup (moved from runtime to migration)
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_file_ref
        ON artifacts(project, artifact_type, artifact_ref)
        WHERE artifact_ref IS NOT NULL
          AND artifact_type IN ('memory_file', 'session_log', 'handoff')`);
    } catch { /* partial index may not be supported on older SQLite */ }

    // retrieval_score column on artifacts
    const artCols = (db.pragma('table_info(artifacts)') as Array<{ name: string }>).map(c => c.name);
    if (!artCols.includes('retrieval_score')) {
      db.exec("ALTER TABLE artifacts ADD COLUMN retrieval_score REAL NOT NULL DEFAULT 1.0");
    }

    // trigger_glob and trigger_command columns on experience_patterns
    if (tables.includes('experience_patterns')) {
      const epCols = (db.pragma('table_info(experience_patterns)') as Array<{ name: string }>).map(c => c.name);
      if (!epCols.includes('trigger_glob')) {
        db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_glob TEXT");
      }
      if (!epCols.includes('trigger_command')) {
        db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_command TEXT");
      }
    }

    // session_summary column on sessions
    const sessCols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map(c => c.name);
    if (!sessCols.includes('session_summary')) {
      db.exec("ALTER TABLE sessions ADD COLUMN session_summary TEXT");
    }
  } catch {
    // Non-throwing — partial migration is acceptable
  }
}

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

  // sessions + telemetry: v3 needs 'adapter' column (ensureAdapterColumns handles both)
  ensureAdapterColumns(db);

  // pressure_scores: check for v2 WARM temperature values
  try {
    db.exec("UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature NOT IN ('HOT', 'COLD')");
  } catch { /* table may not exist */ }
}

/**
 * Initializes the complete v3 schema: 9 tables + telemetry + FTS5 + triggers + indexes.
 * Records schema version 300. Idempotent (all IF NOT EXISTS).
 * Handles in-place upgrade when opening an existing v2 database at the same path.
 */
export function initializeSchema(db: Database): void {
  upgradeV2SchemaInPlace(db);
  runMigrations(db);

  // FTS5: detect stale v2 index with wrong column count (4 cols: title, content, category, tool_name)
  // and drop it so SCHEMA_V3 recreates it with the correct 2-column schema (title, content only).
  // Must run BEFORE db.exec(SCHEMA_V3) so the CREATE VIRTUAL TABLE IF NOT EXISTS succeeds.
  // Idempotent: no-op on fresh DBs (no observations_fts yet) or already-migrated DBs (2 cols).
  rebuildStaleFts5(db);

  db.exec(SCHEMA_V3);
  db.exec(TELEMETRY_SCHEMA);
  db.exec(TEAM_COORDINATION_SCHEMA);

  // Rebuild FTS5 content index from observations table.
  // Needed after upgradeV2SchemaInPlace drops a stale 4-column FTS and SCHEMA_V3 recreates
  // the 2-column version — existing observation rows won't be in the new FTS index otherwise.
  // The 'rebuild' command is idempotent and fast on fresh DBs (no rows to reindex).
  if (hasTable(db, 'observations') && hasTable(db, 'observations_fts')) {
    try {
      db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
    } catch { /* FTS rebuild failed — non-fatal, search won't work but writes are fine */ }
  }

  // Schema fixes: single-owner artifact_claims, porter stemmer on FTS, scoped triggers,
  // file_leases index, learnings FTS. Idempotent — no-op on fresh DBs or already-migrated.
  migrateSchemaFixes(db);

  // Live DB may have v2 schema (applied_at TEXT NOT NULL, no DEFAULT) or v3 (applied_at_epoch).
  // Provide both to handle either table shape; OR IGNORE handles the UNIQUE constraint.
  const svCols = (db.pragma('table_info(schema_versions)') as Array<{ name: string }>).map(c => c.name);
  if (svCols.includes('applied_at')) {
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, datetime())').run(SCHEMA_VERSION);
  } else {
    db.prepare('INSERT OR IGNORE INTO schema_versions (version) VALUES (?)').run(SCHEMA_VERSION);
  }
  db.pragma('user_version = 4');
}

/**
 * Migrates data from a v2 database into the current v3 database.
 * Wraps entire migration in a transaction for atomicity.
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
      db.exec(TEAM_COORDINATION_SCHEMA);

      // Helper: check if a table exists in the v2 database
      const v2HasTable = (tableName: string): boolean => {
        const row = db.prepare(
          "SELECT 1 FROM v2.sqlite_master WHERE type='table' AND name = ?"
        ).get(tableName) as { 1: number } | undefined;
        return row != null;
      };

      // 3. Copy observations, sessions, pressure_scores from v2
      // Guard each table copy with existence check for partial legacy DBs

      // Note: files_modified may be comma-separated in v2, which fails json_valid CHECK.
      // We copy with files_modified defaulting to '[]' and fix in step 7.
      if (v2HasTable('observations')) {
        db.exec(`
          INSERT OR IGNORE INTO observations (id, session_id, project, tool_name, category, title, content, importance, files_modified, timestamp_epoch, access_count, last_accessed_at_epoch, deleted_at_epoch)
          SELECT id, session_id, project, tool_name, category, title, content, importance,
            CASE WHEN json_valid(files_modified) THEN files_modified ELSE '[]' END,
            timestamp_epoch, access_count, last_accessed_at_epoch, deleted_at_epoch
          FROM v2.observations
        `);
      }

      if (v2HasTable('sessions')) {
        db.exec(`
          INSERT OR IGNORE INTO sessions (session_id, scope, project, cwd, source, status, observation_count, created_at_epoch, ended_at_epoch)
          SELECT session_id, scope, project, cwd, source, status, observation_count, created_at_epoch, ended_at_epoch
          FROM v2.sessions
        `);
      }

      // Convert WARM -> COLD during copy (v3 only allows HOT/COLD)
      if (v2HasTable('pressure_scores')) {
        db.exec(`
          INSERT OR IGNORE INTO pressure_scores (file_path, project, raw_pressure, temperature, last_touched_epoch, decay_rate)
          SELECT file_path, project, raw_pressure,
            CASE WHEN temperature IN ('HOT', 'COLD') THEN temperature ELSE 'COLD' END,
            last_touched_epoch, decay_rate
          FROM v2.pressure_scores
        `);
      }

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
      // Guard: v2.observations may not exist in partial legacy DBs
      if (v2HasTable('observations')) {
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
