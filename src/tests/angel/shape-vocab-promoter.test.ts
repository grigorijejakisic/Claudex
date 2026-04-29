/**
 * Tests for Phase 4.1 shape vocabulary promotion sweep.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { promoteShapeVocabulary, recordShapeCandidate } from '../../angel/shape-vocab-promoter.js';

describe('shape-vocab-promoter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('recordShapeCandidate inserts a row; idempotent on (field, value, session)', () => {
    recordShapeCandidate(db, 'task_shape', 'design-discussion', 'sess1', 'p1');
    recordShapeCandidate(db, 'task_shape', 'design-discussion', 'sess1', 'p1'); // dup
    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM shape_candidates
       WHERE field = 'task_shape' AND value = 'design-discussion' AND session_id = 'sess1'`,
    ).get() as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it('3 distinct sessions → 1 promotion to canonical', () => {
    recordShapeCandidate(db, 'task_shape', 'audit', 'sess1', 'p1');
    recordShapeCandidate(db, 'task_shape', 'audit', 'sess2', 'p1');
    recordShapeCandidate(db, 'task_shape', 'audit', 'sess3', 'p1');

    const promoted = promoteShapeVocabulary(db);
    expect(promoted).toBe(1);

    const row = db.prepare(
      `SELECT field, value, promoted_session_count FROM shape_vocabulary
       WHERE field = 'task_shape' AND value = 'audit'`,
    ).get() as { field: string; value: string; promoted_session_count: number };
    expect(row).toBeDefined();
    expect(row.promoted_session_count).toBe(3);
  });

  it('2 distinct sessions only → no promotion', () => {
    recordShapeCandidate(db, 'task_shape', 'low-density', 'sess1', 'p1');
    recordShapeCandidate(db, 'task_shape', 'low-density', 'sess2', 'p1');

    const promoted = promoteShapeVocabulary(db);
    expect(promoted).toBe(0);
  });

  it('3 records but only 2 distinct sessions → no promotion (DISTINCT semantics)', () => {
    recordShapeCandidate(db, 'task_shape', 'two-sess', 'sess1', 'p1');
    recordShapeCandidate(db, 'task_shape', 'two-sess', 'sess1', 'p2');
    recordShapeCandidate(db, 'task_shape', 'two-sess', 'sess2', 'p1');

    const promoted = promoteShapeVocabulary(db);
    expect(promoted).toBe(0);
  });

  it('already-canonical value → no double-promotion', () => {
    db.prepare(
      `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count) VALUES (?, ?, ?, ?)`,
    ).run('task_shape', 'already-canon', Date.now(), 3);

    recordShapeCandidate(db, 'task_shape', 'already-canon', 'sess1', 'p1');
    recordShapeCandidate(db, 'task_shape', 'already-canon', 'sess2', 'p1');
    recordShapeCandidate(db, 'task_shape', 'already-canon', 'sess3', 'p1');

    const promoted = promoteShapeVocabulary(db);
    expect(promoted).toBe(0);
  });

  it('multiple distinct candidates each at density 3 → multiple promotions in one call', () => {
    for (const value of ['v1', 'v2', 'v3']) {
      for (const sess of ['s1', 's2', 's3']) {
        recordShapeCandidate(db, 'task_shape', value, sess, 'p1');
      }
    }
    const promoted = promoteShapeVocabulary(db);
    expect(promoted).toBe(3);
  });

  it('idempotent promotion: running twice promotes once', () => {
    recordShapeCandidate(db, 'task_shape', 'idem', 's1', 'p1');
    recordShapeCandidate(db, 'task_shape', 'idem', 's2', 'p1');
    recordShapeCandidate(db, 'task_shape', 'idem', 's3', 'p1');

    expect(promoteShapeVocabulary(db)).toBe(1);
    expect(promoteShapeVocabulary(db)).toBe(0);

    // Candidates not deleted (history preserved)
    const cnt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM shape_candidates WHERE field='task_shape' AND value='idem'`,
    ).get() as { cnt: number };
    expect(cnt.cnt).toBe(3);
  });
});
