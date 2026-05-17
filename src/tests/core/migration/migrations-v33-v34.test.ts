/**
 * V33→V34 migration — project_id → project column rename.
 *
 * Phase 14 Plan 14-02. Covers:
 *   1. Fresh-DB schema uses `project` (not `project_id`) on artifact + transcript_chunk_v6.
 *   2. user_version reaches 34 after initializeSchema.
 *   3. INSERT + SELECT round-trips work against `project` column.
 *   4. `project_id` column does NOT exist post-migration.
 *   5. Forward migration from a V31-shape DB (project_id column → renamed to project).
 *   6. Index audit: project_id-referencing indexes are renamed after migration.
 *   7. View audit: the learnings VIEW is recreated with `artifact.project` after migration.
 *   8. Trigger audit: INSTEAD OF triggers on learnings VIEW work after migration.
 *   9. transcript_chunk_v6 round-trip via upsertChunk.
 *  10. Rollback migrateV34toV33 renames project → project_id.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, TARGET_USER_VERSION } from '../../../core/migrations.js';
import { openDatabase } from '../../../core/storage.js';
import { migrateV33toV34, migrateV34toV33, hasColumn } from '../../../core/migration-steps.js';
import { applyV17DDL } from '../../../core/migration/v17-ddl.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name);
}

/**
 * Build a minimal V31-shape DB (artifact with project_id column, learnings VIEW,
 * and INSTEAD OF triggers) and apply V17DDL to get the expression indexes, then
 * set user_version to 33 so migrateV33toV34 can be called explicitly.
 */
function buildV33FixtureDb(): Database.Database {
  const db = new Database(':memory:');

  // Minimal V33 artifact table (project_id column, as created by old V17 DDL).
  db.exec(`
    CREATE TABLE artifact (
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL,
      title            TEXT,
      body             TEXT NOT NULL DEFAULT '',
      scope            TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      confidence       REAL,
      created_at_epoch INTEGER NOT NULL DEFAULT 0,
      updated_at_epoch INTEGER NOT NULL DEFAULT 0,
      session_id       TEXT,
      project_id       TEXT,
      embedding_ref    INTEGER,
      supersedes_id    TEXT,
      data             TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE legacy_id_map (
      legacy_table TEXT NOT NULL,
      legacy_id    INTEGER NOT NULL,
      new_uuid     TEXT NOT NULL,
      PRIMARY KEY (legacy_table, legacy_id)
    );

    -- Expression index referencing project_id (mirrors EXPRESSION_INDEXES_DDL).
    CREATE INDEX idx_artifact_learning_agent
      ON artifact(project_id, json_extract(data, '$.agent_id'), json_extract(data, '$.promotion_count') DESC)
      WHERE kind = 'learning';

    -- learnings VIEW referencing artifact.project_id.
    CREATE VIEW learnings AS
    SELECT
      CAST((SELECT m.legacy_id FROM legacy_id_map m
            WHERE m.legacy_table = 'learnings' AND m.new_uuid = artifact.id) AS INTEGER) AS id,
      CAST(artifact.project_id AS TEXT) AS project,
      artifact.body AS content
    FROM artifact
    WHERE kind = 'learning';

    -- INSTEAD OF INSERT trigger referencing project_id.
    CREATE TRIGGER learnings_instead_insert INSTEAD OF INSERT ON learnings
    BEGIN
      INSERT INTO artifact(
        id, kind, body, created_at_epoch, updated_at_epoch, project_id
      ) VALUES (
        lower(hex(randomblob(16))),
        'learning',
        NEW.content,
        unixepoch(),
        unixepoch(),
        NEW.project
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
    END;

    CREATE TABLE IF NOT EXISTS schema_versions (
      version        INTEGER PRIMARY KEY,
      applied_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE transcript_chunk_v6 (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id         TEXT NOT NULL,
      project_id         TEXT NOT NULL,
      turn_index         INTEGER NOT NULL,
      sub_index          INTEGER NOT NULL DEFAULT 0,
      role               TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      provenance         TEXT NOT NULL CHECK(provenance IN ('organic','injected','tool_result','environmental')),
      body               TEXT NOT NULL,
      created_at_epoch_ms INTEGER NOT NULL,
      wrapper_redacted   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_transcript_chunk_v6_project_created
      ON transcript_chunk_v6(project_id, created_at_epoch_ms);
  `);
  db.pragma('user_version = 33');
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V33→V34 migration (Phase 14 Plan 14-02)', () => {
  let db: Database.Database;

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  // --- Test 1: Fresh-DB schema uses `project`, not `project_id`
  it('T1: fresh-DB artifact table has `project` column, not `project_id`', () => {
    db = freshDb();
    const cols = columnNames(db, 'artifact');
    expect(cols).toContain('project');
    expect(cols).not.toContain('project_id');
  });

  // --- Test 2: user_version reaches current TARGET_USER_VERSION (bumped to 38 by Plan 14-07-LINKS-SCHEMA)
  it('T2: TARGET_USER_VERSION is 38 and fresh-DB reaches it', () => {
    expect(TARGET_USER_VERSION).toBe(38);
    db = freshDb();
    const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(uv).toBe(38);
  });

  // --- Test 3: INSERT + SELECT round-trip using `project` column
  it('T3: INSERT into artifact.project and SELECT project round-trips correctly', () => {
    db = freshDb();
    db.prepare(
      `INSERT INTO artifact (id, kind, body, created_at_epoch_ms, updated_at_epoch_ms, project)
       VALUES ('rt-1', 'decision', 'body', 1000, 1000, 'my-project')`,
    ).run();
    const row = db.prepare('SELECT project FROM artifact WHERE id = ?').get('rt-1') as { project: string };
    expect(row.project).toBe('my-project');
  });

  // --- Test 4: `project_id` column does NOT exist on fresh-DB
  it('T4: `project_id` column does not exist on artifact in fresh DB', () => {
    db = freshDb();
    expect(hasColumn(db, 'artifact', 'project_id')).toBe(false);
    expect(hasColumn(db, 'artifact', 'project')).toBe(true);
  });

  // --- Test 5: Forward migration from V33 fixture renames the column
  it('T5: migrateV33toV34 renames artifact.project_id → artifact.project', () => {
    db = buildV33FixtureDb();
    expect(hasColumn(db, 'artifact', 'project_id')).toBe(true);
    migrateV33toV34(db);
    expect(hasColumn(db, 'artifact', 'project_id')).toBe(false);
    expect(hasColumn(db, 'artifact', 'project')).toBe(true);
  });

  // --- Test 6: Index audit — project_id-referencing index is recreated as project
  it('T6: expression index referencing project_id is rebuilt with project after migration', () => {
    db = buildV33FixtureDb();
    migrateV33toV34(db);
    const idxRow = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_artifact_learning_agent'`,
    ).get() as { sql: string } | undefined;
    expect(idxRow).toBeDefined();
    expect(idxRow!.sql).not.toMatch(/project_id/);
    expect(idxRow!.sql).toMatch(/\bproject\b/);
  });

  // --- Test 7: View audit — learnings VIEW is recreated with artifact.project
  it('T7: learnings VIEW SQL references artifact.project (not artifact.project_id) after migration', () => {
    db = buildV33FixtureDb();
    migrateV33toV34(db);
    const viewRow = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='view' AND name='learnings'`,
    ).get() as { sql: string } | undefined;
    expect(viewRow).toBeDefined();
    expect(viewRow!.sql).not.toMatch(/artifact\.project_id/);
    expect(viewRow!.sql).toMatch(/artifact\.project/);
  });

  // --- Test 8: Trigger audit — INSTEAD OF trigger on learnings VIEW works post-migration
  it('T8: INSTEAD OF INSERT on learnings VIEW writes artifact.project after migration', () => {
    db = buildV33FixtureDb();
    migrateV33toV34(db);
    db.prepare(`INSERT INTO learnings(id, project, content) VALUES (1, 'proj-x', 'lesson content')`).run();
    const row = db.prepare(`SELECT project FROM artifact WHERE kind='learning'`).get() as { project: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.project).toBe('proj-x');
  });

  // --- Test 9: transcript_chunk_v6 uses `project` after migration
  it('T9: transcript_chunk_v6.project column exists (not project_id) after migration', () => {
    db = buildV33FixtureDb();
    migrateV33toV34(db);
    expect(hasColumn(db, 'transcript_chunk_v6', 'project_id')).toBe(false);
    expect(hasColumn(db, 'transcript_chunk_v6', 'project')).toBe(true);
    // Verify INSERT works.
    db.prepare(
      `INSERT INTO transcript_chunk_v6 (session_id, project, turn_index, sub_index, role, provenance, body, created_at_epoch_ms, wrapper_redacted)
       VALUES ('s1', 'proj-z', 0, 0, 'user', 'organic', 'hello', 1000000, 0)`,
    ).run();
    const r = db.prepare(`SELECT project FROM transcript_chunk_v6 WHERE session_id='s1'`).get() as { project: string };
    expect(r.project).toBe('proj-z');
  });

  // --- Test 10: Rollback migrateV34toV33 renames project → project_id
  it('T10: migrateV34toV33 renames artifact.project → project_id (reversibility)', () => {
    db = buildV33FixtureDb();
    migrateV33toV34(db);
    expect(hasColumn(db, 'artifact', 'project')).toBe(true);
    expect(hasColumn(db, 'artifact', 'project_id')).toBe(false);
    migrateV34toV33(db);
    expect(hasColumn(db, 'artifact', 'project_id')).toBe(true);
    expect(hasColumn(db, 'artifact', 'project')).toBe(false);
    const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(uv).toBe(33);
  });
});
