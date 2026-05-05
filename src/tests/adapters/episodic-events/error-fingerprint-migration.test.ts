/**
 * Phase 2 Plan 01 — V26 error-fingerprint sidecar migration tests.
 *
 * Covers:
 *   - episodic_index_error_fingerprint table shape (7 columns, 3 indexes,
 *     1 CHECK constraint, 1 FK declaration)
 *   - closed-enum corpus_origin enforcement
 *   - V26 migration idempotency
 *   - Phase 1 V25 episodic_events shape preserved (no ALTER TABLE)
 *
 * IDX-01.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../../core/migrations.js';

const SIDECAR_TABLE = 'episodic_index_error_fingerprint';

const EXPECTED_SIDECAR_COLUMNS = [
  'id',
  'shingle_hash',
  'episode_event_id',
  'ts_epoch',
  'project',
  'corpus_origin',
  'schema_version',
];

const EXPECTED_SIDECAR_INDEXES = [
  'idx_epev_efp_shingle',
  'idx_epev_efp_event',
  'idx_epev_efp_project_ts',
];

const EPISODIC_EVENTS_V25_COLUMNS = [
  'id',
  'session_id',
  'project',
  'ts_epoch',
  'turn_number',
  'type',
  'source',
  'content',
  'provenance',
  'parent_event_id',
  'content_hash',
  'metadata_json',
  'schema_version',
];

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function insertEpisodicEvent(): number {
  const stmt = db.prepare(
    `INSERT INTO episodic_events
       (session_id, project, turn_number, type, source, content, provenance, parent_event_id, content_hash, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    'sess-A',
    'proj',
    1,
    'tool_result',
    'PostToolUse',
    'TypeError: foo',
    'tool_result',
    null,
    'deadbeef',
    null,
  );
  return Number(info.lastInsertRowid);
}

function insertSidecarRow(
  parentId: number,
  corpusOrigin: string,
  shingleHash: string = 'abc123',
): number {
  const info = db
    .prepare(
      `INSERT INTO ${SIDECAR_TABLE}
         (shingle_hash, episode_event_id, ts_epoch, project, corpus_origin)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(shingleHash, parentId, 1746316800, 'proj', corpusOrigin);
  return Number(info.lastInsertRowid);
}

describe('Phase 2 Plan 01 — episodic_index_error_fingerprint V26 migration (IDX-01)', () => {
  it('IDX-01: fresh DB has the sidecar table with the exact 7-column set in order', () => {
    const cols = (
      db.pragma(`table_info(${SIDECAR_TABLE})`) as Array<{ name: string }>
    ).map(c => c.name);
    expect(cols).toEqual(EXPECTED_SIDECAR_COLUMNS);
  });

  it('IDX-01: all three idx_epev_efp_* indexes are present', () => {
    const indexes = (
      db.pragma(`index_list(${SIDECAR_TABLE})`) as Array<{ name: string }>
    )
      .map(i => i.name)
      .filter(n => n.startsWith('idx_epev_efp_'))
      .sort();
    const expected = [...EXPECTED_SIDECAR_INDEXES].sort();
    expect(indexes).toEqual(expected);
  });

  it('IDX-01: CHECK constraint rejects an unknown corpus_origin enum value', () => {
    const parentId = insertEpisodicEvent();
    expect(() => insertSidecarRow(parentId, 'phase2_synthetic')).toThrowError(/CHECK/i);
  });

  it('IDX-04 (V27): CHECK constraint accepts the three-tier corpus_origin set', () => {
    // Phase 2.1 (CONTEXT.md decision 1c) widened the CHECK constraint via
    // V26→V27 migration. The legacy 'phase1_organic' tier is no longer
    // accepted; the three accepted values are v4_backfill +
    // phase1_organic_pre_phase2_close + phase1_organic_post_phase2_close.
    const parentId = insertEpisodicEvent();
    expect(() => insertSidecarRow(parentId, 'v4_backfill', 'h1')).not.toThrow();
    expect(() => insertSidecarRow(parentId, 'phase1_organic_pre_phase2_close', 'h2')).not.toThrow();
    expect(() => insertSidecarRow(parentId, 'phase1_organic_post_phase2_close', 'h3')).not.toThrow();
    // Legacy value rejected post-V27.
    expect(() => insertSidecarRow(parentId, 'phase1_organic', 'h4')).toThrowError(/CHECK/i);
  });

  it('IDX-01: re-running migrations on a V26 DB is a no-op (idempotent)', () => {
    const before = (
      db.pragma(`table_info(${SIDECAR_TABLE})`) as Array<{ name: string }>
    ).length;
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    const after = (
      db.pragma(`table_info(${SIDECAR_TABLE})`) as Array<{ name: string }>
    ).length;
    expect(after).toBe(before);
    const indexCount = (
      db.pragma(`index_list(${SIDECAR_TABLE})`) as Array<{ name: string }>
    )
      .map(i => i.name)
      .filter(n => n.startsWith('idx_epev_efp_')).length;
    expect(indexCount).toBe(EXPECTED_SIDECAR_INDEXES.length);
  });

  it('IDX-01: episodic_events V25 13-column shape unchanged after V26', () => {
    const cols = (
      db.pragma('table_info(episodic_events)') as Array<{ name: string }>
    ).map(c => c.name);
    expect(cols).toEqual(EPISODIC_EVENTS_V25_COLUMNS);
  });

  it('IDX-01: schema_version defaults to 1 when omitted on insert', () => {
    const parentId = insertEpisodicEvent();
    insertSidecarRow(parentId, 'phase1_organic_pre_phase2_close', 'sv-default');
    const row = db
      .prepare(
        `SELECT schema_version FROM ${SIDECAR_TABLE} WHERE shingle_hash = ?`,
      )
      .get('sv-default') as { schema_version: number };
    expect(row.schema_version).toBe(1);
  });

  it('IDX-01: shingle_hash and episode_event_id are NOT NULL', () => {
    const parentId = insertEpisodicEvent();
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${SIDECAR_TABLE}
             (shingle_hash, episode_event_id, ts_epoch, project, corpus_origin)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(null, parentId, 1746316800, 'proj', 'phase1_organic_pre_phase2_close'),
    ).toThrowError(/NOT NULL/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${SIDECAR_TABLE}
             (shingle_hash, episode_event_id, ts_epoch, project, corpus_origin)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('hashX', null, 1746316800, 'proj', 'phase1_organic_pre_phase2_close'),
    ).toThrowError(/NOT NULL/i);
  });

  it('IDX-01: foreign_key_list reports a reference to episodic_events(id)', () => {
    const fks = db.pragma(`foreign_key_list(${SIDECAR_TABLE})`) as Array<{
      table: string;
      from: string;
      to: string;
    }>;
    const ref = fks.find(
      fk => fk.table === 'episodic_events' && fk.from === 'episode_event_id' && fk.to === 'id',
    );
    expect(ref).toBeDefined();
  });
});
