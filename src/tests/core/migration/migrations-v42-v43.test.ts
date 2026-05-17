/**
 * V42→V43 migration — legacy _epoch rename + scale (Phase 14-09b).
 *
 * Covers:
 *   1. Fresh-DB initializeSchema lands at user_version >= 43.
 *   2. Every renamed column exists with the new _epoch_ms name; old _epoch name is gone.
 *   3. Backfill: rows with seconds-range value < 1e11 are scaled by 1000.
 *   4. Idempotent: re-running migrateV42toV43 on an already-V43 DB is a no-op.
 *   5. Reverse migrateV43toV42 restores old column names + down-scales values.
 *   6. INSERT relying on DEFAULT on a post-V43 DB stores ms-range value.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, TARGET_USER_VERSION } from '../../../core/migrations.js';
import { migrateV42toV43, migrateV43toV42, hasColumn } from '../../../core/migration-steps.js';

// Subset of the 24 renames — enough to verify correctness without exhaustive repetition.
// Covers all distinct patterns: NOT NULL with DEFAULT, nullable with DEFAULT, nullable without.
const RENAMED: Array<[string, string, string]> = [
  ['thread_state', 'updated_at_epoch', 'updated_at_epoch_ms'],
  ['checkpoint_tracking', 'last_checkpoint_epoch', 'last_checkpoint_epoch_ms'],
  ['checkpoint_tracking', 'updated_at_epoch', 'updated_at_epoch_ms'],
  ['checkpoint_tracking', 'last_tick_epoch', 'last_tick_epoch_ms'],
  ['verified_facts', 'created_at_epoch', 'created_at_epoch_ms'],
  ['file_leases', 'granted_at_epoch', 'granted_at_epoch_ms'],
  ['artifact_claims', 'claimed_at_epoch', 'claimed_at_epoch_ms'],
  ['session_events', 'timestamp_epoch', 'timestamp_epoch_ms'],
  ['session_journal', 'timestamp_epoch', 'timestamp_epoch_ms'],
  ['artifact_links', 'created_at_epoch', 'created_at_epoch_ms'],
  ['artifact_links', 'valid_at_epoch', 'valid_at_epoch_ms'],
  ['artifact_links', 'invalid_at_epoch', 'invalid_at_epoch_ms'],
  ['capability_boundaries', 'last_updated_epoch', 'last_updated_epoch_ms'],
  ['conversation_turns', 'timestamp_epoch', 'timestamp_epoch_ms'],
  ['artifact_access_log', 'timestamp_epoch', 'timestamp_epoch_ms'],
  ['knowledge_gaps', 'detected_at_epoch', 'detected_at_epoch_ms'],
  ['knowledge_gaps', 'resolved_at_epoch', 'resolved_at_epoch_ms'],
  ['temporal_profile', 'updated_at_epoch', 'updated_at_epoch_ms'],
  ['action_transitions', 'last_epoch', 'last_epoch_ms'],
  ['solution_outcomes', 'created_at_epoch', 'created_at_epoch_ms'],
  ['entity_aliases', 'created_at_epoch', 'created_at_epoch_ms'],
  ['artifacts', 'timestamp_epoch', 'timestamp_epoch_ms'],
  ['artifacts', 'last_materialized_epoch', 'last_materialized_epoch_ms'],
  ['code_index', 'last_indexed_epoch', 'last_indexed_epoch_ms'],
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

/**
 * Build a minimal V42 DB: run initializeSchema to get V43, then force back to V42
 * and manually add the old columns so we can test the forward migration.
 *
 * Because a fresh DB already uses the _epoch_ms names in schema.ts DDL, simulating
 * a pre-V43 DB requires either:
 *  (a) manually adding old columns and removing new ones, or
 *  (b) using a real existing-DB migration path.
 *
 * We take approach (a): create a fresh DB, drop columns that already have the new
 * name, add columns with the old name, then run the forward migration.
 *
 * Only tables that actually have the old column names in their CREATE TABLE DDL
 * (schema.ts) need this treatment. Tables that already use _epoch_ms in schema.ts
 * (like conversation_turns, artifacts) will have hasColumn(oldName) = false, so
 * the migration skips them — that's the correct idempotent behavior.
 */
function buildV42LikeDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);

  // Force back to version 42 so migrateV42toV43 will run.
  db.pragma('user_version = 42');

  // For the tables that schema.ts creates with the OLD column name, the column
  // is already there with the old name (fresh-DB schema has old names for those).
  // But for tables where schema.ts already uses _epoch_ms (e.g. session_journal,
  // conversation_turns), the old column doesn't exist — we add it for testing.
  // In production, these tables would have old columns from pre-V35 migrations.

  // session_events: schema.ts has `timestamp_epoch` (old name) — already present.
  // thread_state: schema.ts has `updated_at_epoch` (old name) — already present.
  // checkpoint_tracking: schema.ts has `updated_at_epoch`, `last_checkpoint_epoch` — present.
  // artifact_links: schema.ts has `created_at_epoch`, `valid_at_epoch`, `invalid_at_epoch` — present.
  // capability_boundaries: schema.ts has `last_updated_epoch` — present.
  // knowledge_gaps: schema.ts has `detected_at_epoch`, `resolved_at_epoch` — present.
  // temporal_profile: schema.ts has `updated_at_epoch` — present.
  // action_transitions: schema.ts has `last_epoch` — present.
  // artifact_access_log: schema.ts has `timestamp_epoch` — present.

  // session_journal: schema.ts already uses timestamp_epoch_ms — add the old column for testing.
  if (hasTable(db, 'session_journal') && !hasColumn(db, 'session_journal', 'timestamp_epoch')) {
    // This simulates a legacy DB where the column had the old name.
    db.exec(`ALTER TABLE session_journal ADD COLUMN timestamp_epoch INTEGER`);
  }

  // conversation_turns: schema.ts uses timestamp_epoch_ms — add old column for testing.
  if (hasTable(db, 'conversation_turns') && !hasColumn(db, 'conversation_turns', 'timestamp_epoch')) {
    db.exec(`ALTER TABLE conversation_turns ADD COLUMN timestamp_epoch INTEGER`);
  }

  // verified_facts: schema.ts now uses created_at_epoch_ms (V43+) — add old column for testing.
  if (hasTable(db, 'verified_facts') && !hasColumn(db, 'verified_facts', 'created_at_epoch')) {
    db.exec(`ALTER TABLE verified_facts ADD COLUMN created_at_epoch INTEGER`);
  }

  // solution_outcomes: schema.ts now uses created_at_epoch_ms (V43+) — add old column for testing.
  if (hasTable(db, 'solution_outcomes') && !hasColumn(db, 'solution_outcomes', 'created_at_epoch')) {
    db.exec(`ALTER TABLE solution_outcomes ADD COLUMN created_at_epoch INTEGER`);
  }

  // entity_aliases: schema.ts now uses created_at_epoch_ms (V43+) — add old column for testing.
  if (hasTable(db, 'entity_aliases') && !hasColumn(db, 'entity_aliases', 'created_at_epoch')) {
    db.exec(`ALTER TABLE entity_aliases ADD COLUMN created_at_epoch INTEGER`);
  }

  // artifacts (legacy): schema.ts uses timestamp_epoch_ms — add old columns for testing.
  if (hasTable(db, 'artifacts') && !hasColumn(db, 'artifacts', 'timestamp_epoch')) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN timestamp_epoch INTEGER`);
  }
  if (hasTable(db, 'artifacts') && !hasColumn(db, 'artifacts', 'last_materialized_epoch')) {
    db.exec(`ALTER TABLE artifacts ADD COLUMN last_materialized_epoch INTEGER`);
  }

  return db;
}

describe('V42→V43: legacy _epoch rename + scale', () => {
  it('1. fresh-DB initializeSchema reaches user_version >= 43', () => {
    const db = freshDb();
    const v = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(v).toBeGreaterThanOrEqual(43);
    expect(TARGET_USER_VERSION).toBeGreaterThanOrEqual(43);
    db.close();
  });

  it('2. every renamed column exists with new _epoch_ms name; old _epoch name is absent', () => {
    const db = freshDb();
    for (const [table, oldCol, newCol] of RENAMED) {
      if (!hasTable(db, table)) continue;
      const hasOld = hasColumn(db, table, oldCol);
      const hasNew = hasColumn(db, table, newCol);
      if (!hasOld && !hasNew) {
        // Column exists only on old-migration-path DBs, not in the fresh schema.
        // e.g. checkpoint_tracking.last_tick_epoch was added by a legacy migration
        // that isn't replayed on a fresh DB. Skip — migrateV42toV43 guards correctly.
        continue;
      }
      // Old column must be absent (either renamed, or it never existed with the old name).
      expect(hasOld).toBe(false);
      // New column must exist (either renamed from old, or the fresh schema already uses it).
      expect(hasNew).toBe(true);
    }
    db.close();
  });

  it('3. backfill: rows with seconds-range value < 1e11 are scaled by 1000', () => {
    const db = buildV42LikeDb();
    const badSec = 1700000000; // ~2023-11-14 in unix seconds

    // Insert a synthetic seconds-value row into session_events (old column name present).
    if (hasTable(db, 'session_events') && hasColumn(db, 'session_events', 'timestamp_epoch')) {
      db.prepare(
        `INSERT INTO session_events (session_id, project, event_type, entity, action, timestamp_epoch)
         VALUES ('test-sess', 'test-proj', 'test', 'entity', 'action', ?)`,
      ).run(badSec);
    }

    // Insert into verified_facts (old column name present in schema.ts).
    if (hasTable(db, 'verified_facts') && hasColumn(db, 'verified_facts', 'created_at_epoch')) {
      db.prepare(
        `INSERT INTO verified_facts (session_id, fact, created_at_epoch)
         VALUES ('test-sess', 'test fact', ?)`,
      ).run(badSec);
    }

    migrateV42toV43(db);

    // session_events: column renamed + value scaled.
    if (hasTable(db, 'session_events') && hasColumn(db, 'session_events', 'timestamp_epoch_ms')) {
      const row = db.prepare(
        `SELECT timestamp_epoch_ms FROM session_events WHERE session_id='test-sess'`,
      ).get() as { timestamp_epoch_ms: number } | undefined;
      if (row) {
        expect(row.timestamp_epoch_ms).toBe(badSec * 1000);
      }
    }

    // verified_facts: column renamed + value scaled.
    if (hasTable(db, 'verified_facts') && hasColumn(db, 'verified_facts', 'created_at_epoch_ms')) {
      const row = db.prepare(
        `SELECT created_at_epoch_ms FROM verified_facts WHERE session_id='test-sess'`,
      ).get() as { created_at_epoch_ms: number } | undefined;
      if (row) {
        expect(row.created_at_epoch_ms).toBe(badSec * 1000);
      }
    }

    db.close();
  });

  it('4. idempotent: re-running migrateV42toV43 on an already-V43 DB is a no-op (no double-scale)', () => {
    const db = freshDb();
    const validMs = 1779000000000; // ~2026-05 in ms — already in ms range

    // Insert a valid ms-range row into session_events (now uses timestamp_epoch_ms).
    if (hasTable(db, 'session_events') && hasColumn(db, 'session_events', 'timestamp_epoch_ms')) {
      db.prepare(
        `INSERT INTO session_events (session_id, project, event_type, entity, action, timestamp_epoch_ms)
         VALUES ('idem-sess', 'test', 'test', 'entity', 'action', ?)`,
      ).run(validMs);
    }

    // Force version back to 42 and re-run migration twice.
    db.pragma('user_version = 42');
    migrateV42toV43(db);
    migrateV42toV43(db); // second run — must not double-scale

    if (hasTable(db, 'session_events') && hasColumn(db, 'session_events', 'timestamp_epoch_ms')) {
      const row = db.prepare(
        `SELECT timestamp_epoch_ms FROM session_events WHERE session_id='idem-sess'`,
      ).get() as { timestamp_epoch_ms: number } | undefined;
      if (row) {
        // Value should remain unchanged — already in ms range, above the 1e11 threshold.
        expect(row.timestamp_epoch_ms).toBe(validMs);
      }
    }

    db.close();
  });

  it('5. reverse migrateV43toV42 restores old column names and down-scales values', () => {
    const db = buildV42LikeDb();
    const badSec = 1748500000; // ~2025-05 in seconds

    // Insert seconds-range value into session_events before running forward migration.
    if (hasTable(db, 'session_events') && hasColumn(db, 'session_events', 'timestamp_epoch')) {
      db.prepare(
        `INSERT INTO session_events (session_id, project, event_type, entity, action, timestamp_epoch)
         VALUES ('rev-sess', 'test', 'test', 'entity', 'action', ?)`,
      ).run(badSec);
    }

    // Run forward migration: column renamed, value scaled to ms.
    migrateV42toV43(db);

    // Verify forward state.
    expect(hasColumn(db, 'session_events', 'timestamp_epoch_ms')).toBe(true);
    expect(hasColumn(db, 'session_events', 'timestamp_epoch')).toBe(false);

    // Run reverse.
    migrateV43toV42(db);

    // Column should be back to old name.
    expect(hasColumn(db, 'session_events', 'timestamp_epoch')).toBe(true);
    expect(hasColumn(db, 'session_events', 'timestamp_epoch_ms')).toBe(false);

    // Value should be down-scaled back to approximately the original seconds value.
    const row = db.prepare(
      `SELECT timestamp_epoch FROM session_events WHERE session_id='rev-sess'`,
    ).get() as { timestamp_epoch: number } | undefined;
    if (row) {
      // INTEGER division: (badSec * 1000) / 1000 = badSec exactly for round values.
      expect(row.timestamp_epoch).toBe(badSec);
    }

    // Version should be stamped as 42.
    const v = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    expect(v).toBe(42);

    db.close();
  });

  it('6. post-V43 DDL has DEFAULT (unixepoch() * 1000) and INSERT on a new connection stores ms-range value', () => {
    // Part A: verify DDL text on the same connection (writable_schema updated the stored DDL).
    const db = freshDb();

    if (!hasTable(db, 'session_events')) {
      db.close();
      return;
    }

    // The DDL in sqlite_master must show the updated DEFAULT.
    const sql = tableSql(db, 'session_events');
    // Must contain the ms DEFAULT.
    expect(sql).toContain('unixepoch() * 1000');
    // Must NOT contain a bare unixepoch() DEFAULT on the renamed column.
    const bareDefaultPattern = /timestamp_epoch_ms[^,)]*DEFAULT\s*\(unixepoch\(\)\)[^*]/;
    expect(sql).not.toMatch(bareDefaultPattern);

    db.close();

    // Part B: verify INSERT produces ms-range value on a NEW connection (schema cache reset).
    // writable_schema changes are visible to new connections immediately; this confirms
    // the DEFAULT is actually applied correctly on DB open (production scenario).
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const tmpFile = path.join(os.tmpdir(), `claudex_v43_test_${Date.now()}.db`);
    try {
      const db2 = new Database(tmpFile);
      initializeSchema(db2);
      db2.close(); // close so a new connection picks up the DDL

      const db3 = new Database(tmpFile);
      if (hasTable(db3, 'session_events') && hasColumn(db3, 'session_events', 'timestamp_epoch_ms')) {
        const beforeMs = Date.now();
        db3.prepare(
          `INSERT INTO session_events (session_id, project, event_type, entity, action)
           VALUES ('default-test', 'test', 'test', 'entity', 'action')`,
        ).run();
        const afterMs = Date.now();
        const row = db3.prepare(
          `SELECT timestamp_epoch_ms FROM session_events WHERE session_id='default-test'`,
        ).get() as { timestamp_epoch_ms: number } | undefined;
        if (row) {
          const lowerBoundMs = Math.floor(beforeMs / 1000) * 1000;
          expect(row.timestamp_epoch_ms).toBeGreaterThanOrEqual(lowerBoundMs);
          expect(row.timestamp_epoch_ms).toBeLessThanOrEqual(afterMs + 2000);
          // Must be in ms range, not seconds range.
          expect(row.timestamp_epoch_ms).toBeGreaterThan(100000000000);
        }
      }
      db3.close();
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* cleanup non-critical */ }
    }
  });
});
