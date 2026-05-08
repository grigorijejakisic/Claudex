/**
 * Tests for upsertChunk against an in-memory V32 DB.
 *
 * Validates plan 08-01's V32 migration end-to-end (initializeSchema reaches
 * the right shape) AND plan 08-02's exported write surface against real
 * SQLite — never mocks, never `:memory:`-with-default-schema.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { upsertChunk } from '../../ingestion/upsert-chunk.js';
import type { ChunkV6 } from '../../ingestion/transcript-chunker-v6.js';

function baseChunk(overrides: Partial<ChunkV6> = {}): ChunkV6 {
  return {
    session_id: 'sess-1',
    project_id: 'proj-1',
    turn_index: 0,
    sub_index: 0,
    role: 'user',
    provenance: 'organic',
    body: 'A chunk body.',
    created_at_epoch_ms: 1700000000000,
    wrapper_redacted: false,
    ...overrides,
  };
}

describe('upsertChunk against V32 DB', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });
  afterEach(() => { db.close(); });

  it('writes a chunk that round-trips through transcript_chunk_v6', () => {
    upsertChunk(db, baseChunk());
    const row = db.prepare(
      `SELECT * FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-1') as ChunkV6 & { id: number };
    expect(row).toBeDefined();
    expect(row.body).toBe('A chunk body.');
    expect(row.role).toBe('user');
    expect(row.provenance).toBe('organic');
    expect(row.wrapper_redacted as unknown as number).toBe(0);
  });

  it('inserting the same chunk twice is idempotent (ON CONFLICT DO NOTHING)', () => {
    const c = baseChunk();
    upsertChunk(db, c);
    upsertChunk(db, c);
    const count = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-1') as { cnt: number }).cnt;
    expect(count).toBe(1);
  });

  it('two chunks with same (session_id, turn_index, role) but different sub_index both persist', () => {
    upsertChunk(db, baseChunk({ sub_index: 0 }));
    upsertChunk(db, baseChunk({ sub_index: 1, body: 'second sub-chunk' }));
    const rows = db.prepare(
      `SELECT sub_index, body FROM transcript_chunk_v6 WHERE session_id = ? ORDER BY sub_index`
    ).all('sess-1') as Array<{ sub_index: number; body: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0].sub_index).toBe(0);
    expect(rows[1].sub_index).toBe(1);
    expect(rows[1].body).toBe('second sub-chunk');
  });

  it('rejects bogus provenance values (closed-enum CHECK)', () => {
    expect(() =>
      upsertChunk(db, baseChunk({ provenance: 'bogus' as ChunkV6['provenance'] }))
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects bogus role values (closed-enum CHECK)', () => {
    expect(() =>
      upsertChunk(db, baseChunk({ role: 'bogus' as ChunkV6['role'] }))
    ).toThrow(/CHECK constraint failed/);
  });

  it('wrapper_redacted=true round-trips as 1', () => {
    upsertChunk(db, baseChunk({ session_id: 'sess-redacted', wrapper_redacted: true }));
    const row = db.prepare(
      `SELECT wrapper_redacted FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-redacted') as { wrapper_redacted: number };
    expect(row.wrapper_redacted).toBe(1);
  });

  it('wrapper_redacted=false round-trips as 0', () => {
    upsertChunk(db, baseChunk({ session_id: 'sess-clean', wrapper_redacted: false }));
    const row = db.prepare(
      `SELECT wrapper_redacted FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-clean') as { wrapper_redacted: number };
    expect(row.wrapper_redacted).toBe(0);
  });

  it('1000-chunk insertion completes under 1 second (cachedPrepare regression guard)', () => {
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      upsertChunk(db, baseChunk({
        session_id: 'bulk',
        turn_index: i,
        body: `body ${i}`,
      }));
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    const count = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = 'bulk'`
    ).get() as { cnt: number }).cnt;
    expect(count).toBe(1000);
  });

  it('persists all four valid provenance values', () => {
    const provenances: Array<ChunkV6['provenance']> = [
      'organic', 'injected', 'tool_result', 'environmental',
    ];
    provenances.forEach((p, i) => {
      upsertChunk(db, baseChunk({
        session_id: `s-${p}`,
        turn_index: i,
        provenance: p,
      }));
    });
    const rows = db.prepare(
      `SELECT provenance FROM transcript_chunk_v6 WHERE session_id LIKE 's-%' ORDER BY id`
    ).all() as Array<{ provenance: string }>;
    expect(rows.map(r => r.provenance)).toEqual(provenances);
  });

  it('persists all four valid role values', () => {
    const roles: Array<ChunkV6['role']> = ['user', 'assistant', 'tool', 'system'];
    roles.forEach((role, i) => {
      upsertChunk(db, baseChunk({
        session_id: `r-${role}`,
        turn_index: i,
        role,
      }));
    });
    const rows = db.prepare(
      `SELECT role FROM transcript_chunk_v6 WHERE session_id LIKE 'r-%' ORDER BY id`
    ).all() as Array<{ role: string }>;
    expect(rows.map(r => r.role)).toEqual(roles);
  });
});
