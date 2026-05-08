/**
 * Live-wiring test for the learnings write path against a V17-collapsed DB
 * fixture. Closes the test gap that let v5.0.0 ship with a silently-broken
 * Phase 7 MIG-02: integration tests in `phase-7-learnings-provenance.test.ts`
 * exercised a `:memory:` DB that took the base-table path, never the V17
 * view-mode path that production runs on.
 *
 * This test runs the actual `upsertLearning` function (the function called
 * from `captureInsightsAsLearnings` in the Stop hook) against a V17-collapsed
 * fixture. Pre-V31, this exact call silently failed with
 *   "table learnings has no column named provenance"
 * Post-V31, it should write through the rebuilt INSTEAD OF triggers and the
 * provenance value should round-trip via the view.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { upsertLearning, getLearningsByProject } from '../../core/learnings.js';
import { migrateV30toV31 } from '../../core/migration-steps.js';

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
  `);
}

describe('Learnings write path — V17 view-mode wiring (regression for v5.0.0 silent-fail)', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('pre-V31 baseline: upsertLearning throws against unmigrated V17 view (regression)', () => {
    buildV17ViewModeFixture(db);
    expect(() =>
      upsertLearning(db, {
        project: 'wiring-test',
        agent_id: 'default',
        fingerprint: 'pre-v31-wiring-fp',
        content: 'pre-V31 should fail to insert',
        provenance: 'organic',
      })
    ).toThrow(/no column.*provenance/i);
  });

  it('post-V31: upsertLearning succeeds against V17 view-mode DB', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    expect(() =>
      upsertLearning(db, {
        project: 'wiring-test',
        agent_id: 'default',
        fingerprint: 'post-v31-wiring-fp',
        content: 'post-V31 lands a real learning',
        provenance: 'organic',
      })
    ).not.toThrow();
  });

  it('post-V31: written learning is readable through getLearningsByProject', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    upsertLearning(db, {
      project: 'wiring-test',
      agent_id: 'default',
      fingerprint: 'roundtrip-fp',
      content: 'roundtrip content',
      provenance: 'organic',
    });
    const rows = getLearningsByProject(db, 'wiring-test');
    expect(rows.length).toBe(1);
    expect(rows[0].fingerprint).toBe('roundtrip-fp');
    expect(rows[0].content).toBe('roundtrip content');
    expect(rows[0].provenance).toBe('organic');
  });

  it('post-V31: provenance defaults to organic when caller omits it', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    upsertLearning(db, {
      project: 'wiring-test',
      agent_id: 'default',
      fingerprint: 'no-provenance-arg-fp',
      content: 'caller did not specify provenance',
    });
    const rows = getLearningsByProject(db, 'wiring-test');
    expect(rows[0].provenance).toBe('organic');
  });

  it('post-V31: closed-enum guard rejects out-of-enum value via upsertLearning', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    expect(() =>
      upsertLearning(db, {
        project: 'wiring-test',
        agent_id: 'default',
        fingerprint: 'bad-prov-fp',
        content: 'bad provenance',
        provenance: 'bogus' as never,
      })
    ).toThrow(/CHECK constraint failed.*provenance/i);
  });

  it('post-V31: ON CONFLICT promotion does not clobber provenance', () => {
    buildV17ViewModeFixture(db);
    migrateV30toV31(db);
    // First insert: tool_result provenance
    upsertLearning(db, {
      project: 'wiring-test',
      agent_id: 'default',
      fingerprint: 'conflict-fp',
      content: 'first version',
      provenance: 'tool_result',
    });
    // Second insert with same fingerprint — should hit ON CONFLICT and bump
    // promotion_count without rewriting provenance.
    upsertLearning(db, {
      project: 'wiring-test',
      agent_id: 'default',
      fingerprint: 'conflict-fp',
      content: 'second version',
      provenance: 'organic',
    });
    const rows = getLearningsByProject(db, 'wiring-test');
    expect(rows.length).toBe(1);
    expect(rows[0].provenance).toBe('tool_result');
    expect(rows[0].promotion_count).toBe(2);
  });
});
