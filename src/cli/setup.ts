/**
 * claudex setup CLI — fresh install entry point.
 * Creates directory structure, initializes DB, writes config,
 * patches ~/.claude/settings.json with hook paths, offers optional v2 migration.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { openDatabase, closeDatabase } from '../core/storage.js';
import { initializeSchema, migrateFromV2, detectV2Database } from '../core/migrations.js';
import { getDbPath, getClaudexHome, getConfigPath } from '../shared/paths.js';
import { getProjectsDir } from '../shared/projects-dir.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../shared/fs-helpers.js';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import { getDbStats } from '../shared/db-stats.js';
import { checkBunVersion } from './bootstrap-steps/bun-version.js';
import { detectOllama } from './bootstrap-steps/ollama-detect.js';
import { pullEmbeddingModel } from './bootstrap-steps/model-pull.js';
import { bootstrapReranker } from './bootstrap-steps/reranker-bootstrap.js';
import Database from 'better-sqlite3';

/** Hook file paths matching build.ts output in dist/adapters/cc-hooks/. */
const HOOK_FILES: Record<string, string> = {
  SessionStart: path.join('adapters', 'cc-hooks', 'session-start.cjs'),
  UserPromptSubmit: path.join('adapters', 'cc-hooks', 'user-prompt-submit.cjs'),
  PostToolUse: path.join('adapters', 'cc-hooks', 'post-tool-use.cjs'),
  Stop: path.join('adapters', 'cc-hooks', 'stop.cjs'),
  PreCompact: path.join('adapters', 'cc-hooks', 'pre-compact.cjs'),
  SessionEnd: path.join('adapters', 'cc-hooks', 'session-end.cjs'),
  PostCompact: path.join('adapters', 'cc-hooks', 'post-compact.cjs'),
  SubagentStart: path.join('adapters', 'cc-hooks', 'subagent-start.cjs'),
  SubagentStop: path.join('adapters', 'cc-hooks', 'subagent-stop.cjs'),
  TaskCreated: path.join('adapters', 'cc-hooks', 'task-created.cjs'),
  TaskCompleted: path.join('adapters', 'cc-hooks', 'task-completed.cjs'),
  PermissionRequest: path.join('adapters', 'cc-hooks', 'permission-request.cjs'),
  PermissionDenied: path.join('adapters', 'cc-hooks', 'permission-denied.cjs'),
  Elicitation: path.join('adapters', 'cc-hooks', 'elicitation.cjs'),
  ElicitationResult: path.join('adapters', 'cc-hooks', 'elicitation-result.cjs'),
  PostToolUseFailure: path.join('adapters', 'cc-hooks', 'post-tool-use-failure.cjs'),
  StopFailure: path.join('adapters', 'cc-hooks', 'stop-failure.cjs'),
  ConfigChange: path.join('adapters', 'cc-hooks', 'config-change.cjs'),
  InstructionsLoaded: path.join('adapters', 'cc-hooks', 'instructions-loaded.cjs'),
  CwdChanged: path.join('adapters', 'cc-hooks', 'cwd-changed.cjs'),
  Setup: path.join('adapters', 'cc-hooks', 'setup.cjs'),
  WorktreeCreate: path.join('adapters', 'cc-hooks', 'worktree-create.cjs'),
  WorktreeRemove: path.join('adapters', 'cc-hooks', 'worktree-remove.cjs'),
  TeammateIdle: path.join('adapters', 'cc-hooks', 'teammate-idle.cjs'),
  PreToolUse: path.join('adapters', 'cc-hooks', 'pre-tool-use.cjs'),
};

/**
 * Hook matchers — CC regex-matches these against tool names (PreToolUse/PostToolUse),
 * session trigger types (SessionStart), or other event-specific fields.
 * Empty string = fire for all events (default). Non-empty = only fire on match.
 *
 * Optimization: hooks that only do meaningful work for specific events should have
 * a matcher to avoid unnecessary process spawns (~100ms each).
 */
const HOOK_MATCHERS: Partial<Record<string, string>> = {
  // PreToolUse only does work for Agent tool (injects Claudex MCP hint into prompts).
  // Permission decision is currently pass-through for all tools.
  // Saves ~95% of unnecessary spawns (50-200 tool calls/session, ~5-10 are Agent).
  PreToolUse: 'Agent',
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
    const command = `node '${hookPath.replace(/'/g, "'\\''")}'`;
    const newEntry = {
      matcher: HOOK_MATCHERS[hookName] ?? '',
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

  const installDirPre = path.resolve(__dirname, '..', '..');

  // [1/8] Bun version check
  console.log('[1/8] Checking Bun version...');
  const bunResult = await checkBunVersion();
  console.log(`  ${bunResult.ok ? '[OK]' : '[FAIL]'} ${bunResult.message}`);
  if (!bunResult.ok) process.exit(1);

  // [2/8] Ollama detection (binary + daemon)
  console.log('[2/8] Detecting Ollama...');
  const ollamaResult = await detectOllama();
  console.log(`  ${ollamaResult.ok ? '[OK]' : '[FAIL]'} ${ollamaResult.message}`);
  if (!ollamaResult.ok) process.exit(1);

  // [3/8] Pull embedding model
  console.log('[3/8] Pulling embedding model (snowflake-arctic-embed2)...');
  const modelResult = await pullEmbeddingModel();
  console.log(`  ${modelResult.ok ? '[OK]' : '[FAIL]'} ${modelResult.message}`);
  if (!modelResult.ok) process.exit(1);

  // [4/8] Bootstrap BGE reranker (best-effort)
  console.log('[4/8] Bootstrapping BGE reranker...');
  const rerankerResult = await bootstrapReranker({ projectRoot: installDirPre });
  console.log(`  [OK] ${rerankerResult.message}`);
  if (rerankerResult.warning) {
    console.log(`  [WARN] ${rerankerResult.warning}`);
  }

  // [5/8] Resolve and ensure projects directory
  console.log('[5/8] Resolving projects directory...');
  const projectsDir = getProjectsDir();
  console.log(`  [OK] Projects directory: ${projectsDir}`);

  // [6/8] Create directory structure
  console.log('[6/8] Creating Claudex home directory structure...');
  const claudexHome = getClaudexHome();
  ensureDir(claudexHome);
  ensureDir(path.join(claudexHome, 'db'));
  ensureDir(path.join(claudexHome, 'identity'));
  console.log(`  [OK] ${claudexHome}`);

  // [7/8] Database initialization
  console.log('[7/8] Initializing database...');
  const dbPath = getDbPath();

  // Check for v2 before initializing (uses core detectV2Database which scans known paths)
  const v2Path = detectV2Database();
  if (v2Path) {
    const v2Stats = getDbStats(v2Path);
    console.log(`\n[INFO] Existing v2 database detected:`);
    console.log(`  Observations: ${v2Stats.observationCount}`);
    console.log(`  Sessions: ${v2Stats.sessionCount}`);
    console.log(`  Pressure scores: ${v2Stats.pressureCount}`);

    const shouldMigrate = await askYesNo('Migrate v2 data? [y/N] ');
    if (shouldMigrate) {
      const resolvedV2 = path.resolve(v2Path);
      const resolvedV3 = path.resolve(dbPath);
      if (resolvedV2 === resolvedV3) {
        // Skip migration — DB is already at runtime path; in-place upgrade handled by initializeSchema
        console.log('[INFO] v2 database is already at v3 runtime path — skipping migration (in-place upgrade will apply)');
      } else {
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
  }

  // Initialize schema (safe with CREATE IF NOT EXISTS)
  const db = openDatabase(dbPath);
  try {
    initializeSchema(db);
  } finally {
    closeDatabase(db);
  }
  console.log(`  [OK] ${dbPath}`);

  // Write default config (only if not exists)
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    await writeJsonFile(configPath, DEFAULT_CONFIG);
    console.log(`  [OK] Config written: ${configPath}`);
  } else {
    console.log(`  [OK] Config preserved: ${configPath}`);
  }

  // [8/8] Patch settings.json
  console.log('[8/8] Registering CC hooks in settings.json...');
  const installDir = installDirPre;
  const hookPaths = getHookPaths(installDir);
  const settingsPath = getSettingsJsonPath();
  const patchResult = patchSettingsJson(settingsPath, hookPaths);

  if (patchResult.patched) {
    const suffix = patchResult.created ? ' (created)' : '';
    console.log(`  [OK] Hooks registered in: ${settingsPath}${suffix}`);
  } else {
    console.log(`  [WARN] Could not patch settings.json at: ${settingsPath}`);
  }

  // Summary
  console.log(`\nSetup complete! Claudex v3 is ready.`);
  console.log(`  - Database:         ${dbPath}`);
  console.log(`  - Config:           ${configPath}`);
  console.log(`  - Projects dir:     ${projectsDir}`);
  console.log(`  - Reranker (:7439): ${rerankerResult.warning ? 'degraded — see warning above' : 'healthy'}`);
  console.log(`  - Hooks:            25 registered in ${settingsPath}`);

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
