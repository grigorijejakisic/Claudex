/**
 * Phase 2 / 2.1 IDX-01/02 — episodic-density CLI.
 *
 * Subcommands:
 *
 *   bun run src/benchmark/episodic-density/cli.ts backfill [--dry-run]
 *     Walks Phase 1 organic tool_result rows + v4 artifact observations,
 *     populates episodic_events.metadata_json.error_fingerprint and the
 *     V26/V27 sidecar episodic_index_error_fingerprint with three-tier
 *     corpus_origin classification (Phase 2.1 Plan 02.1-01).
 *
 *   bun run src/benchmark/episodic-density/cli.ts measure [--seed N]
 *     Phase 2 strict-only entrypoint. Wired by Plan 02-05.
 *
 *   bun run src/benchmark/episodic-density/cli.ts audit [--tier strict_3frame|relaxed_2frame|both] [--seed N]
 *     Phase 2.1 Plan 02.1-03 stratified spot-check audit.
 *
 *   bun run src/benchmark/episodic-density/cli.ts measure-tiered [--seed N]
 *     Phase 2.1 Plan 02.1-04 dual-tier dual-verdict runner.
 *
 * Exit codes:
 *   0 — success-with-floor-met (or dry-run that would have hit floor) /
 *       any KILL/SCOPE_DOWN/GREEN_LIGHT/BLOCKED-tier-but-other-tier-ok
 *   2 — floor not met (corpus too small for measurement)
 *   1 — hard failure (DDL missing, runtime error)
 */

import { runBackfill } from './backfill.js';
import { runFullPhase2Measurement } from './runner.js';
import { runAudit } from './audit.js';
import { runFullPhase21Measurement } from './runner-tiered.js';
import { openDatabase, closeDatabase } from '../../core/storage.js';
import { getDbPath } from '../../shared/paths.js';
import type { LabelerTier } from './types.js';
import type { Database } from 'better-sqlite3';

type AuditTier = LabelerTier | 'both';

interface CliFlags {
  command: 'backfill' | 'measure' | 'audit' | 'measure-tiered' | 'help';
  dryRun: boolean;
  seed?: number;
  auditTier: AuditTier;
}

function parseArgs(argv: string[]): CliFlags {
  const cmd = argv[0];
  const flags: CliFlags = {
    command: 'help',
    dryRun: false,
    auditTier: 'both',
  };
  if (
    cmd === 'backfill' ||
    cmd === 'measure' ||
    cmd === 'audit' ||
    cmd === 'measure-tiered'
  ) {
    flags.command = cmd;
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--seed') {
      const next = argv[++i];
      const n = Number.parseInt(next, 10);
      if (Number.isFinite(n)) flags.seed = n;
    } else if (arg === '--tier') {
      const next = argv[++i];
      if (next === 'strict_3frame' || next === 'relaxed_2frame' || next === 'both') {
        flags.auditTier = next;
      }
    }
  }
  return flags;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Episodic-density harness CLI

Usage:
  bun run src/benchmark/episodic-density/cli.ts backfill [--dry-run]
  bun run src/benchmark/episodic-density/cli.ts measure [--seed N]                           (Phase 2 strict-only)
  bun run src/benchmark/episodic-density/cli.ts audit [--tier strict_3frame|relaxed_2frame|both] [--seed N]
  bun run src/benchmark/episodic-density/cli.ts measure-tiered [--seed N]                    (Phase 2.1 dual-tier)

Backfill exit codes:
  0  success, corpus floor met (>=50 fingerprinted, >=3 projects)
  2  floor not met
  1  hard failure
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

async function runMeasureCommand(flags: CliFlags): Promise<number> {
  const db = openDatabase(getDbPath());
  try {
    const summary = await runFullPhase2Measurement(db, { seed: flags.seed });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      verdict_kind: summary.verdict.kind,
      vesna_probe_state: summary.vesna_probe_state,
      flag_state: summary.flag_state,
      results_md: summary.results_md_path,
      results_json: summary.results_json_path,
      reasoning: summary.verdict.reasoning,
    }, null, 2));
    if (summary.verdict.kind === 'BLOCKED') return 1;
    return 0; // GREEN_LIGHT, SCOPE_DOWN, KILL all exit 0 — empirical-phase discipline
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`measure failed: ${(err as Error).message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}

async function runAuditForTier(db: Database, tier: LabelerTier, seed: number | undefined): Promise<{ tier: LabelerTier; sampleSize: number; allocations: Record<string, number>; markdownPath: string; jsonPath: string }> {
  const { buildCorpus } = await import('./harness.js');
  const corpus = buildCorpus(db);
  const result = await runAudit(db, corpus, tier, { seed });
  const allocations: Record<string, number> = {};
  for (const stratum of result.plan.strata) {
    allocations[stratum.origin] = stratum.allocation;
  }
  return {
    tier,
    sampleSize: result.plan.sampled_total,
    allocations,
    markdownPath: result.markdownPath,
    jsonPath: result.jsonPath,
  };
}

async function runAuditCommand(flags: CliFlags): Promise<number> {
  const db = openDatabase(getDbPath());
  try {
    const tiers: LabelerTier[] =
      flags.auditTier === 'both'
        ? ['strict_3frame', 'relaxed_2frame']
        : [flags.auditTier];
    // CONTEXT.md decision 3d: audit and verdict run in parallel; --tier
    // both runs the two tiers concurrently via Promise.all.
    const summaries = await Promise.all(
      tiers.map(tier => runAuditForTier(db, tier, flags.seed)),
    );
    for (const s of summaries) {
      // eslint-disable-next-line no-console
      console.log(
        `[audit:${s.tier}] sample_size=${s.sampleSize} allocations=${JSON.stringify(s.allocations)} -> md=${s.markdownPath} json=${s.jsonPath}`,
      );
    }
    return 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`audit failed: ${(err as Error).message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}

async function runMeasureTieredCommand(flags: CliFlags): Promise<number> {
  const db = openDatabase(getDbPath());
  try {
    const summary = await runFullPhase21Measurement(db, { seed: flags.seed });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          strict_3frame: {
            kind: summary.verdicts.strict_3frame.kind,
            n: summary.verdicts.strict_3frame.criteria.criterion_1.observed,
            reasoning: summary.verdicts.strict_3frame.reasoning,
          },
          relaxed_2frame: {
            kind: summary.verdicts.relaxed_2frame.kind,
            n: summary.verdicts.relaxed_2frame.criteria.criterion_1.observed,
            reasoning: summary.verdicts.relaxed_2frame.reasoning,
          },
          aggregator_entries_appended: summary.aggregator_entries_appended,
          results_md: summary.results_md_path,
          results_json: summary.results_json_path,
        },
        null,
        2,
      ),
    );
    // KILL/SCOPE_DOWN/GREEN_LIGHT/BLOCKED — all empirical-phase-valid outcomes.
    return 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`measure-tiered failed: ${(err as Error).message}`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  let code = 1;
  if (flags.command === 'backfill') code = await runBackfillCommand(flags);
  else if (flags.command === 'measure') code = await runMeasureCommand(flags);
  else if (flags.command === 'audit') code = await runAuditCommand(flags);
  else if (flags.command === 'measure-tiered') code = await runMeasureTieredCommand(flags);
  else printHelp();
  process.exit(code);
}

void main();
