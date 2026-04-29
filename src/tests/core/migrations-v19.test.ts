/**
 * Tests for the V18→V19 migration (Phase 5.5 curation feedback loop substrate).
 *
 * Verifies:
 *   - Fresh DB initialization reaches user_version = 19 with both
 *     `lesson_pointer` and `pointer_recall_log` tables present.
 *   - V18→V19 upgrade preserves seed data in V18 tables.
 *   - Idempotent re-run is a no-op.
 *   - Three pointer-recall indexes exist (pointer, session, helpful-partial)
 *     plus the lesson_pointer project index.
 *   - CHECK constraint on `lesson_pointer.source` enforces enum values.
 *   - UNIQUE(project, filename, source) on lesson_pointer.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';

function getUserVersion(db: Database.Database): number {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name) as { one: number } | undefined;
  return row != null;
}

describe('Phase 5.5 V18→V19 migration', () => {
  it('fresh DB has V19 tables present (user_version is now 20 after Phase 6)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    // Phase 6 raised TARGET_VERSION to 20; V19 tables remain present.
    expect(getUserVersion(db)).toBe(20);
    expect(tableExists(db, 'lesson_pointer')).toBe(true);
    expect(tableExists(db, 'pointer_recall_log')).toBe(true);

    db.close();
  });

  it('V18→V19 upgrade preserves data in V18 (shape_vocabulary) table', () => {
    const db = new Database(':memory:');
    // Bootstrap to V18 state via initializeSchema, then demote to simulate
    // a V18 DB at open time. Demotion only changes user_version; the V18
    // tables remain. Then runMigrations re-promotes through V18→V19.
    initializeSchema(db);
    db.pragma('user_version = 18');

    const now = Date.now();
    db.prepare(
      `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES (?, ?, ?, ?)`
    ).run('task_shape', 'design-discussion-before-commit', now, 3);

    runMigrations(db);

    // V18→V19 step still runs as part of the upgrade chain; final stamp is V20.
    expect(getUserVersion(db)).toBe(20);
    const seed = db.prepare(
      `SELECT field, value, promoted_session_count FROM shape_vocabulary WHERE field = 'task_shape'`
    ).get() as { field: string; value: string; promoted_session_count: number };
    expect(seed.field).toBe('task_shape');
    expect(seed.value).toBe('design-discussion-before-commit');
    expect(seed.promoted_session_count).toBe(3);

    expect(tableExists(db, 'lesson_pointer')).toBe(true);
    expect(tableExists(db, 'pointer_recall_log')).toBe(true);

    db.close();
  });

  it('runMigrations is idempotent on a fully-migrated DB (no error, no schema churn)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(getUserVersion(db)).toBe(20);

    expect(() => runMigrations(db)).not.toThrow();
    expect(getUserVersion(db)).toBe(20);
    expect(() => initializeSchema(db)).not.toThrow();
    expect(getUserVersion(db)).toBe(20);

    db.close();
  });

  it('three pointer_recall_log indexes exist plus lesson_pointer project index', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const recallIdx = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_pointer_recall_%' ORDER BY name`
    ).all() as Array<{ name: string }>).map(r => r.name);
    expect(recallIdx).toEqual([
      'idx_pointer_recall_helpful',
      'idx_pointer_recall_pointer',
      'idx_pointer_recall_session',
    ]);

    const lpIdx = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_lesson_pointer_project'`
    ).get() as { name: string } | undefined);
    expect(lpIdx?.name).toBe('idx_lesson_pointer_project');

    db.close();
  });

  it('CHECK constraint enforces source IN (lesson, user_note)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(() => {
      db.prepare(
        `INSERT INTO lesson_pointer (project, filename, source, first_seen_epoch_ms)
         VALUES (?, ?, ?, ?)`
      ).run('proj-a', 'feedback_x.md', 'lesson', Date.now());
    }).not.toThrow();

    expect(() => {
      db.prepare(
        `INSERT INTO lesson_pointer (project, filename, source, first_seen_epoch_ms)
         VALUES (?, ?, ?, ?)`
      ).run('proj-a', 'feedback_y.md', 'garbage', Date.now());
    }).toThrow();

    db.close();
  });

  it('UNIQUE(project, filename, source) — INSERT OR IGNORE no-ops the second insert', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const stmt = db.prepare(
      `INSERT OR IGNORE INTO lesson_pointer (project, filename, source, first_seen_epoch_ms)
       VALUES (?, ?, ?, ?)`
    );
    const r1 = stmt.run('proj-a', 'feedback_dup.md', 'lesson', 1000);
    const r2 = stmt.run('proj-a', 'feedback_dup.md', 'lesson', 2000);
    expect(r1.changes).toBe(1);
    expect(r2.changes).toBe(0);

    const rows = db.prepare(
      `SELECT COUNT(*) AS c FROM lesson_pointer WHERE project = 'proj-a' AND filename = 'feedback_dup.md'`
    ).get() as { c: number };
    expect(rows.c).toBe(1);

    db.close();
  });

  it('UNIQUE constraint allows different source for same (project, filename)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const stmt = db.prepare(
      `INSERT INTO lesson_pointer (project, filename, source, first_seen_epoch_ms)
       VALUES (?, ?, ?, ?)`
    );
    expect(() => stmt.run('proj-a', 'feedback_x.md', 'lesson', 1000)).not.toThrow();
    expect(() => stmt.run('proj-a', 'feedback_x.md', 'user_note', 2000)).not.toThrow();

    const c = (db.prepare(
      `SELECT COUNT(*) AS c FROM lesson_pointer WHERE project = 'proj-a' AND filename = 'feedback_x.md'`
    ).get() as { c: number }).c;
    expect(c).toBe(2);

    db.close();
  });
});
