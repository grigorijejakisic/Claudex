/**
 * Regression: V43 migration must succeed on a post-cutover DB where the
 * legacy `artifacts` table has read-only triggers installed.
 *
 * Found 2026-05-18 fresh-session gate test (claudex-v3): V43's
 * `UPDATE artifacts SET timestamp_epoch_ms = timestamp_epoch_ms * 1000`
 * scaling step hit the `prevent_legacy_update_post_cutover` trigger and
 * aborted the entire migration. user_version stayed at 42 and every MCP
 * tool call that triggered `getDb()` re-ran the migration, re-failed, and
 * surfaced "legacy artifacts table is read-only post-cutover; write to V17
 * artifact table instead" as the tool's error of record.
 *
 * Fix: V43 detects the read-only-flipped state, drops the three enforcement
 * triggers before the UPDATE step, runs the scale, and re-installs the
 * triggers in a finally block.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, TARGET_USER_VERSION } from '../../../core/migrations.js';
import {
  migrateV42toV43,
  flipLegacyArtifactsReadOnly,
} from '../../../core/migration-steps.js';

function buildV42LikeDbWithCutoverFlip(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);

  // Seed an artifacts row so the cutover flip can mark it read-only and the
  // V43 UPDATE has a row to (try to) modify.
  db.exec(`
    INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance, timestamp_epoch_ms)
    VALUES ('s1', 'p1', 'observation', 'seed', 'fresh', 3, 3.0, 1700000000)
  `);

  // Roll the DB back to pre-V43 by reverse-migrating the artifacts columns
  // (the part V43 will need to re-apply) so the forward migration has
  // something to do.
  db.exec(`ALTER TABLE artifacts RENAME COLUMN timestamp_epoch_ms TO timestamp_epoch`);
  db.exec(`ALTER TABLE artifacts RENAME COLUMN last_materialized_epoch_ms TO last_materialized_epoch`);
  db.pragma('user_version = 42');

  // Trigger the cutover read-only flip (installs the three triggers + sets read_only=1).
  flipLegacyArtifactsReadOnly(db);

  return db;
}

describe('V43 migration on cutover-flipped DB', () => {
  it('completes the rename + scale step without hitting the read-only trigger', () => {
    const db = buildV42LikeDbWithCutoverFlip();

    // Sanity: triggers exist + read_only flag is set before migration runs
    const triggersBefore = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'prevent_legacy_%'`)
      .all() as Array<{ name: string }>;
    expect(triggersBefore.length).toBe(3);

    const flippedBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE read_only = 1`).get() as { n: number }
    ).n;
    expect(flippedBefore).toBeGreaterThan(0);

    // V43 should succeed (this was the regression — without the fix, this throws
    // SqliteError: 'legacy artifacts table is read-only post-cutover; write to V17 artifact table instead')
    expect(() => migrateV42toV43(db)).not.toThrow();

    // After V43: column is renamed + value is scaled
    const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'timestamp_epoch_ms')).toBe(true);
    expect(cols.some(c => c.name === 'timestamp_epoch')).toBe(false);

    const row = db.prepare(`SELECT timestamp_epoch_ms FROM artifacts WHERE summary = 'seed'`).get() as { timestamp_epoch_ms: number };
    expect(row.timestamp_epoch_ms).toBe(1700000000 * 1000);

    // The triggers must be re-installed so post-migration writes are still blocked
    const triggersAfter = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'prevent_legacy_%'`)
      .all() as Array<{ name: string }>;
    expect(triggersAfter.length).toBe(3);

    // And read_only enforcement is still effective: a new write attempt aborts
    expect(() =>
      db.exec(`UPDATE artifacts SET summary = 'tampered' WHERE summary = 'seed'`),
    ).toThrow(/legacy artifacts table is read-only/);

    db.close();
  });

  it('leaves user_version at 43 after success (no retry-loop)', () => {
    const db = buildV42LikeDbWithCutoverFlip();
    migrateV42toV43(db);

    const v = db.pragma('user_version', { simple: true }) as number;
    expect(v).toBe(43);

    db.close();
  });

  it('does not drop triggers on a DB where read_only flag is not set', () => {
    // Build a V42-like DB WITHOUT the cutover flip. V43 should not need to
    // touch triggers and should not leave triggers in a different state.
    const db = new Database(':memory:');
    initializeSchema(db);
    db.exec(`ALTER TABLE artifacts RENAME COLUMN timestamp_epoch_ms TO timestamp_epoch`);
    db.exec(`ALTER TABLE artifacts RENAME COLUMN last_materialized_epoch_ms TO last_materialized_epoch`);
    db.pragma('user_version = 42');

    // No triggers installed (no cutover flip)
    const triggersBefore = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'prevent_legacy_%'`)
      .all();
    expect(triggersBefore.length).toBe(0);

    expect(() => migrateV42toV43(db)).not.toThrow();

    // Still no triggers after — we shouldn't accidentally install them
    const triggersAfter = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'prevent_legacy_%'`)
      .all();
    expect(triggersAfter.length).toBe(0);

    db.close();
  });
});
