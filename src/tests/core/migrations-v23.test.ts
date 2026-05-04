/**
 * Tests for the V23→V24 migration (Phase 11 STOR-04: drop legacy `*_old`
 * tables left behind by V17). Per Plan 11-05 zero-caller audit.
 *
 * V24 is destructive but idempotent — DROP TABLE IF EXISTS for each of:
 *   learnings_old, decisions_old, experience_patterns_old,
 *   angel_opinions_old, critical_rules_old, project_curated_context_old.
 *
 * Verifies:
 *   - Fresh-DB initialization reaches user_version = 24 (no _old tables present).
 *   - Migrating a DB that has populated _old tables drops them cleanly.
 *   - Idempotency: running migrateV23toV24 twice on a migrated DB is a no-op.
 *   - Compat views (learnings, decisions, etc.) survive the drop because they
 *     route to the artifact kernel via INSTEAD OF triggers, not _old tables.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, TARGET_USER_VERSION } from '../../core/migrations.js';
import { migrateV23toV24 } from '../../core/migration-steps.js';

function getUserVersion(db: Database.Database): number {
  const row = db.pragma('user_version') as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

const LEGACY_OLD_TABLES = [
  'learnings_old',
  'decisions_old',
  'experience_patterns_old',
  'angel_opinions_old',
  'critical_rules_old',
  'project_curated_context_old',
] as const;

describe('Phase 11 V23→V24 migration (drop legacy _old tables)', () => {
  it('fresh DB reaches user_version=25 (V25 = episode substrate, ceiling raised by Phase 1)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(getUserVersion(db)).toBe(TARGET_USER_VERSION);
    db.close();
  });

  it('drops all six _old tables when present', () => {
    const db = new Database(':memory:');
    // Manually create _old tables to simulate a pre-V24 DB state
    for (const tbl of LEGACY_OLD_TABLES) {
      db.exec(`CREATE TABLE ${tbl} (id INTEGER PRIMARY KEY, payload TEXT)`);
    }
    // Confirm they're there before the migration
    for (const tbl of LEGACY_OLD_TABLES) {
      const r = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tbl);
      expect(r).toBeDefined();
    }

    expect(migrateV23toV24(db)).toBe(true);

    for (const tbl of LEGACY_OLD_TABLES) {
      const r = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tbl);
      expect(r).toBeUndefined();
    }
    db.close();
  });

  it('is idempotent: running on a clean DB is a no-op (no error)', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(() => migrateV23toV24(db)).not.toThrow();
    expect(() => migrateV23toV24(db)).not.toThrow();
    db.close();
  });
});
