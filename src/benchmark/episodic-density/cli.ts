/**
 * Phase 2 IDX-01 — episodic-density CLI.
 *
 * Subcommands:
 *
 *   bun run src/benchmark/episodic-density/cli.ts backfill [--dry-run]
 *     Walks Phase 1 organic tool_result rows + v4 artifact observations,
 *     populates episodic_events.metadata_json.error_fingerprint and the
 *     V26 sidecar episodic_index_error_fingerprint. --dry-run reports
 *     counts but performs no writes.
 *
 *   bun run src/benchmark/episodic-density/cli.ts measure [--seed N]
 *     Wired by Plan 02-05. Runs the harness, computes the verdict, writes
 *     02-RESULTS.md / 02-results.json, applies side effects.
 *
 * Exit codes:
 *   0 — success-with-floor-met (or dry-run that would have hit floor) /
 *       any KILL/SCOPE_DOWN/GREEN_LIGHT verdict (negative result is success)
 *   2 — floor not met (corpus too small for measurement)
 *   1 — hard failure (DDL missing, runtime error, BLOCKED verdict)
 */

import { runBackfill } from './backfill.js';
import { openDatabase, closeDatabase } from '../../core/storage.js';
import { getDbPath } from '../../shared/paths.js';

interface CliFlags {
  command: 'backfill' | 'measure' | 'help';
  dryRun: boolean;
  seed?: number;
}

function parseArgs(argv: string[]): CliFlags {
  const cmd = argv[0];
  const flags: CliFlags = {
    command: 'help',
    dryRun: false,
  };
  if (cmd === 'backfill' || cmd === 'measure') {
    flags.command = cmd;
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--seed') {
      const next = argv[++i];
      const n = Number.parseInt(next, 10);
      if (Number.isFinite(n)) flags.seed = n;
    }
  }
  return flags;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Episodic-density harness CLI (Phase 2 IDX-01)

Usage:
  bun run src/benchmark/episodic-density/cli.ts backfill [--dry-run]
  bun run src/benchmark/episodic-density/cli.ts measure [--seed N]

Backfill exit codes:
  0  success, corpus floor met (>=50 fingerprinted, >=3 projects)
  2  floor not met (operator should ingest more sessions, then re-run)
  1  hard failure (V26 migration not applied, runtime error)
`);
}

async function runBackfillCommand(flags: CliFlags): Promise<number> {
  const db = openDatabase(getDbPath());
  try {
    const summary = await runBackfill(db, { dryRun: flags.dryRun });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.floor_met) {
      // eslint-disable-next-line no-console
      console.error(
        `WARN: corpus floor not met — total_fingerprinted=${summary.total_fingerprinted} (need >=50), total_projects=${summary.total_projects} (need >=3).`,
      );
      return 2;
    }
    return 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`backfill failed: ${(err as Error).message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}

async function runMeasureCommand(_flags: CliFlags): Promise<number> {
  // Plan 02-05 wires this branch by importing runFullPhase2Measurement.
  // Until then, this is a graceful "not implemented yet" signal.
  // eslint-disable-next-line no-console
  console.error(
    `measure: not yet implemented at this commit — Plan 02-05 lands the runner. Try 'backfill' or wait for the verdict runner.`,
  );
  return 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  let code = 1;
  if (flags.command === 'backfill') code = await runBackfillCommand(flags);
  else if (flags.command === 'measure') code = await runMeasureCommand(flags);
  else printHelp();
  process.exit(code);
}

void main();
