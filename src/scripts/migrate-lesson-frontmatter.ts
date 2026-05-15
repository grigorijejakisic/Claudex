/**
 * Phase 14 Plan 14-06 — lesson frontmatter epoch migrator.
 *
 * Walks ~/.claude/projects/<slug>/memory/ (or --dir override) and upgrades
 * every lesson file whose frontmatter uses the legacy `created_at_epoch`
 * field (seconds) to the V35 canonical `created_at_epoch_ms` field (ms).
 *
 * Idempotent: files already using `created_at_epoch_ms` are skipped.
 * Atomic: writes via tmp + renameSync (same pattern as lesson-writer.ts).
 *
 * Usage:
 *   bun src/scripts/migrate-lesson-frontmatter.ts [--dry-run] [--dir <path>]
 *
 * Exit codes:
 *   0 — success (migrated N files, M skipped)
 *   1 — argument or validation error
 *   2 — IO error
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigratorArgs {
  dryRun: boolean;
  /** Root to search. Defaults to ~/.claude/projects. */
  searchRoot: string;
}

export interface MigrateResult {
  migrated: string[];
  skipped: string[];
  errors: Array<{ file: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): MigratorArgs {
  const args = argv.slice(2);
  let dryRun = false;
  let searchRoot = path.join(os.homedir(), '.claude', 'projects');

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
      i++;
    } else if (arg === '--dir') {
      i++;
      if (i >= args.length) {
        process.stderr.write('error: --dir requires a value\n');
        process.exit(1);
      }
      searchRoot = args[i];
      i++;
    } else {
      process.stderr.write(`error: unknown flag: ${arg}\n`);
      process.exit(1);
    }
  }

  return { dryRun, searchRoot };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const FILENAME_RE = /^(feedback|project|process)_([a-z0-9][a-z0-9_-]{0,59})\.md$/;

/**
 * Enumerate all lesson files under <searchRoot>/<slug>/memory/*.md.
 * Returns absolute paths for files matching FILENAME_RE.
 */
export function discoverLessonFiles(searchRoot: string): string[] {
  const results: string[] = [];

  let slugDirs: string[];
  try {
    slugDirs = fs.readdirSync(searchRoot);
  } catch {
    return results;
  }

  for (const slug of slugDirs) {
    const memDir = path.join(searchRoot, slug, 'memory');
    let entries: string[];
    try {
      entries = fs.readdirSync(memDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (FILENAME_RE.test(name)) {
        results.push(path.join(memDir, name));
      }
    }
  }

  return results.sort();
}

// ---------------------------------------------------------------------------
// Per-file migration
// ---------------------------------------------------------------------------

/**
 * Result of inspecting one lesson file.
 * - `needsMigration`: true if `created_at_epoch` (sec) is present and
 *   `created_at_epoch_ms` is absent.
 * - `epochSec`: the raw value from `created_at_epoch` (if present).
 * - `alreadyMs`: true if `created_at_epoch_ms` is already present.
 */
export interface FileInspection {
  needsMigration: boolean;
  alreadyMs: boolean;
  epochSec?: number;
}

/**
 * Inspect a lesson file's frontmatter to determine migration status.
 * Non-throwing — returns { needsMigration: false, alreadyMs: false } on parse failure.
 */
export function inspectLessonFile(filePath: string): FileInspection {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { needsMigration: false, alreadyMs: false };
  }

  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { needsMigration: false, alreadyMs: false };
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx < 0) return { needsMigration: false, alreadyMs: false };

  const fmRaw = normalized.slice(4, endIdx);

  let hasLegacyEpoch = false;
  let hasEpochMs = false;
  let epochSec: number | undefined;

  for (const line of fmRaw.split('\n')) {
    // Only top-level keys (no leading whitespace)
    if (line.startsWith(' ') || line.startsWith('\t')) continue;

    const m = /^([a-z_]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;

    if (key === 'created_at_epoch_ms') {
      hasEpochMs = true;
    } else if (key === 'created_at_epoch') {
      const n = Number(value.trim());
      if (Number.isFinite(n) && n > 0) {
        hasLegacyEpoch = true;
        epochSec = n;
      }
    }
  }

  if (hasEpochMs) {
    return { needsMigration: false, alreadyMs: true };
  }
  if (hasLegacyEpoch && epochSec !== undefined) {
    return { needsMigration: true, alreadyMs: false, epochSec };
  }
  return { needsMigration: false, alreadyMs: false };
}

/**
 * Rewrite a lesson file, replacing `created_at_epoch: <sec>` with
 * `created_at_epoch_ms: <ms>` in the frontmatter block.
 *
 * Returns the migrated content string. Throws on IO error.
 * Non-throwing if file inspection shows no migration needed (returns null).
 */
export function migrateFileContent(filePath: string, epochSec: number): string {
  const raw = fs.readFileSync(filePath, 'utf8');
  const normalized = raw.replace(/\r\n/g, '\n');

  // Compute ms value. If the stored value looks like ms already (>= 1e12),
  // use it directly (guard against double-scaling on already-ms files that
  // used the old field name).
  const epochMs = epochSec >= 1e12 ? epochSec : epochSec * 1000;

  // Replace the first occurrence of `created_at_epoch: <value>` with
  // `created_at_epoch_ms: <epochMs>` in the frontmatter block only.
  const endIdx = normalized.indexOf('\n---\n', 4);
  const fmBlock = normalized.slice(4, endIdx);
  const bodyBlock = normalized.slice(endIdx); // includes the closing `\n---\n`

  // Line-by-line replacement to avoid regex over the body section.
  const migratedFmLines = fmBlock.split('\n').map(line => {
    if (line.startsWith(' ') || line.startsWith('\t')) return line;
    const m = /^(created_at_epoch):\s/.exec(line);
    if (m && m[1] === 'created_at_epoch') {
      return `created_at_epoch_ms: ${epochMs}`;
    }
    return line;
  });

  return '---\n' + migratedFmLines.join('\n') + bodyBlock;
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Atomically write content to filePath via tmp + renameSync.
 * Windows-lock retry (50ms busy-wait) mirrors lesson-writer.ts pattern.
 */
export function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + '.migrate.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    const start = Date.now();
    while (Date.now() - start < 50) { /* busy-wait for Windows AV/editor unlock */ }
    fs.renameSync(tmp, filePath);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<number> {
  let args: MigratorArgs;
  try {
    args = parseArgs(argv);
  } catch {
    return 1;
  }

  const { dryRun, searchRoot } = args;

  if (!fs.existsSync(searchRoot)) {
    process.stderr.write(`error: search root does not exist: ${searchRoot}\n`);
    return 1;
  }

  const files = discoverLessonFiles(searchRoot);
  if (files.length === 0) {
    process.stdout.write('no lesson files found\n');
    return 0;
  }

  const result: MigrateResult = { migrated: [], skipped: [], errors: [] };

  for (const filePath of files) {
    const inspection = inspectLessonFile(filePath);

    if (inspection.alreadyMs) {
      result.skipped.push(filePath);
      if (dryRun) {
        process.stdout.write(`skip (already canonical): ${filePath}\n`);
      }
      continue;
    }

    if (!inspection.needsMigration) {
      result.skipped.push(filePath);
      if (dryRun) {
        process.stdout.write(`skip (no legacy field): ${filePath}\n`);
      }
      continue;
    }

    // Needs migration.
    const epochSec = inspection.epochSec!;
    const epochMs = epochSec >= 1e12 ? epochSec : epochSec * 1000;

    let migrated: string;
    try {
      migrated = migrateFileContent(filePath, epochSec);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: filePath, reason });
      process.stderr.write(`error reading ${filePath}: ${reason}\n`);
      continue;
    }

    if (dryRun) {
      process.stdout.write(
        `would migrate: ${filePath}` +
        ` (created_at_epoch=${epochSec} → created_at_epoch_ms=${epochMs})\n`,
      );
      result.migrated.push(filePath);
      continue;
    }

    // Live write.
    try {
      atomicWrite(filePath, migrated);
      process.stdout.write(
        `migrated: ${filePath}` +
        ` (created_at_epoch=${epochSec} → created_at_epoch_ms=${epochMs})\n`,
      );
      result.migrated.push(filePath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: filePath, reason });
      process.stderr.write(`error writing ${filePath}: ${reason}\n`);
    }
  }

  // Summary line.
  process.stdout.write(
    `\ndone: ${result.migrated.length} migrated, ` +
    `${result.skipped.length} skipped, ` +
    `${result.errors.length} errors` +
    (dryRun ? ' (dry-run)' : '') + '\n',
  );

  return result.errors.length > 0 ? 2 : 0;
}

// Run if invoked directly.
if (
  process.argv[1] &&
  (path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('migrate-lesson-frontmatter.ts') ||
    path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('migrate-lesson-frontmatter.js'))
) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    });
}
