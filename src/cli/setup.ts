#!/usr/bin/env node
/**
 * Claudex Setup CLI
 *
 * Interactive one-command setup for Claudex.
 * Usage: npx claudex setup
 *
 * Steps:
 * 1. Creates ~/.claudex/ directory tree
 * 2. Writes default config.json (if not present)
 * 3. Writes empty projects.json (if not present)
 * 4. Patches ~/.claude/settings.json with hook registrations
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PATHS } from '../shared/paths.js';
import { DEFAULT_CONFIG } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '1.0.0';
const CLAUDEX_HOME = PATHS.home;

/** All directories that must exist under ~/.claudex/ */
const DIRECTORIES = [
  PATHS.home,
  PATHS.identity,
  PATHS.memory,
  PATHS.memoryDaily,
  PATHS.memoryTopics,
  PATHS.sessions,
  PATHS.transcripts,
  PATHS.hooks,
  PATHS.hookLogs,
  PATHS.db,
];

/** Empty projects registry */
const EMPTY_PROJECTS = { projects: {} };

/** Hook event → wrapper filenames (without extension) */
const HOOK_MAP: Record<string, string[]> = {
  SessionStart:     ['session-start'],
  SessionEnd:       ['session-end'],
  UserPromptSubmit: ['user-prompt-submit', 'pre-flush'],
  PostToolUse:      ['post-tool-use'],
  PreCompact:       ['pre-compact'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function logHeader(msg: string): void {
  console.log(`\n${msg}`);
}

/**
 * Detect the Claudex repo root from the built script location.
 * In the built output (dist/setup.mjs), import.meta.url points into dist/.
 * The repo root is one level up from dist/.
 */
function detectRepoRoot(): string {
  const scriptUrl = new URL(import.meta.url);
  const rawPath = decodeURIComponent(
    process.platform === 'win32'
      ? scriptUrl.pathname.slice(1) // strip leading / on Windows file URLs
      : scriptUrl.pathname,
  );
  const scriptDir = path.dirname(rawPath);
  // scriptDir is .../Claudex/dist  ->  repo root is parent
  return path.resolve(scriptDir, '..');
}

/**
 * Normalize a path to use forward slashes (Claude Code settings convention).
 */
function forwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Read a JSON file, returning the parsed object or a fallback on any error.
 */
function readJsonFile(filePath: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ...fallback };
  }
}

/**
 * Write a JSON file with 2-space indent.
 */
function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

interface StepResult {
  created: string[];
  skipped: string[];
}

function createDirectories(): StepResult {
  const result: StepResult = { created: [], skipped: [] };

  for (const dir of DIRECTORIES) {
    if (fs.existsSync(dir)) {
      result.skipped.push(dir);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      result.created.push(dir);
    }
  }

  return result;
}

function writeDefaultConfig(): { written: boolean; path: string } {
  const configPath = path.join(CLAUDEX_HOME, 'config.json');
  if (fs.existsSync(configPath)) {
    return { written: false, path: configPath };
  }
  writeJsonFile(configPath, DEFAULT_CONFIG);
  return { written: true, path: configPath };
}

function writeProjectsJson(): { written: boolean; path: string } {
  const projectsPath = path.join(CLAUDEX_HOME, 'projects.json');
  if (fs.existsSync(projectsPath)) {
    return { written: false, path: projectsPath };
  }
  writeJsonFile(projectsPath, EMPTY_PROJECTS);
  return { written: true, path: projectsPath };
}

/**
 * Patch ~/.claude/settings.json with Claudex hook registrations.
 *
 * For each hook event: removes any existing Claudex hooks (by matching known
 * hook filenames), then prepends a fresh Claudex matcher group. Non-Claudex
 * hooks are preserved. Always overwrites — hooks always point to current install.
 */

const CLAUDEX_HOOK_BASENAMES = [
  'session-start', 'session-end', 'user-prompt-submit',
  'pre-flush', 'post-tool-use', 'pre-compact',
] as const;

function isClaudexHookCommand(cmd: string): boolean {
  return CLAUDEX_HOOK_BASENAMES.some(n =>
    cmd.includes(`${n}.mjs`) || cmd.includes(`${n}.cmd`) || cmd.includes(`${n}.sh`),
  );
}

function patchSettings(repoRoot: string): { patched: string[]; settingsPath: string } {
  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settings = readJsonFile(settingsPath, {});
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown[]>;

  const ext = process.platform === 'win32' ? '.cmd' : '.sh';
  const patched: string[] = [];

  for (const [event, wrapperNames] of Object.entries(HOOK_MAP)) {
    const hookCommands = wrapperNames.map(name => ({
      type: 'command' as const,
      command: forwardSlashes(path.join(repoRoot, 'hooks', `${name}${ext}`)),
    }));

    if (!Array.isArray(hooks[event])) {
      hooks[event] = [];
    }
    const entries = hooks[event] as Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }>;

    // Strip Claudex hooks from each existing group; drop groups that become empty
    const nonClaudex = entries
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !isClaudexHookCommand(h.command ?? '')) }))
      .filter(g => g.hooks.length > 0);

    // Claudex entry first, then preserved non-Claudex groups
    hooks[event] = [{ matcher: '*', hooks: hookCommands }, ...nonClaudex];
    patched.push(event);
  }

  writeJsonFile(settingsPath, settings);
  return { patched, settingsPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'setup') {
    console.log('Usage: claudex <command>');
    console.log('');
    console.log('Commands:');
    console.log('  setup    Create ~/.claudex/ dirs, write config, register Claude hooks');
    process.exit(command ? 1 : 0);
  }

  console.log(`\n  Claudex Setup  v${VERSION}`);
  console.log('  ─────────────────────────');

  try {
    // Step 1: Create directories
    logHeader('[1/4] Creating ~/.claudex/ directory tree...');
    const dirs = createDirectories();
    if (dirs.created.length > 0) {
      for (const d of dirs.created) log(`+ ${forwardSlashes(d)}`);
    }
    if (dirs.skipped.length > 0) {
      log(`(${dirs.skipped.length} directories already existed)`);
    }

    // Step 2: Write default config
    logHeader('[2/4] Writing default config...');
    const config = writeDefaultConfig();
    if (config.written) {
      log(`+ ${forwardSlashes(config.path)}`);
    } else {
      log(`~ ${forwardSlashes(config.path)} (already exists, skipped)`);
    }

    // Step 3: Write projects.json
    logHeader('[3/4] Writing projects registry...');
    const projects = writeProjectsJson();
    if (projects.written) {
      log(`+ ${forwardSlashes(projects.path)}`);
    } else {
      log(`~ ${forwardSlashes(projects.path)} (already exists, skipped)`);
    }

    // Step 4: Patch settings.json
    logHeader('[4/4] Registering hooks in Claude Code settings...');
    const repoRoot = detectRepoRoot();
    log(`Claudex install: ${forwardSlashes(repoRoot)}`);
    log(`OS: ${process.platform}`);

    const hookResult = patchSettings(repoRoot);
    for (const event of hookResult.patched) log(`+ ${event}`);
    log(`Settings: ${forwardSlashes(hookResult.settingsPath)}`);

    // Summary
    logHeader('Setup complete!');
    log(`Config:   ${forwardSlashes(path.join(CLAUDEX_HOME, 'config.json'))}`);
    log(`Settings: ${forwardSlashes(hookResult.settingsPath)}`);
    log('Run `claude` to start a session with Claudex hooks active.\n');

    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  Setup failed: ${message}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
