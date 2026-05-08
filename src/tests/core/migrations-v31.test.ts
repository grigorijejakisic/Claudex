/**
 * Tests for the V30→V31 migration (v5.0.1 hot-fix: close the V17 view-mode
 * learnings.provenance gap that V30 left open).
 *
 * V30 added `learnings.provenance` via ALTER TABLE, which works on base-table
 * DBs but is silently skipped on V17-collapsed DBs where `learnings` is a
 * view over the `artifact` kernel. V31 lands the view-mode equivalent:
 * rebuilt view with provenance projection + INSTEAD OF triggers that accept
 * NEW.provenance and persist into artifact.data JSON, plus backfill.
 *
 * Verifies:
 *   - TARGET_USER_VERSION is 31
 *   - Fresh-DB initialization (base-table path) still has provenance + UV=31
 *   - V17 view-mode fixture: V31 rebuilds the view to expose `provenance`
 *   - V17 view-mode fixture: INSERT INTO learnings (..., provenance) succeeds
 *     after V31 (the exact production failure pre-V31)
 *   - V17 view-mode fixture: provenance round-trips through view → artifact
 *     data JSON → view
 *   - V17 view-mode fixture: closed-enum CHECK rejects out-of-enum provenance
 *   - V17 view-mode fixture: backfill populates 'organic' for pre-existing
 *     learning artifacts whose data JSON lacks the field
 *   - migrateV30toV31 is idempotent (second call no-op on rebuilt view)
 *   - UPDATE that doesn't touch provenance preserves the existing value
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations, TARGET_USER_VERSION } from '../../core/migrations.js';
import { migrateV30toV31 } from '../../core/migration-steps.js';

/**
 * Build a minimal V17-collapsed DB shape: artifact kernel table, legacy_id_map,
 * and the pre-V31 learnings view + 3 INSTEAD OF triggers (no provenance carry).
 * Mirrors what an existing production install looks like before V31 runs.
 */
function buildV17ViewModeFixture(db: Database.Database): void {
  db.exec(`
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
      CAST(json_extract(artifact.data, '$.agent_id') AS TEXT) AS agent_id,
      CAST(json_extract(artifact.data, '$.fingerprint') AS TEXT) AS fingerprint,
      artifact.body AS content,
      CAST(json_extract(artifact.data, '$.promotion_count') AS INTEGER) AS promotion_count,
      CAST(json_extract(artifact.data, '$.first_seen_epoch') AS INTEGER) AS first_seen_epoch,
      CAST(json_extract(artifact.data, '$.last_promoted_epoch') AS INTEGER) AS last_promoted_epoch,
      CAST(artifact.updated_at_epoch / 1000 AS INTEGER) AS updated_at_epoch
    FROM artifact
    WHERE kind = 'learning'
    ORDER BY created_at_epoch;

    CREATE TRIGGER learnings_instead_insert INSTEAD OF INSERT ON learnings
    BEGIN
      INSERT INTO artifact(
        id, kind, title, body, scope, status, confidence,
        created_at_epoch, updated_at_epoch, session_id, project_id, data
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
          'promotion_count', NEW.promotion_count,
          'first_seen_epoch', NEW.first_seen_epoch,
          'last_promoted_epoch', NEW.last_promoted_epoch
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
    END;

    CREATE TRIGGER learnings_instead_update INSTEAD OF UPDATE ON learnings
    BEGIN
      UPDATE artifact SET
        project_id = NEW.project,
        body = NEW.content,
        updated_at_epoch = NEW.updated_at_epoch * 1000,
        data = json_set(json_set(json_set(json_set(json_set(data, '$.agent_id', NEW.agent_id), '$.fingerprint', NEW.fingerprint), '$.promotion_count', NEW.promotion_count), '$.first_seen_epoch', NEW.first_seen_epoch), '$.last_promoted_epoch', NEW.last_promoted_epoch),
        updated_at_epoch = unixepoch() * 1000
      WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = 'learnings' AND legacy_id = OLD.id);
    END;

    CREATE TRIGGER learnings_instead_delete INSTEAD OF DELETE ON learnings
    BEGIN
      DELETE FROM artifact
        WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = 'learnings' AND legacy_id = OLD.id)
          AND kind = 'learning';
      DELETE FROM legacy_id_map
        WHERE legacy_table = 'learnings' AND legacy_id = OLD.id;
    END;
  `);
}

describe('V30→V31 migration (V17 view-mode learnings.provenance close)', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('TARGET_USER_VERSION is 31', () => {
    expect(TARGET_USER_VERSION).toBe(31);
  });

  it('fresh-DB initialization (base-table path) still has provenance + UV=31', () => {
    initializeSchema(db);
    const meta = db.prepare(
      "SELECT type FROM sqlite_master WHERE name='learnings'"
    ).get() as { type: string };
    expect(meta.type).toBe('table');
    const cols = db.prepare(`PRAGMA table_info(learnings)`).all() as Array<{ name: string }>;
    expect(cols.find(c => c.name === 'provenance')).toBeDefined();
    const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(uv).toBe(31);
  });

  it('migrateV30toV31 is no-op on base-table DBs (returns false)', () => {
    initializeSchema(db);
    expect(migrateV30toV31(db)).toBe(false);
  });

  it('V17 view-mode fixture: pre-V31 INSERT with provenance fails (regression baseline)', () => {
    buildV17ViewModeFixture(db);
    expect(() =>
      db.prepare(
        `INSERT INTO learnings (project, agent_id, fingerprint, content, provenance) VALUES (?, ?, ?, ?, ?)`
      ).run('p', 'default', 'fp-pre', 'c', 'organic')
    ).toThrow(/no column.*provenance/i);
  });

  it('V17 view-mode fixture: V31 rebuilds the view to expose `provenance`', () => {
    buildV17ViewModeFixture(db);
    expect(migrateV30toV31(db)).toBe(true);
    const cols = db.prepare(`PRAGMA table_info(learnings)`).all() as Array<{ name: string }>;
    expect(cols.find(c => c.name === 'provenance')).toBeDefined();
  });

  it('V17 view-mode fixture: post-V31 INSERT with provenance succeeds and persists', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    db.prepare(
      `INSERT INTO learnings (project, agent_id, fingerprint, content, provenance) VALUES (?, ?, ?, ?, ?)`
    ).run('test-project', 'default', 'fp-post', 'a learning', 'organic');
    const row = db.prepare(
      `SELECT provenance FROM learnings WHERE fingerprint = 'fp-post'`
    ).get() as { provenance: string };
    expect(row.provenance).toBe('organic');
    // Verify it actually landed in the artifact.data JSON, not a phantom default.
    const artifact = db.prepare(
      `SELECT json_extract(data, '$.provenance') AS p FROM artifact WHERE kind='learning' AND json_extract(data, '$.fingerprint') = 'fp-post'`
    ).get() as { p: string };
    expect(artifact.p).toBe('organic');
  });

  it('V17 view-mode fixture: INSERT without provenance defaults to organic', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    db.prepare(
      `INSERT INTO learnings (project, agent_id, fingerprint, content) VALUES (?, ?, ?, ?)`
    ).run('p', 'default', 'fp-default', 'c');
    const row = db.prepare(
      `SELECT provenance FROM learnings WHERE fingerprint = 'fp-default'`
    ).get() as { provenance: string };
    expect(row.provenance).toBe('organic');
  });

  it('V17 view-mode fixture: closed-enum guard rejects out-of-enum provenance', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    expect(() =>
      db.prepare(
        `INSERT INTO learnings (project, agent_id, fingerprint, content, provenance) VALUES (?, ?, ?, ?, ?)`
      ).run('p', 'default', 'fp-bad', 'c', 'bogus')
    ).toThrow(/CHECK constraint failed.*provenance/i);
  });

  it('V17 view-mode fixture: closed-enum guard accepts all four enum values', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    for (const p of ['organic', 'injected', 'tool_result', 'environmental']) {
      expect(() =>
        db.prepare(
          `INSERT INTO learnings (project, agent_id, fingerprint, content, provenance) VALUES (?, ?, ?, ?, ?)`
        ).run('p', 'default', `fp-${p}`, 'c', p)
      ).not.toThrow();
    }
  });

  it('V17 view-mode fixture: backfill populates organic for pre-existing rows', () => {
    buildV17ViewModeFixture(db);
    // Seed an artifact-of-kind-learning that lacks provenance in its JSON
    // (mirrors the 191 production rows pre-fix).
    db.prepare(
      `INSERT INTO artifact (id, kind, title, body, scope, status, created_at_epoch, updated_at_epoch, project_id, data)
       VALUES (?, 'learning', ?, ?, 'project', 'active', ?, ?, ?, ?)`
    ).run(
      'pre-fix-id-1',
      'pre',
      'pre-fix learning content',
      Date.now(),
      Date.now(),
      'test-project',
      JSON.stringify({ agent_id: 'default', fingerprint: 'fp-prefix', promotion_count: 1 })
    );
    db.prepare(
      `INSERT INTO legacy_id_map (legacy_table, legacy_id, new_uuid) VALUES ('learnings', 1, 'pre-fix-id-1')`
    ).run();

    // Confirm pre-state: no provenance in JSON.
    const before = db.prepare(
      `SELECT json_extract(data, '$.provenance') AS p FROM artifact WHERE id='pre-fix-id-1'`
    ).get() as { p: string | null };
    expect(before.p).toBeNull();

    migrateV30toV31(db);

    // Post-state: provenance backfilled to 'organic'.
    const after = db.prepare(
      `SELECT json_extract(data, '$.provenance') AS p FROM artifact WHERE id='pre-fix-id-1'`
    ).get() as { p: string };
    expect(after.p).toBe('organic');

    // And the view exposes it.
    const viewRow = db.prepare(
      `SELECT provenance FROM learnings WHERE fingerprint = 'fp-prefix'`
    ).get() as { provenance: string };
    expect(viewRow.provenance).toBe('organic');
  });

  it('V17 view-mode fixture: migrateV30toV31 is idempotent (second call returns false)', () => {
    buildV17ViewModeFixture(db);
    expect(migrateV30toV31(db)).toBe(true);
    expect(migrateV30toV31(db)).toBe(false);
  });

  it('V17 view-mode fixture: UPDATE without touching provenance preserves it', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    db.prepare(
      `INSERT INTO learnings (project, agent_id, fingerprint, content, provenance) VALUES (?, ?, ?, ?, ?)`
    ).run('p', 'default', 'fp-keep', 'c', 'tool_result');
    const id = (db.prepare(`SELECT id FROM learnings WHERE fingerprint='fp-keep'`).get() as { id: number }).id;
    // UPDATE that does not set provenance — current learnings.ts code path
    // does this on conflict-resolution UPDATEs.
    db.prepare(
      `UPDATE learnings SET content = ? WHERE id = ?`
    ).run('updated content', id);
    const row = db.prepare(
      `SELECT provenance, content FROM learnings WHERE id = ?`
    ).get(id) as { provenance: string; content: string };
    expect(row.provenance).toBe('tool_result');
    expect(row.content).toBe('updated content');
  });

  it('runMigrations on existing-V30-view DB advances to UV=31', () => {
    buildV17ViewModeFixture(db);
    db.pragma('user_version = 30');
    runMigrations(db);
    const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(uv).toBe(31);
    const cols = db.prepare(`PRAGMA table_info(learnings)`).all() as Array<{ name: string }>;
    expect(cols.find(c => c.name === 'provenance')).toBeDefined();
  });
});
