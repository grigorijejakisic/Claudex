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
  db.exec('CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC)');
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
 * Adds the `episodic_events` table. Each row is a typed conversational or
 * environmental event with provenance attached as a row attribute (closed
 * enum CHECK constraint). The substrate is forward-only and write-only in
 * Phase 1 — no readers, no embeddings, no backfill of legacy
 * `conversation_turns`. See
 * `.planning/phases/01-episode-substrate/01-CONTEXT.md` for the design and
 * `.planning/phases/01-episode-substrate/01-04-substrate-readme.md` for the
 * operator-facing reference (lands in Plan 01-04).
 *
 * Idempotent — `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
 * mean re-running on a V25+ DB is a no-op.
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
  return true;
}
