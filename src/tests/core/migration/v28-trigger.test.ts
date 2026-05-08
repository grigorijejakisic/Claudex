/**
 * V28 — experience_patterns INSERT-blocked trigger.
 *
 * Phase 4 AR-03 / Layer 3 (schema) cutoff signal. The trigger blocks any
 * INSERT into experience_patterns unless temp.session_pragmas contains
 * key='allow_legacy_pattern_insert'. Tests must opt in explicitly via the
 * helpers from test-db.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../core/storage.js';
import { runMigrations, TARGET_USER_VERSION } from '../../../core/migrations.js';
import { allowLegacyPatternInsert, blockLegacyPatternInsert } from '../../helpers/test-db.js';

describe('V28 — experience_patterns INSERT-blocked trigger', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('runs migrations past V28 (V29 boundary substrate, V30 learnings provenance)', () => {
    expect(TARGET_USER_VERSION).toBeGreaterThanOrEqual(29);
    const row = db.pragma('user_version') as Array<{ user_version: number }>;
    expect(row[0].user_version).toBeGreaterThanOrEqual(29);
  });

  it('creates the experience_patterns_insert_blocked TEMP trigger', () => {
    // TEMP trigger lives in sqlite_temp_master because SQLite forbids a
    // permanent trigger from referencing temp.session_pragmas.
    const row = db.prepare(
      "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name='experience_patterns_insert_blocked'",
    ).get();
    expect(row).toBeDefined();
  });

  it('creates temp.session_pragmas per connection', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_temp_master WHERE type='table' AND name='session_pragmas'",
    ).get();
    expect(row).toBeDefined();
  });

  it('blocks INSERT when no pragma is set', () => {
    expect(() => db.prepare(
      `INSERT INTO experience_patterns (id, pattern_type, trigger_context, lesson, source_project, created_at_epoch)
       VALUES ('test1', 'correction', 't', 'l', 'p', strftime('%s','now'))`,
    ).run()).toThrowError(/experience_patterns is read-only legacy/);
  });

  it('allows INSERT when pragma is set', () => {
    allowLegacyPatternInsert(db);
    expect(() => db.prepare(
      `INSERT INTO experience_patterns (id, pattern_type, trigger_context, lesson, source_project, created_at_epoch)
       VALUES ('test2', 'correction', 't', 'l', 'p', strftime('%s','now'))`,
    ).run()).not.toThrow();
  });

  it('re-blocks after pragma is cleared', () => {
    allowLegacyPatternInsert(db);
    blockLegacyPatternInsert(db);
    expect(() => db.prepare(
      `INSERT INTO experience_patterns (id, pattern_type, trigger_context, lesson, source_project, created_at_epoch)
       VALUES ('test3', 'correction', 't', 'l', 'p', strftime('%s','now'))`,
    ).run()).toThrowError(/experience_patterns is read-only legacy/);
  });

  it('fresh connections re-block (per-connection TEMP table)', () => {
    allowLegacyPatternInsert(db);
    db.close();
    db = openDatabase(':memory:');
    expect(() => db.prepare(
      `INSERT INTO experience_patterns (id, pattern_type, trigger_context, lesson, source_project, created_at_epoch)
       VALUES ('test4', 'correction', 't', 'l', 'p', strftime('%s','now'))`,
    ).run()).toThrowError(/experience_patterns is read-only legacy/);
  });

  it('migration is idempotent (re-running does not fail)', () => {
    runMigrations(db);
    runMigrations(db);
    const row = db.pragma('user_version') as Array<{ user_version: number }>;
    expect(row[0].user_version).toBeGreaterThanOrEqual(29);
  });

  it('FTS5 sync trigger experience_patterns_ai still fires after permitted INSERT', () => {
    allowLegacyPatternInsert(db);
    db.prepare(
      `INSERT INTO experience_patterns (id, pattern_type, trigger_context, lesson, source_project, created_at_epoch)
       VALUES ('test5', 'correction', 'uniquetriggertoken', 'uniquelesson', 'p', strftime('%s','now'))`,
    ).run();
    const ftsRow = db.prepare(
      `SELECT trigger_context FROM experience_patterns_fts WHERE trigger_context MATCH 'uniquetriggertoken'`,
    ).get() as { trigger_context: string } | undefined;
    expect(ftsRow?.trigger_context).toContain('uniquetriggertoken');
  });
});
