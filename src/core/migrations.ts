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
import { SCHEMA_V3, TELEMETRY_SCHEMA, TEAM_COORDINATION_SCHEMA, SHAPE_VOCABULARY_SCHEMA, POINTER_RECALL_SCHEMA, ARTIFACT_TASK_PATTERN_SCHEMA, SCHEMA_V22 } from './schema.js';
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
  migrateV11toV12,
  migrateV12toV13,
  migrateV13toV14,
  migrateV14toV15,
  migrateV15toV16,
  migrateV16toV17,
  migrateV17toV18,
  migrateV18toV19,
  migrateV19toV20,
  migrateV20toV21,
  migrateV21toV22,
  migrateV22toV23,
  migrateV23toV24,
  migrateV24toV25,
  migrateV25toV26,
  migrateV26toV27,
  migrateV27toV28,
  migrateV28toV29,
  migrateV29toV30,
  migrateV30toV31,
  migrateV31toV32,
  migrateSchemaFixes,
  cleanupOrphanTables,
  upgradeV2SchemaInPlace,
} from './migration-steps.js';
import { loadSqliteVec } from './sqlite-vec-loader.js';

// Re-export migrateV14toV15 for direct use from initializeSchema fresh-DB path.
export { migrateV14toV15 };

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
 *   10 — Angel System Phase 1: message bus + data fixes
 *   17 — Phase P1 unified artifact kernel
 *   18 — Phase 4.1 shape vocabulary substrate
 *   19 — Phase 5.5 curation feedback loop substrate
 *   20 — Phase 6 P5: telemetry event_kind enum +'reranker_fallback'
 *   21 — Phase 6.5: artifact_task_pattern sidecar + telemetry enum
 *        +'cross_project_ambiguous' +'cross_project_query_expansion'
 *   22 — Phase 8.5: retrieval_log + session_flag tables (recall observability)
 *   23 — Phase 9.8: drop policy_weights + artifacts.q_value (RL stack delete)
 *   24 — Phase 11 STOR-04: drop legacy `*_old` tables from V17
 *   25 — v5 Phase 1 (EPI-01): episodic_events + closed-enum provenance
 *   26 — v5 Phase 2 (IDX-01): error-fingerprint sidecar
 *   27 — v5 Phase 2.1 (IDX-04): widen corpus_origin CHECK constraint
 *   28 — v5 Phase 4 (AR-03): experience_patterns insert guard
 *   29 — v5 Phase 6 (EBD-05): episode_boundary_cursor + sessions liveness cols
 *   30 — v5 Phase 7 (MIG-01): learnings.provenance ALTER (base-table)
 *   31 — v5.0.1 hot-fix (MIG-02): learnings.provenance view rebuild (V17 view-mode)
 *   32 — v6 Phase 8: transcript_chunk_v6 + vec_transcript_chunks_v6 (TRX-05)
 *
 * Dual version tracking:
 * Both `PRAGMA user_version` and `schema_versions` table are needed:
 *   - `PRAGMA user_version = 10` — fast O(1) check on every DB open (runMigrations hot path)
 *   - `schema_versions.version = 300` — semantic version for cross-version detection
 *     (detectV2Database, verifyMigration, migrateFromV2)
 * user_version gates incremental ALTER migrations; schema_versions gates data migrations
 * and cross-install compatibility checks.
 */
/**
 * Target SQLite `PRAGMA user_version` for the current build.
 * `claudex doctor` (DIAG-05) reads this to verify the on-disk DB is in sync.
 * Bumping a migration must bump this constant in lockstep.
 */
export const TARGET_USER_VERSION = 32;

export function runMigrations(db: Database): void {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  let version = row[0]?.user_version ?? 0;

  const TARGET_VERSION = TARGET_USER_VERSION;

  if (version >= TARGET_VERSION) {
    // Still load sqlite-vec even if no migration is needed — the extension
    // doesn't persist across DB connections, so every open needs it loaded
    // for callers that want to query vec0 tables.
    loadSqliteVec(db);
    return;
  }

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
    [11, () => migrateV11toV12(db)],
    [12, () => migrateV12toV13(db)],
    [13, () => migrateV13toV14(db)],
    [14, () => migrateV14toV15(db)],
    [15, () => migrateV15toV16(db)],
    [16, () => migrateV16toV17(db)],
    [17, () => migrateV17toV18(db)],
    [18, () => migrateV18toV19(db)],
    [19, () => { migrateV19toV20(db); }],
    [20, () => { migrateV20toV21(db); }],
    [21, () => { migrateV21toV22(db); }],
    [22, () => { migrateV22toV23(db); }],
    [23, () => { migrateV23toV24(db); }],
    [24, () => { migrateV24toV25(db); }],
    [25, () => { migrateV25toV26(db); }],
    [26, () => { migrateV26toV27(db); }],
    [27, () => { migrateV27toV28(db); }],
    [28, () => { migrateV28toV29(db); }],
    [29, () => { migrateV29toV30(db); }],
    [30, () => { migrateV30toV31(db); }],
    [31, () => { migrateV31toV32(db); }],
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
  // Ensure sqlite-vec is loaded on this connection even if runMigrations
  // took the fast-path return (already at TARGET_VERSION). Idempotent
  // per-connection — safe to call multiple times.
  loadSqliteVec(db);

  // Version-aware skip: on a post-V17 DB, the 6 legacy knowledge tables
  // (learnings/decisions/experience_patterns/angel_opinions/critical_rules/
  // project_curated_context) have been replaced by views over `artifact`.
  // SQLite throws "views may not be indexed" for any re-run CREATE INDEX
  // against those names, so every V1–V16 "belt and braces" DDL block below
  // is unsafe on V17 DBs. The data has already been migrated; the schema
  // is already shaped. Skip them. Still run loadSqliteVec (done above),
  // cleanupOrphanTables, and the schema_versions write at the end.
  const currentUv = (db.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version ?? 0;
  const isPostV17 = currentUv >= 17;

  if (!isPostV17) {
    // Create vec0 virtual tables explicitly. For fresh in-memory or brand-new
    // DBs, runMigrations returns early (no `observations` table → assumes
    // nothing to migrate) and V14→V15 never runs. The SCHEMA_V3 DDL below
    // creates the regular tables but not the virtual ones. Run the V15
    // migration step directly here so vec0 tables exist regardless of
    // whether initialization came via migration or fresh creation.
    migrateV14toV15(db);

    // V15→V16: project_curated_context table. No extension required, so the
    // fresh-DB path can call it unconditionally. Idempotent via IF NOT EXISTS.
    migrateV15toV16(db);

    // V16→V17 DDL — create the artifact kernel + artifact_fts + legacy_id_map
    // as DORMANT storage. Data migration is CLI-driven via migrate:v17:apply
    // (Plan 02-05 runner) because Phase A requires Ollama. Creating the tables
    // up-front lets callers port their FTS5 MATCH queries to artifact_fts even
    // before the actual row migration runs. Matches the V14→V15 vec0 pattern.
    try { migrateV16toV17(db); } catch { /* non-fatal: may fail on older sqlite-vec */ }

    // FTS5: detect stale v2 index with wrong column count and rebuild
    rebuildStaleFts5(db);

    db.exec(SCHEMA_V3);
    db.exec(TELEMETRY_SCHEMA);
    db.exec(TEAM_COORDINATION_SCHEMA);
    db.exec(SHAPE_VOCABULARY_SCHEMA);
    db.exec(POINTER_RECALL_SCHEMA);
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    db.exec(SCHEMA_V22);

    // Rebuild FTS5 content index from observations table
    if (hasTable(db, 'observations') && hasTable(db, 'observations_fts')) {
      try {
        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
      } catch { /* FTS rebuild failed — non-fatal */ }
    }

    // Schema fixes: single-owner artifact_claims, porter stemmer on FTS, etc.
    migrateSchemaFixes(db);
  } else {
    // Post-V17 DB: the artifact kernel DDL is still worth re-asserting
    // (it's fully idempotent via IF NOT EXISTS and doesn't touch the views).
    // This keeps the "dormant storage" contract for any connection that
    // opens a V17 DB after a fresh checkout.
    try { migrateV16toV17(db); } catch { /* non-fatal: may fail on older sqlite-vec */ }

    // Telemetry + team coordination schemas are orthogonal to the artifact
    // migration — their tables are NOT replaced by V17 views, so re-exec is
    // safe and cheap. Keeps fresh-V17 clones bootstrap-able.
    db.exec(TELEMETRY_SCHEMA);
    db.exec(TEAM_COORDINATION_SCHEMA);
    db.exec(SHAPE_VOCABULARY_SCHEMA);
    db.exec(POINTER_RECALL_SCHEMA);
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    db.exec(SCHEMA_V22);

    // Phase 4.1: V18 raised TARGET_VERSION 16→18, so legacy partial-v2 DBs
    // (e.g., only `observations` exists at open time) now reach user_version=18
    // via runMigrations and land here. Those DBs need SCHEMA_V3 to create
    // sessions/telemetry/checkpoint_meta/etc. SCHEMA_V3 is `CREATE TABLE IF
    // NOT EXISTS`-guarded throughout. The V17 view-substitution that would
    // collide with SCHEMA_V3's table names is created by the v17-runner CLI
    // (applyGeneratedDDL), NOT by migrateV16toV17 alone — so as long as the
    // runner has not been invoked, SCHEMA_V3 is safe to re-run here. We gate
    // the legacy-table-bearing portions behind a `sessions` existence check
    // to avoid running SCHEMA_V3 on a fully-migrated post-V17 DB where the
    // views ARE in place.
    // Detect whether the V17 runner has installed the legacy-table-replacing
    // views (e.g., learnings, decisions). If yes, SCHEMA_V3 cannot run because
    // its CREATE INDEX statements would trip "views may not be indexed". If
    // no (V17 DDL only — kernel tables but no views), SCHEMA_V3 is safe AND
    // necessary for legacy DBs upgraded in-process to fill in v3 tables.
    const v17ViewsActive = (db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='view' AND name='learnings' LIMIT 1"
    ).get() as { 1: number } | undefined) != null;

    // Heuristic: a "post-V17 in-process upgrade" DB has not run the V17 view
    // runner, so the legacy knowledge tables must exist as real tables (or be
    // missing entirely). If `session_journal` is missing AND views are not
    // active, this is a legacy v2/partial-v3 DB that needs SCHEMA_V3 to fill
    // in the v3 tables (learnings, decisions, artifacts, session_journal, etc.).
    const needsSchemaV3 = !v17ViewsActive && !hasTable(db, 'session_journal');

    if (needsSchemaV3) {
      // FTS5: detect stale v2 index with wrong column count and rebuild
      // (must run BEFORE SCHEMA_V3 so SCHEMA_V3's 2-column FTS5 DDL can execute).
      rebuildStaleFts5(db);
      db.exec(SCHEMA_V3);
      // Rebuild FTS5 content index from observations table
      if (hasTable(db, 'observations') && hasTable(db, 'observations_fts')) {
        try {
          db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
        } catch { /* FTS rebuild failed — non-fatal */ }
      }
      // Schema fixes: single-owner artifact_claims, porter stemmer on FTS, etc.
      migrateSchemaFixes(db);
    }
  }

  // Drop orphan tables from pre-V6 schemas (runs unconditionally, not gated by migrateSchemaFixes guard)
  cleanupOrphanTables(db);

  // Ensure schema_versions exists for the version-record INSERT below.
  // V17 DDL replaces 6 legacy tables with views but does NOT recreate
  // schema_versions; SCHEMA_V3 (where it lives) is skipped on the post-V17
  // path. For legacy DBs upgraded through runMigrations into V17/V18 directly,
  // we need this guard so the INSERT below has a target table.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
  );`);

  // Record schema version
  const svCols = (db.pragma('table_info(schema_versions)') as Array<{ name: string }>).map(c => c.name);
  if (svCols.includes('applied_at')) {
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, datetime())').run(SCHEMA_VERSION);
  } else {
    db.prepare('INSERT OR IGNORE INTO schema_versions (version) VALUES (?)').run(SCHEMA_VERSION);
  }
  // Do not demote a V23 (or newer) DB. Phase 9.8 raises the ceiling 22→23
  // (drops policy_weights table + artifacts.q_value column — RL stack delete).
  // Fresh DBs that took the early-return in runMigrations (no `observations`
  // table) are stamped here after SCHEMA_V3 + V19 + V20 + V21 + V22 DDL run.
  // The V22→V23 migration is destructive (DROP), so a fresh-DB path must also
  // run it to ensure policy_weights / q_value are absent on new installs.
  if (currentUv < 23) {
    migrateV22toV23(db);
    db.pragma('user_version = 23');
  }
  // Phase 11 STOR-04: drop legacy `*_old` tables. Idempotent — fresh DBs that
  // never had _old tables get a no-op DROP IF EXISTS sweep. Sets user_version 24.
  if (currentUv < 24) {
    migrateV23toV24(db);
    db.pragma('user_version = 24');
  }
  // V5 Phase 1 (EPI-01): episode substrate. Creates `episodic_events` with
  // closed-enum `provenance` CHECK constraint and supporting indexes.
  // Idempotent via IF NOT EXISTS. Fresh-DB path lands here; runMigrations
  // step-table covers existing-DB upgrades from V24.
  if (currentUv < 25) {
    migrateV24toV25(db);
    db.pragma('user_version = 25');
  }
  // V5 Phase 2 (IDX-01): error-fingerprint sidecar. First sidecar pattern in
  // the v5 substrate — inverted index of metadata_json-derived fingerprints
  // for cross-session error recall. Idempotent. Fresh-DB path lands here;
  // runMigrations step-table covers existing-DB upgrades from V25.
  if (currentUv < 26) {
    migrateV25toV26(db);
    db.pragma('user_version = 26');
  }
  // V5 Phase 2.1 (IDX-04): widen corpus_origin CHECK constraint to the
  // three-tier phase-anchored scheme (v4_backfill /
  // phase1_organic_pre_phase2_close / phase1_organic_post_phase2_close).
  // Idempotent — guards on the legacy CHECK signature.
  if (currentUv < 27) {
    migrateV26toV27(db);
    db.pragma('user_version = 27');
  }
  // V5 Phase 4 (AR-03): mark this DB as past the V28 cutoff. The actual
  // gating mechanism (TEMP table + TEMP trigger) is installed unconditionally
  // below — TEMP objects don't persist across connections, so re-installation
  // happens every initializeSchema call.
  if (currentUv < 28) {
    migrateV27toV28(db);
    db.pragma('user_version = 28');
  }
  // V5 Phase 6 (EBD-05): episode_boundary_cursor table + sessions
  // last_heartbeat_ts/last_jsonl_write_ts columns. Substrate for the
  // crash-resilient boundary detector (fsnotify watcher + heartbeat tick +
  // idle-sweep). Idempotent via existence checks. Fresh-DB path lands here
  // (sessions table from SCHEMA_V3 already exists; columns get added);
  // runMigrations step-table covers existing-DB upgrades from V28.
  if (currentUv < 29) {
    migrateV28toV29(db);
    db.pragma('user_version = 29');
  }
  // V5 Phase 7 (MIG-01/02): learnings.provenance column with closed-enum
  // CHECK matching episodic_events. Plan 07-03 lands the write-path filter
  // that ensures the column is structurally always 'organic' from the
  // production codepath. Idempotent via DDL substring scan. Fresh-DB path
  // lands here; runMigrations step-table covers existing-DB upgrades from V29.
  if (currentUv < 30) {
    migrateV29toV30(db);
    db.pragma('user_version = 30');
  }
  // v5.0.1 hot-fix (MIG-02 V17 view-mode close): rebuild the `learnings` view
  // and INSTEAD OF triggers to carry `provenance` through to artifact.data
  // JSON on V17-collapsed DBs. V30 added the column on base-table DBs but
  // skipped view-mode DBs, breaking the production write path silently.
  // Idempotent on already-V31 DBs and no-op on base-table DBs (V30 sufficed).
  if (currentUv < 31) {
    migrateV30toV31(db);
    db.pragma('user_version = 31');
  }
  // v6 Phase 8 (TRX-05): transcript_chunk_v6 metadata table + paired
  // vec_transcript_chunks_v6 vec0 virtual table. Purely additive — no
  // existing table/view/trigger touched. Idempotent on already-V32 DBs.
  // Fresh-DB path lands here; runMigrations step-table covers existing-DB
  // upgrades from V31.
  if (currentUv < 32) {
    migrateV31toV32(db);
    db.pragma('user_version = 32');
  }

  // Phase 4 (V28): per-connection sidecar + TEMP TRIGGER guarding writes
  // to the legacy `experience_patterns` table. Both objects live in the
  // `temp` schema because (a) SQLite forbids a permanent-schema trigger
  // from referencing temp objects and (b) overrides must be per-connection
  // so tests cannot leak to production code paths. Phase 7 retirement work
  // for other legacy tables (learning, decision, transcript_chunk) can
  // reuse `session_pragmas` with different keys. Must run AFTER the
  // experience_patterns table is created (SCHEMA_V3 / post-V17 path) and
  // on every initializeSchema call — TEMP objects do not persist.
  if (hasTable(db, 'experience_patterns')) {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS session_pragmas (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TEMP TRIGGER IF NOT EXISTS experience_patterns_insert_blocked
      BEFORE INSERT ON experience_patterns
      WHEN (SELECT value FROM temp.session_pragmas
            WHERE key='allow_legacy_pattern_insert' LIMIT 1) IS NULL
      BEGIN
        SELECT RAISE(FAIL,
          'experience_patterns is read-only legacy after Phase 4 (.planning/reframes/2026-05-05-multi-handle-kill.md). Set session_pragma allow_legacy_pattern_insert=1 only for tests, fixtures, or Phase 7 retirement work.');
      END;
    `);
  }
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
