/**
 * claudex worker-context CLI — assembles a task-specific knowledge package for spawned workers.
 *
 * Usage:
 *   node dist/cli/worker-context.cjs "task description" --project <name> [--max-tokens 3000] [--files src/foo.ts,src/bar.ts]
 *
 * Outputs:
 *   stdout — package.formatted (ready-to-inject context string, may be empty)
 *   stderr — [worker-context] <tokens> tokens, <sections> sections
 *
 * Exit 0 always. Errors are written to stderr and produce empty stdout.
 * Non-throwing by design — failures are optional-enhancement failures, not blockers.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import { getProjectId } from '../shared/scope-detector.js';
import { assembleWorkerContext } from '../assembly/worker-context.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  taskDescription: string;
  project: string | null;
  maxTokens: number;
  files: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv = process.argv.slice(2) — first positional is task description
  const args = argv.slice();

  let taskDescription = '';
  let project: string | null = null;
  let maxTokens = 3000;
  let files: string[] = [];

  // First positional argument is the task description (not a flag)
  if (args.length > 0 && !args[0].startsWith('--')) {
    taskDescription = args.shift()!;
  }

  // Parse remaining flags
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--project' && i + 1 < args.length) {
      project = args[++i];
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
    } else if (arg === '--max-tokens' && i + 1 < args.length) {
      const v = parseInt(args[++i], 10);
      if (!isNaN(v) && v > 0) maxTokens = v;
    } else if (arg.startsWith('--max-tokens=')) {
      const v = parseInt(arg.slice('--max-tokens='.length), 10);
      if (!isNaN(v) && v > 0) maxTokens = v;
    } else if (arg === '--files' && i + 1 < args.length) {
      files = args[++i].split(',').map(f => f.trim()).filter(Boolean);
    } else if (arg.startsWith('--files=')) {
      files = arg.slice('--files='.length).split(',').map(f => f.trim()).filter(Boolean);
    }
  }

  return { taskDescription, project, maxTokens, files };
}

// ---------------------------------------------------------------------------
// Section count helper
// ---------------------------------------------------------------------------

function countSections(pkg: ReturnType<typeof assembleWorkerContext>): number {
  return [
    pkg.experienceWarnings,
    pkg.learnings,
    pkg.relevantArtifacts,
    pkg.hotFiles,
    pkg.primer,
  ].filter(s => s.length > 0).length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.taskDescription) {
    process.stderr.write('[worker-context] ERROR: task description is required (first positional argument)\n');
    process.stderr.write('Usage: node dist/cli/worker-context.cjs "task description" [--project <name>] [--max-tokens 3000] [--files src/foo.ts]\n');
    process.exit(0); // Exit 0 — failure is non-blocking
    return;
  }

  // Resolve project: explicit flag > scope detection from cwd
  const project = args.project ?? getProjectId(process.cwd());

  // Open DB
  let db: Database.Database;
  const dbPath = getDbPath();
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');
  } catch (err) {
    process.stderr.write(`[worker-context] ERROR: Could not open database at ${dbPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stdout.write('');
    process.exit(0);
    return;
  }

  try {
    const pkg = assembleWorkerContext(db, args.taskDescription, project, {
      maxTokens: args.maxTokens,
      fileScope: args.files.length > 0 ? args.files : undefined,
    });

    const sections = countSections(pkg);
    process.stderr.write(`[worker-context] ${pkg.tokenBudget} tokens, ${sections} sections (project: ${project})\n`);

    // Always write to stdout — empty string is valid (no matches)
    process.stdout.write(pkg.formatted);
    if (pkg.formatted && !pkg.formatted.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } catch (err) {
    process.stderr.write(`[worker-context] ERROR: assembly failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stdout.write('');
  } finally {
    try { db!.close(); } catch { /* non-throwing */ }
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Entry point guard
// ---------------------------------------------------------------------------

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].includes('worker-context') || process.argv[1].endsWith('worker-context.cjs'));

if (isDirectExecution) {
  main();
}
