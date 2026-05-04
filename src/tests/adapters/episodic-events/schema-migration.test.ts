/**
 * Phase 1 Plan 01 — V25 episode substrate schema migration tests.
 *
 * Covers:
 *   - episodic_events table shape (13 columns, 4 indexes, 1 CHECK constraint)
 *   - closed-enum provenance enforcement
 *   - migration idempotency
 *   - legacy conversation_turns preservation
 *   - schema_version default + content_hash NOT NULL + parent_event_id self-reference
 *
 * EPI-01, EPI-02, EPI-06.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations, TARGET_USER_VERSION } from '../../../core/migrations.js';

const EXPECTED_COLUMNS = [
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

const EXPECTED_INDEXES = [
  'idx_epev_session_turn_ts',
  'idx_epev_project_ts',
  'idx_epev_provenance',
  'idx_epev_parent',
];

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function insertEvent(provenance: string, opts: Partial<Record<string, unknown>> = {}): number {
  const stmt = db.prepare(
    `INSERT INTO episodic_events
       (session_id, project, turn_number, type, source, content, provenance, parent_event_id, content_hash, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    opts.session_id ?? 'sess-A',
    opts.project ?? 'proj',
    opts.turn_number ?? null,
    opts.type ?? 'user_prompt',
    opts.source ?? 'cc-hooks/test',
    opts.content ?? 'hello',
    provenance,
    opts.parent_event_id ?? null,
    opts.content_hash ?? 'deadbeef',
    opts.metadata_json ?? null,
  );
  return Number(info.lastInsertRowid);
}

describe('Phase 1 Plan 01 — episodic_events V25 migration (EPI-01, EPI-02, EPI-06)', () => {
  it('EPI-01: fresh DB has the episodic_events table with the exact 13-column set in order', () => {
    const cols = (db.pragma('table_info(episodic_events)') as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(EXPECTED_COLUMNS);
  });

  it('EPI-01: all four idx_epev_* indexes are present', () => {
    const indexes = (db.pragma('index_list(episodic_events)') as Array<{ name: string }>)
      .map(i => i.name)
      .filter(n => n.startsWith('idx_epev_'));
    for (const expected of EXPECTED_INDEXES) {
      expect(indexes).toContain(expected);
    }
  });

  it('EPI-02: provenance CHECK constraint rejects values outside the closed enum', () => {
    expect(() => insertEvent('organis')).toThrow(/CHECK/i);
  });

  it('EPI-02: provenance CHECK constraint accepts each of the four enum values', () => {
    for (const value of ['organic', 'injected', 'tool_result', 'environmental']) {
      expect(() => insertEvent(value)).not.toThrow();
    }
    const counts = db.prepare('SELECT provenance, COUNT(*) AS c FROM episodic_events GROUP BY provenance').all() as Array<{ provenance: string; c: number }>;
    expect(counts).toHaveLength(4);
  });

  it('EPI-01: re-running migrations on an already-V25 DB is a no-op (idempotent)', () => {
    insertEvent('organic', { content: 'pre-existing row' });
    const before = (db.prepare('SELECT COUNT(*) AS c FROM episodic_events').get() as { c: number }).c;
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => initializeSchema(db)).not.toThrow();
    const after = (db.prepare('SELECT COUNT(*) AS c FROM episodic_events').get() as { c: number }).c;
    expect(after).toBe(before);
    const cols = (db.pragma('table_info(episodic_events)') as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(EXPECTED_COLUMNS);
  });

  it('EPI-06: legacy conversation_turns table is unmodified by V25 migration (column shape preserved)', () => {
    db.prepare('INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text) VALUES (?, ?, ?, ?, ?)')
      .run('sess-leg', 'proj', 0, 'raw user prompt', 'asst response');
    runMigrations(db);
    const row = db.prepare('SELECT user_text, assistant_text FROM conversation_turns WHERE session_id=?').get('sess-leg') as { user_text: string; assistant_text: string };
    expect(row.user_text).toBe('raw user prompt');
    expect(row.assistant_text).toBe('asst response');

    const ctCols = (db.pragma('table_info(conversation_turns)') as Array<{ name: string }>).map(c => c.name);
    expect(ctCols).toEqual([
      'id',
      'session_id',
      'project',
      'turn_number',
      'user_text',
      'assistant_text',
      'timestamp_epoch',
      'embedding',
    ]);
  });

  it('EPI-01: schema_version defaults to 1 when not specified', () => {
    const id = insertEvent('organic');
    const row = db.prepare('SELECT schema_version FROM episodic_events WHERE id=?').get(id) as { schema_version: number };
    expect(row.schema_version).toBe(1);
  });

  it('EPI-01: parent_event_id is nullable and self-referencing across rows', () => {
    const parentId = insertEvent('organic', { content: 'parent prompt', turn_number: 0 });
    expect(() => insertEvent('injected', { content: 'wrapper body', turn_number: 0, parent_event_id: parentId })).not.toThrow();
    const child = db.prepare('SELECT parent_event_id FROM episodic_events WHERE provenance=?').get('injected') as { parent_event_id: number };
    expect(child.parent_event_id).toBe(parentId);
  });

  it('EPI-01: content_hash is required (NOT NULL constraint)', () => {
    const stmt = db.prepare(
      `INSERT INTO episodic_events (session_id, project, type, source, content, provenance, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() => stmt.run('sess', 'proj', 'user_prompt', 'cc-hooks/test', 'x', 'organic', null)).toThrow(/NOT NULL/i);
  });

  it('EPI-01: PRAGMA user_version reaches V25 (TARGET_USER_VERSION)', () => {
    expect(TARGET_USER_VERSION).toBe(25);
    const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version;
    expect(uv).toBe(25);
  });
});
