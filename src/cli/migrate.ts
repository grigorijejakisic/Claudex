/**
 * claudex migrate CLI — automates v2→v3 database migration.
 * Detects v2 DB, backs it up, migrates to a fresh v3 DB, verifies integrity,
 * then swaps the temp DB into the main path.
 *
 * Migration strategy (safe swap):
 *   1. Copy original → backup (.v2-backup)
 *   2. Create fresh v3 DB at temp path
 *   3. Run migrateFromV2(tempDb, backupPath)
 *   4. Verify integrity on temp DB
 *   5. Rename temp → main path (atomic swap)
 *
 * This ensures original DB is untouched until the final swap succeeds.
 * @see Architecture Section 4.3.2
 */

import * as fs from 'fs';
import * as path from 'path';
import { openDatabase, closeDatabase } from '../core/storage.js';
import { initializeSchema, migrateFromV2, detectV2Database } from '../core/migrations.js';
import { getDbPath, getClaudexHome } from '../shared/paths.js';
import Database from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────

export interface MigrationCounts {
  observationCount: number;
  sessionCount: number;
  pressureCount: number;
}

export interface MigrationResult {
  success: boolean;
  counts: MigrationCounts;
  backupPath: string;
  error?: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Gathers row counts from a database (v2 or v3) for display and verification.
 * Non-throwing — returns zeroed stats on any error.
 */
export function getDbStats(dbPath: string): MigrationCounts {
  const stats: MigrationCounts = { observationCount: 0, sessionCount: 0, pressureCount: 0 };
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      try {
        const obs = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
        stats.observationCount = obs.count;
      } catch { /* table may not exist */ }
      try {
        const sess = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
        stats.sessionCount = sess.count;
      } catch { /* table may not exist */ }
      try {
        const press = db.prepare('SELECT COUNT(*) as count FROM pressure_scores').get() as { count: number };
        stats.pressureCount = press.count;
      } catch { /* table may not exist */ }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch { /* non-throwing */ }
  return stats;
}

/**
 * Verifies the integrity of a migrated v3 database against expected counts.
 * Checks:
 *   - observation/session/pressure_score counts match expected
 *   - all observations have valid JSON in files_modified
 *   - schema_versions contains version 300
 *
 * Returns { valid: true } on success, { valid: false, reason } on failure.
 * Non-throwing — wraps all DB access.
 */
export function verifyMigration(db: Database.Database, expected: MigrationCounts): VerifyResult {
  try {
    // Check schema version 300
    const versionRow = db
      .prepare('SELECT version FROM schema_versions WHERE version = 300')
      .get() as { version: number } | undefined;
    if (!versionRow) {
      return { valid: false, reason: 'schema_versions does not contain version 300' };
    }

    // Check observation count
    const obsRow = db
      .prepare('SELECT COUNT(*) as count FROM observations')
      .get() as { count: number };
    if (obsRow.count !== expected.observationCount) {
      return {
        valid: false,
        reason: `observation count mismatch: expected ${expected.observationCount}, got ${obsRow.count}`,
      };
    }

    // Check session count
    const sessRow = db
      .prepare('SELECT COUNT(*) as count FROM sessions')
      .get() as { count: number };
    if (sessRow.count !== expected.sessionCount) {
      return {
        valid: false,
        reason: `session count mismatch: expected ${expected.sessionCount}, got ${sessRow.count}`,
      };
    }

    // Check pressure_score count
    const pressRow = db
      .prepare('SELECT COUNT(*) as count FROM pressure_scores')
      .get() as { count: number };
    if (pressRow.count !== expected.pressureCount) {
      return {
        valid: false,
        reason: `pressure_score count mismatch: expected ${expected.pressureCount}, got ${pressRow.count}`,
      };
    }

    // Check all observations have valid JSON in files_modified
    const invalidJsonRow = db
      .prepare("SELECT COUNT(*) as count FROM observations WHERE NOT json_valid(files_modified)")
      .get() as { count: number };
    if (invalidJsonRow.count > 0) {
      return {
        valid: false,
        reason: `${invalidJsonRow.count} observation(s) have invalid JSON in files_modified`,
      };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Runs the full v2→v3 migration for a given DB path.
 * Safe swap strategy: backup → temp → verify → swap.
 * Exported for testability.
 *
 * @param dbPath - The main (v2) database path to migrate in-place
 * @returns MigrationResult with success flag, counts, and backup path
 */
export function runMigration(dbPath: string): MigrationResult {
  const dbDir = path.dirname(dbPath);
  const backupPath = dbPath + '.v2-backup';
  const tempPath = path.join(dbDir, 'claudex-v3-temp.db');

  // Step 1: Read v2 stats before migration
  const v2Stats = getDbStats(dbPath);

  // Step 2: Backup the original DB
  try {
    fs.copyFileSync(dbPath, backupPath);
  } catch (err) {
    return {
      success: false,
      counts: v2Stats,
      backupPath,
      error: `Failed to create backup: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 3: Create fresh v3 DB at temp path
  // Clean up any leftover temp DB from a previous failed attempt
  try {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch { /* non-critical — openDatabase will overwrite */ }

  let tempDb: Database.Database | null = null;
  try {
    tempDb = openDatabase(tempPath);

    // Step 4: Initialize v3 schema on temp DB
    initializeSchema(tempDb);

    // Step 5: Migrate from backup into temp DB
    // CRITICAL: use backupPath as source (not dbPath) to avoid same-path guard
    migrateFromV2(tempDb, backupPath);

    // Step 6: Verify integrity
    const verifyResult = verifyMigration(tempDb, v2Stats);
    if (!verifyResult.valid) {
      closeDatabase(tempDb);
      tempDb = null;
      return {
        success: false,
        counts: v2Stats,
        backupPath,
        error: `Integrity check failed: ${verifyResult.reason}`,
      };
    }

    closeDatabase(tempDb);
    tempDb = null;

    // Step 7: Atomic swap — rename temp DB to main path
    // On Windows, rename fails if target exists; remove first
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
      fs.renameSync(tempPath, dbPath);
    } catch (err) {
      return {
        success: false,
        counts: v2Stats,
        backupPath,
        error: `Failed to swap temp DB to main path: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Clean up WAL/SHM sidecar files for both paths:
    // - original DB (dbPath): orphaned after unlink; if left, SQLite may apply v2 WAL to v3 DB on open
    // - temp DB (tempPath): not moved by renameSync, left as orphans if they exist
    for (const ext of ['-wal', '-shm']) {
      for (const base of [dbPath, tempPath]) {
        try {
          const side = base + ext;
          if (fs.existsSync(side)) fs.unlinkSync(side);
        } catch { /* non-critical */ }
      }
    }

    return { success: true, counts: v2Stats, backupPath };
  } catch (err) {
    if (tempDb) {
      try { closeDatabase(tempDb); } catch { /* ignore */ }
    }
    // Clean up temp DB on failure
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch { /* non-critical */ }
    return {
      success: false,
      counts: v2Stats,
      backupPath,
      error: `Migration failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Main entry point ──────────────────────────────────────────────────

/**
 * Main migrate entry point.
 */
export async function main(): Promise<void> {
  console.log('Claudex v3 Migration');
  console.log('====================\n');

  // 1. Detect v2 database
  const v2Path = detectV2Database();
  if (!v2Path) {
    console.log('[INFO] No v2 database detected. Nothing to migrate.');
    console.log('       (Expected locations: ~/.claudex/claudex.db or ~/.claudex/db/claudex.db)');
    process.exit(0);
  }

  // 2. Show v2 stats
  const v2Stats = getDbStats(v2Path);
  console.log(`[INFO] v2 database found: ${v2Path}`);
  console.log(`  Observations:   ${v2Stats.observationCount}`);
  console.log(`  Sessions:       ${v2Stats.sessionCount}`);
  console.log(`  Pressure scores: ${v2Stats.pressureCount}`);
  console.log('');

  // 3. Run migration
  console.log('[INFO] Starting migration...');
  const result = runMigration(v2Path);

  if (!result.success) {
    console.error(`[ERROR] Migration failed: ${result.error}`);
    console.error(`[INFO]  Original database preserved at: ${v2Path}`);
    process.exit(1);
  }

  // 4. Report success
  console.log(`[OK] Backup created: ${result.backupPath}`);
  console.log(`[OK] Migration complete!`);
  console.log(`  Observations:    ${result.counts.observationCount}`);
  console.log(`  Sessions:        ${result.counts.sessionCount}`);
  console.log(`  Pressure scores: ${result.counts.pressureCount}`);
  console.log('');
  console.log(`[OK] v3 database ready: ${v2Path}`);
  console.log(`[OK] v2 backup retained: ${result.backupPath}`);

  process.exit(0);
}

// Only auto-run when executed directly (not when imported for tests)
const isDirectRun =
  typeof require !== 'undefined' && require.main === module
  || process.argv[1]?.endsWith('migrate.cjs')
  || process.argv[1]?.endsWith('migrate.js')
  || process.argv[1]?.endsWith('migrate.ts');

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[ERROR] Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
