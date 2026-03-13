/**
 * claudex setup CLI — fresh install entry point.
 * Creates directory structure, initializes DB, writes config,
 * patches ~/.claude/settings.json with hook paths, offers optional v2 migration.
 * @see Architecture Section 4.3
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { openDatabase, closeDatabase } from '../core/storage.js';
import { initializeSchema, migrateFromV2, detectV2Database } from '../core/migrations.js';
import { getDbPath, getClaudexHome, getConfigPath } from '../shared/paths.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../shared/fs-helpers.js';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import Database from 'better-sqlite3';

/** Hook file paths matching build.ts output in dist/adapters/cc-hooks/. */
const HOOK_FILES: Record<string, string> = {
  SessionStart: path.join('adapters', 'cc-hooks', 'session-start.cjs'),
  UserPromptSubmit: path.join('adapters', 'cc-hooks', 'user-prompt-submit.cjs'),
  PostToolUse: path.join('adapters', 'cc-hooks', 'post-tool-use.cjs'),
  Stop: path.join('adapters', 'cc-hooks', 'stop.cjs'),
  PreCompact: path.join('adapters', 'cc-hooks', 'pre-compact.cjs'),
  SessionEnd: path.join('adapters', 'cc-hooks', 'session-end.cjs'),
};

/**
 * Returns absolute paths to all hook dist files for the given install directory.
 */
export function getHookPaths(installDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [hookName, fileName] of Object.entries(HOOK_FILES)) {
    result[hookName] = path.resolve(installDir, 'dist', fileName);
  }
  return result;
}

/**
 * Returns the path to ~/.claude/settings.json.
 */
export function getSettingsJsonPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Patches settings.json with hook entries, preserving existing hooks and settings.
 * Claudex hooks are identified by 'claudex' or 'CLAUDEXv3' in the command path.
 * Returns { patched: true, created: boolean }.
 */
export function patchSettingsJson(
  settingsPath: string,
  hookPaths: Record<string, string>
): { patched: boolean; created: boolean } {
  let settings = readJsonFile<Record<string, unknown>>(settingsPath);
  const existed = settings !== null;

  if (!settings) {
    settings = {};
  }

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  const hooks = settings.hooks as Record<string, unknown[]>;

  for (const [hookName, hookPath] of Object.entries(hookPaths)) {
    const command = `node "${hookPath}"`;
    const newEntry = {
      matcher: '',
      hooks: [{ type: 'command', command }],
    };

    if (!Array.isArray(hooks[hookName])) {
      hooks[hookName] = [newEntry];
      continue;
    }

    const hookArray = hooks[hookName] as Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;

    // Find existing Claudex entry
    const claudexIndex = hookArray.findIndex((entry) => {
      if (!entry.hooks || !Array.isArray(entry.hooks)) return false;
      return entry.hooks.some(
        (h) =>
          typeof h.command === 'string' &&
          (h.command.toLowerCase().includes('claudex'))
      );
    });

    if (claudexIndex >= 0) {
      // Update in-place
      hookArray[claudexIndex] = newEntry;
    } else {
      // Append
      hookArray.push(newEntry);
    }
  }

  // Write synchronously for setup (simpler than async)
  try {
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch {
    return { patched: false, created: false };
  }

  return { patched: true, created: !existed };
}

/**
 * Gathers row counts from a v2 database for display during setup.
 * Non-throwing — returns zeroed stats on any error.
 */
function getV2Stats(dbPath: string): { observationCount: number; sessionCount: number; pressureCount: number } {
  const stats = { observationCount: 0, sessionCount: 0, pressureCount: 0 };
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
      db.close();
    } catch {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch { /* non-throwing */ }
  return stats;
}

/**
 * Prompts user for y/N input. Returns true if answered yes.
 */
async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

/**
 * Main setup entry point.
 */
export async function main(): Promise<void> {
  console.log('Claudex v3 Setup');
  console.log('================\n');

  // 1. Create directory structure
  const claudexHome = getClaudexHome();
  ensureDir(claudexHome);
  ensureDir(path.join(claudexHome, 'db'));
  ensureDir(path.join(claudexHome, 'identity'));
  console.log(`[OK] Directory structure created: ${claudexHome}`);

  // 2. Database initialization
  const dbPath = getDbPath();

  // Check for v2 before initializing (uses core detectV2Database which scans known paths)
  const v2Path = detectV2Database();
  if (v2Path) {
    const v2Stats = getV2Stats(v2Path);
    console.log(`\n[INFO] Existing v2 database detected:`);
    console.log(`  Observations: ${v2Stats.observationCount}`);
    console.log(`  Sessions: ${v2Stats.sessionCount}`);
    console.log(`  Pressure scores: ${v2Stats.pressureCount}`);

    const shouldMigrate = await askYesNo('Migrate v2 data? [y/N] ');
    if (shouldMigrate) {
      const backupPath = v2Path + '.v2-backup';
      fs.copyFileSync(v2Path, backupPath);
      console.log(`[OK] v2 backup created: ${backupPath}`);

      const db = openDatabase(dbPath);
      try {
        migrateFromV2(db, v2Path);
        console.log('[OK] v2 data migrated');
      } finally {
        closeDatabase(db);
      }
    }
  }

  // Initialize schema (safe with CREATE IF NOT EXISTS)
  const db = openDatabase(dbPath);
  try {
    initializeSchema(db);
  } finally {
    closeDatabase(db);
  }
  console.log(`[OK] Database initialized: ${dbPath}`);

  // 3. Write default config (only if not exists)
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    await writeJsonFile(configPath, DEFAULT_CONFIG);
    console.log(`[OK] Config written: ${configPath}`);
  } else {
    console.log(`[OK] Config already exists: ${configPath} (preserved)`);
  }

  // 4. Patch settings.json
  const installDir = path.resolve(__dirname, '..', '..');
  const hookPaths = getHookPaths(installDir);
  const settingsPath = getSettingsJsonPath();
  const patchResult = patchSettingsJson(settingsPath, hookPaths);

  if (patchResult.patched) {
    const suffix = patchResult.created ? ' (created)' : '';
    console.log(`[OK] Hook paths registered in: ${settingsPath}${suffix}`);
  } else {
    console.log(`[WARN] Could not patch settings.json at: ${settingsPath}`);
  }

  // 5. Summary
  console.log(`\nSetup complete! Claudex v3 is ready.`);
  console.log(`  - Database: ${dbPath}`);
  console.log(`  - Config: ${configPath}`);
  console.log(`  - Hooks: 6 registered in ${settingsPath}`);

  process.exit(0);
}

// Only auto-run when executed directly (not when imported for tests)
const isDirectRun = typeof require !== 'undefined' && require.main === module
  || process.argv[1]?.endsWith('setup.cjs')
  || process.argv[1]?.endsWith('setup.js')
  || process.argv[1]?.endsWith('setup.ts');

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[ERROR] Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
