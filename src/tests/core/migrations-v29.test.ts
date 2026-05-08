/**
 * Tests for the V28→V29 migration (Phase 6 EBD-05: crash-resilient
 * episode boundary substrate).
 *
 * V29 lands:
 *   - New table `episode_boundary_cursor` (PK: project + session_id)
 *   - sessions.last_heartbeat_ts INTEGER NULL
 *   - sessions.last_jsonl_write_ts INTEGER NULL
 *
 * Verifies:
 *   - TARGET_USER_VERSION is 29
 *   - Fresh-DB initialization creates the cursor table + new sessions columns
 *   - PRAGMA user_version reports 29 after init
 *   - runMigrations is idempotent (second call no-op)
 *   - PRIMARY KEY (project, session_id) is enforced
 *   - last_close_event_id allows NULL (boundary not yet emitted)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations, TARGET_USER_VERSION } from '../../core/migrations.js';

describe('V28→V29 migration', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('TARGET_USER_VERSION is at least 29', () => {
    // Phase 7 (V30) advanced TARGET_USER_VERSION; V29-specific behavior is
    // tested by the structural assertions below regardless of the global
    // target version.
    expect(TARGET_USER_VERSION).toBeGreaterThanOrEqual(29);
  });

  it('initializeSchema on fresh DB creates episode_boundary_cursor', () => {
    initializeSchema(db);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='episode_boundary_cursor'"
    ).get();
    expect(row).toBeDefined();
  });

  it('initializeSchema on fresh DB adds sessions.last_heartbeat_ts and sessions.last_jsonl_write_ts', () => {
    initializeSchema(db);
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('last_heartbeat_ts');
    expect(names).toContain('last_jsonl_write_ts');
  });

  it('runMigrations advances PRAGMA user_version past 28 (V29 lands)', () => {
    initializeSchema(db);
    const row = db.pragma('user_version') as Array<{ user_version: number }>;
    expect(row[0]?.user_version).toBeGreaterThanOrEqual(29);
  });

  it('runMigrations is idempotent — second call is a no-op', () => {
    initializeSchema(db);
    const v1 = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    runMigrations(db);
    const v2 = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(v2).toBe(v1);
  });

  it('episode_boundary_cursor enforces (project, session_id) primary key', () => {
    initializeSchema(db);
    db.prepare(
      `INSERT INTO episode_boundary_cursor
        (project, session_id, last_processed_jsonl_offset, last_processed_event_ts_epoch)
        VALUES (?, ?, ?, ?)`
    ).run('p', 's', 0, 0);
    expect(() =>
      db.prepare(
        `INSERT INTO episode_boundary_cursor
          (project, session_id, last_processed_jsonl_offset, last_processed_event_ts_epoch)
          VALUES (?, ?, ?, ?)`
      ).run('p', 's', 1, 1)
    ).toThrow();
  });

  it('episode_boundary_cursor allows last_close_event_id NULL', () => {
    initializeSchema(db);
    expect(() =>
      db.prepare(
        `INSERT INTO episode_boundary_cursor
          (project, session_id, last_processed_jsonl_offset, last_processed_event_ts_epoch, last_close_event_id)
          VALUES (?, ?, ?, ?, NULL)`
      ).run('p', 's', 0, 0)
    ).not.toThrow();
  });
});
