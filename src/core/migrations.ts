/**
 * Schema initialization and migration orchestrator.
 *
 * Public API (unchanged — all existing imports work):
 *   - initializeSchema(db) — full schema setup for fresh/existing DBs
 *   - runMigrations(db) — incremental PRAGMA user_version migrations
 *   - migrateFromV2(db, v2DbPath) — cross-database v2 data import
 *   - detectV2Database() — find existing v2 database for migration
 *
 * DDL constants live in schema.ts, migration steps in migration-steps.ts.
 */

import type { Database } from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { SCHEMA_VERSION } from '../shared/constants.js';
import { getClaudexHome } from '../shared/paths.js';
import { SCHEMA_V3, TELEMETRY_SCHEMA, TEAM_COORDINATION_SCHEMA } from './schema.js';
import {
  hasTable,
  rebuildStaleFts5,
  migrateV1toV2,
  migrateV2toV3,
  migrateV3toV4,
  migrateV4toV5,
  migrateV5toV6,
  migrateV6toV7,
  migrateV7toV8,
  migrateV8toV9,
  migrateV9toV10,
  migrateV10toV11,
  migrateSchemaFixes,
  upgradeV2SchemaInPlace,
} from './migration-steps.js';

// ---------------------------------------------------------------------------
// runMigrations — incremental PRAGMA user_version migrations
// ---------------------------------------------------------------------------

/**
 * PRAGMA user_version migration runner.
 * Detects DB version and applies incremental migrations.
 * Called by openDatabase() (hot path) and initializeSchema() (CLI/test path).
 *
 * Version map:
 *   0 — fresh DB (no tables) or legacy DB (pre-versioning, has tables)
 *   1 — reserved (unused currently)
 *   2 — v2 schema (pre-v3 migration)
 *   3–7 — incremental migrations (v3→v4, v4→v5, ..., v7→v8)
 *   8 — v8 (Evolved Flow)
 *   9 — v9 (Semantic Intelligence)
 *   10 — current (Angel System Phase 1: message bus + data fixes)
 *
 * Dual version tracking:
 * Both `PRAGMA user_version` and `schema_versions` table are needed:
 *   - `PRAGMA user_version = 10` — fast O(1) check on every DB open (runMigrations hot path)
 *   - `schema_versions.version = 300` — semantic version for cross-version detection
 *     (detectV2Database, verifyMigration, migrateFromV2)
 * user_version gates incremental ALTER migrations; schema_versions gates data migrations
 * and cross-install compatibility checks.
 */
export function runMigrations(db: Database): void {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  let version = row[0]?.user_version ?? 0;

  const TARGET_VERSION = 11;

  if (version >= TARGET_VERSION) return;

  // Run all migrations from current version to target
  const migrations: Array<[number, () => void]> = [
    [2, () => { /* v2→v3 handled by migrateV2toV3 below */ }],
    [3, () => migrateV3toV4(db)],
    [4, () => migrateV4toV5(db)],
    [5, () => migrateV5toV6(db)],
    [6, () => migrateV6toV7(db)],
    [7, () => migrateV7toV8(db)],
    [8, () => migrateV8toV9(db)],
    [9, () => migrateV9toV10(db)],
    [10, () => migrateV10toV11(db)],
  ];

  // Handle special cases for version 0 and 1
  if (version === 0) {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    if (!tables.includes('observations')) return; // Fresh DB — no migrations needed
    migrateV1toV2(db);
    if (!migrateV2toV3(db)) { db.pragma('user_version = 2'); return; }
    version = 3;
  } else if (version === 1) {
    migrateV1toV2(db);
    if (!migrateV2toV3(db)) { db.pragma('user_version = 2'); return; }
    version = 3;
  } else if (version === 2) {
    if (!migrateV2toV3(db)) return;
    version = 3;
  }

  // Run remaining migrations sequentially, tracking last successful version
  let lastSuccessfulVersion = version;
  for (const [fromVersion, migrate] of migrations) {
    if (version <= fromVersion && fromVersion >= 3) {
      try {
        migrate();
        lastSuccessfulVersion = fromVersion + 1;
      } catch {
        // Stop at first failure — don't skip broken migrations
        break;
      }
    }
  }

  db.pragma(`user_version = ${lastSuccessfulVersion >= TARGET_VERSION ? TARGET_VERSION : lastSuccessfulVersion}`);
}

// ---------------------------------------------------------------------------
// initializeSchema — full schema setup
// ---------------------------------------------------------------------------

/**
 * Initializes the complete v3 schema: 21 tables + telemetry + FTS5 + triggers + indexes.
 * Records schema version 300. Idempotent (all IF NOT EXISTS).
 * Handles in-place upgrade when opening an existing v2 database at the same path.
 */
export function initializeSchema(db: Database): void {
  upgradeV2SchemaInPlace(db);
  runMigrations(db);

  // FTS5: detect stale v2 index with wrong column count and rebuild
  rebuildStaleFts5(db);

  db.exec(SCHEMA_V3);
  db.exec(TELEMETRY_SCHEMA);
  db.exec(TEAM_COORDINATION_SCHEMA);

  // Rebuild FTS5 content index from observations table
  if (hasTable(db, 'observations') && hasTable(db, 'observations_fts')) {
    try {
      db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
    } catch { /* FTS rebuild failed — non-fatal */ }
  }

  // Schema fixes: single-owner artifact_claims, porter stemmer on FTS, etc.
  migrateSchemaFixes(db);

  // Record schema version
  const svCols = (db.pragma('table_info(schema_versions)') as Array<{ name: string }>).map(c => c.name);
  if (svCols.includes('applied_at')) {
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, datetime())').run(SCHEMA_VERSION);
  } else {
    db.prepare('INSERT OR IGNORE INTO schema_versions (version) VALUES (?)').run(SCHEMA_VERSION);
  }
  db.pragma('user_version = 11');
}

// ---------------------------------------------------------------------------
// migrateFromV2 — cross-database v2 data import
// ---------------------------------------------------------------------------

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
    throw new Error(`migrateFromV2: source and target are the same database (${sourcePath})`);
  }

  const escapedPath = v2DbPath.replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${escapedPath}' AS v2`);

  try {
    const migrate = db.transaction(() => {
      db.exec(SCHEMA_V3);
      db.exec(TELEMETRY_SCHEMA);
      db.exec(TEAM_COORDINATION_SCHEMA);

      const v2HasTable = (tableName: string): boolean => {
        const row = db.prepare("SELECT 1 FROM v2.sqlite_master WHERE type='table' AND name = ?").get(tableName) as { 1: number } | undefined;
        return row != null;
      };

      if (v2HasTable('observations')) {
        db.exec(`INSERT OR IGNORE INTO observations (id, session_id, project, tool_name, category, title, content, importance, files_modified, timestamp_epoch, access_count, last_accessed_at_epoch, deleted_at_epoch)
          SELECT id, session_id, project, tool_name, category, title, content, importance, CASE WHEN json_valid(files_modified) THEN files_modified ELSE '[]' END, timestamp_epoch, access_count, last_accessed_at_epoch, deleted_at_epoch FROM v2.observations`);
      }

      if (v2HasTable('sessions')) {
        db.exec(`INSERT OR IGNORE INTO sessions (session_id, scope, project, cwd, source, status, observation_count, created_at_epoch, ended_at_epoch)
          SELECT session_id, scope, project, cwd, source, status, observation_count, created_at_epoch, ended_at_epoch FROM v2.sessions`);
      }

      if (v2HasTable('pressure_scores')) {
        db.exec(`INSERT OR IGNORE INTO pressure_scores (file_path, project, raw_pressure, temperature, last_touched_epoch, decay_rate)
          SELECT file_path, project, raw_pressure, CASE WHEN temperature IN ('HOT', 'COLD') THEN temperature ELSE 'COLD' END, last_touched_epoch, decay_rate FROM v2.pressure_scores`);
      }

      const v2Tables = db.prepare("SELECT name FROM v2.sqlite_master WHERE type='table' AND name NOT IN ('observations', 'sessions', 'pressure_scores', 'sqlite_sequence')").all() as Array<{ name: string }>;
      for (const { name } of v2Tables) {
        if (name.startsWith('_archived_') || name.startsWith('sqlite_')) continue;
        try {
          const escapedName = name.replace(/"/g, '""');
          const escapedArchived = `_archived_${name}`.replace(/"/g, '""');
          db.exec(`ALTER TABLE v2."${escapedName}" RENAME TO "${escapedArchived}"`);
        } catch { /* skip */ }
      }

      db.exec(`UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature = 'WARM'`);

      try {
        db.exec(`INSERT OR IGNORE INTO checkpoint_tracking (session_id, last_checkpoint_epoch, observation_count, updated_at_epoch)
          SELECT session_id, last_checkpoint_epoch, observation_count, updated_at_epoch FROM v2._archived_checkpoint_state`);
      } catch { /* skip */ }

      if (v2HasTable('observations')) {
        const rows = db.prepare("SELECT id, files_modified FROM v2.observations WHERE NOT json_valid(files_modified)").all() as Array<{ id: number; files_modified: string }>;
        const updateStmt = db.prepare('UPDATE observations SET files_modified = ? WHERE id = ?');
        for (const row of rows) {
          const files = row.files_modified.split(',').map(f => f.trim()).filter(f => f.length > 0);
          updateStmt.run(JSON.stringify(files), row.id);
        }
      }

      db.prepare('INSERT OR IGNORE INTO schema_versions (version) VALUES (?)').run(SCHEMA_VERSION);
    });

    migrate();
  } finally {
    db.exec('DETACH DATABASE v2');
  }
}

// ---------------------------------------------------------------------------
// detectV2Database
// ---------------------------------------------------------------------------

/**
 * Detects an existing v2 database by checking known paths.
 * Returns path if found and schema version < 300, otherwise null.
 * Non-throwing.
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

      try {
        const testDb = new DatabaseConstructor(candidate, { readonly: true });
        try {
          const row = testDb.prepare('SELECT MAX(version) as version FROM schema_versions').get() as { version: number } | undefined;
          if (!row || row.version < SCHEMA_VERSION) {
            testDb.close();
            return candidate;
          }
          testDb.close();
        } catch {
          testDb.close();
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}
