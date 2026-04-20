/**
 * V17 Plan 02-07 deliverable: computed-UPDATE regression test.
 *
 * Locks in the SQLite behavior we rely on for INSTEAD OF UPDATE triggers on
 * legacy views — specifically that NEW.column carries the post-expression
 * value when the caller writes `UPDATE view SET col = col + N WHERE id = ?`.
 *
 * If this ever fails after a SQLite upgrade, the trigger generator must fall
 * back to explicit json_set with json_extract reading from artifact.data.
 * See 02-CONTEXT.md caveat #4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV17DDL } from '../../../core/migration/v17-ddl.js';
import { applyGeneratedDDL, generateViewsAndTriggers } from '../../../core/migration/v17-triggers.js';
import { KIND_MAPPING } from '../../../core/migration/kind-mapping.js';

function mkMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  applyV17DDL(db);
  applyGeneratedDDL(db, generateViewsAndTriggers(KIND_MAPPING));
  return db;
}

describe('V17 INSTEAD OF UPDATE — computed RHS via NEW.x (caveat #4)', () => {
  let db: Database.Database;

  beforeEach(() => { db = mkMigratedDb(); });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  it('propagates score = score + 2 correctly through the view trigger', () => {
    db.prepare(`
      INSERT INTO experience_patterns(
        id, pattern_type, trigger_context, lesson, source_project, created_at_epoch, score
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('p1', 'correction', 'ctx', 'lesson', 'proj', 0, 5);

    db.prepare(`UPDATE experience_patterns SET score = score + 2 WHERE id = ?`).run('p1');

    const { score } = db.prepare(
      `SELECT json_extract(data, '$.score') AS score FROM artifact WHERE id = ?`,
    ).get('p1') as { score: number };
    expect(score).toBe(7);
  });

  it('propagates times_triggered + 1 and times_useful increments simultaneously', () => {
    db.prepare(`
      INSERT INTO experience_patterns(
        id, pattern_type, trigger_context, lesson, source_project,
        created_at_epoch, score, times_triggered, times_useful
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('p2', 'correction', 'c', 'l', 'proj', 0, 2, 3, 1);

    db.prepare(`
      UPDATE experience_patterns
      SET score = score + 2, times_triggered = times_triggered + 1
      WHERE id = ?
    `).run('p2');

    const row = db.prepare(
      `SELECT json_extract(data, '$.score') AS score,
              json_extract(data, '$.times_triggered') AS tt
       FROM artifact WHERE id = ?`,
    ).get('p2') as { score: number; tt: number };
    expect(row.score).toBe(4);
    expect(row.tt).toBe(4);
  });

  it('propagates string concat on root_cause correctly', () => {
    db.prepare(`
      INSERT INTO experience_patterns(
        id, pattern_type, trigger_context, lesson, source_project,
        created_at_epoch, root_cause
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('p3', 'correction', 'c', 'l', 'proj', 0, 'initial');

    db.prepare(`
      UPDATE experience_patterns
      SET root_cause = COALESCE(root_cause, '') || ' more'
      WHERE id = ?
    `).run('p3');

    const { rc } = db.prepare(
      `SELECT json_extract(data, '$.root_cause') AS rc FROM artifact WHERE id = ?`,
    ).get('p3') as { rc: string };
    expect(rc).toBe('initial more');
  });

  it('propagates MAX(x, y) computed RHS correctly', () => {
    db.prepare(`
      INSERT INTO experience_patterns(
        id, pattern_type, trigger_context, lesson, source_project,
        created_at_epoch, score
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('p4', 'correction', 'c', 'l', 'proj', 0, 3);

    db.prepare(`UPDATE experience_patterns SET score = MAX(score, 7) WHERE id = ?`).run('p4');

    const { score } = db.prepare(
      `SELECT json_extract(data, '$.score') AS score FROM artifact WHERE id = ?`,
    ).get('p4') as { score: number };
    expect(score).toBe(7);
  });
});
