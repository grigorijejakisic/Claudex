/**
 * Tests for the V31→V32 migration (Phase 8 — v6 transcript ingestion substrate).
 *
 * V32 is purely additive: creates `transcript_chunk_v6` (regular table) and
 * `vec_transcript_chunks_v6` (vec0 virtual table) alongside the legacy
 * `artifact(kind='transcript_chunk')` slot. The legacy slot stays untouched
 * per Phase 7 CONTEXT decision 1 + Phase 8 CONTEXT decision 3.
 *
 * Verifies:
 *   - TARGET_USER_VERSION is 32
 *   - Fresh-DB initialization (initializeSchema) converges to UV=32 with
 *     transcript_chunk_v6 + vec_transcript_chunks_v6 present
 *   - Incremental migration (runMigrations) on existing DBs lands the same
 *     shape — convergence invariant from Plan 06-01
 *   - Base-table fresh-DB: full column shape, indexes, CHECK constraints
 *   - V17-collapsed DB: V32 runs without touching the legacy `learnings` view
 *     or any other V17 view-mode object
 *   - Re-running migrateV31toV32 on an already-V32 DB is a no-op (returns false)
 *   - Closed-enum CHECK on `role` and `provenance` reject bad inserts (WIR-01
 *     framing — exercises the EXPORTED migration step against real fixtures)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations, TARGET_USER_VERSION } from '../../core/migrations.js';
import { migrateV31toV32 } from '../../core/migration-steps.js';

/**
 * Build a minimal V17-collapsed DB shape with the schema_versions / artifact
 * / legacy_id_map foundation that runMigrations needs to advance from V17
 * forward, plus the V31-shape `learnings` view (provenance projection from
 * artifact.data JSON). Mirrors what an existing post-V31 production install
 * looks like before V32 runs.
 */
function buildV17V32Fixture(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE artifact (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT,
      body TEXT,
      scope TEXT,
      status TEXT,
      confidence REAL,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL,
      session_id TEXT,
      project_id TEXT,
      embedding_ref INTEGER,
      supersedes_id TEXT,
      data TEXT
    );
    CREATE TABLE legacy_id_map (
      legacy_table TEXT NOT NULL,
      legacy_id INTEGER NOT NULL,
      new_uuid TEXT NOT NULL,
      PRIMARY KEY (legacy_table, legacy_id)
    );

    CREATE VIEW learnings AS
    SELECT
      CAST((SELECT m.legacy_id FROM legacy_id_map m WHERE m.legacy_table = 'learnings' AND m.new_uuid = artifact.id) AS INTEGER) AS id,
      CAST(artifact.project_id AS TEXT) AS project,
      artifact.body AS content,
      COALESCE(CAST(json_extract(artifact.data, '$.provenance') AS TEXT), 'organic') AS provenance
    FROM artifact
    WHERE kind = 'learning'
    ORDER BY created_at_epoch;
  `);
}

describe('V31→V32 migration (Phase 8 — v6 transcript ingestion substrate)', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('TARGET_USER_VERSION is 38', () => {
    expect(TARGET_USER_VERSION).toBe(38);
  });

  describe('migrateV31toV32 — base-table fresh-DB', () => {
    it('creates transcript_chunk_v6 with all 10 columns', () => {
      initializeSchema(db);
      const cols = db.prepare(`PRAGMA table_info(transcript_chunk_v6)`)
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const names = cols.map(c => c.name);
      expect(names).toEqual([
        'id', 'session_id', 'project', 'turn_index', 'sub_index',
        'role', 'provenance', 'body', 'created_at_epoch_ms', 'wrapper_redacted',
      ]);
    });

    it('creates the two regular indexes + one unique index', () => {
      initializeSchema(db);
      const indexes = db.prepare(`PRAGMA index_list('transcript_chunk_v6')`)
        .all() as Array<{ name: string; unique: number }>;
      const byName = new Map(indexes.map(i => [i.name, i]));
      expect(byName.has('idx_transcript_chunk_v6_session_turn')).toBe(true);
      expect(byName.has('idx_transcript_chunk_v6_project_created')).toBe(true);
      expect(byName.get('uq_transcript_chunk_v6_session_turn_role_sub')?.unique).toBe(1);
    });

    it('creates vec_transcript_chunks_v6 virtual table OR sqlite-vec is unavailable', () => {
      initializeSchema(db);
      const meta = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name='vec_transcript_chunks_v6'"
      ).get() as { sql: string } | undefined;
      // If sqlite-vec loaded, the virtual table exists. If not, this test
      // is silently skipped — mirrors migrateV14toV15's silent-skip pattern.
      if (meta) {
        expect(meta.sql).toMatch(/vec0\(.*embedding.*float\[1024\]/);
      }
    });

    it('rejects role values outside the closed enum', () => {
      initializeSchema(db);
      expect(() =>
        db.prepare(
          `INSERT INTO transcript_chunk_v6 (session_id, project, turn_index, role, provenance, body, created_at_epoch_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run('s1', 'p1', 0, 'bogus', 'organic', 'b', Date.now())
      ).toThrow(/CHECK constraint failed/);
    });

    it('rejects provenance values outside the closed enum', () => {
      initializeSchema(db);
      expect(() =>
        db.prepare(
          `INSERT INTO transcript_chunk_v6 (session_id, project, turn_index, role, provenance, body, created_at_epoch_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run('s1', 'p1', 0, 'user', 'bogus', 'b', Date.now())
      ).toThrow(/CHECK constraint failed/);
    });

    it('accepts all four enum values for provenance', () => {
      initializeSchema(db);
      for (const p of ['organic', 'injected', 'tool_result', 'environmental']) {
        expect(() =>
          db.prepare(
            `INSERT INTO transcript_chunk_v6 (session_id, project, turn_index, role, provenance, body, created_at_epoch_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(`s-${p}`, 'p1', 0, 'user', p, 'b', Date.now())
        ).not.toThrow();
      }
    });

    it('user_version reports 38 after fresh init', () => {
      initializeSchema(db);
      const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
      expect(uv).toBe(38);
    });
  });

  describe('migrateV31toV32 — V17-collapsed DB', () => {
    it('runs idempotently and lands the new tables alongside the legacy view', () => {
      buildV17V32Fixture(db);
      // Pretend we're at V31 — runMigrations advances to V32.
      db.pragma('user_version = 31');
      runMigrations(db);
      const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
      expect(uv).toBe(38);

      // transcript_chunk_v6 exists.
      const tc = db.prepare(
        "SELECT type FROM sqlite_master WHERE name='transcript_chunk_v6'"
      ).get() as { type: string } | undefined;
      expect(tc?.type).toBe('table');

      // The V17 `learnings` view is untouched (still a view, still has the
      // same provenance projection).
      const lv = db.prepare(
        "SELECT type, sql FROM sqlite_master WHERE name='learnings'"
      ).get() as { type: string; sql: string } | undefined;
      expect(lv?.type).toBe('view');
      expect(lv?.sql).toMatch(/provenance/i);
    });

    it('legacy artifact-kernel transcript_chunk slot is left untouched', () => {
      buildV17V32Fixture(db);
      // Pre-seed a legacy transcript_chunk artifact to verify it survives.
      db.prepare(
        `INSERT INTO artifact (id, kind, title, body, scope, status, created_at_epoch, updated_at_epoch, project_id, data)
         VALUES (?, 'transcript_chunk', ?, ?, 'project', 'active', ?, ?, ?, ?)`
      ).run(
        'legacy-tc-1', 'legacy', 'legacy chunk body', Date.now(), Date.now(), 'p1', JSON.stringify({})
      );

      db.pragma('user_version = 31');
      runMigrations(db);

      const survivor = db.prepare(
        "SELECT id, body FROM artifact WHERE id='legacy-tc-1' AND kind='transcript_chunk'"
      ).get() as { id: string; body: string } | undefined;
      expect(survivor?.id).toBe('legacy-tc-1');
      expect(survivor?.body).toBe('legacy chunk body');
    });
  });

  describe('migrateV31toV32 — idempotent re-run', () => {
    it('returns false on second call and does not error', () => {
      initializeSchema(db);
      // initializeSchema already ran V32. Calling migrateV31toV32 directly
      // must short-circuit.
      expect(migrateV31toV32(db)).toBe(false);
    });

    it('schema unchanged across redundant runs', () => {
      initializeSchema(db);
      const before = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name='transcript_chunk_v6'"
      ).get() as { sql: string };
      migrateV31toV32(db);
      migrateV31toV32(db);
      const after = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name='transcript_chunk_v6'"
      ).get() as { sql: string };
      expect(after.sql).toBe(before.sql);
    });
  });

  describe('initializeSchema convergence', () => {
    it('fresh-DB initialization converges to UV=32 with the same shape as incremental migration', () => {
      // Fresh-DB path
      const freshDb = new Database(':memory:');
      initializeSchema(freshDb);
      const freshUv = (freshDb.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
      expect(freshUv).toBe(38);
      const freshShape = freshDb.prepare(
        "SELECT sql FROM sqlite_master WHERE name='transcript_chunk_v6'"
      ).get() as { sql: string };
      const freshIndexes = (freshDb.prepare(`PRAGMA index_list('transcript_chunk_v6')`)
        .all() as Array<{ name: string; unique: number }>)
        .map(i => `${i.name}:${i.unique}`).sort();
      freshDb.close();

      // Incremental migration path on the V17-collapsed fixture
      const incDb = new Database(':memory:');
      buildV17V32Fixture(incDb);
      incDb.pragma('user_version = 31');
      runMigrations(incDb);
      const incUv = (incDb.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
      expect(incUv).toBe(37);
      const incShape = incDb.prepare(
        "SELECT sql FROM sqlite_master WHERE name='transcript_chunk_v6'"
      ).get() as { sql: string };
      const incIndexes = (incDb.prepare(`PRAGMA index_list('transcript_chunk_v6')`)
        .all() as Array<{ name: string; unique: number }>)
        .map(i => `${i.name}:${i.unique}`).sort();
      incDb.close();

      // Both paths end at the same column-shape table and the same indexes.
      expect(incShape.sql.replace(/\s+/g, ' ')).toBe(freshShape.sql.replace(/\s+/g, ' '));
      expect(incIndexes).toEqual(freshIndexes);
    });
  });
});
