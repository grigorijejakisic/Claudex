/**
 * claudex migrate CLI — automated v2-to-v3 database migration.
 * Backs up the existing DB, creates a fresh v3 DB, migrates data,
 * verifies row counts and schema integrity, then swaps atomically.
 *
 * Usage:
 *   node dist/cli/migrate.cjs [--source <path>] [--dry-run] [--force]
 *
 * @see Architecture Section 4.3.2 (Migration)
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../core/storage.js';
import { initializeSchema, migrateFromV2, detectV2Database } from '../core/migrations.js';
import { getDbPath } from '../shared/paths.js';
import { SCHEMA_VERSION } from '../shared/constants.js';

// ── Types ────────────────────────────────────────────────────────────

export interface MigrateArgs {
  source?: string;
  dryRun: boolean;
  force: boolean;
}

export interface MigrateResult {
  success: boolean;
  backupPath?: string;
  newDbPath?: string;
  sourceCounts: RowCounts;
  targetCounts: RowCounts;
  errors: string[];
  steps: string[];
}

interface RowCounts {
  observations: number;
  sessions: number;
  pressureScores: number;
}

// ── Arg parsing ──────────────────────────────────────────────────────

/**
 * Parses process.argv-style arguments for the migrate command.
 * Exported for testability.
 */
export function parseArgs(argv: string[]): MigrateArgs {
  const args = argv.slice(2);
  let source: string | undefined;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--source' && i + 1 < args.length) {
      source = args[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    }
  }

  return { source, dryRun, force };
}

// ── Row count helpers ────────────────────────────────────────────────

/**
 * Gets row counts from a database. Non-throwing — returns zeros on error.
 */
export function getRowCounts(db: Database.Database): RowCounts {
  const counts: RowCounts = { observations: 0, sessions: 0, pressureScores: 0 };
  try {
    const obs = db.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number } | undefined;
    counts.observations = obs?.cnt ?? 0;
  } catch { /* table may not exist */ }
  try {
    const sess = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number } | undefined;
    counts.sessions = sess?.cnt ?? 0;
  } catch { /* table may not exist */ }
  try {
    const press = db.prepare('SELECT COUNT(*) as cnt FROM pressure_scores').get() as { cnt: number } | undefined;
    counts.pressureScores = press?.cnt ?? 0;
  } catch { /* table may not exist */ }
  return counts;
}

// ── Verification ─────────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

/**
 * Runs post-migration verification queries on the new DB.
 * Compares row counts against source and checks JSON validity + schema version.
 */
export function verifyMigration(
  targetDb: Database.Database,
  sourceCounts: RowCounts
): VerificationResult {
  const checks: VerificationResult['checks'] = [];

  // 1. Observation count
  const targetCounts = getRowCounts(targetDb);
  checks.push({
    name: 'observations_count',
    passed: targetCounts.observations === sourceCounts.observations,
    detail: `source=${sourceCounts.observations} target=${targetCounts.observations}`,
  });

  // 2. Sessions count
  checks.push({
    name: 'sessions_count',
    passed: targetCounts.sessions === sourceCounts.sessions,
    detail: `source=${sourceCounts.sessions} target=${targetCounts.sessions}`,
  });

  // 3. Pressure scores count
  checks.push({
    name: 'pressure_scores_count',
    passed: targetCounts.pressureScores === sourceCounts.pressureScores,
    detail: `source=${sourceCounts.pressureScores} target=${targetCounts.pressureScores}`,
  });

  // 4. JSON validity of files_modified
  try {
    const invalid = targetDb
      .prepare('SELECT COUNT(*) as cnt FROM observations WHERE NOT json_valid(files_modified)')
      .get() as { cnt: number } | undefined;
    const invalidCount = invalid?.cnt ?? 0;
    checks.push({
      name: 'json_valid_files_modified',
      passed: invalidCount === 0,
      detail: `invalid_count=${invalidCount}`,
    });
  } catch (err) {
    checks.push({
      name: 'json_valid_files_modified',
      passed: false,
      detail: `query_error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 5. Schema version
  try {
    const row = targetDb
      .prepare('SELECT version FROM schema_versions ORDER BY applied_at_epoch DESC LIMIT 1')
      .get() as { version: number } | undefined;
    const version = row?.version ?? 0;
    checks.push({
      name: 'schema_version',
      passed: version === SCHEMA_VERSION,
      detail: `version=${version} expected=${SCHEMA_VERSION}`,
    });
  } catch (err) {
    checks.push({
      name: 'schema_version',
      passed: false,
      detail: `query_error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

// ── Safe file swap (Windows-aware) ───────────────────────────────────

/**
 * Swaps newPath into currentPath using a .pre-swap intermediate.
 * On Windows, rename can't overwrite an existing file, so we:
 *   1. Move current -> current.pre-swap
 *   2. Move new -> current
 * On failure, attempts rollback of step 1.
 *
 * Handles stale .pre-swap from prior failed attempt (REC-20).
 */
export function safeSwap(currentPath: string, newPath: string): void {
  const preSwapPath = currentPath + '.pre-swap';

  // REC-20: Clean up stale .pre-swap if it exists
  if (fs.existsSync(preSwapPath)) {
    try {
      fs.unlinkSync(preSwapPath);
    } catch {
      // If we can't remove it, try renaming it out of the way
      try {
        fs.renameSync(preSwapPath, preSwapPath + '.old');
      } catch {
        throw new Error(`Cannot clean up stale .pre-swap file at ${preSwapPath}`);
      }
    }
  }

  // Step 1: Move current -> pre-swap
  try {
    fs.renameSync(currentPath, preSwapPath);
  } catch (err) {
    throw new Error(
      `Swap step 1 failed (move current to .pre-swap): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Step 2: Move new -> current
  try {
    fs.renameSync(newPath, currentPath);
  } catch (err) {
    // Attempt rollback: move .pre-swap back to current
    try {
      fs.renameSync(preSwapPath, currentPath);
    } catch (rollbackErr) {
      throw new Error(
        `Swap step 2 failed AND rollback failed. ` +
        `Original DB at: ${preSwapPath}. ` +
        `New DB at: ${newPath}. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}. ` +
        `Rollback error: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
      );
    }
    throw new Error(
      `Swap step 2 failed (move new to current), rolled back successfully: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Cleanup: remove .pre-swap (best-effort)
  try {
    fs.unlinkSync(preSwapPath);
  } catch {
    // Non-critical — leave it for manual cleanup
  }
}

/**
 * Cleans up the temporary migration source copy and its WAL/SHM files.
 * Best-effort — never throws.
 */
function cleanupMigrationSource(migrationSourcePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const p = migrationSourcePath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* best-effort */ }
  }
}

// ── Main migration logic ─────────────────────────────────────────────

/**
 * Runs the full migration pipeline.
 * Exported for testability — accepts explicit paths instead of using defaults.
 */
export function runMigration(sourcePath: string, opts: { dryRun?: boolean; force?: boolean } = {}): MigrateResult {
  const result: MigrateResult = {
    success: false,
    sourceCounts: { observations: 0, sessions: 0, pressureScores: 0 },
    targetCounts: { observations: 0, sessions: 0, pressureScores: 0 },
    errors: [],
    steps: [],
  };

  // ── Step 1: Validate source exists ──────────────────────────────
  if (!fs.existsSync(sourcePath)) {
    result.errors.push(`Source database not found: ${sourcePath}`);
    return result;
  }
  result.steps.push(`Validated source: ${sourcePath}`);

  // ── Step 1b: Guard against migrating an already-v3 database ────
  try {
    const testDb = new Database(sourcePath, { readonly: true });
    try {
      const row = testDb.prepare('SELECT MAX(version) as version FROM schema_versions').get() as { version: number } | undefined;
      if (row && row.version >= SCHEMA_VERSION) {
        testDb.close();
        result.errors.push(`Source database is already v3 (version=${row.version}). Migration not needed.`);
        return result;
      }
    } catch {
      // No schema_versions table or query error — assume it's a v2 database, proceed
    } finally {
      try { testDb.close(); } catch { /* ignore */ }
    }
  } catch {
    // Can't open the DB to check — proceed and let later steps handle it
  }

  // ── Step 2: Read source row counts ──────────────────────────────
  let sourceDb: Database.Database | null = null;
  try {
    sourceDb = new Database(sourcePath, { readonly: true });
    sourceDb.pragma('busy_timeout = 5000');
    result.sourceCounts = getRowCounts(sourceDb);
    result.steps.push(
      `Source counts: observations=${result.sourceCounts.observations} ` +
      `sessions=${result.sourceCounts.sessions} ` +
      `pressure_scores=${result.sourceCounts.pressureScores}`
    );
  } catch (err) {
    result.errors.push(`Failed to read source database: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  } finally {
    if (sourceDb) {
      try { sourceDb.close(); } catch { /* ignore */ }
    }
  }

  // ── Step 3: Create backup ───────────────────────────────────────
  // Checkpoint WAL before copying to ensure all committed data is in the main file.
  // Without this, copyFileSync only copies the main .db and misses WAL-committed rows.
  try {
    const checkpointDb = new Database(sourcePath);
    checkpointDb.pragma('wal_checkpoint(TRUNCATE)');
    checkpointDb.close();
    result.steps.push('WAL checkpointed before backup');
  } catch {
    // Non-critical: source may not be in WAL mode, or may not have a WAL file.
    // Proceed with backup anyway — the main file is still valid.
  }

  const backupPath = sourcePath + '.v2-backup';
  result.backupPath = backupPath;

  if (fs.existsSync(backupPath)) {
    if (!opts.force) {
      result.steps.push(`Backup already exists: ${backupPath} (skipped, use --force to overwrite)`);
    } else {
      try {
        fs.copyFileSync(sourcePath, backupPath);
        result.steps.push(`Backup overwritten (--force): ${backupPath}`);
      } catch (err) {
        result.errors.push(`Failed to overwrite backup: ${err instanceof Error ? err.message : String(err)}`);
        return result;
      }
    }
  } else {
    try {
      fs.copyFileSync(sourcePath, backupPath);
      result.steps.push(`Backup created: ${backupPath}`);
    } catch (err) {
      result.errors.push(`Failed to create backup: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }

  if (opts.dryRun) {
    result.steps.push('Dry run — stopping before migration');
    result.success = true;
    return result;
  }

  // ── Step 3b: Create migration source (upgraded copy) ────────────
  // migrateFromV2() expects the v2 source to have v3 column names
  // (created_at_epoch, source). We create a working copy of the source,
  // apply initializeSchema to upgrade its columns, then use it as the
  // ATTACH source. This keeps the backup pristine.
  const migrationSourcePath = sourcePath + '.v2-migration-source';
  try {
    fs.copyFileSync(sourcePath, migrationSourcePath);
  } catch (err) {
    result.errors.push(`Failed to create migration source copy: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  let upgradeDb: Database.Database | null = null;
  try {
    upgradeDb = openDatabase(migrationSourcePath);
    initializeSchema(upgradeDb);
    // Checkpoint WAL before closing to release file locks on Windows
    try { upgradeDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
    result.steps.push('Migration source schema upgraded for compatibility');
  } catch (err) {
    result.errors.push(`Failed to upgrade migration source schema: ${err instanceof Error ? err.message : String(err)}`);
    if (upgradeDb) {
      try { upgradeDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      closeDatabase(upgradeDb);
    }
    cleanupMigrationSource(migrationSourcePath);
    return result;
  } finally {
    if (upgradeDb) {
      closeDatabase(upgradeDb);
      upgradeDb = null;
    }
  }

  // ── Step 4: Create fresh v3 DB at temp path ─────────────────────
  const tempPath = sourcePath + '.v3-new';
  result.newDbPath = tempPath;

  // Clean up prior failed attempt
  if (fs.existsSync(tempPath)) {
    try {
      fs.unlinkSync(tempPath);
      result.steps.push(`Cleaned up stale temp DB: ${tempPath}`);
    } catch (err) {
      result.errors.push(`Failed to remove stale temp DB: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }
  // Also clean WAL/SHM files from prior attempts
  for (const suffix of ['-wal', '-shm']) {
    const walPath = tempPath + suffix;
    if (fs.existsSync(walPath)) {
      try { fs.unlinkSync(walPath); } catch { /* best-effort */ }
    }
  }

  let freshDb: Database.Database | null = null;
  try {
    // Initialize fresh v3 DB
    freshDb = openDatabase(tempPath);
    initializeSchema(freshDb);
    result.steps.push(`Fresh v3 database created: ${tempPath}`);

    // ── Step 5: Migrate data from upgraded source copy ─────────
    // Use the migration source (upgraded v2 copy) — not the pristine backup
    migrateFromV2(freshDb, migrationSourcePath);
    result.steps.push('Migration completed');

    // ── Step 6: Verify ──────────────────────────────────────────
    const verification = verifyMigration(freshDb, result.sourceCounts);
    result.targetCounts = getRowCounts(freshDb);

    for (const check of verification.checks) {
      const status = check.passed ? 'PASS' : 'FAIL';
      result.steps.push(`Verify ${check.name}: ${status} (${check.detail})`);
    }

    if (!verification.passed) {
      const failedChecks = verification.checks.filter((c) => !c.passed).map((c) => c.name);
      result.errors.push(`Verification failed: ${failedChecks.join(', ')}`);
      // Close DB before cleanup
      closeDatabase(freshDb);
      freshDb = null;
      // Don't swap — delete temp DB, preserve backup
      try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }
      cleanupMigrationSource(migrationSourcePath);
      return result;
    }

    // Close the fresh DB before swap (REC-21: ensure DB is closed)
    closeDatabase(freshDb);
    freshDb = null;
    result.steps.push('Database handles closed');

    // ── Step 7: Swap ────────────────────────────────────────────
    try {
      safeSwap(sourcePath, tempPath);
      result.steps.push(`Swap complete: ${tempPath} -> ${sourcePath}`);
    } catch (err) {
      result.errors.push(`Swap failed: ${err instanceof Error ? err.message : String(err)}`);
      // Temp DB may still exist — don't delete it, user may want to recover
      return result;
    }

    cleanupMigrationSource(migrationSourcePath);
    result.success = true;
    return result;
  } catch (err) {
    // Migration or other step threw
    result.errors.push(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    // Close DB if still open
    if (freshDb) {
      closeDatabase(freshDb);
      freshDb = null;
    }
    // Clean up temp DB, preserve backup
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch { /* best-effort */ }
    cleanupMigrationSource(migrationSourcePath);
    return result;
  }
}

// ── CLI output formatting ────────────────────────────────────────────

export function formatResult(result: MigrateResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push('=== Migration Successful ===');
  } else {
    lines.push('=== Migration Failed ===');
  }
  lines.push('');

  for (const step of result.steps) {
    lines.push(`  [+] ${step}`);
  }

  if (result.errors.length > 0) {
    lines.push('');
    for (const err of result.errors) {
      lines.push(`  [!] ${err}`);
    }
  }

  if (result.success) {
    lines.push('');
    lines.push('Summary:');
    lines.push(`  Observations: ${result.targetCounts.observations}`);
    lines.push(`  Sessions:     ${result.targetCounts.sessions}`);
    lines.push(`  Pressure:     ${result.targetCounts.pressureScores}`);
    if (result.backupPath) {
      lines.push(`  Backup:       ${result.backupPath}`);
    }
  }

  return lines.join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);

  // Resolve source path
  const sourcePath = args.source ?? detectV2Database() ?? getDbPath();

  if (!fs.existsSync(sourcePath)) {
    console.error(`[ERROR] No database found at: ${sourcePath}`);
    console.error('Use --source <path> to specify the v2 database location.');
    process.exit(1);
  }

  console.log('Claudex v2 -> v3 Migration');
  console.log('==========================\n');
  console.log(`Source: ${sourcePath}`);
  if (args.dryRun) console.log('Mode: DRY RUN\n');

  const result = runMigration(sourcePath, { dryRun: args.dryRun, force: args.force });
  console.log('\n' + formatResult(result));

  process.exit(result.success ? 0 : 1);
}

// Only auto-run when executed directly
const isDirectRun = typeof require !== 'undefined' && require.main === module
  || process.argv[1]?.endsWith('migrate.cjs')
  || process.argv[1]?.endsWith('migrate.js')
  || process.argv[1]?.endsWith('migrate.ts');

if (isDirectRun) {
  main();
}
