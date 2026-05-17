/**
 * V39→V40 migration — epoch_ms DEFAULT canonicalization.
 *
 * Phase 14-08 substrate hygiene. Covers:
 *   1. Fresh-DB initializeSchema lands at TARGET_USER_VERSION = 40.
 *   2. Post-V40 DDL: DEFAULT (unixepoch() * 1000) on the 7 affected tables.
 *   3. Backfill: rows with `_ms` value < 1e11 (seconds-as-ms) are scaled by 1000.
 *   4. Idempotent: re-running migrateV39toV40 is a no-op.
 *   5. Reverse migrateV40toV39 restores DEFAULT (unixepoch()) (DDL only).
 *   6. session_signals INSERT relying on DEFAULT now stores ms (not sec).
 *   7. Live row count: no rows < 1e11 remain in affected tables after V40.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, TARGET_USER_VERSION } from '../../../core/migrations.js';
import { migrateV39toV40, migrateV40toV39, hasColumn } from '../../../core/migration-steps.js';

const AFFECTED: Array<[string, string]> = [
  ['checkpoint_meta', 'created_at_epoch_ms'],
  ['checkpoint_meta', 'updated_at_epoch_ms'],
  ['sessions', 'created_at_epoch_ms'],
  ['observations', 'timestamp_epoch_ms'],
  ['retrieval_events', 'timestamp_epoch_ms'],
  ['session_signals', 'created_at_epoch_ms'],
  ['session_messages', 'created_at_epoch_ms'],
  ['episodic_events', 'ts_epoch_ms'],
];

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function tableSql(db: Database.Database, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string } | undefined;
  return row?.sql ?? '';
}

describe('V39→V40: epoch_ms DEFAULT canonicalization', () => {
  it('1. fresh-DB initializeSchema reaches TARGET_USER_VERSION = 40', () => {
    const db = freshDb();
    const v = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(v).toBe(40);
    expect(TARGET_USER_VERSION).toBe(40);
    db.close();
  });

  it('2. post-V40 DDL: affected tables use DEFAULT (unixepoch() * 1000), not bare unixepoch()', () => {
    const db = freshDb();
    for (const [table, col] of AFFECTED) {
      if (!hasTable(db, table)) continue;
      const sql = tableSql(db, table);
      // The column should not have a bare DEFAULT (unixepoch())
      const badPattern = new RegExp(`"?${col}"?\\s+INTEGER[^,]*DEFAULT\\s*\\(unixepoch\\(\\)\\)`);
      expect(sql).not.toMatch(badPattern);
    }
    db.close();
  });

  it('3. backfill: rows with _ms < 1e11 are scaled by 1000', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    // Force-set version back to 39 so we can re-run the V40 migration
    // against synthetic bad data.
    db.pragma('user_version = 39');

    // Insert a synthetic bad row in session_signals (seconds-as-ms value).
    const badSec = 1700000000; // ~2023-11-14 in seconds
    db.prepare(`
      INSERT INTO session_signals (session_id, project, signal_type, target, created_at_epoch_ms)
      VALUES ('test-session', 'test-project', 'discovery', 'test-target', ?)
    `).run(badSec);

    migrateV39toV40(db);

    const row = db.prepare(`SELECT created_at_epoch_ms FROM session_signals WHERE session_id='test-session'`).get() as { created_at_epoch_ms: number };
    expect(row.created_at_epoch_ms).toBe(badSec * 1000);
    db.close();
  });

  it('4. idempotent: re-running migrateV39toV40 is a no-op (no double-scale)', () => {
    const db = freshDb();
    // Already at V40 from initializeSchema. Insert a valid ms row.
    const validMs = 1779000000000; // ~2026-05 in ms
    db.prepare(`
      INSERT INTO session_signals (session_id, project, signal_type, target, created_at_epoch_ms)
      VALUES ('idem-session', 'test', 'wip', 'target', ?)
    `).run(validMs);

    // Re-run the migration explicitly.
    db.pragma('user_version = 39');
    migrateV39toV40(db);
    migrateV39toV40(db); // run twice — should not double-scale

    const row = db.prepare(`SELECT created_at_epoch_ms FROM session_signals WHERE session_id='idem-session'`).get() as { created_at_epoch_ms: number };
    expect(row.created_at_epoch_ms).toBe(validMs);
    db.close();
  });

  it('5. reverse migrateV40toV39 restores DEFAULT (unixepoch()) — DDL only', () => {
    const db = freshDb();
    migrateV40toV39(db);
    const sql = tableSql(db, 'session_signals');
    expect(sql).toMatch(/DEFAULT\s*\(unixepoch\(\)\)/);
    expect(sql).not.toMatch(/DEFAULT\s*\(unixepoch\(\)\s*\*\s*1000\)/);
    const v = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(v).toBe(39);
    db.close();
  });

  it('6. INSERT relying on DEFAULT on post-V40 DB stores ms, not sec', () => {
    const db = freshDb();
    const beforeMs = Date.now();
    db.prepare(`
      INSERT INTO session_signals (session_id, project, signal_type, target)
      VALUES ('default-test', 'test', 'wip', 'target')
    `).run();
    const afterMs = Date.now();

    const row = db.prepare(`SELECT created_at_epoch_ms FROM session_signals WHERE session_id='default-test'`).get() as { created_at_epoch_ms: number };
    // The DEFAULT-produced value should be in the ms range (>= ~1.7e12 in 2026).
    expect(row.created_at_epoch_ms).toBeGreaterThanOrEqual(beforeMs);
    expect(row.created_at_epoch_ms).toBeLessThanOrEqual(afterMs + 2000);
    expect(row.created_at_epoch_ms).toBeGreaterThan(100000000000); // > 1e11
    db.close();
  });

  it('7. no bad rows remain in affected tables after V40 migration', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    db.pragma('user_version = 39');

    // Insert one bad row per affected table where possible.
    db.prepare(`INSERT INTO session_signals (session_id, project, signal_type, target, created_at_epoch_ms) VALUES ('s','p','wip','t',1700000000)`).run();
    db.prepare(`INSERT INTO sessions (session_id, scope, project, cwd, source, status, created_at_epoch_ms) VALUES ('s2','main','p','.','test','active',1700000000)`).run();

    migrateV39toV40(db);

    // Scan all affected columns for rows still < 1e11 (other than legitimate zero-defaults).
    for (const [table, col] of AFFECTED) {
      if (!hasTable(db, table) || !hasColumn(db, table, col)) continue;
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} > 0 AND ${col} < 100000000000`).get() as { n: number };
      expect(row.n).toBe(0);
    }
    db.close();
  });
});
