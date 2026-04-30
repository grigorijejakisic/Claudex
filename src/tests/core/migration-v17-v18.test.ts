/**
 * Tests for the V17→V18 migration (Phase 4.1 lesson substrate tables).
 *
 * Verifies:
 *   - Fresh DB initialization reaches user_version = 18 with shape_vocabulary
 *     and shape_candidates tables present.
 *   - Idempotency: re-running initializeSchema does not throw.
 *   - Direct migrateV17toV18 invocation is safe to call multiple times.
 *   - Index idx_shape_candidates_field_value exists post-migration.
 *   - Schema columns and primary keys match the locked spec.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { migrateV17toV18 } from '../../core/migration-steps.js';

function getUserVersion(db: Database.Database): number {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

describe('Phase 4.1 V17→V18 migration', () => {
  it('fresh DB has shape_vocabulary tables present (user_version is now 21 after Phase 6.5)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    expect(getUserVersion(db)).toBe(24);

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>).map(t => t.name);

    expect(tables).toContain('shape_vocabulary');
    expect(tables).toContain('shape_candidates');

    db.close();
  });

  it('initializeSchema is idempotent — second call does not throw and tables remain', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
    expect(getUserVersion(db)).toBe(24);

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('shape_vocabulary', 'shape_candidates')"
    ).all() as Array<{ name: string }>).map(t => t.name);
    expect(tables.sort()).toEqual(['shape_candidates', 'shape_vocabulary']);

    db.close();
  });

  it('runMigrations promotes a stub V16 DB to current TARGET_VERSION', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 16');
    // Minimal stub: V17 DDL is idempotent and IF NOT EXISTS-guarded; the V17→V18
    // step itself is also IF NOT EXISTS-guarded so a partial pre-state is fine.
    runMigrations(db);
    // Phase 6.5 raised TARGET_VERSION to 21.
    expect(getUserVersion(db)).toBe(24);
    db.close();
  });

  it('migrateV17toV18 can be called directly and is idempotent', () => {
    const db = new Database(':memory:');
    expect(() => migrateV17toV18(db)).not.toThrow();
    expect(() => migrateV17toV18(db)).not.toThrow();

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('shape_vocabulary', 'shape_candidates')"
    ).all() as Array<{ name: string }>).map(t => t.name);
    expect(tables.length).toBe(2);

    db.close();
  });

  it('idx_shape_candidates_field_value index exists after migration', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_shape_candidates_field_value'"
    ).all() as Array<{ name: string }>;
    expect(indexes.length).toBe(1);

    db.close();
  });

  it('shape_vocabulary columns and primary key match the locked spec', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const cols = db.pragma('table_info(shape_vocabulary)') as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual([
      'field',
      'promoted_at_epoch',
      'promoted_session_count',
      'value',
    ]);

    const pkCols = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    expect(pkCols).toEqual(['field', 'value']);

    db.close();
  });

  it('shape_candidates columns and primary key match the locked spec', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    const cols = db.pragma('table_info(shape_candidates)') as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual([
      'field',
      'project',
      'proposed_at_epoch',
      'session_id',
      'value',
    ]);

    const pkCols = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    expect(pkCols).toEqual(['field', 'value', 'session_id']);

    db.close();
  });
});
