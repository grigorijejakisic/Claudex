/**
 * Phase 14-07k — backfill Last-Session Synthesis for prior sessions.
 *
 * Usage:
 *   bun src/scripts/backfill-session-synthesis.ts --project <name> [--since YYYY-MM-DD] [--dry-run] [--force]
 *
 * --dry-run    (default): list sessions that WOULD be synthesized; do not write
 * --force      : re-run synthesis for sessions that already have synthesis
 *                (use for prompt-version replay after bumping to v2, v3, etc.)
 * --since DATE : only sessions on/after DATE (default: 30 days ago)
 *
 * Exit codes:
 *   0 — success (all synthesized, or dry-run completed)
 *   1 — partial failure (some sessions failed; details printed)
 *   2 — invalid args or missing --project
 *   3 — DB / IO error
 */

import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { synthesizeLastSession, deriveSynthesisArtifactId } from '../angel/last-session-synthesis.js';
import { runMigrations } from '../core/migrations.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  project: string;
  since: Date;
  dryRun: boolean;
  force: boolean;
  promptVersion: string;
  llmModel?: string;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const args = argv.slice(2); // skip node + script
  const result: Partial<CliArgs> = {
    dryRun: true,  // default
    force: false,
    since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),  // 30 days ago
    promptVersion: 'v1',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project') {
      result.project = args[++i];
    } else if (arg === '--since') {
      const dateStr = args[++i];
      if (!dateStr) return { error: '--since requires a YYYY-MM-DD value' };
      const parsed = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(parsed.getTime())) return { error: `Invalid date: ${dateStr}` };
      result.since = parsed;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--apply') {
      result.dryRun = false;
    } else if (arg === '--force') {
      result.force = true;
    } else if (arg === '--prompt-version') {
      result.promptVersion = args[++i] ?? 'v1';
    } else if (arg === '--model') {
      result.llmModel = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }

  if (!result.project) {
    return { error: '--project is required' };
  }

  return result as CliArgs;
}

function printUsage(): void {
  console.log(`
Last-Session Synthesis Backfill (Phase 14-07k)

Usage:
  bun src/scripts/backfill-session-synthesis.ts --project <name> [options]

Options:
  --project <name>          Project name (required)
  --since YYYY-MM-DD        Only sessions on/after date (default: 30 days ago)
  --dry-run                 List sessions that would be synthesized (DEFAULT)
  --apply                   Actually run synthesis and persist artifacts
  --force                   Re-run synthesis for sessions that already have it
                            (use for prompt-version replay)
  --prompt-version <v>      Prompt version to use (default: v1)
  --model <name>            Ollama model to use (default: llama3.1:8b or ANGEL_LLM_MODEL)
  --help                    Show this help

Exit codes:
  0  Success (or dry-run completed)
  1  Partial failure (some sessions failed)
  2  Invalid arguments
  3  DB / IO error
`);
}

// ---------------------------------------------------------------------------
// Session enumeration
// ---------------------------------------------------------------------------

interface SessionRow {
  session_id: string;
  created_at_epoch_ms: number;
  project: string;
}

/**
 * List sessions for the project created on/after `since`.
 */
export function listSessionsForProject(
  db: Database.Database,
  project: string,
  since: Date,
): SessionRow[] {
  try {
    const sinceMs = since.getTime();

    // Try created_at_epoch_ms first; fall back to created_at_epoch * 1000
    const cols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map(c => c.name);
    const tsCol = cols.includes('created_at_epoch_ms')
      ? 'created_at_epoch_ms'
      : 'created_at_epoch * 1000';

    return db.prepare(
      `SELECT session_id, ${tsCol} AS created_at_epoch_ms, project
       FROM sessions
       WHERE project = ?
         AND ${tsCol} >= ?
       ORDER BY ${tsCol} DESC`
    ).all(project, sinceMs) as SessionRow[];
  } catch {
    return [];
  }
}

/**
 * Check whether a session already has a synthesis artifact.
 */
export function hasSynthesisArtifact(db: Database.Database, sessionId: string): boolean {
  try {
    const artifactId = deriveSynthesisArtifactId(sessionId);
    const projectColList = (db.pragma('table_info(artifact)') as Array<{ name: string }>).map(c => c.name);
    const projectCol = projectColList.includes('project') ? 'project' : 'project_id';
    const row = db.prepare(
      `SELECT id FROM artifact WHERE id = ? AND kind = 'session_synthesis' LIMIT 1`
    ).get(artifactId);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * List sessions that are candidates for synthesis (no existing artifact, or --force).
 */
export function listSessionsWithoutSynthesis(
  db: Database.Database,
  project: string,
  since: Date,
  force: boolean,
): SessionRow[] {
  const all = listSessionsForProject(db, project, since);
  if (force) return all;
  return all.filter(s => !hasSynthesisArtifact(db, s.session_id));
}

// ---------------------------------------------------------------------------
// Single-session backfill
// ---------------------------------------------------------------------------

export interface BackfillOneResult {
  session_id: string;
  status: 'synthesized' | 'already_exists' | 'failed' | 'skipped';
  error?: string;
}

/**
 * Synthesize LSS for a single session.
 * Returns result with status.
 */
export async function backfillOne(
  db: Database.Database,
  session: SessionRow,
  opts: { force: boolean; promptVersion: string; llmModel?: string },
): Promise<BackfillOneResult> {
  const { session_id, project } = session;

  if (!opts.force && hasSynthesisArtifact(db, session_id)) {
    return { session_id, status: 'already_exists' };
  }

  try {
    const result = await synthesizeLastSession(session_id, db, {
      project,
      prompt_version: opts.promptVersion,
      llm_model: opts.llmModel,
    });

    if (result) {
      return { session_id, status: 'synthesized' };
    } else {
      return { session_id, status: 'failed', error: 'synthesizeLastSession returned null (check session_events for lss_synthesis_failed)' };
    }
  } catch (err) {
    return { session_id, status: 'failed', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main backfill orchestrator
// ---------------------------------------------------------------------------

export async function backfillSynthesis(args: CliArgs, db: Database.Database): Promise<number> {
  const candidates = listSessionsWithoutSynthesis(db, args.project, args.since, args.force);

  if (candidates.length === 0) {
    console.log(`No sessions to synthesize for project '${args.project}' since ${args.since.toISOString().slice(0, 10)}.`);
    if (!args.force) {
      console.log('(All sessions already have synthesis. Use --force to re-run.)');
    }
    return 0;
  }

  console.log(`\nProject: ${args.project}`);
  console.log(`Since: ${args.since.toISOString().slice(0, 10)}`);
  console.log(`Sessions to synthesize: ${candidates.length}`);
  console.log(`Mode: ${args.dryRun ? 'DRY-RUN (use --apply to persist)' : 'APPLY'}`);
  console.log(`Prompt version: ${args.promptVersion}`);
  if (args.llmModel) console.log(`Model: ${args.llmModel}`);
  console.log('');

  if (args.dryRun) {
    console.log('Sessions that WOULD be synthesized:');
    for (const s of candidates) {
      const date = new Date(s.created_at_epoch_ms).toISOString().slice(0, 10);
      console.log(`  ${s.session_id} (${date})`);
    }
    return 0;
  }

  // Apply mode — run synthesis for each session
  const results: BackfillOneResult[] = [];
  let failureCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const session = candidates[i]!;
    const date = new Date(session.created_at_epoch_ms).toISOString().slice(0, 10);
    process.stdout.write(`[${i + 1}/${candidates.length}] ${session.session_id} (${date}) ... `);

    const result = await backfillOne(db, session, {
      force: args.force,
      promptVersion: args.promptVersion,
      llmModel: args.llmModel,
    });

    results.push(result);

    switch (result.status) {
      case 'synthesized':
        console.log('OK');
        break;
      case 'already_exists':
        console.log('SKIPPED (already exists)');
        break;
      case 'failed':
        console.log(`FAILED: ${result.error ?? 'unknown'}`);
        failureCount++;
        break;
      case 'skipped':
        console.log('SKIPPED');
        break;
    }
  }

  const successCount = results.filter(r => r.status === 'synthesized').length;
  const skippedCount = results.filter(r => r.status === 'already_exists' || r.status === 'skipped').length;

  console.log(`\nSummary: ${successCount} synthesized, ${skippedCount} skipped, ${failureCount} failed`);

  return failureCount > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// DB open helper
// ---------------------------------------------------------------------------

function openDb(): Database.Database | null {
  try {
    const dbPath = process.env['CLAUDEX_DB_PATH']
      ?? path.join(
          process.env['USERPROFILE'] ?? process.env['HOME'] ?? os.homedir(),
          '.claudex', 'db', 'claudex.db',
        );
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    runMigrations(db);
    return db;
  } catch (err) {
    console.error('Failed to open DB:', String(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if ('error' in parsed) {
    console.error(`Error: ${parsed.error}`);
    printUsage();
    process.exit(2);
  }

  const db = openDb();
  if (!db) {
    process.exit(3);
  }

  try {
    const exitCode = await backfillSynthesis(parsed, db);
    process.exit(exitCode);
  } catch (err) {
    console.error('Backfill error:', String(err));
    process.exit(3);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// Only run when executed directly (not when imported in tests)
if (process.argv[1] && (process.argv[1].endsWith('backfill-session-synthesis.ts') || process.argv[1].endsWith('backfill-session-synthesis.js') || process.argv[1].endsWith('backfill-session-synthesis.cjs'))) {
  main().catch(err => {
    console.error(err);
    process.exit(3);
  });
}
