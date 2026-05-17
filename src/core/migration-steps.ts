/**
 * Migration step functions — all versioned schema migrations (V1→V2 through V8→V9).
 *
 * Each function is idempotent and non-throwing (safe to re-run).
 * Called by runMigrations() in migrations.ts.
 *
 * Split from migrations.ts for clarity — steps are procedural, schema is declarative.
 */

import type { Database } from 'better-sqlite3';
import { loadSqliteVec } from './sqlite-vec-loader.js';
import { applyV17DDL } from './migration/v17-ddl.js';
import { applyGeneratedDDL, generateViewsAndTriggers } from './migration/v17-triggers.js';
import { KIND_MAPPING } from './migration/kind-mapping.js';
import { SHAPE_VOCABULARY_SCHEMA, POINTER_RECALL_SCHEMA, TELEMETRY_SCHEMA, ARTIFACT_TASK_PATTERN_SCHEMA, SCHEMA_V22 } from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



/**
 * Checks whether a table exists in the database.
 */
export function hasTable(db: Database, table: string): boolean {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?").get(table) as { cnt: number };
  return row.cnt > 0;
}

/**
 * Checks whether a column exists on a table.
 * Uses PRAGMA table_info for reliable detection.
 */
export function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

/**
 * Ensures adapter columns exist on sessions and telemetry tables.
 * Idempotent — checks column existence before ALTER.
 * Called from migrateV1toV2 and available for any future migration path.
 */
export function ensureAdapterColumns(db: Database): void {
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
export function rebuildStaleFts5(db: Database): void {
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

// ---------------------------------------------------------------------------
// V1 → V2
// ---------------------------------------------------------------------------

/**
 * Migrates a V1 (legacy, pre-versioning) database to V2 schema.
 * All operations are idempotent — checks column existence before ALTER.
 */
export function migrateV1toV2(db: Database): void {
  if (hasTable(db, 'pressure_scores') && hasColumn(db, 'pressure_scores', 'last_accessed_epoch') && !hasColumn(db, 'pressure_scores', 'last_touched_epoch')) {
    db.exec('ALTER TABLE pressure_scores ADD COLUMN last_touched_epoch INTEGER');
    db.exec('UPDATE pressure_scores SET last_touched_epoch = last_accessed_epoch');
  }
  if (!hasColumn(db, 'observations', 'consumed')) {
    db.exec('ALTER TABLE observations ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'observations', 'obs_type')) {
    db.exec('ALTER TABLE observations ADD COLUMN obs_type TEXT');
  }
  ensureAdapterColumns(db);
  // Use _ms name if already present (post-V35 fixture), otherwise legacy name
  const tsCol = hasColumn(db, 'observations', 'timestamp_epoch_ms') ? 'timestamp_epoch_ms' : 'timestamp_epoch';
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, ${tsCol} DESC)`);
}

// ---------------------------------------------------------------------------
// V2 → V3
// ---------------------------------------------------------------------------

/**
 * Extends artifact_type CHECK constraint to include file-based types
 * (memory_file, session_log, handoff) for Claudex Recall.
 * SQLite doesn't support ALTER CHECK — must rebuild the table.
 * Idempotent — safe to call on DBs that already have the new types.
 */
export function migrateV2toV3(db: Database): boolean {
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    if (!tables.includes('artifacts')) return true;

    try {
      db.exec(`SAVEPOINT v3_probe`);
      db.exec(`INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, state, ttl, importance)
        VALUES ('__v3_probe__', '__v3_probe__', 'memory_file', NULL, '__v3_probe__', 'packed', 0, 1)`);
      db.exec(`ROLLBACK TO v3_probe`);
      db.exec(`RELEASE v3_probe`);
      return true;
    } catch {
      try { db.exec('ROLLBACK TO v3_probe'); } catch { /* */ }
      try { db.exec('RELEASE v3_probe'); } catch { /* */ }
    }

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

// ---------------------------------------------------------------------------
// V3 → V4
// ---------------------------------------------------------------------------

/**
 * Adds artifacts_fts, context_triggers, session_events tables,
 * retrieval_score column, and trigger_glob/trigger_command columns.
 */
export function migrateV3toV4(db: Database): void {
  try {
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
      db.exec(`INSERT INTO artifacts_fts(rowid, summary, content) SELECT id, summary, COALESCE(content, '') FROM artifacts`);
    }

    if (!tables.includes('context_triggers')) {
      db.exec(`CREATE TABLE context_triggers (id INTEGER PRIMARY KEY AUTOINCREMENT, glob_pattern TEXT, command_pattern TEXT, knowledge_domain TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 5, project TEXT NOT NULL DEFAULT '__global__');`);
    }

    if (!tables.includes('session_events')) {
      db.exec(`CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, event_type TEXT NOT NULL, entity TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(project, timestamp_epoch);`);
    }

    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_file_ref ON artifacts(project, artifact_type, artifact_ref) WHERE artifact_ref IS NOT NULL AND artifact_type IN ('memory_file', 'session_log', 'handoff')`);
    } catch { /* partial index may not be supported on older SQLite */ }

    const artCols = (db.pragma('table_info(artifacts)') as Array<{ name: string }>).map(c => c.name);
    if (!artCols.includes('retrieval_score')) {
      db.exec("ALTER TABLE artifacts ADD COLUMN retrieval_score REAL NOT NULL DEFAULT 1.0");
    }

    if (tables.includes('experience_patterns')) {
      const epCols = (db.pragma('table_info(experience_patterns)') as Array<{ name: string }>).map(c => c.name);
      if (!epCols.includes('trigger_glob')) db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_glob TEXT");
      if (!epCols.includes('trigger_command')) db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_command TEXT");
    }

    const sessCols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map(c => c.name);
    if (!sessCols.includes('session_summary')) db.exec("ALTER TABLE sessions ADD COLUMN session_summary TEXT");
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// V4 → V5
// ---------------------------------------------------------------------------

/**
 * V4 → V5: retrieval_feedback table + v2 legacy cleanup.
 */
export function migrateV4toV5(db: Database): void {
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);

    if (!tables.includes('retrieval_feedback')) {
      db.exec(`CREATE TABLE retrieval_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, artifact_id INTEGER NOT NULL, query_text TEXT NOT NULL, was_useful INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_artifact ON retrieval_feedback(artifact_id);
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_session ON retrieval_feedback(session_id);`);
    }

    if (tables.includes('reasoning_chains')) {
      try {
        db.exec(`UPDATE reasoning_chains SET timestamp_epoch = timestamp_epoch / 1000 WHERE timestamp_epoch > 10000000000`);
        db.exec(`UPDATE reasoning_chains SET created_at_epoch = created_at_epoch / 1000 WHERE created_at_epoch > 10000000000`);
      } catch { /* non-fatal */ }
    }

    try {
      db.exec(`UPDATE observations SET content = '' WHERE content IS NULL`);
      db.exec(`UPDATE observations SET access_count = 0 WHERE access_count IS NULL`);
      db.exec(`UPDATE sessions SET status = 'completed' WHERE status IS NULL`);
      db.exec(`UPDATE sessions SET observation_count = 0 WHERE observation_count IS NULL`);
      db.exec(`UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature IS NULL`);
      db.exec(`UPDATE pressure_scores SET last_touched_epoch = 0 WHERE last_touched_epoch IS NULL`);
      db.exec(`UPDATE pressure_scores SET decay_rate = 0.1 WHERE decay_rate IS NULL`);
      db.exec(`UPDATE session_journal SET timestamp_epoch = 0 WHERE timestamp_epoch IS NULL`);
    } catch { /* non-fatal */ }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// V5 → V6
// ---------------------------------------------------------------------------

/**
 * V5 → V6: Full table rebuild for NOT NULL constraints + journal metadata column.
 */
export function migrateV5toV6(db: Database): void {
  try {
    if (hasTable(db, 'session_journal') && !hasColumn(db, 'session_journal', 'metadata')) {
      db.exec("ALTER TABLE session_journal ADD COLUMN metadata TEXT");
    }

    if (hasTable(db, 'session_journal')) {
      try {
        db.exec("SAVEPOINT v6_sj_probe");
        db.exec("INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch) VALUES ('__probe__', '__probe__', 'flow', '__probe__', NULL)");
        db.exec("ROLLBACK TO v6_sj_probe");
        db.exec("RELEASE v6_sj_probe");

        db.exec("BEGIN");
        db.exec(`CREATE TABLE session_journal_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, entry_type TEXT NOT NULL CHECK (entry_type IN ('flow', 'milestone', 'summary')), content TEXT NOT NULL, metadata TEXT, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()))`);
        db.exec(`INSERT INTO session_journal_new (id, session_id, project, entry_type, content, metadata, timestamp_epoch) SELECT id, session_id, project, entry_type, content, metadata, COALESCE(timestamp_epoch, 0) FROM session_journal`);
        db.exec("DROP TABLE session_journal");
        db.exec("ALTER TABLE session_journal_new RENAME TO session_journal");
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* */ }
        try { db.exec("ROLLBACK TO v6_sj_probe"); } catch { /* */ }
        try { db.exec("RELEASE v6_sj_probe"); } catch { /* */ }
      }
    }

    if (hasTable(db, 'sessions')) {
      try {
        db.exec("SAVEPOINT v6_sess_probe");
        db.exec("INSERT INTO sessions (session_id, status) VALUES ('__v6_probe__', NULL)");
        db.exec("ROLLBACK TO v6_sess_probe");
        db.exec("RELEASE v6_sess_probe");

        db.exec("BEGIN");
        db.exec(`CREATE TABLE sessions_new (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'unknown', project TEXT NOT NULL DEFAULT '__global__', cwd TEXT NOT NULL DEFAULT '.', source TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')), observation_count INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), ended_at_epoch INTEGER, adapter TEXT DEFAULT 'unknown', session_summary TEXT)`);
        db.exec(`INSERT INTO sessions_new SELECT session_id, COALESCE(scope, 'unknown'), COALESCE(project, '__global__'), COALESCE(cwd, '.'), source, COALESCE(status, 'completed'), COALESCE(observation_count, 0), created_at_epoch, ended_at_epoch, adapter, session_summary FROM sessions`);
        db.exec("DROP TABLE sessions");
        db.exec("ALTER TABLE sessions_new RENAME TO sessions");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, created_at_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, created_at_epoch DESC)");
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* */ }
        try { db.exec("ROLLBACK TO v6_sess_probe"); } catch { /* */ }
        try { db.exec("RELEASE v6_sess_probe"); } catch { /* */ }
      }
    }

    if (hasTable(db, 'observations')) {
      try {
        db.exec("SAVEPOINT v6_obs_probe");
        db.exec("INSERT INTO observations (session_id, tool_name, category, title, content, importance) VALUES ('__v6__', 'Test', 'code', 'test', NULL, 1)");
        db.exec("ROLLBACK TO v6_obs_probe");
        db.exec("RELEASE v6_obs_probe");

        db.exec("BEGIN");
        db.exec("DROP TRIGGER IF EXISTS observations_ai");
        db.exec("DROP TRIGGER IF EXISTS observations_ad");
        db.exec("DROP TRIGGER IF EXISTS observations_au");

        db.exec(`CREATE TABLE observations_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT, tool_name TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('code', 'architecture', 'decision', 'error', 'test', 'config', 'dependency', 'documentation', 'performance', 'security', 'other')), title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)), timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()), access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at_epoch INTEGER, deleted_at_epoch INTEGER DEFAULT NULL, consumed INTEGER NOT NULL DEFAULT 0, obs_type TEXT)`);
        db.exec(`INSERT INTO observations_new SELECT id, session_id, project, tool_name, category, title, COALESCE(content, ''), importance, files_modified, timestamp_epoch, COALESCE(access_count, 0), last_accessed_at_epoch, deleted_at_epoch, consumed, obs_type FROM observations`);
        db.exec("DROP TABLE observations");
        db.exec("ALTER TABLE observations_new RENAME TO observations");

        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_composite ON observations(tool_name, category, project, session_id, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_active ON observations(project, deleted_at_epoch, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_importance ON observations(project, deleted_at_epoch, importance)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC)");

        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);

        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* */ }
        try { db.exec("ROLLBACK TO v6_obs_probe"); } catch { /* */ }
        try { db.exec("RELEASE v6_obs_probe"); } catch { /* */ }
      }
    }

    if (hasTable(db, 'pressure_scores')) {
      try {
        db.exec("SAVEPOINT v6_ps_probe");
        db.exec("INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature) VALUES ('__probe__', '__probe__', 0, NULL)");
        db.exec("ROLLBACK TO v6_ps_probe");
        db.exec("RELEASE v6_ps_probe");

        db.exec("BEGIN");
        db.exec(`CREATE TABLE pressure_scores_new (file_path TEXT NOT NULL, project TEXT NOT NULL, raw_pressure REAL NOT NULL DEFAULT 0, temperature TEXT NOT NULL DEFAULT 'COLD', last_touched_epoch INTEGER NOT NULL DEFAULT 0, decay_rate REAL NOT NULL DEFAULT 0.1, PRIMARY KEY (file_path, project))`);
        db.exec(`INSERT OR IGNORE INTO pressure_scores_new (file_path, project, raw_pressure, temperature, last_touched_epoch, decay_rate) SELECT file_path, project, raw_pressure, COALESCE(temperature, 'COLD'), COALESCE(last_touched_epoch, 0), COALESCE(decay_rate, 0.1) FROM pressure_scores`);
        db.exec("DROP TABLE pressure_scores");
        db.exec("ALTER TABLE pressure_scores_new RENAME TO pressure_scores");
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* */ }
        try { db.exec("ROLLBACK TO v6_ps_probe"); } catch { /* */ }
        try { db.exec("RELEASE v6_ps_probe"); } catch { /* */ }
      }
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// V6 → V7
// ---------------------------------------------------------------------------

/**
 * V6 → V7: Rebuild observations + sessions tables for NOT NULL constraints.
 */
export function migrateV6toV7(db: Database): void {
  try {
    if (hasTable(db, 'sessions')) {
      try {
        db.exec("SAVEPOINT v7_sess_probe");
        db.exec("INSERT INTO sessions (session_id, status) VALUES ('__v7_probe__', NULL)");
        db.exec("ROLLBACK TO v7_sess_probe");
        db.exec("RELEASE v7_sess_probe");

        db.exec("BEGIN");
        db.exec(`CREATE TABLE sessions_new (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'unknown', project TEXT NOT NULL DEFAULT '__global__', cwd TEXT NOT NULL DEFAULT '.', source TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')), observation_count INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), ended_at_epoch INTEGER, adapter TEXT DEFAULT 'unknown', session_summary TEXT)`);
        db.exec(`INSERT INTO sessions_new SELECT session_id, COALESCE(scope, 'unknown'), COALESCE(project, '__global__'), COALESCE(cwd, '.'), source, COALESCE(status, 'completed'), COALESCE(observation_count, 0), created_at_epoch, ended_at_epoch, adapter, session_summary FROM sessions`);
        db.exec("DROP TABLE sessions");
        db.exec("ALTER TABLE sessions_new RENAME TO sessions");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, created_at_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, created_at_epoch DESC)");
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* */ }
        try { db.exec("ROLLBACK TO v7_sess_probe"); } catch { /* */ }
        try { db.exec("RELEASE v7_sess_probe"); } catch { /* */ }
      }
    }

    if (hasTable(db, 'observations')) {
      try {
        db.exec("SAVEPOINT v7_obs_probe");
        db.exec("INSERT INTO observations (session_id, tool_name, category, title, content, importance) VALUES ('__v7__', 'Test', 'code', 'test', NULL, 1)");
        db.exec("ROLLBACK TO v7_obs_probe");
        db.exec("RELEASE v7_obs_probe");

        try {
          db.exec("UPDATE observations SET category = 'code' WHERE category NOT IN ('code','architecture','decision','error','test','config','dependency','documentation','performance','security','other')");
        } catch { /* non-fatal */ }

        db.exec("BEGIN");
        db.exec("DROP TRIGGER IF EXISTS observations_ai");
        db.exec("DROP TRIGGER IF EXISTS observations_ad");
        db.exec("DROP TRIGGER IF EXISTS observations_au");

        db.exec(`CREATE TABLE observations_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT, tool_name TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('code', 'architecture', 'decision', 'error', 'test', 'config', 'dependency', 'documentation', 'performance', 'security', 'other')), title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)), timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()), access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at_epoch INTEGER, deleted_at_epoch INTEGER DEFAULT NULL, consumed INTEGER NOT NULL DEFAULT 0, obs_type TEXT)`);
        db.exec(`INSERT INTO observations_new SELECT id, session_id, project, tool_name, category, title, COALESCE(content, ''), importance, files_modified, timestamp_epoch, COALESCE(access_count, 0), last_accessed_at_epoch, deleted_at_epoch, consumed, obs_type FROM observations`);
        db.exec("DROP TABLE observations");
        db.exec("ALTER TABLE observations_new RENAME TO observations");

        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_composite ON observations(tool_name, category, project, session_id, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_active ON observations(project, deleted_at_epoch, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_importance ON observations(project, deleted_at_epoch, importance)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC)");

        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);

        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* */ }
        try { db.exec("ROLLBACK TO v7_obs_probe"); } catch { /* */ }
        try { db.exec("RELEASE v7_obs_probe"); } catch { /* */ }
      }
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// V7 → V8
// ---------------------------------------------------------------------------

/**
 * V7 → V8: Evolved Flow — recall_text column + FTS5 index on session_journal.
 */
export function migrateV7toV8(db: Database): void {
  try {
    if (hasTable(db, 'session_journal') && !hasColumn(db, 'session_journal', 'recall_text')) {
      db.exec("ALTER TABLE session_journal ADD COLUMN recall_text TEXT");
    }

    if (hasTable(db, 'session_journal') && !hasTable(db, 'session_journal_fts')) {
      db.exec(`
        CREATE VIRTUAL TABLE session_journal_fts USING fts5(
          content, recall_text, content='session_journal', content_rowid=id, tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS journal_fts_ai AFTER INSERT ON session_journal BEGIN
          INSERT INTO session_journal_fts(rowid, content, recall_text) VALUES (new.id, new.content, COALESCE(new.recall_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS journal_fts_ad AFTER DELETE ON session_journal BEGIN
          INSERT INTO session_journal_fts(session_journal_fts, rowid, content, recall_text) VALUES ('delete', old.id, old.content, COALESCE(old.recall_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS journal_fts_au AFTER UPDATE ON session_journal BEGIN
          INSERT INTO session_journal_fts(session_journal_fts, rowid, content, recall_text) VALUES ('delete', old.id, old.content, COALESCE(old.recall_text, ''));
          INSERT INTO session_journal_fts(rowid, content, recall_text) VALUES (new.id, new.content, COALESCE(new.recall_text, ''));
        END;
      `);
      try { db.exec("INSERT INTO session_journal_fts(session_journal_fts) VALUES('rebuild')"); } catch { /* non-fatal */ }
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// V8 → V9
// ---------------------------------------------------------------------------

/**
 * V8 → V9: Semantic Intelligence — vector embeddings, activation scores,
 * superseded-artifact flagging, confidence scoring, novelty scoring.
 */
export function migrateV8toV9(db: Database): void {
  try {
    if (hasTable(db, 'artifacts')) {
      if (!hasColumn(db, 'artifacts', 'embedding')) db.exec("ALTER TABLE artifacts ADD COLUMN embedding BLOB");
      if (!hasColumn(db, 'artifacts', 'activation_score')) db.exec("ALTER TABLE artifacts ADD COLUMN activation_score REAL NOT NULL DEFAULT 1.0");
      if (!hasColumn(db, 'artifacts', 'superseded_by')) db.exec("ALTER TABLE artifacts ADD COLUMN superseded_by INTEGER");
      if (!hasColumn(db, 'artifacts', 'valid_until')) db.exec("ALTER TABLE artifacts ADD COLUMN valid_until INTEGER");
      if (!hasColumn(db, 'artifacts', 'confidence')) db.exec("ALTER TABLE artifacts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0");
      if (!hasColumn(db, 'artifacts', 'novelty_score')) db.exec("ALTER TABLE artifacts ADD COLUMN novelty_score REAL NOT NULL DEFAULT 0.5");
    }

    if (hasTable(db, 'experience_patterns')) {
      if (!hasColumn(db, 'experience_patterns', 'embedding')) db.exec("ALTER TABLE experience_patterns ADD COLUMN embedding BLOB");
      if (!hasColumn(db, 'experience_patterns', 'assumption')) db.exec("ALTER TABLE experience_patterns ADD COLUMN assumption TEXT");
      if (!hasColumn(db, 'experience_patterns', 'reality')) db.exec("ALTER TABLE experience_patterns ADD COLUMN reality TEXT");
      if (!hasColumn(db, 'experience_patterns', 'root_cause')) db.exec("ALTER TABLE experience_patterns ADD COLUMN root_cause TEXT");
      if (!hasColumn(db, 'experience_patterns', 'generalized_rule')) db.exec("ALTER TABLE experience_patterns ADD COLUMN generalized_rule TEXT");
      if (!hasColumn(db, 'experience_patterns', 'abstraction_level')) db.exec("ALTER TABLE experience_patterns ADD COLUMN abstraction_level TEXT DEFAULT 'tip'");
      if (!hasColumn(db, 'experience_patterns', 'verified')) db.exec("ALTER TABLE experience_patterns ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, 'experience_patterns', 'verification_count')) db.exec("ALTER TABLE experience_patterns ADD COLUMN verification_count INTEGER NOT NULL DEFAULT 0");
    }

    if (hasTable(db, 'thread_state')) {
      if (!hasColumn(db, 'thread_state', 'summary_embedding')) db.exec("ALTER TABLE thread_state ADD COLUMN summary_embedding BLOB");
    }

    if (hasTable(db, 'session_journal')) {
      if (!hasColumn(db, 'session_journal', 'embedding')) db.exec("ALTER TABLE session_journal ADD COLUMN embedding BLOB");
    }

    db.exec(`CREATE TABLE IF NOT EXISTS artifact_links (source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, link_type TEXT NOT NULL CHECK (link_type IN ('related', 'supports', 'contradicts', 'supersedes', 'caused_by')), strength REAL NOT NULL DEFAULT 0.5, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (source_id, target_id));`);

    db.exec(`CREATE TABLE IF NOT EXISTS retrieval_events (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id INTEGER NOT NULL, session_id TEXT NOT NULL, query_text TEXT, was_referenced INTEGER, correction_followed INTEGER, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE INDEX IF NOT EXISTS idx_retrieval_artifact ON retrieval_events(artifact_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_events(session_id);`);

    db.exec(`CREATE TABLE IF NOT EXISTS capability_boundaries (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, domain TEXT NOT NULL, total_interactions INTEGER NOT NULL DEFAULT 0, corrections INTEGER NOT NULL DEFAULT 0, last_updated_epoch INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(project, domain));`);

    // Backfill activation_score for pre-V9 artifacts.
    // Uses importance as proxy (no access_count on artifacts — it's on observations).
    try {
      db.exec(`UPDATE artifacts SET activation_score = MAX(0.1, 0.0 + (importance - 3) * 0.3 + 1.0) WHERE activation_score = 1.0 AND id > 0`);
    } catch { /* non-fatal */ }

  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Schema Fixes (post-DDL)
// ---------------------------------------------------------------------------

/**
 * Migration: schema correctness and performance fixes.
 * Applies 6 changes: artifact_claims rebuild, experience_patterns_fts rebuild,
 * file_leases index, learnings_fts FTS5 table + sync triggers.
 */
export function migrateSchemaFixes(db: Database): void {
  if (hasTable(db, 'learnings_fts') && hasTable(db, 'artifact_claims')) {
    try {
      const cols = db.pragma('table_info(artifact_claims)') as Array<{ name: string; type: string }>;
      const artCol = cols.find(c => c.name === 'artifact_id');
      if (artCol?.type === 'INTEGER') return;
    } catch { /* proceed */ }
  }

  const migrate = db.transaction(() => {
    if (hasTable(db, 'artifact_claims')) db.exec('DROP TABLE artifact_claims');
    db.exec(`CREATE TABLE artifact_claims (artifact_id INTEGER PRIMARY KEY, worker_id TEXT NOT NULL, claimed_at_epoch INTEGER NOT NULL, ttl_seconds INTEGER NOT NULL DEFAULT 300)`);

    if (hasTable(db, 'experience_patterns_fts')) db.exec('DROP TABLE experience_patterns_fts');
    db.exec('DROP TRIGGER IF EXISTS experience_patterns_ai');
    db.exec('DROP TRIGGER IF EXISTS experience_patterns_ad');
    db.exec('DROP TRIGGER IF EXISTS experience_patterns_au');

    db.exec(`CREATE VIRTUAL TABLE experience_patterns_fts USING fts5(trigger_context, lesson, anti_pattern, tokenize='porter unicode61', content=experience_patterns, content_rowid=rowid)`);
    db.exec(`CREATE TRIGGER experience_patterns_ai AFTER INSERT ON experience_patterns BEGIN INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern) VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern); END`);
    db.exec(`CREATE TRIGGER experience_patterns_ad AFTER DELETE ON experience_patterns BEGIN INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern) VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern); END`);
    db.exec(`CREATE TRIGGER experience_patterns_au AFTER UPDATE OF trigger_context, lesson, anti_pattern ON experience_patterns BEGIN INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern) VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern); INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern) VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern); END`);

    if (hasTable(db, 'experience_patterns')) {
      db.exec(`INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern) SELECT rowid, trigger_context, lesson, COALESCE(anti_pattern, '') FROM experience_patterns`);
    }

    if (hasTable(db, 'file_leases')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_file_leases_worker ON file_leases(worker_id)');
    }

    if (!hasTable(db, 'learnings_fts')) {
      db.exec(`CREATE VIRTUAL TABLE learnings_fts USING fts5(content, tokenize='porter unicode61', content=learnings, content_rowid=id)`);
      db.exec(`CREATE TRIGGER learnings_fts_ai AFTER INSERT ON learnings BEGIN INSERT INTO learnings_fts(rowid, content) VALUES(new.id, new.content); END`);
      db.exec(`CREATE TRIGGER learnings_fts_ad AFTER DELETE ON learnings BEGIN INSERT INTO learnings_fts(learnings_fts, rowid, content) VALUES('delete', old.id, old.content); END`);
      db.exec(`CREATE TRIGGER learnings_fts_au AFTER UPDATE OF content ON learnings BEGIN INSERT INTO learnings_fts(learnings_fts, rowid, content) VALUES('delete', old.id, old.content); INSERT INTO learnings_fts(rowid, content) VALUES(new.id, new.content); END`);

      if (hasTable(db, 'learnings')) {
        db.exec('INSERT INTO learnings_fts(rowid, content) SELECT id, content FROM learnings');
      }
    }

  });

  migrate();
}

/**
 * Drop orphan tables from pre-V6 schemas. No production code references these.
 * Called from initializeSchema (not migrateSchemaFixes) to avoid the early-return guard.
 * Idempotent — safe to call every startup.
 */
export function cleanupOrphanTables(db: Database): void {
  const orphanTables = [
    'audit_log', 'checkpoint_state', 'consensus_decisions',
    'consensus_fts', 'reasoning_chains', 'reasoning_fts',
  ];
  for (const table of orphanTables) {
    try {
      if (hasTable(db, table)) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    } catch { /* non-throwing per table */ }
  }
}

// ---------------------------------------------------------------------------
// V2 in-place upgrade
// ---------------------------------------------------------------------------

/**
 * V9→V10: Session messages table + ACE counters + data fixes.
 *
 * 1. Creates session_messages table (inter-session message bus)
 * 2. ACE helpful/harmful counters + escalation_level on experience_patterns
 * 3. Backfills counters from existing times_useful/times_triggered
 * 4. Fixes historical millisecond epochs in sessions table
 * 5. Deduplicates reflection artifacts (keeps oldest, deletes rest)
 */
export function migrateV9toV10(db: Database): void {
  try {
    // 1. Create conversation_turns table (raw dialogue storage)
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        turn_number INTEGER NOT NULL DEFAULT 0,
        user_text TEXT,
        assistant_text TEXT,
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_convturns_session
        ON conversation_turns(session_id, turn_number);
      CREATE INDEX IF NOT EXISTS idx_convturns_project
        ON conversation_turns(project, timestamp_epoch DESC);
    `);

    // FTS5 for conversation search (non-fatal if it fails)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
          user_text, assistant_text,
          content=conversation_turns,
          content_rowid=id,
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS convturns_fts_ai AFTER INSERT ON conversation_turns BEGIN
          INSERT INTO conversation_turns_fts(rowid, user_text, assistant_text)
          VALUES (new.id, COALESCE(new.user_text, ''), COALESCE(new.assistant_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS convturns_fts_ad AFTER DELETE ON conversation_turns BEGIN
          INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_text, assistant_text)
          VALUES ('delete', old.id, COALESCE(old.user_text, ''), COALESCE(old.assistant_text, ''));
        END;
      `);
    } catch { /* FTS5 non-fatal */ }

    // 1b. Create session_messages table
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_session TEXT NOT NULL,
        sender TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'event'
          CHECK (message_type IN ('event', 'command', 'query', 'advisory')),
        content TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('normal', 'urgent', 'advisory')),
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        delivered_at_epoch INTEGER,
        acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessmsg_target
        ON session_messages(target_session, delivered_at_epoch, priority);
      CREATE INDEX IF NOT EXISTS idx_sessmsg_sender
        ON session_messages(sender, created_at_epoch DESC);
    `);

    // 2. ACE counters + escalation on experience_patterns
    if (hasTable(db, 'experience_patterns')) {
      if (!hasColumn(db, 'experience_patterns', 'helpful_count'))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, 'experience_patterns', 'harmful_count'))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN harmful_count INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, 'experience_patterns', 'escalation_level'))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN escalation_level TEXT NOT NULL DEFAULT 'pattern'");

      // Backfill: derive helpful/harmful from existing times_useful and score
      try {
        db.exec(`
          UPDATE experience_patterns
          SET helpful_count = times_useful,
              harmful_count = MAX(0, times_triggered - times_useful)
          WHERE helpful_count = 0 AND harmful_count = 0 AND times_triggered > 0
        `);
      } catch { /* non-fatal */ }
    }

    // 4. Fix historical millisecond epochs in sessions table.
    // Bug: old code stored Date.now() (ms) instead of seconds.
    // Threshold: anything > year 2100 in seconds (4102444800) is clearly milliseconds.
    const MAX_SANE_EPOCH = 4_102_444_800;
    db.exec(`
      UPDATE sessions
      SET created_at_epoch = CAST(created_at_epoch / 1000 AS INTEGER)
      WHERE created_at_epoch > ${MAX_SANE_EPOCH}
    `);
    db.exec(`
      UPDATE sessions
      SET ended_at_epoch = CAST(ended_at_epoch / 1000 AS INTEGER)
      WHERE ended_at_epoch IS NOT NULL AND ended_at_epoch > ${MAX_SANE_EPOCH}
    `);

    // 5. Deduplicate reflection artifacts: keep oldest per summary, delete rest.
    // Bug: broken shouldRunReflection guard (ms epochs) caused duplicate creation on every prompt.
    try {
      db.exec(`
        DELETE FROM artifacts WHERE id IN (
          SELECT a.id FROM artifacts a
          WHERE a.summary LIKE '[Reflection]%'
          AND a.id NOT IN (
            SELECT MIN(id) FROM artifacts
            WHERE summary LIKE '[Reflection]%'
            GROUP BY project, summary
          )
        )
      `);
      // Rebuild FTS5 after deletes
      db.exec("INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')");
    } catch { /* non-fatal */ }

  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// V10 → V11
// ---------------------------------------------------------------------------

/**
 * V10→V11: Proactive Memory — stability classification, maturity lifecycle,
 * artifact access log, knowledge gaps, temporal profile, action transitions.
 *
 * 1. Add stability_class, novelty_score, consolidated_into to observations
 * 2. Add maturity, confidence to experience_patterns
 * 3. Add valid_at_epoch, invalid_at_epoch to artifact_links
 * 4. Create artifact_access_log, knowledge_gaps, temporal_profile, action_transitions tables
 * 5. Backfill stability_class based on category
 * 6. Backfill maturity + confidence based on trigger/helpful counts
 */
export function migrateV10toV11(db: Database): void {
  // Each step is isolated so a failure in one doesn't cascade and skip later steps.
  // Root cause: the original single try/catch swallowed errors from steps 1-7,
  // preventing step 8 (retrieval_mode + trigger_intents) from ever running.

  // 1. Add columns to observations
  try {
    if (hasTable(db, 'observations')) {
      if (!hasColumn(db, 'observations', 'stability_class'))
        db.exec("ALTER TABLE observations ADD COLUMN stability_class TEXT DEFAULT 'standard'");
      if (!hasColumn(db, 'observations', 'novelty_score'))
        db.exec("ALTER TABLE observations ADD COLUMN novelty_score REAL DEFAULT 0.5");
      if (!hasColumn(db, 'observations', 'consolidated_into'))
        db.exec("ALTER TABLE observations ADD COLUMN consolidated_into INTEGER");
    }
  } catch { /* non-fatal */ }

  // 2. Add columns to experience_patterns
  try {
    if (hasTable(db, 'experience_patterns')) {
      if (!hasColumn(db, 'experience_patterns', 'maturity'))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN maturity TEXT DEFAULT 'candidate'");
      if (!hasColumn(db, 'experience_patterns', 'confidence'))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN confidence REAL DEFAULT 0.5");
    }
  } catch { /* non-fatal */ }

  // 3. Add columns to artifact_links
  try {
    if (hasTable(db, 'artifact_links')) {
      if (!hasColumn(db, 'artifact_links', 'valid_at_epoch'))
        db.exec("ALTER TABLE artifact_links ADD COLUMN valid_at_epoch INTEGER");
      if (!hasColumn(db, 'artifact_links', 'invalid_at_epoch'))
        db.exec("ALTER TABLE artifact_links ADD COLUMN invalid_at_epoch INTEGER");
    }
  } catch { /* non-fatal */ }

  // 4. Create new tables
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        access_type TEXT NOT NULL DEFAULT 'retrieval'
          CHECK (access_type IN ('retrieval', 'materialization', 'reference', 'spread')),
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_aal_artifact
        ON artifact_access_log(artifact_id, timestamp_epoch DESC);
    `);
  } catch { /* non-fatal */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        domain TEXT NOT NULL,
        description TEXT NOT NULL,
        detected_by TEXT NOT NULL,
        detected_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        priority REAL NOT NULL DEFAULT 0.5,
        resolved_at_epoch INTEGER,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kg_project
        ON knowledge_gaps(project, resolved_at_epoch);
    `);
  } catch { /* non-fatal */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        hour_bucket INTEGER NOT NULL CHECK (hour_bucket BETWEEN 0 AND 5),
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        session_count INTEGER NOT NULL DEFAULT 0,
        avg_duration_sec REAL,
        common_first_actions TEXT DEFAULT '[]',
        updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(project, hour_bucket, day_of_week)
      );
    `);
  } catch { /* non-fatal */ }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_transitions (
        project TEXT NOT NULL,
        from_action TEXT NOT NULL,
        to_action TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        last_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (project, from_action, to_action)
      );
    `);
  } catch { /* non-fatal */ }

  // 5. Backfill stability_class based on category
  try {
    db.exec(`
      UPDATE observations SET stability_class = 'transient'
      WHERE stability_class = 'standard' AND category IN ('error', 'test')
    `);
    db.exec(`
      UPDATE observations SET stability_class = 'stable'
      WHERE stability_class = 'standard' AND category IN ('architecture', 'decision')
    `);
  } catch { /* non-fatal */ }

  // 6. Backfill experience_patterns maturity + confidence
  try {
    if (hasTable(db, 'experience_patterns')) {
      // Proven: times_triggered >= 5 AND helpful_count >= 3
      db.exec(`
        UPDATE experience_patterns SET maturity = 'proven'
        WHERE maturity = 'candidate' AND times_triggered >= 5 AND helpful_count >= 3
      `);
      // Established: times_triggered >= 2 (but not already proven)
      db.exec(`
        UPDATE experience_patterns SET maturity = 'established'
        WHERE maturity = 'candidate' AND times_triggered >= 2
      `);
      // Confidence: Bayesian (helpful + 1) / (helpful + harmful + 2)
      db.exec(`
        UPDATE experience_patterns
        SET confidence = CAST((helpful_count + 1) AS REAL) / CAST((helpful_count + harmful_count + 2) AS REAL)
        WHERE confidence = 0.5 AND (helpful_count > 0 OR harmful_count > 0)
      `);
    }
  } catch { /* non-fatal */ }

  // 7. Add qdrant_synced to thread_state (tracks whether embedding was pushed to Qdrant)
  try {
    if (hasTable(db, 'thread_state') && !hasColumn(db, 'thread_state', 'qdrant_synced')) {
      db.exec("ALTER TABLE thread_state ADD COLUMN qdrant_synced INTEGER NOT NULL DEFAULT 0");
    }
  } catch { /* non-fatal */ }

  // 8. Add retrieval_mode and trigger_intents to experience_patterns.
  // retrieval_mode: 'always' (injected every turn), 'categorical' (intent-triggered), 'reactive' (keyword/vector).
  // trigger_intents: JSON array of intent categories for categorical patterns.
  try {
    if (hasTable(db, 'experience_patterns')) {
      if (!hasColumn(db, 'experience_patterns', 'retrieval_mode'))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN retrieval_mode TEXT DEFAULT 'reactive'");
      if (!hasColumn(db, 'experience_patterns', 'trigger_intents'))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_intents TEXT DEFAULT '[]'");
    }
  } catch { /* non-fatal */ }
}

/**
 * V11 → V12: Session communication — signals, naming, messaging extensions.
 * Adds session_signals table, session name column, and session_messages extensions.
 */
export function migrateV11toV12(db: Database): void {
  // 1. Add name + transferred_to to sessions
  try {
    if (hasTable(db, 'sessions')) {
      if (!hasColumn(db, 'sessions', 'name'))
        db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
      if (!hasColumn(db, 'sessions', 'transferred_to'))
        db.exec("ALTER TABLE sessions ADD COLUMN transferred_to TEXT");
    }
  } catch { /* non-fatal */ }

  // 2. Recreate session_messages with extended message_type CHECK + new columns.
  // SQLite doesn't support ALTER CHECK — must recreate the table.
  try {
    if (hasTable(db, 'session_messages') && !hasColumn(db, 'session_messages', 'sender_type')) {
      db.exec(`
        CREATE TABLE session_messages_v12 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_session TEXT NOT NULL,
          sender TEXT NOT NULL,
          sender_type TEXT NOT NULL DEFAULT 'angel'
            CHECK (sender_type IN ('angel', 'session', 'system')),
          message_type TEXT NOT NULL DEFAULT 'event'
            CHECK (message_type IN ('event', 'command', 'query', 'advisory', 'request', 'response', 'notify', 'transfer', 'acknowledge')),
          content TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal'
            CHECK (priority IN ('normal', 'urgent', 'advisory')),
          request_id TEXT,
          created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
          delivered_at_epoch INTEGER,
          acknowledged INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO session_messages_v12 (id, target_session, sender, message_type, content, priority, created_at_epoch, delivered_at_epoch, acknowledged)
          SELECT id, target_session, sender, message_type, content, priority, created_at_epoch, delivered_at_epoch, acknowledged
          FROM session_messages;
        DROP TABLE session_messages;
        ALTER TABLE session_messages_v12 RENAME TO session_messages;
        CREATE INDEX IF NOT EXISTS idx_sessmsg_target
          ON session_messages(target_session, delivered_at_epoch, priority);
        CREATE INDEX IF NOT EXISTS idx_sessmsg_sender
          ON session_messages(sender, created_at_epoch DESC);
      `);
    }
  } catch { /* non-fatal */ }

  // 3. Create session_signals table
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        signal_type TEXT NOT NULL
          CHECK (signal_type IN ('wip', 'failure', 'danger', 'claim', 'discovery')),
        target TEXT NOT NULL,
        detail TEXT,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at_epoch INTEGER,
        cleared_at_epoch INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_signals_project_type
        ON session_signals(project, signal_type, cleared_at_epoch);
      CREATE INDEX IF NOT EXISTS idx_signals_session
        ON session_signals(session_id, cleared_at_epoch);
    `);
  } catch { /* non-fatal */ }

  // 4. Add index on sessions.name for fast lookup
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name)");
  } catch { /* non-fatal */ }

  // 5. Recreate artifacts table with entity_summary in artifact_type CHECK.
  // SQLite can't ALTER CHECK — must recreate. Removes state CHECK too (legacy
  // values 'fresh'/'materialized'/'packed' conflict with new 'active'/'superseded').
  try {
    if (hasTable(db, 'artifacts')) {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'").get() as { sql: string };
      if (schema?.sql && !schema.sql.includes('entity_summary')) {
        db.exec(`
          CREATE TABLE artifacts_v12 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            project TEXT,
            artifact_type TEXT NOT NULL CHECK (artifact_type IN (
              'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone',
              'memory_file', 'session_log', 'handoff', 'entity_summary'
            )),
            artifact_ref TEXT,
            summary TEXT,
            content TEXT,
            state TEXT DEFAULT 'active',
            ttl INTEGER,
            importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
            timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
            last_materialized_epoch INTEGER,
            retrieval_score REAL DEFAULT 0.0,
            embedding BLOB,
            activation_score REAL DEFAULT 0.0,
            superseded_by INTEGER,
            valid_until INTEGER,
            confidence REAL DEFAULT 1.0,
            novelty_score REAL DEFAULT 0.5
          );
          INSERT INTO artifacts_v12 SELECT * FROM artifacts;
          DROP TABLE artifacts;
          ALTER TABLE artifacts_v12 RENAME TO artifacts;
          CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project, artifact_type, timestamp_epoch DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, timestamp_epoch DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type, state, importance DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_activation ON artifacts(project, activation_score DESC);
        `);
      }
    }
  } catch { /* non-fatal */ }

  // 6. Create angel_opinions table (CARA reasoning — Tier 3.1)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS angel_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        subject TEXT NOT NULL,
        opinion TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        reinforced_count INTEGER NOT NULL DEFAULT 0,
        weakened_count INTEGER NOT NULL DEFAULT 0,
        contradicted_count INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT 'inferred',
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(project, subject)
      );
      CREATE INDEX IF NOT EXISTS idx_opinions_project
        ON angel_opinions(project, confidence DESC);
    `);
  } catch { /* non-fatal */ }

  // 6. Create entity_aliases table (entity resolution — Tier 2.6)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT NOT NULL,
        canonical TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (alias)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_canonical ON entity_aliases(canonical);
    `);
  } catch { /* non-fatal */ }

  // 6. Create solution_outcomes table (outcome tracking — Tier 2.1)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS solution_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        pattern_id TEXT,
        artifact_id INTEGER,
        approach TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial', 'unknown')),
        impact TEXT,
        effectiveness_score REAL DEFAULT 0.5,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_pattern ON solution_outcomes(pattern_id, outcome);
      CREATE INDEX IF NOT EXISTS idx_outcomes_project ON solution_outcomes(project, created_at_epoch DESC);
    `);
  } catch { /* non-fatal */ }

  // 7. FTS5 index on decisions table for proper ranked search
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        content,
        content=decisions,
        content_rowid=id,
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS decisions_fts_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS decisions_fts_ad AFTER DELETE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS decisions_fts_au AFTER UPDATE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
        INSERT INTO decisions_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    // Populate FTS from existing data
    db.exec("INSERT OR IGNORE INTO decisions_fts(rowid, content) SELECT id, content FROM decisions");
  } catch { /* non-fatal — FTS5 may already exist */ }

  // 8. retrieval_count / success_count columns on artifacts (Phase 2: Local
  // Intelligence Amplifier — surviving retrieval-feedback path).
  // q_value was dropped in V23 (Phase 9.8 — RL stack delete).
  try {
    if (hasTable(db, 'artifacts')) {
      if (!hasColumn(db, 'artifacts', 'retrieval_count'))
        db.exec("ALTER TABLE artifacts ADD COLUMN retrieval_count INTEGER DEFAULT 0");
      if (!hasColumn(db, 'artifacts', 'success_count'))
        db.exec("ALTER TABLE artifacts ADD COLUMN success_count INTEGER DEFAULT 0");
    }
  } catch { /* non-fatal */ }

  // 9. Codebase index table (Phase 3: Local Intelligence Amplifier)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_index (
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        last_indexed_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        ast_hash TEXT,
        symbols TEXT,
        call_graph TEXT,
        imports TEXT,
        exports TEXT,
        embedding BLOB,
        PRIMARY KEY (project, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_code_index_project
        ON code_index(project, last_indexed_epoch DESC);
    `);
  } catch { /* non-fatal */ }
}

/**
 * Upgrades v2 tables in-place when v3 opens the same database file.
 */
export function upgradeV2SchemaInPlace(db: Database): void {
  const sessionCols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  if (sessionCols.length === 0) return;

  const colNames = new Set(sessionCols.map(c => c.name));

  if (colNames.has('started_at_epoch') && !colNames.has('created_at_epoch')) {
    db.exec('ALTER TABLE sessions RENAME COLUMN started_at_epoch TO created_at_epoch');
  }
  if (!colNames.has('source')) {
    db.exec("ALTER TABLE sessions ADD COLUMN source TEXT");
  }

  ensureAdapterColumns(db);

  try {
    db.exec("UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature NOT IN ('HOT', 'COLD')");
  } catch { /* table may not exist */ }

  // Repair: sessions CHECK constraint missing 'transferred' (introduced in V12 session-transfer)
  // Historical migrations rebuilt sessions without 'transferred'; schema.ts has it for fresh DBs.
  // Only runs on V12+ databases that already have name/transferred_to columns.
  try {
    const sessCols = new Set((db.pragma('table_info(sessions)') as Array<{ name: string }>).map(c => c.name));
    if (!sessCols.has('name') || !sessCols.has('transferred_to')) {
      // Pre-V12 DB — skip repair; V12 migration will add columns properly
    } else {
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get() as { sql: string } | undefined;
      if (ddl?.sql && ddl.sql.includes('CHECK') && !ddl.sql.includes('transferred')) {
        db.exec('BEGIN');
        db.exec(`CREATE TABLE sessions_repair (
          session_id TEXT PRIMARY KEY,
          scope TEXT NOT NULL DEFAULT 'unknown',
          project TEXT NOT NULL DEFAULT '__global__',
          cwd TEXT NOT NULL DEFAULT '.',
          source TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'transferred')),
          observation_count INTEGER NOT NULL DEFAULT 0,
          created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
          ended_at_epoch INTEGER,
          adapter TEXT DEFAULT 'unknown',
          session_summary TEXT,
          name TEXT,
          transferred_to TEXT
        )`);
        db.exec('INSERT INTO sessions_repair SELECT session_id, scope, project, cwd, source, status, observation_count, created_at_epoch, ended_at_epoch, adapter, session_summary, name, transferred_to FROM sessions');
        db.exec('DROP TABLE sessions');
        db.exec('ALTER TABLE sessions_repair RENAME TO sessions');
        db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(status, created_at_epoch DESC)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name)');
        db.exec('COMMIT');
      }
    }
  } catch { /* non-fatal — CHECK repair can be retried */ }
}

// ---------------------------------------------------------------------------
// V12 → V13: Critical Reminders Tier
// ---------------------------------------------------------------------------

/**
 * V12 → V13: Creates critical_rules table for behavioral rule re-injection.
 * Anti-drift backbone: re-injects CLAUDE.md rules at strategic moments.
 */
export function migrateV12toV13(db: Database): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS critical_rules (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        variants TEXT,
        source TEXT NOT NULL CHECK (source IN ('author', 'system-promoted')),
        drift_risk TEXT NOT NULL CHECK (drift_risk IN ('safety', 'working-method', 'style')),
        domain_tags TEXT,
        base_ttl INTEGER NOT NULL,
        current_ttl INTEGER,
        last_injected_turn INTEGER,
        injection_count INTEGER DEFAULT 0,
        violation_count INTEGER DEFAULT 0,
        compliance_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_critical_rules_project_source
        ON critical_rules(project, source);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_critical_rules_dedup
        ON critical_rules(project, rule_text);
    `);
  } catch { /* non-fatal — table may exist from SCHEMA_V3 */ }
}

/**
 * V13 → V14: Adds extraction_cursor column to sessions table.
 * Enables cursor-based incremental pattern extraction in Angel.
 * NULL = never extracted (process all turns). Integer = last processed turn_number.
 */
export function migrateV13toV14(db: Database): void {
  try {
    if (!hasColumn(db, 'sessions', 'extraction_cursor')) {
      db.exec('ALTER TABLE sessions ADD COLUMN extraction_cursor INTEGER');
    }
  } catch { /* non-fatal — column may already exist */ }

  // Add needs_reembed flag to experience_patterns for deferred re-embedding by Angel.
  // Hooks set this flag; Angel picks it up on next heartbeat.
  try {
    if (!hasColumn(db, 'experience_patterns', 'needs_reembed')) {
      db.exec('ALTER TABLE experience_patterns ADD COLUMN needs_reembed INTEGER NOT NULL DEFAULT 0');
    }
  } catch { /* non-fatal — column may already exist */ }
}

/**
 * V14 → V15: sqlite-vec foundation — vec0 virtual tables for vector similarity.
 *
 * Creates five vec0 virtual tables that mirror Qdrant's 5 collections, with
 * matching 1024-dim float vectors (snowflake-arctic-embed2 native dimension):
 *
 *   - vec_artifacts      — artifact embeddings (primary retrieval surface)
 *   - vec_patterns       — experience pattern embeddings
 *   - vec_threads        — thread topic embeddings
 *   - vec_journal        — session journal embeddings
 *   - vec_conversations  — conversation turn embeddings
 *
 * Each table's rowid must match the corresponding SQLite row's id (stored as
 * BigInt to avoid the "only integers allowed for primary key values" error
 * — JavaScript Number binds as REAL in better-sqlite3, which vec0 rejects).
 *
 * Phase 1 of the Qdrant → sqlite-vec migration (see
 * context/specs/SQLITE_VEC_MIGRATION.md). In Phase 1, these tables exist
 * as dormant storage alongside Qdrant — no caller writes to them yet.
 * Phase 2 introduces a facade that routes reads/writes based on a
 * feature flag. Phase 5 removes Qdrant.
 *
 * If the sqlite-vec extension is unavailable (package missing, binary
 * mismatch, unsupported platform), this migration is a silent no-op.
 * The migration runner will proceed and the system will continue using
 * Qdrant exclusively.
 */
export function migrateV14toV15(db: Database): void {
  // Load the extension. loadSqliteVec is idempotent per-connection.
  const loaded = loadSqliteVec(db);
  if (!loaded) {
    // Extension unavailable — skip virtual table creation. The DB is still
    // at V14 functionally but we mark it as V15 so future runs don't retry
    // (they'd fail the same way). Callers that want vec0 features should
    // check sqliteVecLoadStatus() at runtime.
    return;
  }

  // All five virtual tables use the same schema shape — a single embedding
  // column with fixed 1024 dimensions (snowflake-arctic-embed2 native).
  // If the dimension ever changes, add a new V16 migration that creates
  // parallel tables and backfills.
  const tables = [
    'vec_artifacts',
    'vec_patterns',
    'vec_threads',
    'vec_journal',
    'vec_conversations',
    'vec_transcript_chunks_v6',
  ];
  for (const table of tables) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[1024])`);
    } catch {
      // Non-fatal — if the table already exists or the create fails,
      // the migration is still valid. A failed create will surface at
      // first query time if any caller actually uses the table.
    }
  }
}

/**
 * V15→V16: project_curated_context table.
 *
 * Adds a privileged always-on injection slot per project (and globally),
 * written authoritatively by the agent at /endsession with Angel fallback
 * for crashed sessions. Bypasses RRF ranking — not competing for slots
 * in hybrid retrieval.
 *
 * See context/specs/CURATED_CONTEXT.md for the full design.
 *
 * Types: mental_model, workspace_map, shipped, reframe, constraint, preference
 * (workspace_map and shipped are project-only; enforced in CRUD, not DB CHECK)
 *
 * curator='agent' → authoritative (trust_tier=2 by default)
 * curator='angel' → proposed (trust_tier=1, status='proposed')
 * trust_tier=3    → user-promoted, immune to auto-eviction
 */
export function migrateV15toV16(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_curated_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'mental_model', 'workspace_map', 'shipped',
        'reframe', 'constraint', 'preference'
      )),
      content TEXT NOT NULL,
      tags TEXT,
      supersedes_id INTEGER REFERENCES project_curated_context(id),
      curator TEXT NOT NULL CHECK(curator IN ('agent', 'angel')),
      trust_tier INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'superseded', 'proposed', 'archived')),
      source_session_id TEXT,
      created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_pcc_project_status
      ON project_curated_context(project, status);
    CREATE INDEX IF NOT EXISTS idx_pcc_project_type
      ON project_curated_context(project, type, status);
  `);
}

/**
 * V16→V17: Unified artifact table + legacy views + INSTEAD OF triggers.
 *
 * NOTE: this function only applies the DDL and the generated views/triggers.
 * It does NOT move data from the 6 legacy tables into `artifact` — that is
 * the migration RUNNER's job (see src/core/migration/v17-runner.ts, Plan 02-05).
 *
 * Called only by the explicit migrate:v17:apply CLI path. Not invoked from
 * runMigrations() or initializeSchema() because Phase A (pre-embed) requires
 * Ollama and must run outside any implicit open-time path.
 *
 * Also retires the 2 legacy FTS5 tables per Amendment 4 — these DROPs happen
 * AFTER the runner renames legacy tables to {name}_old, otherwise the
 * `content='learnings'` binding breaks the view substitution. See Plan 02-05
 * for sequencing.
 */
export function migrateV16toV17(db: Database): void {
  // DDL only — kernel + registry + map + vec0 + fts5 + indexes.
  // Views and INSTEAD OF triggers are NOT created here because they would
  // collide with the still-present legacy tables (CREATE VIEW name conflicts
  // with CREATE TABLE name of same name). The runner (src/core/migration/
  // v17-runner.ts) renames legacy tables to {name}_old first, then calls
  // applyGeneratedDDL to install the views.
  applyV17DDL(db);
}

/**
 * V17→V18: Phase 4.1 lesson substrate tables.
 *
 * Adds shape_vocabulary + shape_candidates for Angel-curated bounded vocabulary
 * (task_shape / failure_mode / solution_pattern fields on lesson frontmatter).
 *
 * No changes to critical_rules — multi_project_count lives in `data` JSON
 * under the V17 view-over-artifact pattern (see RESEARCH §Schema migration).
 *
 * Idempotent: all CREATE TABLE/INDEX guarded by IF NOT EXISTS.
 */
export function migrateV17toV18(db: Database): void {
  db.exec(SHAPE_VOCABULARY_SCHEMA);
}

/**
 * V18→V19: Phase 5.5 curation feedback loop substrate.
 *
 * Adds lesson_pointer registry + pointer_recall_log table. No data migration
 * needed — both tables are net-new. Idempotent via IF NOT EXISTS in DDL.
 */
export function migrateV18toV19(db: Database): void {
  db.exec(POINTER_RECALL_SCHEMA);
}

/**
 * V19→V20: Phase 6 (P5) — extend telemetry CHECK enum to include
 * 'reranker_fallback'. SQLite cannot ALTER a CHECK constraint, so the
 * standard rebuild-and-copy pattern applies. Returns true on success.
 *
 * Steps (single transaction):
 *   1. Rename existing `telemetry` to `telemetry_v19`.
 *   2. Recreate `telemetry` with the V20 enum from TELEMETRY_SCHEMA.
 *   3. Copy rows back (existing kinds remain valid under the additive enum).
 *   4. Drop `telemetry_v19`.
 *   5. Re-create indexes (already in TELEMETRY_SCHEMA but explicit for clarity).
 *
 * Idempotent: if `telemetry_v19` is absent and `telemetry` already accepts
 * `'reranker_fallback'`, the function is a no-op via existence guards.
 */
export function migrateV19toV20(db: Database): boolean {
  // Stub-DB guard — if no telemetry table exists yet, the V20 enum will be
  // installed when initializeSchema later execs TELEMETRY_SCHEMA. The
  // version stamp can still advance.
  if (!hasTable(db, 'telemetry')) {
    return true;
  }
  // Pre-V19 shape guard — partial-v2 fixtures hit the runner with a
  // telemetry table that pre-dates the `event_kind` column. The V20 rebuild
  // requires the V19 column shape (event_kind + json detail + latency_ms +
  // timestamp_epoch + adapter). When the live table lacks `event_kind` we
  // skip the rebuild — initializeSchema's `db.exec(TELEMETRY_SCHEMA)` is
  // CREATE-IF-NOT-EXISTS so the v2-era table also stays put. The stamp
  // still advances because the schema is structurally compatible: only
  // `event_kind` access matters at runtime, and any hook calling
  // `INSERT INTO telemetry (event_kind, ...)` will fail loudly on the
  // pre-V19 shape (already broken before V20).
  if (!hasColumn(db, 'telemetry', 'event_kind')) {
    return true;
  }
  // Idempotency guard — if the new enum is already in place, skip.
  if (telemetryAcceptsRerankerFallback(db)) {
    return true;
  }

  const tx = db.transaction(() => {
    // 1. Rename existing telemetry table out of the way.
    db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v19;`);

    // Drop the V19 indexes by name (they followed the table rename in some
    // SQLite versions, but explicit DROP is safer for cross-version behavior).
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);

    // 2. Recreate telemetry with the V20 enum (TELEMETRY_SCHEMA also
    //    creates the indexes, so no extra DDL needed).
    db.exec(TELEMETRY_SCHEMA);

    // 3. Copy rows back.
    db.exec(`
      INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
      SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
      FROM telemetry_v19;
    `);

    // 4. Drop the old table.
    db.exec(`DROP TABLE telemetry_v19;`);
  });

  tx();
  return true;
}

/**
 * Probe whether the current `telemetry.event_kind` CHECK constraint admits
 * `'reranker_fallback'`. Used as the V20 idempotency guard.
 */
function telemetryAcceptsRerankerFallback(db: Database): boolean {
  if (!hasTable(db, 'telemetry')) return false;
  // Inspect the live DDL — sqlite_master.sql has the constraint text.
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get() as { sql?: string } | undefined;
  return !!row?.sql && row.sql.includes("'reranker_fallback'");
}

/**
 * V20→V21: Phase 6.5 — task-pattern fingerprint sidecar + telemetry CHECK
 * enum extension for the cross-project query expansion path.
 *
 * Two additive changes:
 *   1. CREATE TABLE artifact_task_pattern (sidecar; PK on artifact_id) +
 *      idx_artifact_task_pattern_pattern.
 *   2. Extend telemetry.event_kind CHECK enum to include
 *      'cross_project_ambiguous' and 'cross_project_query_expansion'.
 *
 * SQLite cannot ALTER a CHECK constraint, so the standard rebuild-and-copy
 * pattern is reused (mirrors V19→V20 verbatim). Returns true on success.
 *
 * Idempotent: if the sidecar table already exists AND telemetry already
 * accepts the new enums, the function is a no-op via existence guards.
 */
export function migrateV20toV21(db: Database): boolean {
  // Stub-DB guard — if no telemetry table exists yet, install only the
  // sidecar (cheap, decoupled). The telemetry CHECK enum will be installed
  // when initializeSchema later execs TELEMETRY_SCHEMA. The version stamp
  // can still advance.
  if (!hasTable(db, 'telemetry')) {
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    return true;
  }
  // Pre-V19 shape guard — telemetry rebuild requires the V19+ column shape
  // (event_kind + json detail + latency_ms + timestamp_epoch + adapter).
  // When the live table lacks `event_kind`, install only the sidecar.
  if (!hasColumn(db, 'telemetry', 'event_kind')) {
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    return true;
  }
  // Idempotency guard — if the sidecar exists AND the new enums are in
  // place, skip everything.
  if (hasTable(db, 'artifact_task_pattern') && telemetryAcceptsCrossProjectEnums(db)) {
    return true;
  }

  const tx = db.transaction(() => {
    // Phase A: install the sidecar table. Cheap and idempotent.
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);

    // Phase B: rebuild telemetry with the V21 enum, only if needed.
    if (!telemetryAcceptsCrossProjectEnums(db)) {
      // 1. Rename existing telemetry table out of the way.
      db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v20;`);

      // Drop the V20 indexes by name (explicit DROP is safer cross-version).
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);

      // 2. Recreate telemetry with the V21 enum (TELEMETRY_SCHEMA also
      //    creates the indexes, so no extra DDL needed).
      db.exec(TELEMETRY_SCHEMA);

      // 3. Copy rows back.
      db.exec(`
        INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
        SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
        FROM telemetry_v20;
      `);

      // 4. Drop the old table.
      db.exec(`DROP TABLE telemetry_v20;`);
    }
  });

  tx();
  return true;
}

/**
 * Probe whether the current `telemetry.event_kind` CHECK constraint admits
 * the V21 cross-project enums. Used as the V21 idempotency guard.
 */
function telemetryAcceptsCrossProjectEnums(db: Database): boolean {
  if (!hasTable(db, 'telemetry')) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get() as { sql?: string } | undefined;
  if (!row?.sql) return false;
  return row.sql.includes("'cross_project_ambiguous'") &&
         row.sql.includes("'cross_project_query_expansion'");
}

/**
 * V21→V22: Phase 8.5 — Recall observability + self-instrumented agent.
 *
 * Two additive tables:
 *   1. retrieval_log: per-session log of MCP retrieval invocations
 *      (claudex_search / claudex_recall / pointer_surface) with query,
 *      top_k_results JSON, used_in_output flag, and cl100k_base token cost.
 *   2. session_flag: per-session key/value flags (e.g., narration_silent)
 *      so Phase 8.5 toggles avoid the session_signals enum CHECK.
 *
 * SCHEMA_V22 is fully `CREATE … IF NOT EXISTS`; this migration is just the
 * `db.exec(SCHEMA_V22)` + version stamp. Returns true on success.
 *
 * Idempotent: existence guards in the DDL plus the user_version stamp.
 */
export function migrateV21toV22(db: Database): boolean {
  // Idempotency: if both tables already exist, skip the exec but still
  // advance the user_version stamp (caller handles stamping).
  if (hasTable(db, 'retrieval_log') && hasTable(db, 'session_flag')) {
    return true;
  }
  db.exec(SCHEMA_V22);
  return true;
}

/**
 * V22→V23: Phase 9.8 — RL stack deletion.
 *
 * Drops:
 *   1. `policy_weights` table (V11 — RL model weights for memory policy training)
 *   2. `artifacts.q_value` column (added in migrateSchemaFixes for MemRL)
 *
 * Rationale: Phase 8 verdict DELETE_ALLOWED (V4_RL_ABLATION.md, 2026-04-29,
 * Δ=0pp). The RL stack (retrieval-rl, memrl-scorer, rl-trainer, rl-policy,
 * rl-model, rl-reward, plus the rl-scoring-disabled-counter) is gone in
 * commit corpus, so these schema objects are orphan storage.
 *
 * Idempotent: guarded by hasTable / hasColumn checks. Returns true.
 *
 * Surrounding columns `retrieval_count` and `success_count` (added alongside
 * q_value in migrateSchemaFixes step 8) are NOT dropped — they're written by
 * the surviving retrieval-feedback path (Phase 6 P5) and consumed by
 * `getRetrievalScoreMultiplier`.
 */
export function migrateV22toV23(db: Database): boolean {
  // Drop policy_weights (table-level — straightforward).
  if (hasTable(db, 'policy_weights')) {
    db.exec('DROP TABLE IF EXISTS policy_weights');
  }

  // Drop q_value column from artifacts.
  // SQLite 3.35+ supports `ALTER TABLE DROP COLUMN`. better-sqlite3 ships a
  // recent SQLite that meets this requirement. Guard for environments where
  // the column doesn't exist (fresh-DB path or already-applied migration).
  if (hasTable(db, 'artifacts') && hasColumn(db, 'artifacts', 'q_value')) {
    try {
      db.exec('ALTER TABLE artifacts DROP COLUMN q_value');
    } catch { /* non-fatal — leave column in place if drop fails */ }
  }

  return true;
}

/**
 * V24 — Drop the 6 legacy `*_old` tables left behind by V17 (Phase 11 STOR-04).
 *
 * Phase 11 zero-caller audit confirmed no live code reads from these tables:
 *   learnings_old / decisions_old / experience_patterns_old /
 *   angel_opinions_old / critical_rules_old / project_curated_context_old.
 *
 * Compat views (same names without `_old`) route to the artifact kernel via
 * INSTEAD OF triggers and are unaffected. Migration is idempotent — `IF EXISTS`
 * guard means re-running on an already-migrated DB is a no-op. Audit lives at
 * `.planning/phases/11-p9-final-validation/11-05-OLD-TABLES-AUDIT.md`.
 */
export function migrateV23toV24(db: Database): boolean {
  const legacyOldTables = [
    'learnings_old',
    'decisions_old',
    'experience_patterns_old',
    'angel_opinions_old',
    'critical_rules_old',
    'project_curated_context_old',
  ];
  for (const tbl of legacyOldTables) {
    db.exec(`DROP TABLE IF EXISTS ${tbl}`);
  }
  return true;
}

/**
 * V25 — Phase 1 (v5) episode substrate.
 *
 * Two additive changes:
 *   1. CREATE TABLE episodic_events with the locked column set + closed-enum
 *      provenance CHECK constraint + 4 supporting indexes.
 *   2. Extend telemetry.event_kind CHECK enum with 'episodic_write_failure'
 *      so the dual-write rollback path (Plans 01-02 / 01-03) can record
 *      atomicity failures as queryable rows. Same rebuild-and-copy pattern
 *      as V19→V20 (reranker_fallback) and V20→V21 (cross_project_*).
 *
 * The substrate is forward-only and write-only in Phase 1 — no readers, no
 * embeddings, no backfill of legacy `conversation_turns`. See
 * `.planning/phases/01-episode-substrate/01-CONTEXT.md` for the design and
 * `.planning/phases/01-episode-substrate/01-04-substrate-readme.md` for the
 * operator-facing reference (lands in Plan 01-04).
 *
 * Idempotent — `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
 * mean re-running on a V25+ DB is a no-op; the telemetry rebuild guards on
 * `telemetryAcceptsEpisodicWriteFailure(db)`.
 */
export function migrateV24toV25(db: Database): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      ts_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      turn_number INTEGER,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('organic','injected','tool_result','environmental')),
      parent_event_id INTEGER REFERENCES episodic_events(id),
      content_hash TEXT NOT NULL,
      metadata_json TEXT,
      schema_version SMALLINT NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_epev_session_turn_ts ON episodic_events(session_id, turn_number, ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_epev_project_ts     ON episodic_events(project, ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_epev_provenance     ON episodic_events(provenance);
    CREATE INDEX IF NOT EXISTS idx_epev_parent         ON episodic_events(parent_event_id);
  `);

  // Telemetry CHECK enum rebuild — same pattern as V19→V20 / V20→V21.
  // Skip when telemetry doesn't exist yet (stub-DB / fresh-DB tail flow runs
  // TELEMETRY_SCHEMA later) or when the enum already includes the new value.
  if (hasTable(db, 'telemetry')
      && hasColumn(db, 'telemetry', 'event_kind')
      && !telemetryAcceptsEpisodicWriteFailure(db)) {
    const tx = db.transaction(() => {
      db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v24;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
      db.exec(TELEMETRY_SCHEMA);
      db.exec(`
        INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
        SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
        FROM telemetry_v24;
      `);
      db.exec(`DROP TABLE telemetry_v24;`);
    });
    tx();
  }
  return true;
}

/**
 * Probe whether the current `telemetry.event_kind` CHECK constraint admits
 * `'episodic_write_failure'`. Used as the V25 idempotency guard.
 */
function telemetryAcceptsEpisodicWriteFailure(db: Database): boolean {
  if (!hasTable(db, 'telemetry')) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get() as { sql?: string } | undefined;
  return !!row?.sql && row.sql.includes("'episodic_write_failure'");
}

/**
 * V25 → V26: Phase 2 IDX-01 — error-fingerprint sidecar.
 *
 * Creates `episodic_index_error_fingerprint`, the FIRST sidecar pattern in the
 * v5 substrate (per CONTEXT item 6 of `.planning/phases/02-multi-modal-index-
 * seeds-density-check/02-CONTEXT.md`):
 *   - inverted index over per-row error fingerprints derived from
 *     `episodic_events.metadata_json.error_fingerprint`
 *   - `corpus_origin` CHECK enum makes the v4-backfill / phase1-organic split
 *     observable in post-hoc analysis (CONTEXT item 2 known-limitation)
 *   - foreign key to `episodic_events(id)` (FKs are not enforced by default in
 *     this codebase — declaration only; matches Phase 1 conventions)
 *   - three indexes covering the hot lookups (shingle_hash, episode_event_id,
 *     and the (project, ts_epoch) range scan for cluster analysis)
 *
 * The episodic_events table is intentionally NOT altered — Phase 1's "no ALTER
 * TABLE on episodic_events" contract holds. Per-row fingerprint payloads land
 * in `metadata_json.error_fingerprint` (Plan 02-02); inverted-index rows land
 * here via Plan 02-03's explicit backfill.
 *
 * Idempotent — `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
 * mean re-running on a V26+ DB is a no-op.
 */
export function migrateV25toV26(db: Database): boolean {
  if (hasTable(db, 'episodic_index_error_fingerprint')) {
    return false;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_index_error_fingerprint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shingle_hash TEXT NOT NULL,
      episode_event_id INTEGER NOT NULL REFERENCES episodic_events(id),
      ts_epoch INTEGER NOT NULL,
      project TEXT NOT NULL,
      corpus_origin TEXT NOT NULL CHECK (corpus_origin IN ('phase1_organic','v4_backfill')),
      schema_version SMALLINT NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_epev_efp_shingle      ON episodic_index_error_fingerprint(shingle_hash);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_event        ON episodic_index_error_fingerprint(episode_event_id);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_project_ts   ON episodic_index_error_fingerprint(project, ts_epoch);
  `);
  return true;
}

/**
 * V26→V27 (Phase 2.1 IDX-04 — three-tier corpus_origin partition).
 *
 * Phase 2's V26 introduced `episodic_index_error_fingerprint` with a
 * CHECK constraint accepting `corpus_origin IN ('phase1_organic',
 * 'v4_backfill')`. Phase 2.1 (CONTEXT.md decision 1c) replaces the
 * single `phase1_organic` tier with a phase-anchored two-way split
 * (`phase1_organic_pre_phase2_close` / `phase1_organic_post_phase2_close`)
 * so re-runs preserve the partition meaning across time.
 *
 * SQLite has no `ALTER TABLE ... DROP CHECK`, so we rebuild the table:
 *   1. Rename existing table.
 *   2. Create the new table with the relaxed CHECK constraint covering
 *      all three accepted values (v4_backfill stays unchanged).
 *   3. Copy rows, mapping the legacy 'phase1_organic' value to
 *      'phase1_organic_pre_phase2_close' (every legacy organic row was
 *      written by Phase 2's backfill — i.e. before PHASE2_CLOSE_TS_EPOCH —
 *      so the pre-tier is the correct mapping).
 *   4. Drop the old table.
 *   5. Re-create indexes.
 *
 * Idempotent: a second run is a no-op because the new CHECK constraint
 * already accepts all three values; `hasTable` short-circuit + the
 * legacy-rename guard.
 */
export function migrateV26toV27(db: Database): boolean {
  if (!hasTable(db, 'episodic_index_error_fingerprint')) return false;

  // Detect legacy CHECK constraint: if the schema lists only the old
  // two values, we need to rebuild. If the new three-value form is
  // already present, this migration is a no-op.
  const sqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='episodic_index_error_fingerprint'",
  ).get() as { sql?: string } | undefined;
  const sql = sqlRow?.sql ?? '';
  if (sql.includes('phase1_organic_pre_phase2_close')) return false;

  db.exec(`
    ALTER TABLE episodic_index_error_fingerprint RENAME TO _v26_episodic_index_error_fingerprint;

    CREATE TABLE episodic_index_error_fingerprint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shingle_hash TEXT NOT NULL,
      episode_event_id INTEGER NOT NULL REFERENCES episodic_events(id),
      ts_epoch INTEGER NOT NULL,
      project TEXT NOT NULL,
      corpus_origin TEXT NOT NULL CHECK (corpus_origin IN ('v4_backfill','phase1_organic_pre_phase2_close','phase1_organic_post_phase2_close')),
      schema_version SMALLINT NOT NULL DEFAULT 1
    );

    INSERT INTO episodic_index_error_fingerprint (id, shingle_hash, episode_event_id, ts_epoch, project, corpus_origin, schema_version)
      SELECT
        id,
        shingle_hash,
        episode_event_id,
        ts_epoch,
        project,
        CASE corpus_origin
          WHEN 'phase1_organic' THEN 'phase1_organic_pre_phase2_close'
          ELSE corpus_origin
        END,
        schema_version
      FROM _v26_episodic_index_error_fingerprint;

    DROP TABLE _v26_episodic_index_error_fingerprint;

    CREATE INDEX IF NOT EXISTS idx_epev_efp_shingle    ON episodic_index_error_fingerprint(shingle_hash);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_event      ON episodic_index_error_fingerprint(episode_event_id);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_project_ts ON episodic_index_error_fingerprint(project, ts_epoch);
  `);
  return true;
}

/**
 * V27→V28 (Phase 4 AR-03 — extraction-time pattern creation cutoff, Layer 3).
 *
 * Marker migration: bumps user_version 27→28 to record that this DB has
 * acknowledged the Phase 4 cutoff contract. The actual gating mechanism
 * lives in `initializeSchema()` (see `installPhase4PatternGuard` /
 * temp.session_pragmas wiring there) because:
 *
 *   - SQLite forbids a permanent-schema trigger from referencing temp
 *     objects (`trigger ... cannot reference objects in database temp`).
 *   - Per CONTEXT.md, the override sidecar MUST be a per-connection TEMP
 *     table so test/fixture overrides cannot leak to other connections.
 *   - A TEMP TRIGGER + TEMP TABLE pair satisfies both constraints; both
 *     get installed at connection-open time inside `initializeSchema()`.
 *
 * Phase 4 deletes the three production code sites that previously INSERTed
 * into `experience_patterns` (Sites A/B/C — see
 * `.planning/reframes/2026-05-05-multi-handle-kill.md` and 04-CONTEXT.md).
 * The TEMP trigger is the schema-level guard against future regression:
 * any caller wanting to write must opt in by setting the pragma, which
 * makes the deviation greppable and reviewable. Phase 7 retirement work
 * will ultimately drop / project / keep this table.
 *
 * Idempotent: a no-op body. The runMigrations runner advances
 * `user_version` from 27 to 28 once this entry is reached; re-running on
 * an already-V28 DB is a no-op via the runner's version comparison.
 */
export function migrateV27toV28(_db: Database): boolean {
  return true;
}

/**
 * V28→V29 (Phase 6 EBD-05 — crash-resilient episode boundary substrate).
 *
 * Lands two pieces of durable state needed by the boundary detector:
 *
 *   1. New `episode_boundary_cursor` table — per (project, session_id):
 *      last_processed_jsonl_offset, last_processed_event_ts_epoch,
 *      last_close_event_id. Crash-replay cursor: on reboot, the watcher
 *      resumes from the last cursor row instead of re-emitting close events.
 *
 *   2. Two columns on `sessions`:
 *      - last_heartbeat_ts INTEGER NULL — bumped by the 5 lifecycle hooks
 *        (UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd).
 *      - last_jsonl_write_ts INTEGER NULL — bumped by the chokidar watcher
 *        when a JSONL append is observed.
 *
 * Soft FK: `last_close_event_id` references `episodic_events.id` but no
 * PRAGMA foreign_keys flip in V29 (schema-wide FK enforcement is a separate
 * decision deferred per CONTEXT). Phase 6 plan 04's boundary detector
 * uses heartbeat-compare-before-cleanup as the durability invariant, not
 * SQLite-side FK semantics.
 *
 * Idempotent via existence checks on the cursor table and column-name
 * substring scan of the sessions DDL (SQLite has no IF NOT EXISTS for
 * ALTER TABLE ADD COLUMN — same pattern as `.claude/rules/schema-migration.md`).
 * Re-running on a V29 DB is a no-op (returns false).
 */
export function migrateV28toV29(db: Database): boolean {
  const hasCursor = hasTable(db, 'episode_boundary_cursor');
  const sessionsColsRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
  ).get() as { sql?: string } | undefined;
  const sessionsSql = sessionsColsRow?.sql ?? '';
  const hasHeartbeatCol = sessionsSql.includes('last_heartbeat_ts');
  const hasJsonlCol = sessionsSql.includes('last_jsonl_write_ts');
  if (hasCursor && hasHeartbeatCol && hasJsonlCol) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_boundary_cursor (
      project                       TEXT    NOT NULL,
      session_id                    TEXT    NOT NULL,
      last_processed_jsonl_offset   INTEGER NOT NULL DEFAULT 0,
      last_processed_event_ts_epoch INTEGER NOT NULL DEFAULT 0,
      last_close_event_id           INTEGER,
      PRIMARY KEY (project, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ebc_session
      ON episode_boundary_cursor(session_id);
    CREATE INDEX IF NOT EXISTS idx_ebc_close_event
      ON episode_boundary_cursor(last_close_event_id) WHERE last_close_event_id IS NOT NULL;
  `);

  if (!hasHeartbeatCol) {
    try { db.exec(`ALTER TABLE sessions ADD COLUMN last_heartbeat_ts INTEGER`); } catch { /* already added */ }
  }
  if (!hasJsonlCol) {
    try { db.exec(`ALTER TABLE sessions ADD COLUMN last_jsonl_write_ts INTEGER`); } catch { /* already added */ }
  }

  return true;
}

/**
 * V29→V30 (Phase 7 MIG-01/02 — learnings provenance discipline).
 *
 * `learnings` is the only v4 storage category where preserve-as-legacy framing
 * is wrong. `captureInsightsAsLearnings` is live and useful — what's missing is
 * Phase 1's provenance-tag discipline. V30 lands the column; Plan 07-03 lands
 * the write-path filter that skips insights extracted from injected blocks.
 *
 * Adds `learnings.provenance TEXT NOT NULL DEFAULT 'organic'` with a closed-enum
 * CHECK that mirrors `episodic_events.provenance` exactly (V25 migration):
 * `('organic','injected','tool_result','environmental')`. Backfills existing
 * rows to `'organic'` per CONTEXT decision 1 (default-on-existing baseline).
 *
 * V17 view-mode DBs: `learnings` is a VIEW over `artifact` (kind='learning')
 * and SQLite forbids ALTER on a view. In that environment, provenance
 * discipline lives in the JSON `data` column on the artifact kernel; the
 * write-path filter (Plan 07-03) operates upstream of the view's INSTEAD OF
 * trigger and is sufficient for the Mem0-trap closure. We detect the view
 * shape and skip — same pattern Phase 4 schema work used to coexist with V17.
 *
 * Idempotent via column-name substring scan of the `learnings` DDL. SQLite has
 * no IF NOT EXISTS for ALTER TABLE ADD COLUMN — same pattern as V28→V29.
 * Re-running on a V30 DB is a no-op (returns false).
 */
export function migrateV29toV30(db: Database): boolean {
  const learningsMeta = db.prepare(
    "SELECT type, sql FROM sqlite_master WHERE name='learnings' AND type IN ('table','view')"
  ).get() as { type: string; sql?: string } | undefined;
  if (!learningsMeta) return false;
  // V17 view-mode: provenance lives in artifact.data JSON; ALTER would fail.
  if (learningsMeta.type === 'view') return false;

  const learningsSql = learningsMeta.sql ?? '';
  const hasProvenanceCol = learningsSql.includes('provenance');
  if (hasProvenanceCol) return false;

  // SQLite ALTER TABLE ADD COLUMN supports DEFAULT and CHECK — same shape
  // used for episodic_events.provenance in V25. The CHECK fires on every
  // INSERT and on UPDATEs that touch the column.
  db.exec(
    `ALTER TABLE learnings
       ADD COLUMN provenance TEXT NOT NULL DEFAULT 'organic'
         CHECK (provenance IN ('organic','injected','tool_result','environmental'))`
  );

  // Backfill existing rows. ALTER TABLE ... ADD COLUMN with DEFAULT already
  // populates existing rows with the DEFAULT value, but we explicitly UPDATE
  // any NULL row as a defensive no-op so the migration is correct on engine
  // variants that interpret ADD COLUMN DEFAULT differently. On modern SQLite
  // (better-sqlite3 ships 3.46+) this UPDATE matches zero rows.
  db.exec(`UPDATE learnings SET provenance = 'organic' WHERE provenance IS NULL`);

  return true;
}

/**
 * V30→V31 (v5.0.1 hot-fix — close the V17 view-mode learnings.provenance gap).
 *
 * Phase 7 MIG-02 added `learnings.provenance` via ALTER TABLE in V30, but
 * skipped the column on V17 view-mode DBs (where `learnings` is a view over
 * the `artifact` kernel; ALTER on a view fails). The skip was correct in
 * isolation but the equivalent column-projection-via-data-JSON path was
 * never landed, so the production code path
 * (`upsertLearning` writes provenance) silently fails on V17-collapsed DBs:
 *   `INSERT INTO learnings (..., provenance) VALUES (..., 'organic')`
 *   → `table learnings has no column named provenance`
 * The error is swallowed by `captureInsightsAsLearnings`'s try/catch, so the
 * production write path silently drops every learning. Discovered post-ship
 * via live-wiring audit; phase-7-learnings-provenance.test.ts passed because
 * its `:memory:` DB took the base-table path, not the V17 view path.
 *
 * V31 lands the V17-view-mode equivalent of V30:
 *   - Rebuilds the `learnings` view to project `provenance` from
 *     `artifact.data->>'$.provenance'`, defaulting to 'organic' on read.
 *   - Rebuilds the INSTEAD OF INSERT/UPDATE triggers to accept and persist
 *     `NEW.provenance` into `artifact.data` JSON, with a closed-enum guard
 *     equivalent to V25's `episodic_events.provenance` CHECK.
 *   - Backfills all `artifact` rows of `kind='learning'` with provenance
 *     'organic' where the JSON field is absent (matches V30's backfill
 *     for the base-table case).
 *
 * Idempotent: detects whether the view already exposes a `provenance` column
 * and returns false if so. No-op on base-table DBs (V30 already added the
 * column there).
 */
export function migrateV30toV31(db: Database): boolean {
  const learningsMeta = db.prepare(
    "SELECT type, sql FROM sqlite_master WHERE name='learnings' AND type IN ('table','view')"
  ).get() as { type: string; sql?: string } | undefined;
  if (!learningsMeta) return false;
  // Base-table case: V30 already added the column. No work for V31.
  if (learningsMeta.type === 'table') return false;

  const viewSql = learningsMeta.sql ?? '';
  // Idempotent guard: the rebuilt view exposes a `provenance` column.
  if (/\bprovenance\b/i.test(viewSql)) return false;

  // Drop existing triggers + view (must drop triggers before the view
  // they depend on).
  db.exec(`
    DROP TRIGGER IF EXISTS learnings_instead_insert;
    DROP TRIGGER IF EXISTS learnings_instead_update;
    DROP TRIGGER IF EXISTS learnings_instead_delete;
    DROP VIEW IF EXISTS learnings;
  `);

  // Detect column names that depend on migration history:
  //   - artifact.project_id was renamed to artifact.project in V34 (Plan 14-02)
  //   - artifact.updated_at_epoch was renamed to artifact.updated_at_epoch_ms in V35 (Plan 14-06)
  //   - artifact.created_at_epoch was renamed to artifact.created_at_epoch_ms in V35 (Plan 14-06)
  // V31 runs BEFORE V34 and V35 on legacy DBs, so we must use whichever column names exist now.
  const artifactProjectCol = hasColumn(db, 'artifact', 'project') ? 'project' : 'project_id';
  const artifactUpdatedCol = hasColumn(db, 'artifact', 'updated_at_epoch_ms') ? 'updated_at_epoch_ms' : 'updated_at_epoch';
  const artifactCreatedCol = hasColumn(db, 'artifact', 'created_at_epoch_ms') ? 'created_at_epoch_ms' : 'created_at_epoch';

  // Recreate view with provenance column projected from artifact.data JSON.
  // COALESCE to 'organic' so existing rows that have no provenance JSON
  // field still satisfy NOT NULL semantics from the consumer's perspective.
  // The actual backfill below populates the JSON for those rows.
  // The view exposes both legacy (epoch seconds) aliases and _ms aliases so that
  // both pre-V35 and post-V35 production code paths can read/write via the view.
  // updated_at_epoch_ms and last_promoted_epoch_ms are exposed as primary names
  // since learnings.ts (updated for Plan 14-06) uses the _ms names; legacy aliases
  // (updated_at_epoch, last_promoted_epoch) are retained for backwards compat.
  db.exec(`
    CREATE VIEW learnings AS
    SELECT
      CAST((SELECT m.legacy_id FROM legacy_id_map m WHERE m.legacy_table = 'learnings' AND m.new_uuid = artifact.id) AS INTEGER) AS id,
      CAST(artifact.${artifactProjectCol} AS TEXT) AS project,
      CAST(json_extract(artifact.data, '$.agent_id') AS TEXT) AS agent_id,
      CAST(json_extract(artifact.data, '$.fingerprint') AS TEXT) AS fingerprint,
      artifact.body AS content,
      CAST(json_extract(artifact.data, '$.promotion_count') AS INTEGER) AS promotion_count,
      CAST(json_extract(artifact.data, '$.first_seen_epoch') AS INTEGER) AS first_seen_epoch,
      CAST(json_extract(artifact.data, '$.first_seen_epoch') AS INTEGER) AS first_seen_epoch_ms,
      CAST(json_extract(artifact.data, '$.last_promoted_epoch') AS INTEGER) AS last_promoted_epoch,
      CAST(json_extract(artifact.data, '$.last_promoted_epoch') AS INTEGER) AS last_promoted_epoch_ms,
      CAST(artifact.${artifactUpdatedCol} / 1000 AS INTEGER) AS updated_at_epoch,
      artifact.${artifactUpdatedCol} AS updated_at_epoch_ms,
      COALESCE(CAST(json_extract(artifact.data, '$.provenance') AS TEXT), 'organic') AS provenance
    FROM artifact
    WHERE kind = 'learning'
    ORDER BY ${artifactCreatedCol}
  `);

  // INSTEAD OF INSERT — accepts NEW.provenance, validates against closed
  // enum (matches V25 episodic_events.provenance and V30 base-table CHECK),
  // persists into artifact.data JSON.
  db.exec(`
    CREATE TRIGGER learnings_instead_insert INSTEAD OF INSERT ON learnings
    BEGIN
      SELECT CASE
        WHEN NEW.provenance IS NOT NULL
         AND NEW.provenance NOT IN ('organic','injected','tool_result','environmental')
        THEN RAISE(ABORT, 'CHECK constraint failed: learnings.provenance')
      END;
      INSERT INTO artifact(
        id, kind, title, body, scope, status, confidence,
        ${artifactCreatedCol}, ${artifactUpdatedCol}, session_id, ${artifactProjectCol}, data
      ) VALUES (
        lower(hex(randomblob(16))),
        'learning',
        substr(NEW.content, 1, 80),
        NEW.content,
        'project',
        'active',
        NULL,
        COALESCE(NEW.first_seen_epoch * 1000, unixepoch() * 1000),
        COALESCE(NEW.updated_at_epoch * 1000, unixepoch() * 1000),
        NULL,
        NEW.project,
        json_object(
          'agent_id', NEW.agent_id,
          'fingerprint', NEW.fingerprint,
          'promotion_count', COALESCE(NEW.promotion_count, 1),
          'first_seen_epoch', COALESCE(NEW.first_seen_epoch, unixepoch()),
          'last_promoted_epoch', COALESCE(NEW.last_promoted_epoch, unixepoch()),
          'provenance', COALESCE(NEW.provenance, 'organic')
        )
      );
      INSERT INTO legacy_id_map(legacy_table, legacy_id, new_uuid)
      VALUES (
        'learnings',
        COALESCE(
          NEW.id,
          (SELECT COALESCE(MAX(legacy_id), 0) + 1 FROM legacy_id_map WHERE legacy_table = 'learnings')
        ),
        (SELECT id FROM artifact WHERE rowid = last_insert_rowid())
      );
    END
  `);

  // INSTEAD OF UPDATE — preserves existing provenance if NEW.provenance is
  // null (UPDATEs that don't touch provenance must not clobber it).
  // Validates against closed enum when set.
  db.exec(`
    CREATE TRIGGER learnings_instead_update INSTEAD OF UPDATE ON learnings
    BEGIN
      SELECT CASE
        WHEN NEW.provenance IS NOT NULL
         AND NEW.provenance NOT IN ('organic','injected','tool_result','environmental')
        THEN RAISE(ABORT, 'CHECK constraint failed: learnings.provenance')
      END;
      UPDATE artifact SET
        ${artifactProjectCol} = NEW.project,
        body = NEW.content,
        data = json_set(json_set(json_set(json_set(json_set(json_set(data,
          '$.agent_id', NEW.agent_id),
          '$.fingerprint', NEW.fingerprint),
          '$.promotion_count', NEW.promotion_count),
          '$.first_seen_epoch', COALESCE(NEW.first_seen_epoch_ms, NEW.first_seen_epoch, json_extract(data, '$.first_seen_epoch'))),
          '$.last_promoted_epoch', COALESCE(NEW.last_promoted_epoch_ms, NEW.last_promoted_epoch, json_extract(data, '$.last_promoted_epoch'))),
          '$.provenance', COALESCE(NEW.provenance, json_extract(data, '$.provenance'), 'organic')
        ),
        ${artifactUpdatedCol} = COALESCE(NEW.updated_at_epoch_ms, unixepoch() * 1000)
      WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = 'learnings' AND legacy_id = OLD.id);
    END
  `);

  // INSTEAD OF DELETE — unchanged from V17 (no provenance dependency).
  db.exec(`
    CREATE TRIGGER learnings_instead_delete INSTEAD OF DELETE ON learnings
    BEGIN
      DELETE FROM artifact
        WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = 'learnings' AND legacy_id = OLD.id)
          AND kind = 'learning';
      DELETE FROM legacy_id_map
        WHERE legacy_table = 'learnings' AND legacy_id = OLD.id;
    END
  `);

  // Backfill: existing learning artifacts have no $.provenance in their
  // data JSON (V30 ALTER + DEFAULT was skipped on view-mode DBs). Set
  // provenance to 'organic' for all rows where it's absent. Mirrors V30's
  // baseline-organic backfill for the base-table case.
  db.exec(`
    UPDATE artifact
    SET data = json_set(data, '$.provenance', 'organic')
    WHERE kind = 'learning'
      AND json_extract(data, '$.provenance') IS NULL
  `);

  return true;
}

/**
 * V31→V32 (Phase 8 — v6 transcript ingestion substrate).
 *
 * Adds two new objects, purely additive, no existing table/view/trigger
 * touched:
 *
 *   - `transcript_chunk_v6` (regular table) — metadata for each ingested
 *     transcript chunk: session/project/turn keys, role + closed-enum
 *     `provenance` CHECK matching V25 episodic_events / V30 learnings,
 *     body, created_at_epoch_ms, sub_index for sentence-boundary
 *     sub-chunks of long turns, and a wrapper_redacted flag set by the
 *     ingestion pipeline when parseWrappers stripped at least one
 *     wrapper-tagged span from the source turn.
 *   - `vec_transcript_chunks_v6` (vec0 virtual table) — 1024-dim float
 *     embeddings keyed by transcript_chunk_v6.id, populated by Phase 8's
 *     ingestion pipeline via the existing arctic-embed2 path.
 *
 * Idempotency: if `transcript_chunk_v6` already exists, returns false.
 * Migration runs identically on base-table fresh-DBs and V17-collapsed
 * shapes — both shapes have the schema-versions / artifact / legacy-id-map
 * foundation that the new tables sit alongside; the legacy
 * `artifact(kind='transcript_chunk')` slot stays untouched per Phase 7
 * CONTEXT decision 1 + Phase 8 CONTEXT decision 3.
 *
 * vec0 virtual table creation follows migrateV14toV15's silent-skip
 * pattern — wrapped in try/catch so DBs without sqlite-vec still advance
 * to UV=32 functionally (only the bi-encoder path degrades).
 */
/**
 * V32 → V33 (Phase 13 Plan 03): session_highlights table for per-session FRAME
 * artifacts (mental model, open questions, reframes, tools introduced,
 * decisions not made, posture context). New table, distinct from
 * project_curated_context — per-session scope, structured fields, 1:1 session FK.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
 * Shape-agnostic: no existing table is altered; no view/trigger is touched.
 * WIR-01 coverage in 13-03 tests applies the same DDL against V32 fresh-DB
 * and V17-collapsed shapes — both succeed because the DDL touches no
 * pre-existing surface.
 */
export function migrateV32toV33(db: Database): boolean {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      mental_model TEXT,
      open_questions TEXT,
      reframes TEXT,
      tools_introduced TEXT,
      decisions_not_made TEXT,
      posture_context TEXT,
      degraded INTEGER NOT NULL DEFAULT 0,
      degraded_reason TEXT,
      degraded_model TEXT,
      created_at_epoch_ms INTEGER NOT NULL,
      re_extracted_at_epoch_ms INTEGER,
      UNIQUE(session_id, project)
    );
    CREATE INDEX IF NOT EXISTS idx_session_highlights_project_created
      ON session_highlights (project, created_at_epoch_ms DESC);
  `);
  return true;
}

export function migrateV31toV32(db: Database): boolean {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_chunk_v6'"
  ).get() as { 1: number } | undefined;
  if (exists) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_chunk_v6 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      sub_index INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
      provenance TEXT NOT NULL CHECK (provenance IN ('organic','injected','tool_result','environmental')),
      body TEXT NOT NULL,
      created_at_epoch_ms INTEGER NOT NULL,
      wrapper_redacted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_chunk_v6_session_turn
      ON transcript_chunk_v6(session_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_transcript_chunk_v6_project_created
      ON transcript_chunk_v6(project_id, created_at_epoch_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_transcript_chunk_v6_session_turn_role_sub
      ON transcript_chunk_v6(session_id, turn_index, role, sub_index);
  `);

  // vec0 virtual table — silent-skip if sqlite-vec unavailable, mirroring
  // migrateV14toV15 (the existing five vec_* tables follow the same shape).
  const loaded = loadSqliteVec(db);
  if (loaded) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_transcript_chunks_v6 USING vec0(embedding float[1024])`);
    } catch {
      // Non-fatal — failed create surfaces at first query time.
    }
  }

  return true;
}

/**
 * V33 → V34 (Phase 14 Plan 14-02, 2026-05-15):
 * Project-naming column unification. The V17 `artifact` table and
 * `transcript_chunk_v6` use `project_id`; every other project-scoped
 * table uses `project`. The collision causes cross-table queries to
 * fail in non-obvious ways. This migration renames the V17 outliers.
 *
 * SQLite `ALTER TABLE ... RENAME COLUMN` requires SQLite 3.25+;
 * better-sqlite3 ships with 3.40+ on supported Node versions, so
 * this is safe.
 *
 * FTS5 sidecar `artifact_fts` is content-table-bound (content=artifact,
 * content_rowid=id) — column rename on the source table does NOT
 * require FTS DDL changes (FTS reads by rowid, not by column name).
 * Existing triggers (artifact_ai/ad/au) are inspected; if any
 * reference `project_id` directly, they're recreated against `project`.
 *
 * Indexes referencing `project_id` are dropped + recreated.
 *
 * Reverse migration `migrateV34toV33` exists for rollback. Both
 * migrations bump user_version + add a schema_versions row.
 */
export function migrateV33toV34(db: Database): void {
  // Guard: only rename if the old column name still exists.
  // If applyV17DDL was already updated to use `project` (fresh-DB or test fixture),
  // the rename is a no-op. hasColumn check prevents "no such column" throws.
  if (hasColumn(db, 'artifact', 'project_id')) {
    db.exec(`ALTER TABLE artifact RENAME COLUMN project_id TO project`);
  }
  const tcHasProjectId = (db.pragma('table_info(transcript_chunk_v6)') as Array<{ name: string }>)
    .some(c => c.name === 'project_id');
  if (tcHasProjectId) {
    db.exec(`ALTER TABLE transcript_chunk_v6 RENAME COLUMN project_id TO project`);
  }

  // Audit indexes — drop any that reference project_id.
  const idxRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='index'
       AND (tbl_name='artifact' OR tbl_name='transcript_chunk_v6')`
  ).all() as Array<{ name: string; sql: string | null }>;
  for (const r of idxRows) {
    if (r.sql && /project_id/i.test(r.sql)) {
      db.exec(`DROP INDEX IF EXISTS "${r.name}"`);
      db.exec(r.sql.replace(/project_id/g, 'project'));
    }
  }

  // Audit triggers — same pattern.
  const trgRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger'
       AND (tbl_name='artifact' OR tbl_name='transcript_chunk_v6')`
  ).all() as Array<{ name: string; sql: string | null }>;
  for (const r of trgRows) {
    if (r.sql && /project_id/i.test(r.sql)) {
      db.exec(`DROP TRIGGER IF EXISTS "${r.name}"`);
      db.exec(r.sql.replace(/project_id/g, 'project'));
    }
  }

  // Audit views that reference artifact.project_id (e.g., the learnings view
  // installed by migrateV30toV31 on V17-collapsed DBs). SQLite views do not
  // auto-update on column renames — drop + recreate each affected view AND
  // its associated INSTEAD OF triggers (which also reference project_id).
  const viewRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='view'`
  ).all() as Array<{ name: string; sql: string | null }>;
  for (const v of viewRows) {
    if (v.sql && /project_id/i.test(v.sql)) {
      // Drop INSTEAD OF triggers on this view first (triggers are order-sensitive).
      const vTriggers = db.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`
      ).all(v.name) as Array<{ name: string; sql: string | null }>;
      for (const t of vTriggers) {
        db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
      }
      // Recreate view with project_id → project substitution.
      db.exec(`DROP VIEW IF EXISTS "${v.name}"`);
      db.exec(v.sql.replace(/\bartifact\.project_id\b/g, 'artifact.project'));
      // Recreate triggers with project_id → project substitution.
      for (const t of vTriggers) {
        if (t.sql) {
          db.exec(t.sql.replace(/project_id/g, 'project'));
        }
      }
    }
  }

  db.pragma('user_version = 34');
  // schema_versions may or may not exist, and may have different column layouts
  // depending on the migration path (SCHEMA_V3 path vs legacy path). Use a
  // compatible insert that only specifies `version` (always present).
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
      version        INTEGER PRIMARY KEY,
      applied_at_epoch INTEGER
    )`);
    const svCols = (db.pragma('table_info(schema_versions)') as Array<{ name: string }>).map(c => c.name);
    if (svCols.includes('applied_at_epoch')) {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (34, unixepoch())`);
    } else {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (34)`);
    }
  } catch { /* schema_versions tracking is non-critical — continue */ }
}

export function migrateV34toV33(db: Database): void {
  // Reverse: rename back to project_id. Mirror trigger/index audit.
  db.exec(`ALTER TABLE artifact RENAME COLUMN project TO project_id`);
  db.exec(`ALTER TABLE transcript_chunk_v6 RENAME COLUMN project TO project_id`);

  const idxRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='index'
       AND (tbl_name='artifact' OR tbl_name='transcript_chunk_v6')`
  ).all() as Array<{ name: string; sql: string | null }>;
  for (const r of idxRows) {
    if (r.sql && /\bproject\b(?!_id)/i.test(r.sql)) {
      db.exec(`DROP INDEX IF EXISTS "${r.name}"`);
      db.exec(r.sql.replace(/\bproject\b/g, 'project_id'));
    }
  }

  const trgRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger'
       AND (tbl_name='artifact' OR tbl_name='transcript_chunk_v6')`
  ).all() as Array<{ name: string; sql: string | null }>;
  for (const r of trgRows) {
    if (r.sql && /\bproject\b(?!_id)/i.test(r.sql)) {
      db.exec(`DROP TRIGGER IF EXISTS "${r.name}"`);
      db.exec(r.sql.replace(/\bproject\b/g, 'project_id'));
    }
  }

  db.pragma('user_version = 33');
}

// ---------------------------------------------------------------------------
// V34 → V35  (epoch-ms canonicalization)
// ---------------------------------------------------------------------------

/**
 * Migrates V34 → V35: renames every `*_epoch` column to `*_epoch_ms` and
 * scales second-precision values by ×1000 (WHERE guard prevents double-scaling).
 *
 * Tables affected:
 *   sessions, observations, learnings, checkpoint_meta,
 *   artifact (V17 — rename-only; values already ms),
 *   episodic_events, telemetry, pressure_scores, schema_versions,
 *   session_messages, session_signals, retrieval_events.
 *
 * SQLite limitations:
 *   - DEFAULT expressions on renamed columns are preserved verbatim by
 *     ALTER TABLE ... RENAME COLUMN — they stay as `unixepoch()`.
 *     Post-rename the canonical DDL is updated (Task 4) so fresh DBs use
 *     `unixepoch() * 1000`. We do NOT rebuild tables here; the default on
 *     the column in the migrated DB stays `unixepoch()` (returns seconds),
 *     but fresh DBs at V35 will have the correct ms default directly.
 *   - This limitation is documented: existing DBs may write seconds for new
 *     rows via raw SQL defaults until the process restarts with new code.
 *     Application-level callers always use `Date.now()` via epoch.ts, so
 *     this only affects direct SQL without explicit values (rare).
 *
 * Index + trigger audit mirrors the V33→V34 pattern used for project_id.
 * The entire rename + scale sequence is wrapped in a single transaction.
 *
 * Reverse migration: `migrateV35toV34` divides values by 1000 (floor) and
 * renames columns back. Sub-second precision is lost (documented).
 */
export function migrateV34toV35(db: Database): void {
  // Each entry: { table, oldCol, newCol, scale }
  // scale=true: UPDATE SET newCol = newCol * 1000 WHERE newCol < 1e12
  // scale=false: rename only (values already ms, e.g., artifact V17)
  const renames: Array<{ table: string; oldCol: string; newCol: string; scale: boolean }> = [
    // sessions
    { table: 'sessions', oldCol: 'created_at_epoch', newCol: 'created_at_epoch_ms', scale: true },
    { table: 'sessions', oldCol: 'ended_at_epoch',   newCol: 'ended_at_epoch_ms',   scale: true },
    // observations
    { table: 'observations', oldCol: 'timestamp_epoch',        newCol: 'timestamp_epoch_ms',        scale: true },
    { table: 'observations', oldCol: 'last_accessed_at_epoch', newCol: 'last_accessed_at_epoch_ms', scale: true },
    { table: 'observations', oldCol: 'deleted_at_epoch',       newCol: 'deleted_at_epoch_ms',       scale: true },
    // learnings
    { table: 'learnings', oldCol: 'first_seen_epoch',    newCol: 'first_seen_epoch_ms',    scale: true },
    { table: 'learnings', oldCol: 'last_promoted_epoch', newCol: 'last_promoted_epoch_ms', scale: true },
    { table: 'learnings', oldCol: 'updated_at_epoch',    newCol: 'updated_at_epoch_ms',    scale: true },
    // checkpoint_meta
    { table: 'checkpoint_meta', oldCol: 'created_at_epoch', newCol: 'created_at_epoch_ms', scale: true },
    { table: 'checkpoint_meta', oldCol: 'updated_at_epoch', newCol: 'updated_at_epoch_ms', scale: true },
    // artifact (V17) — values are already milliseconds (runner multiplies by 1000 at write time)
    // scale=false: WHERE guard still applied via UPDATE below as a safety net
    { table: 'artifact', oldCol: 'created_at_epoch', newCol: 'created_at_epoch_ms', scale: false },
    { table: 'artifact', oldCol: 'updated_at_epoch', newCol: 'updated_at_epoch_ms', scale: false },
    // episodic_events
    { table: 'episodic_events', oldCol: 'ts_epoch', newCol: 'ts_epoch_ms', scale: true },
    // telemetry
    { table: 'telemetry', oldCol: 'timestamp_epoch', newCol: 'timestamp_epoch_ms', scale: true },
    // pressure_scores
    { table: 'pressure_scores', oldCol: 'last_touched_epoch', newCol: 'last_touched_epoch_ms', scale: true },
    // schema_versions
    { table: 'schema_versions', oldCol: 'applied_at_epoch', newCol: 'applied_at_epoch_ms', scale: true },
    // session_messages
    { table: 'session_messages', oldCol: 'created_at_epoch',   newCol: 'created_at_epoch_ms',   scale: true },
    { table: 'session_messages', oldCol: 'delivered_at_epoch', newCol: 'delivered_at_epoch_ms', scale: true },
    // session_signals
    { table: 'session_signals', oldCol: 'created_at_epoch', newCol: 'created_at_epoch_ms', scale: true },
    { table: 'session_signals', oldCol: 'expires_at_epoch',  newCol: 'expires_at_epoch_ms',  scale: true },
    { table: 'session_signals', oldCol: 'cleared_at_epoch',  newCol: 'cleared_at_epoch_ms',  scale: true },
    // retrieval_events
    { table: 'retrieval_events', oldCol: 'timestamp_epoch', newCol: 'timestamp_epoch_ms', scale: true },
    // kind_registry (V17 DDL table — passive kind tracking)
    { table: 'kind_registry', oldCol: 'first_seen_epoch', newCol: 'first_seen_epoch_ms', scale: true },
    { table: 'kind_registry', oldCol: 'last_seen_epoch',  newCol: 'last_seen_epoch_ms',  scale: true },
    // session_journal (SCHEMA_V3 table)
    { table: 'session_journal', oldCol: 'timestamp_epoch', newCol: 'timestamp_epoch_ms', scale: true },
    // conversation_turns (V10 table)
    { table: 'conversation_turns', oldCol: 'timestamp_epoch', newCol: 'timestamp_epoch_ms', scale: true },
    // artifacts (SCHEMA_V3 table — legacy pre-V17 knowledge artifact store)
    { table: 'artifacts', oldCol: 'timestamp_epoch',         newCol: 'timestamp_epoch_ms',         scale: true },
    { table: 'artifacts', oldCol: 'last_materialized_epoch', newCol: 'last_materialized_epoch_ms',  scale: true },
  ];

  const tx = db.transaction(() => {
    for (const r of renames) {
      // Skip tables that don't exist in this DB shape (e.g., artifact on pre-V17 DBs)
      if (!hasTable(db, r.table)) continue;
      // Skip if old column doesn't exist (idempotency guard — fresh V35 DBs won't have old names)
      if (!hasColumn(db, r.table, r.oldCol)) continue;
      // Skip if new column already exists (double-run guard)
      if (hasColumn(db, r.table, r.newCol)) continue;

      db.exec(`ALTER TABLE "${r.table}" RENAME COLUMN "${r.oldCol}" TO "${r.newCol}"`);

      if (r.scale) {
        // Scale sec→ms only for rows that look like seconds (< 1e12).
        // Rows already at ms precision are left unchanged.
        db.exec(
          `UPDATE "${r.table}"
           SET "${r.newCol}" = "${r.newCol}" * 1000
           WHERE "${r.newCol}" IS NOT NULL AND "${r.newCol}" < 1000000000000`
        );
      }
    }

    // ── Indexes ──────────────────────────────────────────────────────────
    // Audit every index on affected tables; if its DDL references an old
    // column name, drop + recreate with the new name.
    const affectedTables = [...new Set(renames.map(r => r.table))];
    const oldNewMap: Record<string, string> = {};
    for (const r of renames) oldNewMap[r.oldCol] = r.newCol;

    const idxRows = db.prepare(
      `SELECT name, sql, tbl_name FROM sqlite_master
       WHERE type='index'
         AND tbl_name IN (${affectedTables.map(() => '?').join(',')})`
    ).all(...affectedTables) as Array<{ name: string; sql: string | null; tbl_name: string }>;

    for (const idx of idxRows) {
      if (!idx.sql) continue;
      let newSql = idx.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g');
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g'), newCol);
          changed = true;
        }
      }
      if (changed) {
        db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        try { db.exec(newSql); } catch { /* index reconstruction failed — non-fatal; log to schema_versions later */ }
      }
    }

    // ── Triggers ─────────────────────────────────────────────────────────
    const trgRows = db.prepare(
      `SELECT name, sql, tbl_name FROM sqlite_master
       WHERE type='trigger'
         AND tbl_name IN (${affectedTables.map(() => '?').join(',')})`
    ).all(...affectedTables) as Array<{ name: string; sql: string | null; tbl_name: string }>;

    for (const trg of trgRows) {
      if (!trg.sql) continue;
      let newSql = trg.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g');
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g'), newCol);
          changed = true;
        }
      }
      if (changed) {
        db.exec(`DROP TRIGGER IF EXISTS "${trg.name}"`);
        try { db.exec(newSql); } catch { /* trigger reconstruction failed — non-fatal */ }
      }
    }

    // ── Views ─────────────────────────────────────────────────────────────
    const viewRows = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='view'`
    ).all() as Array<{ name: string; sql: string | null }>;

    for (const v of viewRows) {
      if (!v.sql) continue;
      let newSql = v.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g');
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g'), newCol);
          changed = true;
        }
      }
      if (changed) {
        // Drop INSTEAD OF triggers on this view before dropping the view
        const vTriggers = db.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`
        ).all(v.name) as Array<{ name: string; sql: string | null }>;
        for (const t of vTriggers) {
          db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
        }
        db.exec(`DROP VIEW IF EXISTS "${v.name}"`);
        try {
          db.exec(newSql);
          // Recreate triggers with renamed columns
          for (const t of vTriggers) {
            if (t.sql) {
              let tSql = t.sql;
              for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
                tSql = tSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g'), newCol);
              }
              try { db.exec(tSql); } catch { /* trigger recreation failed */ }
            }
          }
        } catch { /* view recreation failed — non-fatal */ }
      }
    }

    // ── schema_versions + user_version ───────────────────────────────────
    db.pragma('user_version = 35');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
        version          INTEGER PRIMARY KEY,
        applied_at_epoch_ms INTEGER
      )`);
      const svCols = (db.pragma('table_info(schema_versions)') as Array<{ name: string }>).map(c => c.name);
      if (svCols.includes('applied_at_epoch_ms')) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch_ms) VALUES (35, unixepoch() * 1000)`);
      } else if (svCols.includes('applied_at_epoch')) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (35, unixepoch())`);
      } else {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (35)`);
      }
    } catch { /* schema_versions tracking is non-critical */ }
  });

  tx();
}

/**
 * Reverse migration V35 → V34: renames `*_epoch_ms` columns back to `*_epoch`
 * and divides values by 1000 (floor). Sub-second precision is lost — this is
 * documented and acceptable for rollback scenarios.
 */
export function migrateV35toV34(db: Database): void {
  const renames: Array<{ table: string; oldCol: string; newCol: string }> = [
    { table: 'sessions', oldCol: 'created_at_epoch_ms', newCol: 'created_at_epoch' },
    { table: 'sessions', oldCol: 'ended_at_epoch_ms',   newCol: 'ended_at_epoch'   },
    { table: 'observations', oldCol: 'timestamp_epoch_ms',        newCol: 'timestamp_epoch'        },
    { table: 'observations', oldCol: 'last_accessed_at_epoch_ms', newCol: 'last_accessed_at_epoch' },
    { table: 'observations', oldCol: 'deleted_at_epoch_ms',       newCol: 'deleted_at_epoch'       },
    { table: 'learnings', oldCol: 'first_seen_epoch_ms',    newCol: 'first_seen_epoch'    },
    { table: 'learnings', oldCol: 'last_promoted_epoch_ms', newCol: 'last_promoted_epoch' },
    { table: 'learnings', oldCol: 'updated_at_epoch_ms',    newCol: 'updated_at_epoch'    },
    { table: 'checkpoint_meta', oldCol: 'created_at_epoch_ms', newCol: 'created_at_epoch' },
    { table: 'checkpoint_meta', oldCol: 'updated_at_epoch_ms', newCol: 'updated_at_epoch' },
    { table: 'artifact', oldCol: 'created_at_epoch_ms', newCol: 'created_at_epoch' },
    { table: 'artifact', oldCol: 'updated_at_epoch_ms', newCol: 'updated_at_epoch' },
    { table: 'episodic_events', oldCol: 'ts_epoch_ms', newCol: 'ts_epoch' },
    { table: 'telemetry', oldCol: 'timestamp_epoch_ms', newCol: 'timestamp_epoch' },
    { table: 'pressure_scores', oldCol: 'last_touched_epoch_ms', newCol: 'last_touched_epoch' },
    { table: 'schema_versions', oldCol: 'applied_at_epoch_ms', newCol: 'applied_at_epoch' },
    { table: 'session_messages', oldCol: 'created_at_epoch_ms',   newCol: 'created_at_epoch'   },
    { table: 'session_messages', oldCol: 'delivered_at_epoch_ms', newCol: 'delivered_at_epoch' },
    { table: 'session_signals', oldCol: 'created_at_epoch_ms', newCol: 'created_at_epoch' },
    { table: 'session_signals', oldCol: 'expires_at_epoch_ms',  newCol: 'expires_at_epoch'  },
    { table: 'session_signals', oldCol: 'cleared_at_epoch_ms',  newCol: 'cleared_at_epoch'  },
    { table: 'retrieval_events', oldCol: 'timestamp_epoch_ms', newCol: 'timestamp_epoch' },
    { table: 'kind_registry', oldCol: 'first_seen_epoch_ms', newCol: 'first_seen_epoch' },
    { table: 'kind_registry', oldCol: 'last_seen_epoch_ms',  newCol: 'last_seen_epoch'  },
    { table: 'session_journal', oldCol: 'timestamp_epoch_ms', newCol: 'timestamp_epoch' },
    { table: 'conversation_turns', oldCol: 'timestamp_epoch_ms', newCol: 'timestamp_epoch' },
    { table: 'artifacts', oldCol: 'timestamp_epoch_ms',         newCol: 'timestamp_epoch'         },
    { table: 'artifacts', oldCol: 'last_materialized_epoch_ms', newCol: 'last_materialized_epoch' },
  ];

  const tx = db.transaction(() => {
    for (const r of renames) {
      if (!hasTable(db, r.table)) continue;
      if (!hasColumn(db, r.table, r.oldCol)) continue;
      if (hasColumn(db, r.table, r.newCol)) continue;

      db.exec(`ALTER TABLE "${r.table}" RENAME COLUMN "${r.oldCol}" TO "${r.newCol}"`);

      // Divide ms → sec (floor). Only scale rows that look like ms (>= 1e12).
      // artifact values are already ms from V17; divide them back to sec.
      db.exec(
        `UPDATE "${r.table}"
         SET "${r.newCol}" = "${r.newCol}" / 1000
         WHERE "${r.newCol}" IS NOT NULL AND "${r.newCol}" >= 1000000000000`
      );
    }

    // Rebuild indexes + triggers for affected tables
    const newOldMap: Record<string, string> = {};
    for (const r of renames) newOldMap[r.oldCol] = r.newCol;
    const affectedTables = [...new Set(renames.map(r => r.table))];

    const idxRows = db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type='index'
         AND tbl_name IN (${affectedTables.map(() => '?').join(',')})`
    ).all(...affectedTables) as Array<{ name: string; sql: string | null }>;

    for (const idx of idxRows) {
      if (!idx.sql) continue;
      let newSql = idx.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(newOldMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g');
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g'), newCol);
          changed = true;
        }
      }
      if (changed) {
        db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        try { db.exec(newSql); } catch { /* non-fatal */ }
      }
    }

    const trgRows = db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type='trigger'
         AND tbl_name IN (${affectedTables.map(() => '?').join(',')})`
    ).all(...affectedTables) as Array<{ name: string; sql: string | null }>;

    for (const trg of trgRows) {
      if (!trg.sql) continue;
      let newSql = trg.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(newOldMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g');
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, 'g'), newCol);
          changed = true;
        }
      }
      if (changed) {
        db.exec(`DROP TRIGGER IF EXISTS "${trg.name}"`);
        try { db.exec(newSql); } catch { /* non-fatal */ }
      }
    }

    db.pragma('user_version = 34');
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (34)`);
    } catch { /* non-critical */ }
  });

  tx();
}

// ---------------------------------------------------------------------------
// Internal regex escape helper (used by migrateV34toV35 / migrateV35toV34)
// ---------------------------------------------------------------------------
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// V35 → V36: extend telemetry event_kind CHECK to include 'session_end_action'
// ---------------------------------------------------------------------------

/**
 * Probe whether the current telemetry CHECK constraint admits 'session_end_action'.
 * Used as the idempotency guard in migrateV35toV36.
 */
function telemetryAcceptsSessionEndAction(db: Database): boolean {
  if (!hasTable(db, 'telemetry')) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get() as { sql?: string } | undefined;
  return !!row?.sql && row.sql.includes("'session_end_action'");
}

/**
 * V35→V36: Phase 14 Plan 14-05 — extend telemetry.event_kind CHECK constraint
 * to include 'session_end_action'.
 *
 * SQLite cannot ALTER a CHECK constraint, so the standard rebuild-and-copy
 * pattern is used (mirrors V19→V20, V20→V21, etc.).
 *
 * Steps (single transaction):
 *   1. Rename existing `telemetry` to `telemetry_v35`.
 *   2. Drop old indexes.
 *   3. Recreate `telemetry` with the V36 enum (TELEMETRY_SCHEMA).
 *   4. Copy rows back (all existing event kinds remain valid).
 *   5. Drop `telemetry_v35`.
 *   6. Stamp user_version = 36.
 *
 * Idempotent: if telemetry already accepts 'session_end_action', no-op.
 * Additive: pre-V36 DBs silently swallow INSERT (try/catch in recordSessionEndAction).
 */
export function migrateV35toV36(db: Database): boolean {
  if (!hasTable(db, 'telemetry')) return true;
  if (!hasColumn(db, 'telemetry', 'event_kind')) return true;
  if (telemetryAcceptsSessionEndAction(db)) return true;

  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v35;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);

    db.exec(TELEMETRY_SCHEMA);

    // Copy rows — old column name in V35 is timestamp_epoch_ms (already renamed by V35 migration)
    db.exec(`
      INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter)
      SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter
      FROM telemetry_v35;
    `);

    db.exec(`DROP TABLE telemetry_v35;`);

    db.pragma('user_version = 36');
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (36)`);
    } catch { /* non-critical */ }
  });

  tx();
  return true;
}

/**
 * Reverse migration V36 → V35: removes 'session_end_action' from the
 * telemetry CHECK constraint by recreating the table with the V35 enum.
 *
 * Rows with event_kind='session_end_action' are dropped (no V35 constraint
 * admission). This matches the documented rollback behavior for additive
 * telemetry extensions.
 */
export function migrateV36toV35(db: Database): boolean {
  if (!hasTable(db, 'telemetry')) return true;
  if (!telemetryAcceptsSessionEndAction(db)) return true;

  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v36;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);

    // Recreate with V35 schema (without session_end_action).
    // Import TELEMETRY_SCHEMA_V35 inline by re-declaring the V35 DDL.
    db.exec(`
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
    'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
    'reranker_fallback',
    'cross_project_ambiguous', 'cross_project_query_expansion',
    'episodic_write_failure',
    'signal_reread_after_surface', 'signal_retrieval_fallback',
    'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
    'handoff_parse_failed'
  )),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  latency_ms REAL,
  timestamp_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  adapter TEXT DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch_ms DESC);
    `);

    // Copy back only rows with V35-admissible event kinds (drops session_end_action rows)
    db.exec(`
      INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter)
      SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter
      FROM telemetry_v36
      WHERE event_kind != 'session_end_action';
    `);

    db.exec(`DROP TABLE telemetry_v36;`);

    db.pragma('user_version = 35');
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (35)`);
    } catch { /* non-critical */ }
  });

  tx();
  return true;
}

// ---------------------------------------------------------------------------
// V36 → V37: Phase 14-07a — Unified artifact schema + artifact_id_map
// ---------------------------------------------------------------------------

/**
 * V36→V37: Phase 14-07a — Substrate unification.
 *
 * Three additive changes in a single transaction:
 *   1. Add `read_only` flag column to legacy `artifacts` (default 0; 14-07c
 *      flips at cutover to refuse new writes to the legacy table).
 *   2. Create `artifact_id_map` mapping table: legacy INTEGER PK ↔ V17 TEXT
 *      hash ID. Indexed on v17_id for reverse lookup.
 *   3. Create `vec_artifact_v17` vec0 virtual table for V17 unified embeddings.
 *   4. Populate `artifact_id_map` for every existing legacy `artifacts` row,
 *      inserting corresponding rows into `artifact` (V17 unified table) with
 *      correct field mapping per RCA-3 loss-map (summary→title, content→body,
 *      importance (1-5) → confidence (0-1), state→status enum, etc.).
 *   5. Extend `telemetry.event_kind` CHECK enum with 're_vectorize_failed'.
 *   6. Bump PRAGMA user_version to 37 + insert schema_versions row.
 *
 * Non-destructive: legacy `artifacts` table is NOT dropped, NOT truncated,
 * NOT structurally altered except for the additive `read_only` column.
 * The FTS5 triggers on `artifact_fts` continue to sync V17 artifact writes.
 * Legacy `artifacts_fts` and its triggers are left in place.
 *
 * Idempotent: if `artifact_id_map` already exists, the entire body is a no-op.
 *
 * Reverse: `migrateV37toV36` drops `artifact_id_map` and `vec_artifact_v17`,
 * attempts DROP COLUMN `read_only` (no-op on unsupported SQLite), removes
 * 're_vectorize_failed' from telemetry enum, decrements user_version.
 */
export function migrateV36toV37(db: Database): boolean {
  // Idempotency guard: if the map table already exists, we're already at V37.
  if (hasTable(db, 'artifact_id_map')) {
    return true;
  }

  const tx = db.transaction(() => {
    // ── Step 1: Add read_only flag column to legacy artifacts ─────────────
    // Only additive; flag is FALSE during 14-07a. 14-07c flips it to TRUE.
    if (hasTable(db, 'artifacts') && !hasColumn(db, 'artifacts', 'read_only')) {
      db.exec(`ALTER TABLE artifacts ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`);
    }

    // ── Step 2: Create artifact_id_map mapping table ──────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_id_map (
        legacy_id          INTEGER PRIMARY KEY,
        v17_id             TEXT NOT NULL UNIQUE,
        mapped_at_epoch_ms INTEGER NOT NULL,
        project            TEXT NOT NULL,
        FOREIGN KEY (v17_id) REFERENCES artifact(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_v17
        ON artifact_id_map(v17_id);
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_project
        ON artifact_id_map(project);
    `);

    // ── Step 3: Create vec_artifact_v17 vec0 table for V17 embeddings ─────
    // Load sqlite-vec if not already loaded on this connection.
    loadSqliteVec(db);
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifact_v17
          USING vec0(embedding float[1024]);
      `);
    } catch {
      // Non-fatal if sqlite-vec is unavailable — re-vectorization (14-07c)
      // will fail loudly at cutover time if vec0 is missing. Migration can
      // still proceed; the schema gate at cutover enforces vec0 presence.
    }

    // ── Step 4: Populate artifact_id_map from legacy artifacts ───────────
    _populateArtifactIdMapInTransaction(db);

    // ── Step 5: Extend telemetry enum with 're_vectorize_failed' ──────────
    _extendTelemetryForV37(db);

    // ── Step 6: Stamp version ─────────────────────────────────────────────
    db.pragma('user_version = 37');
    try {
      const svCols = (db.pragma('table_info(schema_versions)') as Array<{ name: string }>).map(c => c.name);
      if (svCols.includes('applied_at_epoch_ms')) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch_ms) VALUES (37, unixepoch() * 1000)`);
      } else if (svCols.includes('applied_at_epoch')) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (37, unixepoch())`);
      } else {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (37)`);
      }
    } catch { /* schema_versions tracking is non-critical */ }
  });

  tx();
  return true;
}

/**
 * Internal helper: populate `artifact_id_map` from legacy `artifacts` rows.
 * Must be called inside an existing transaction (migrateV36toV37's tx).
 *
 * Per each legacy row:
 *   1. Derive V17 ID: sha256(legacy_id || ':' || project || ':' || timestamp_epoch_ms || ':' || sha256(summary || COALESCE(content,''))).slice(0,32)
 *   2. Insert into `artifact` (V17 kernel) with field mapping per RCA-3 loss-map.
 *   3. Insert into `artifact_id_map`.
 * Rows already in the map are skipped (INSERT OR IGNORE).
 *
 * Field mapping (RCA-3 loss-map):
 *   summary → title
 *   content → body
 *   artifact_type → kind
 *   importance (1-5 int) → confidence (0.0-1.0 float, formula: importance / 5.0)
 *   state ('fresh','packed','materialized') → status ('active','stale','superseded')
 *   timestamp_epoch_ms (ms) → created_at_epoch_ms (ms, same unit post-V35)
 *   superseded_by (forward INTEGER) → supersedes_id: resolved lazily via artifact_id_map (set NULL on initial pass; 14-07b/c resolves remaining)
 *   ttl, last_materialized_epoch_ms, retrieval_score, activation_score, valid_until, novelty_score → data JSON sidecar
 *   artifact_ref → data.artifact_ref (preserved for 14-07b callers)
 *   embedding BLOB → NOT copied (re-vectorize.ts writes fresh embeddings at 14-07c cutover)
 */
function _populateArtifactIdMapInTransaction(db: Database): void {
  if (!hasTable(db, 'artifacts')) return; // No legacy table → nothing to migrate.
  if (!hasTable(db, 'artifact')) return;  // V17 kernel must exist.

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');

  const stateToStatus = (state: string): string => {
    switch (state) {
      case 'fresh': return 'active';
      case 'packed': return 'stale';
      case 'materialized': return 'superseded';
      default: return 'active';
    }
  };

  const legacyRows = db.prepare(`
    SELECT id, session_id, project, artifact_type, artifact_ref,
           summary, content, state, ttl, importance,
           retrieval_score, timestamp_epoch_ms, last_materialized_epoch_ms,
           activation_score, superseded_by, valid_until, confidence,
           novelty_score
    FROM artifacts
  `).all() as Array<{
    id: number;
    session_id: string;
    project: string;
    artifact_type: string;
    artifact_ref: string | null;
    summary: string;
    content: string | null;
    state: string;
    ttl: number;
    importance: number;
    retrieval_score: number;
    timestamp_epoch_ms: number;
    last_materialized_epoch_ms: number | null;
    activation_score: number;
    superseded_by: number | null;
    valid_until: number | null;
    confidence: number;
    novelty_score: number;
  }>;

  const insertArtifactStmt = db.prepare(`
    INSERT OR IGNORE INTO artifact(
      id, kind, title, body, scope, status, confidence,
      created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMapStmt = db.prepare(`
    INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
    VALUES (?, ?, ?, ?)
  `);

  const now = Date.now();

  for (const row of legacyRows) {
    // Derive V17 ID: sha256(legacy_id:project:timestamp_epoch_ms:content_hash).slice(0,32)
    const contentHash = createHash('sha256')
      .update(row.summary + (row.content ?? ''))
      .digest('hex');
    const v17Id = createHash('sha256')
      .update(`${row.id}:${row.project}:${row.timestamp_epoch_ms}:${contentHash}`)
      .digest('hex')
      .slice(0, 32);

    // Scale importance (1-5) → confidence (0.0-1.0)
    const v17Confidence = row.importance / 5.0;

    // Map state enum to status enum
    const v17Status = stateToStatus(row.state);

    // Build data JSON sidecar (all non-kernel legacy fields)
    const dataSidecar: Record<string, unknown> = {
      migrated_from_legacy_id: row.id,
      ttl: row.ttl,
      retrieval_score: row.retrieval_score,
      activation_score: row.activation_score,
      novelty_score: row.novelty_score,
    };
    if (row.artifact_ref !== null) dataSidecar['artifact_ref'] = row.artifact_ref;
    if (row.last_materialized_epoch_ms !== null) dataSidecar['last_materialized_epoch'] = row.last_materialized_epoch_ms;
    if (row.valid_until !== null) dataSidecar['valid_until'] = row.valid_until;
    // superseded_by resolution is deferred — resolved post-loop below

    insertArtifactStmt.run(
      v17Id,
      row.artifact_type,       // kind = artifact_type (same values)
      row.summary,             // title = summary
      row.content ?? '',       // body = content (COALESCE empty string)
      'project',               // scope = 'project' (all artifacts are project-scoped)
      v17Status,
      v17Confidence,
      row.timestamp_epoch_ms,
      row.timestamp_epoch_ms,  // updated_at_epoch_ms same as created initially
      row.session_id,
      row.project,
      JSON.stringify(dataSidecar),
    );

    insertMapStmt.run(row.id, v17Id, now, row.project);
  }

  // ── Post-loop: resolve supersedes_id (direction flip: superseded_by → supersedes_id) ──
  // Legacy semantics: artifacts.superseded_by = S means "I (this row L) was replaced by row S".
  // V17 semantics: artifact.supersedes_id = L means "I (row S) replaced row L".
  //
  // So: for each legacy row L with superseded_by = S (non-null),
  //   find the V17 row for S (the superseding row),
  //   and set that V17 row's supersedes_id = V17_id(L) (the superseded row's V17 ID).
  //
  // SQL: For each artifact in V17 whose legacy_id = S,
  //   find any legacy row L where L.superseded_by = S,
  //   and set supersedes_id = artifact_id_map[L.id].v17_id.
  db.exec(`
    UPDATE artifact
    SET supersedes_id = (
      SELECT m_superseded.v17_id
      FROM artifact_id_map m_superseding
      INNER JOIN artifacts leg_superseded ON leg_superseded.superseded_by = m_superseding.legacy_id
      INNER JOIN artifact_id_map m_superseded ON m_superseded.legacy_id = leg_superseded.id
      WHERE m_superseding.v17_id = artifact.id
      LIMIT 1
    )
    WHERE artifact.supersedes_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM artifact_id_map m_superseding
        INNER JOIN artifacts leg_superseded ON leg_superseded.superseded_by = m_superseding.legacy_id
        WHERE m_superseding.v17_id = artifact.id
      )
  `);
}
