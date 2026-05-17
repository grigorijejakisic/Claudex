/**
 * Phase 14-07-LINKS-SCHEMA — migration tests.
 *
 * Covers (15 tests):
 *  1. forward: migrateV37toV38 lands on a V37 DB
 *  2. forward: tables exist post-migration (soft_link, hard_link, hard_link_history)
 *  3. forward: indexes exist (named indexes on soft_link / hard_link / history)
 *  4. forward: idempotent re-run is a no-op
 *  5. reverse: migrateV38toV37 drops the tables; user_version = 37
 *  6. CHECK constraint: invalid soft_link type rejected
 *  7. CHECK constraint: invalid hard_link type rejected
 *  8. CHECK constraint: confidence out of [0,1] rejected
 *  9. UNIQUE constraint: duplicate (src, dst, type) on soft_link raises
 * 10. UNIQUE constraint: duplicate (src, dst, type) on hard_link raises
 * 11. FK constraint: soft_link insert without matching src artifact raises
 * 12. FK constraint: hard_link insert without matching dst artifact raises
 * 13. ON DELETE RESTRICT: deleting an artifact referenced by soft_link raises
 * 14. hard_link_history ON DELETE CASCADE: deleting hard_link removes its history rows
 * 15. TARGET_USER_VERSION === 39
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV37toV38, migrateV38toV37 } from '../../../core/migration-steps.js';
import { applyV17DDL } from '../../../core/migration/v17-ddl.js';
import { TARGET_USER_VERSION } from '../../../core/migrations.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasTable(db: Database.Database, name: string): boolean {
  return !!(
    db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(name)
  );
}

function hasIndex(db: Database.Database, name: string): boolean {
  return !!(
    db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
    ).get(name)
  );
}

function userVersion(db: Database.Database): number {
  return (db.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version ?? 0;
}

/**
 * Build a minimal V37-shape DB:
 * - artifact table (V17 DDL)
 * - schema_versions table
 * - PRAGMA user_version = 37
 * - FK enforcement on
 */
function buildV37Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // V17 artifact kernel.
  applyV17DDL(db);

  // schema_versions (needed for INSERT OR IGNORE).
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);

  db.pragma('user_version = 37');
  return db;
}

/**
 * Insert a minimal artifact row. Returns the id.
 */
function insertArtifact(db: Database.Database, id: string, project = 'test-project'): string {
  db.prepare(`
    INSERT OR IGNORE INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms, project)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, 'learning', 'test body', Date.now(), Date.now(), project);
  return id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('migrateV37toV38 — forward', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildV37Db();
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-1: lands cleanly on a V37 DB; user_version = 38', () => {
    expect(() => migrateV37toV38(db)).not.toThrow();
    expect(userVersion(db)).toBe(38);
  });

  it('test-2: three tables exist after migration', () => {
    migrateV37toV38(db);
    expect(hasTable(db, 'soft_link')).toBe(true);
    expect(hasTable(db, 'hard_link')).toBe(true);
    expect(hasTable(db, 'hard_link_history')).toBe(true);
  });

  it('test-3: named indexes are present', () => {
    migrateV37toV38(db);
    // soft_link indexes
    expect(hasIndex(db, 'idx_soft_link_src')).toBe(true);
    expect(hasIndex(db, 'idx_soft_link_dst')).toBe(true);
    expect(hasIndex(db, 'idx_soft_link_project')).toBe(true);
    // hard_link indexes
    expect(hasIndex(db, 'idx_hard_link_src')).toBe(true);
    expect(hasIndex(db, 'idx_hard_link_dst')).toBe(true);
    expect(hasIndex(db, 'idx_hard_link_project')).toBe(true);
    // hard_link_history index
    expect(hasIndex(db, 'idx_hard_link_history_link')).toBe(true);
  });

  it('test-4: re-run is idempotent — does not throw, user_version stays 38', () => {
    migrateV37toV38(db);
    expect(() => migrateV37toV38(db)).not.toThrow();
    expect(userVersion(db)).toBe(38);
  });
});

describe('migrateV38toV37 — reverse', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildV37Db();
    migrateV37toV38(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-5: drops link tables and stamps user_version = 37', () => {
    migrateV38toV37(db);
    expect(hasTable(db, 'soft_link')).toBe(false);
    expect(hasTable(db, 'hard_link')).toBe(false);
    expect(hasTable(db, 'hard_link_history')).toBe(false);
    expect(userVersion(db)).toBe(37);
  });
});

describe('CHECK constraints', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildV37Db();
    migrateV37toV38(db);
    db.pragma('foreign_keys = ON');
    insertArtifact(db, 'art-a');
    insertArtifact(db, 'art-b');
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-6: invalid soft_link type is rejected by CHECK', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO soft_link(src_artifact_id, dst_artifact_id, type, created_by_session, created_at_epoch_ms, project)
        VALUES ('art-a', 'art-b', 'invalid_type', 'sess-1', 1000, 'test-project')
      `).run();
    }).toThrow();
  });

  it('test-7: invalid hard_link type is rejected by CHECK', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO hard_link(src_artifact_id, dst_artifact_id, type, proposed_confidence, proposed_by_session, proposed_at_epoch_ms, project)
        VALUES ('art-a', 'art-b', 'bad_type', 0.8, 'sess-1', 1000, 'test-project')
      `).run();
    }).toThrow();
  });

  it('test-8: confidence outside [0, 1] is rejected by CHECK', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO soft_link(src_artifact_id, dst_artifact_id, type, confidence, created_by_session, created_at_epoch_ms, project)
        VALUES ('art-a', 'art-b', 'supersedes', 1.5, 'sess-1', 1000, 'test-project')
      `).run();
    }).toThrow();

    expect(() => {
      db.prepare(`
        INSERT INTO soft_link(src_artifact_id, dst_artifact_id, type, confidence, created_by_session, created_at_epoch_ms, project)
        VALUES ('art-a', 'art-b', 'references', -0.1, 'sess-1', 1000, 'test-project')
      `).run();
    }).toThrow();
  });
});

describe('UNIQUE constraints', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildV37Db();
    migrateV37toV38(db);
    db.pragma('foreign_keys = ON');
    insertArtifact(db, 'art-a');
    insertArtifact(db, 'art-b');
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-9: duplicate (src, dst, type) on soft_link raises', () => {
    const stmt = db.prepare(`
      INSERT INTO soft_link(src_artifact_id, dst_artifact_id, type, created_by_session, created_at_epoch_ms, project)
      VALUES ('art-a', 'art-b', 'supersedes', 'sess-1', 1000, 'test-project')
    `);
    stmt.run();
    expect(() => stmt.run()).toThrow();
  });

  it('test-10: duplicate (src, dst, type) on hard_link raises', () => {
    const stmt = db.prepare(`
      INSERT INTO hard_link(src_artifact_id, dst_artifact_id, type, proposed_confidence, proposed_by_session, proposed_at_epoch_ms, project)
      VALUES ('art-a', 'art-b', 'triggered_by', 0.9, 'sess-1', 1000, 'test-project')
    `);
    stmt.run();
    expect(() => stmt.run()).toThrow();
  });
});

describe('FK constraints', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildV37Db();
    migrateV37toV38(db);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('test-11: soft_link insert without matching src artifact raises FK error', () => {
    // Insert a valid dst but no src.
    insertArtifact(db, 'art-dst');
    expect(() => {
      db.prepare(`
        INSERT INTO soft_link(src_artifact_id, dst_artifact_id, type, created_by_session, created_at_epoch_ms, project)
        VALUES ('nonexistent-src', 'art-dst', 'references', 'sess-1', 1000, 'test-project')
      `).run();
    }).toThrow();
  });

  it('test-12: hard_link insert without matching dst artifact raises FK error', () => {
    // Insert a valid src but no dst.
    insertArtifact(db, 'art-src');
    expect(() => {
      db.prepare(`
        INSERT INTO hard_link(src_artifact_id, dst_artifact_id, type, proposed_confidence, proposed_by_session, proposed_at_epoch_ms, project)
        VALUES ('art-src', 'nonexistent-dst', 'evidence_for', 0.7, 'sess-1', 1000, 'test-project')
      `).run();
    }).toThrow();
  });

  it('test-13: ON DELETE RESTRICT — deleting an artifact referenced by soft_link raises', () => {
    insertArtifact(db, 'art-a');
    insertArtifact(db, 'art-b');
    // Insert a link from art-a to art-b.
    db.prepare(`
      INSERT INTO soft_link(src_artifact_id, dst_artifact_id, type, created_by_session, created_at_epoch_ms, project)
      VALUES ('art-a', 'art-b', 'supersedes', 'sess-1', 1000, 'test-project')
    `).run();
    // Trying to delete art-a (which is a src) must fail.
    expect(() => {
      db.prepare(`DELETE FROM artifact WHERE id = 'art-a'`).run();
    }).toThrow();
  });

  it('test-14: hard_link_history ON DELETE CASCADE — deleting hard_link removes history rows', () => {
    insertArtifact(db, 'art-c');
    insertArtifact(db, 'art-d');

    // Insert a hard link.
    const result = db.prepare(`
      INSERT INTO hard_link(src_artifact_id, dst_artifact_id, type, proposed_confidence, proposed_by_session, proposed_at_epoch_ms, project)
      VALUES ('art-c', 'art-d', 'contradicts', 0.6, 'sess-1', 1000, 'test-project')
    `).run();
    const hlId = result.lastInsertRowid;

    // Insert a history row.
    db.prepare(`
      INSERT INTO hard_link_history(hard_link_id, action, session_id, action_at_epoch_ms)
      VALUES (?, 'proposed', 'sess-1', 1000)
    `).run(hlId);

    const histBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM hard_link_history WHERE hard_link_id = ?`).get(hlId) as { n: number }
    ).n;
    expect(histBefore).toBe(1);

    // Delete the hard_link — history rows must cascade.
    db.prepare(`DELETE FROM hard_link WHERE id = ?`).run(hlId);

    const histAfter = (
      db.prepare(`SELECT COUNT(*) AS n FROM hard_link_history WHERE hard_link_id = ?`).get(hlId) as { n: number }
    ).n;
    expect(histAfter).toBe(0);
  });
});

describe('TARGET_USER_VERSION', () => {
  it('test-15: TARGET_USER_VERSION is 39', () => {
    expect(TARGET_USER_VERSION).toBe(39);
  });
});
