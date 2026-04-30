/**
 * Tests for the V20→V21 migration (Phase 6.5: cross-project task-pattern recall).
 *
 * V21 ships two additive changes:
 *   1. CREATE TABLE artifact_task_pattern (sidecar; PK on artifact_id) + index.
 *   2. Telemetry CHECK enum gains 'cross_project_ambiguous' and
 *      'cross_project_query_expansion'.
 *
 * SQLite cannot ALTER a CHECK constraint, so the rebuild-and-copy pattern
 * from V19→V20 is reused for the telemetry rebuild. The sidecar is purely
 * additive (new table, no rebuild needed).
 *
 * Verifies:
 *   - Fresh-DB initialization reaches user_version = 21.
 *   - artifact_task_pattern table exists with correct columns + index.
 *   - telemetry accepts 'cross_project_ambiguous' and
 *     'cross_project_query_expansion' post-migration.
 *   - Idempotency on a V21 DB.
 *   - V19→V20→V21 chain preserves rows.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';

function getUserVersion(db: Database.Database): number {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

describe('Phase 6.5 V20→V21 migration (artifact_task_pattern + telemetry +cross_project_*)', () => {
  it('fresh DB reaches user_version=21 with sidecar + telemetry tables present', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(getUserVersion(db)).toBe(24);

    const sidecar = db.prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='artifact_task_pattern'"
    ).get() as { one: number } | undefined;
    expect(sidecar?.one).toBe(1);

    const idx = db.prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type='index' AND name='idx_artifact_task_pattern_pattern'"
    ).get() as { one: number } | undefined;
    expect(idx?.one).toBe(1);

    db.close();
  });

  it('artifact_task_pattern has the expected column shape', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const cols = db.pragma('table_info(artifact_task_pattern)') as Array<{ name: string; type: string; pk: number }>;
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual([
      'artifact_id',
      'classified_at_epoch_ms',
      'classifier_confidence',
      'classifier_source',
      'task_pattern',
    ]);
    const pkCol = cols.find(c => c.pk > 0);
    expect(pkCol?.name).toBe('artifact_id');

    db.close();
  });

  it('inserting event_kind=cross_project_ambiguous succeeds post-migration', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => {
      db.prepare(
        `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        'sess-amb',
        'cross_project_ambiguous',
        JSON.stringify({ a_id: 1, b_id: 2, cosine: 0.78 }),
        2.5,
        'cross-project-equivalence',
      );
    }).not.toThrow();

    const row = db.prepare(
      `SELECT event_kind FROM telemetry WHERE session_id='sess-amb'`
    ).get() as { event_kind: string };
    expect(row.event_kind).toBe('cross_project_ambiguous');

    db.close();
  });

  it('inserting event_kind=cross_project_query_expansion succeeds post-migration', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => {
      db.prepare(
        `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        'sess-exp',
        'cross_project_query_expansion',
        JSON.stringify({ candidate_count: 12, matched_count: 3 }),
        4.2,
        'recall-server',
      );
    }).not.toThrow();

    const row = db.prepare(
      `SELECT event_kind FROM telemetry WHERE session_id='sess-exp'`
    ).get() as { event_kind: string };
    expect(row.event_kind).toBe('cross_project_query_expansion');

    db.close();
  });

  it('runMigrations is idempotent on a V21 DB (no churn, no demotion)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(getUserVersion(db)).toBe(24);

    expect(() => runMigrations(db)).not.toThrow();
    expect(getUserVersion(db)).toBe(24);

    expect(() => initializeSchema(db)).not.toThrow();
    expect(getUserVersion(db)).toBe(24);

    // No `telemetry_v20` left behind by an idempotent re-run.
    const stale = db.prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='telemetry_v20'"
    ).get() as { one: number } | undefined;
    expect(stale).toBeUndefined();

    db.close();
  });

  it('V19→V20→V21 chain advances cleanly and preserves prior telemetry rows', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    // Seed rows under several pre-V21 kinds (including the V20 'reranker_fallback').
    const seedStmt = db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
       VALUES (?, ?, ?, ?, ?)`
    );
    seedStmt.run('sess-A', 'hook_invocation',   '{"hook":"start"}', 1.5, 'cc-hooks');
    seedStmt.run('sess-A', 'reranker_fallback', '{"port":7439}',    2.0, 'hybrid-retrieval');
    seedStmt.run('sess-B', 'enrichment',        '{}',               3.0, 'angel');

    const before = db.prepare(
      `SELECT id, session_id, event_kind, detail, latency_ms, adapter
         FROM telemetry ORDER BY id ASC`
    ).all();
    expect(before.length).toBe(3);

    // Demote to V19 to simulate an old DB at open time. The V20 step rebuilds
    // telemetry first (adds 'reranker_fallback'), then V21 rebuilds again to
    // add the cross_project_* enums.
    db.pragma('user_version = 19');

    runMigrations(db);

    expect(getUserVersion(db)).toBe(24);

    const after = db.prepare(
      `SELECT id, session_id, event_kind, detail, latency_ms, adapter
         FROM telemetry ORDER BY id ASC`
    ).all();
    expect(after).toEqual(before);

    // All three new V20+V21 kinds are now accepted.
    expect(() => {
      db.prepare(`INSERT INTO telemetry (session_id, event_kind) VALUES (?, ?)`)
        .run('sess-C', 'cross_project_ambiguous');
    }).not.toThrow();
    expect(() => {
      db.prepare(`INSERT INTO telemetry (session_id, event_kind) VALUES (?, ?)`)
        .run('sess-D', 'cross_project_query_expansion');
    }).not.toThrow();

    db.close();
  });

  it('artifact_task_pattern PRIMARY KEY (artifact_id) prevents duplicates', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    db.prepare(
      `INSERT INTO artifact_task_pattern
        (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
        VALUES (?, ?, ?, ?, ?)`
    ).run(42, 'auth-flow-design', Date.now(), 0.92, 'write_time');

    expect(() => {
      db.prepare(
        `INSERT INTO artifact_task_pattern
          (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
          VALUES (?, ?, ?, ?, ?)`
      ).run(42, 'something-else', Date.now(), 0.95, 'write_time');
    }).toThrow();

    // INSERT OR IGNORE should be the safe upsert pattern.
    expect(() => {
      db.prepare(
        `INSERT OR IGNORE INTO artifact_task_pattern
          (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
          VALUES (?, ?, ?, ?, ?)`
      ).run(42, 'something-else', Date.now(), 0.95, 'write_time');
    }).not.toThrow();

    const row = db.prepare(
      `SELECT task_pattern FROM artifact_task_pattern WHERE artifact_id = 42`
    ).get() as { task_pattern: string };
    expect(row.task_pattern).toBe('auth-flow-design');

    db.close();
  });

  it('classifier_source CHECK rejects invalid values', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => {
      db.prepare(
        `INSERT INTO artifact_task_pattern
          (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
          VALUES (?, ?, ?, ?, ?)`
      ).run(7, 'scraping-rate-limit-investigation', Date.now(), 0.9, 'totally_made_up');
    }).toThrow();

    db.close();
  });
});
