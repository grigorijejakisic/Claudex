/**
 * V17 Plan 02-07 deliverable: naming-convention lint test.
 *
 * Asserts every distinct `kind` in `artifact` matches lowercase_snake_case_singular.
 * Runs against a migrated fixture DB — all 6 P1 kinds seeded.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyV17DDL } from '../../../core/migration/v17-ddl.js';

function seedMigratedWithAllKinds(): Database.Database {
  const db = new Database(':memory:');
  applyV17DDL(db);
  const kinds = [
    'learning',
    'decision',
    'experience_pattern',
    'angel_opinion',
    'critical_rule',
    'mental_model',
  ];
  const stmt = db.prepare(`
    INSERT INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const k of kinds) stmt.run(k + '-fixture', k, 'body', 0, 0);
  return db;
}

describe('V17 artifact kind naming convention', () => {
  it('every kind matches lowercase_snake_case_singular', () => {
    const db = seedMigratedWithAllKinds();
    try {
      const rows = db.prepare('SELECT DISTINCT kind FROM artifact').all() as { kind: string }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const { kind } of rows) {
        expect(kind, `kind '${kind}' violates lowercase_snake_case_singular`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    } finally {
      db.close();
    }
  });

  it('kind_registry is in sync with artifact kinds', () => {
    const db = seedMigratedWithAllKinds();
    try {
      const registered = new Set(
        (db.prepare('SELECT kind FROM kind_registry').all() as { kind: string }[]).map((r) => r.kind),
      );
      const actual = new Set(
        (db.prepare('SELECT DISTINCT kind FROM artifact').all() as { kind: string }[]).map((r) => r.kind),
      );
      expect(registered.size).toBe(actual.size);
      for (const k of actual) expect(registered.has(k), `registry missing '${k}'`).toBe(true);
    } finally {
      db.close();
    }
  });

  it('rejects a hypothetical kind that violates the convention at lint time', () => {
    const db = seedMigratedWithAllKinds();
    try {
      // Insert a deliberately-bad kind; the lint test MUST catch it.
      db.prepare(`
        INSERT INTO artifact(id, kind, body, created_at_epoch_ms, updated_at_epoch_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run('bad', 'SomeBadKind', 'body', 0, 0);

      const rows = db.prepare('SELECT DISTINCT kind FROM artifact').all() as { kind: string }[];
      const offenders = rows.filter((r) => !/^[a-z][a-z0-9_]*$/.test(r.kind));
      expect(offenders.length).toBe(1);
      expect(offenders[0].kind).toBe('SomeBadKind');
    } finally {
      db.close();
    }
  });
});
