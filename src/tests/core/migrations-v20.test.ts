/**
 * Tests for the V19→V20 migration (Phase 6 P5: telemetry CHECK enum extension).
 *
 * V20 adds 'reranker_fallback' to the telemetry.event_kind enum so the
 * Phase 6 reranker hard-required visibility surface (Plan 04) can record
 * cross-encoder→bi-encoder fallback events. The migration is additive only
 * — no existing kind is removed and no row is altered.
 *
 * Verifies:
 *   - Fresh-DB initialization reaches user_version = 20.
 *   - Inserting `event_kind='reranker_fallback'` succeeds post-migration.
 *   - All ten pre-V20 event_kinds remain accepted.
 *   - A bogus event_kind still fails the CHECK (negative test).
 *   - V19→V20 upgrade preserves existing telemetry rows verbatim.
 *   - runMigrations is idempotent on a V20 DB.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';

function getUserVersion(db: Database.Database): number {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

describe('Phase 6 V19→V20 migration (telemetry +reranker_fallback)', () => {
  it('fresh DB reaches user_version=20 with telemetry table present', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(getUserVersion(db)).toBe(20);

    const t = db.prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='telemetry'"
    ).get() as { one: number } | undefined;
    expect(t?.one).toBe(1);

    db.close();
  });

  it('inserting event_kind=reranker_fallback succeeds post-migration', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => {
      db.prepare(
        `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        'sess-test-1',
        'reranker_fallback',
        JSON.stringify({ reason: 'cross-encoder unreachable', port: 7439 }),
        12.5,
        'hybrid-retrieval',
      );
    }).not.toThrow();

    const row = db.prepare(
      `SELECT event_kind, adapter FROM telemetry WHERE session_id='sess-test-1'`
    ).get() as { event_kind: string; adapter: string };
    expect(row.event_kind).toBe('reranker_fallback');
    expect(row.adapter).toBe('hybrid-retrieval');

    db.close();
  });

  it('all ten pre-V20 event_kinds remain accepted', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const kinds = [
      'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
      'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
    ];
    const stmt = db.prepare(
      `INSERT INTO telemetry (session_id, event_kind) VALUES (?, ?)`
    );
    for (const k of kinds) {
      expect(() => stmt.run('sess-pre-v20', k)).not.toThrow();
    }

    const c = (db.prepare(
      `SELECT COUNT(*) AS c FROM telemetry WHERE session_id='sess-pre-v20'`
    ).get() as { c: number }).c;
    expect(c).toBe(kinds.length);

    db.close();
  });

  it('bogus event_kind still fails the CHECK constraint (negative test)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => {
      db.prepare(
        `INSERT INTO telemetry (session_id, event_kind) VALUES (?, ?)`
      ).run('sess-neg', 'totally_made_up_kind');
    }).toThrow();

    db.close();
  });

  it('V19→V20 upgrade preserves all existing telemetry rows', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    // Seed a V20 DB with rows under several pre-V20 kinds.
    const seedStmt = db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
       VALUES (?, ?, ?, ?, ?)`
    );
    seedStmt.run('sess-A', 'hook_invocation', '{"hook":"start"}', 1.5, 'cc-hooks');
    seedStmt.run('sess-A', 'injection',       '{"size":42}',     2.0, 'cc-hooks');
    seedStmt.run('sess-B', 'enrichment',      '{}',              3.0, 'angel');
    seedStmt.run('sess-B', 'error',           '{"msg":"x"}',     4.0, 'angel');

    // Snapshot then demote to V19 to simulate a V19 DB at open time.
    const before = db.prepare(
      `SELECT id, session_id, event_kind, detail, latency_ms, adapter
         FROM telemetry ORDER BY id ASC`
    ).all();
    expect(before.length).toBe(4);

    db.pragma('user_version = 19');

    // Re-promote — runMigrations should rebuild telemetry with the V20 enum
    // and copy every row verbatim.
    runMigrations(db);

    expect(getUserVersion(db)).toBe(20);

    const after = db.prepare(
      `SELECT id, session_id, event_kind, detail, latency_ms, adapter
         FROM telemetry ORDER BY id ASC`
    ).all();
    expect(after).toEqual(before);

    // Old rows survive AND the new kind is now accepted.
    expect(() => {
      db.prepare(`INSERT INTO telemetry (session_id, event_kind) VALUES (?, ?)`)
        .run('sess-C', 'reranker_fallback');
    }).not.toThrow();

    db.close();
  });

  it('runMigrations is idempotent on a V20 DB (no churn, no demotion)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(getUserVersion(db)).toBe(20);

    expect(() => runMigrations(db)).not.toThrow();
    expect(getUserVersion(db)).toBe(20);

    expect(() => initializeSchema(db)).not.toThrow();
    expect(getUserVersion(db)).toBe(20);

    // No `telemetry_v19` left behind by an idempotent re-run.
    const stale = db.prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='telemetry_v19'"
    ).get() as { one: number } | undefined;
    expect(stale).toBeUndefined();

    db.close();
  });
});
