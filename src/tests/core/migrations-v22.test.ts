/**
 * Tests for the V21→V22 migration (Phase 8.5: recall observability +
 * self-instrumented agent).
 *
 * V22 ships two additive tables:
 *   1. retrieval_log — per-session log of MCP retrieval invocations.
 *   2. session_flag — per-session key/value flags (narration_silent toggle).
 *
 * Both DDLs use IF NOT EXISTS, so this is a strictly additive migration.
 *
 * Verifies:
 *   - Fresh-DB initialization reaches user_version = 22.
 *   - retrieval_log + session_flag exist with the expected shape + index.
 *   - Idempotency: running migrateV21toV22 twice does not throw or duplicate.
 *   - End-to-end insert through recordRetrieval round-trips through
 *     listSessionRetrievals.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { migrateV21toV22 } from '../../core/migration-steps.js';
import { recordRetrieval, listSessionRetrievals } from '../../intelligence/retrieval-log.js';

function getUserVersion(db: Database.Database): number {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

describe('Phase 8.5 V21→V22 migration (retrieval_log + session_flag)', () => {
  it('fresh DB reaches user_version=22', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(getUserVersion(db)).toBe(22);
    db.close();
  });

  it('retrieval_log table exists with expected columns', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const tbl = db.prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='retrieval_log'"
    ).get() as { one: number } | undefined;
    expect(tbl?.one).toBe(1);

    const cols = db.pragma('table_info(retrieval_log)') as Array<{ name: string }>;
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual([
      'id',
      'invoked_at_epoch_ms',
      'query',
      'session_id',
      'surface',
      'token_cost',
      'top_k_results',
      'used_in_output',
    ]);

    db.close();
  });

  it('idx_retrieval_log_session index exists', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const idx = db.prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type='index' AND name='idx_retrieval_log_session'"
    ).get() as { one: number } | undefined;
    expect(idx?.one).toBe(1);

    db.close();
  });

  it('session_flag table exists with PRIMARY KEY (session_id, flag_key)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const tbl = db.prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='session_flag'"
    ).get() as { one: number } | undefined;
    expect(tbl?.one).toBe(1);

    // Two-column PK can't be enforced via a single ROWID PK; SQLite uses a
    // composite PK index instead. Verify by attempting a duplicate insert.
    db.prepare(
      `INSERT INTO session_flag (session_id, flag_key, flag_value, set_at_epoch_ms)
       VALUES (?, ?, ?, ?)`
    ).run('sess-1', 'narration_silent', '1', Date.now());
    expect(() => {
      db.prepare(
        `INSERT INTO session_flag (session_id, flag_key, flag_value, set_at_epoch_ms)
         VALUES (?, ?, ?, ?)`
      ).run('sess-1', 'narration_silent', '1', Date.now());
    }).toThrow();

    db.close();
  });

  it('retrieval_log enforces surface enum CHECK', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => {
      db.prepare(
        `INSERT INTO retrieval_log
           (session_id, invoked_at_epoch_ms, surface, query, top_k_results, used_in_output, token_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('s1', Date.now(), 'made_up_surface', null, '[]', 0, 0);
    }).toThrow();

    db.close();
  });

  it('retrieval_log rejects invalid JSON in top_k_results', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => {
      db.prepare(
        `INSERT INTO retrieval_log
           (session_id, invoked_at_epoch_ms, surface, query, top_k_results, used_in_output, token_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('s1', Date.now(), 'claudex_search', null, 'not-json', 0, 0);
    }).toThrow();

    db.close();
  });

  it('migrateV21toV22 is idempotent — second run does not throw', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => migrateV21toV22(db)).not.toThrow();
    expect(() => migrateV21toV22(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expect(getUserVersion(db)).toBe(22);

    db.close();
  });

  it('end-to-end: recordRetrieval round-trips through listSessionRetrievals', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const id = recordRetrieval(db, {
      sessionId: 'sess-rt',
      surface: 'claudex_search',
      query: 'rate-limit shadowban',
      topKResults: [{ id: 1, source: 'artifacts', score: 0.95 }],
      responseText: 'rate-limit shadowban — Mozzart returns 429 per-IP, 15-min auto-heal',
    });
    expect(id).toBeGreaterThan(0);

    const rows = listSessionRetrievals(db, 'sess-rt');
    expect(rows.length).toBe(1);
    expect(rows[0].surface).toBe('claudex_search');
    expect(rows[0].query).toBe('rate-limit shadowban');
    expect(rows[0].token_cost).toBeGreaterThan(0);
    expect(rows[0].used_in_output).toBe(0);

    db.close();
  });
});
