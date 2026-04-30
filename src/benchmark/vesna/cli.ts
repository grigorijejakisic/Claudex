/**
 * Vesna CLI entry — invoked by `bun run vesna`.
 *
 * Flags:
 *   --probes-dir <path>   Probe JSON directory. Default: src/benchmark/vesna/probes
 *   --trials <n>          Trials per probe. Default: 3
 *   --strict              Treat flaky probes as failures (default: tagged but not gated)
 *   --json                Emit JSON-only SuiteReport to stdout (CI-friendly)
 *
 * Exit code: 0 iff `report.gated === true` (per Plan 01 spec).
 */

import { runVesnaSuite } from './index.js';
import type { ProbeCategory, SuiteReport } from './types.js';

interface CliFlags {
  probesDir: string;
  trials: number;
  strict: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    probesDir: 'src/benchmark/vesna/probes',
    trials: 3,
    strict: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--probes-dir':
        flags.probesDir = argv[++i];
        break;
      case '--trials':
        flags.trials = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(flags.trials) || flags.trials < 1) {
          throw new Error(`Invalid --trials value (must be positive integer)`);
        }
        break;
      case '--strict':
        flags.strict = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: bun run vesna [-- --flag value ...]',
      '',
      'Flags:',
      '  --probes-dir <path>  Probe JSON directory (default: src/benchmark/vesna/probes)',
      '  --trials <n>         Trials per probe (default: 3)',
      '  --strict             Treat flaky probes as failures',
      '  --json               Emit JSON-only SuiteReport to stdout',
      '  -h, --help           Show this help',
      '',
      'Exit code: 0 iff aggregate >=80% AND every non-empty category >=80%.',
      '',
    ].join('\n'),
  );
}

function formatHumanReport(
  report: SuiteReport,
  strict: boolean,
): string {
  const lines: string[] = [];
  const cats: ProbeCategory[] = [
    'entity-recall',
    'constraint-recall',
    'handoff-pickup',
    'cross-project',
    'lesson-application',
    'self-instrumented',
  ];

  // Per-probe lines
  if (report.failed_probes.length > 0) {
    lines.push('## Failed probes');
    for (const f of report.failed_probes) {
      lines.push(`  [${f.id}] ${f.category} FAIL`);
      for (const d of f.diagnostics) {
        lines.push(`    - ${d}`);
      }
    }
    lines.push('');
  }

  if (report.flaky_probes.length > 0) {
    lines.push(`## Flaky probes (${strict ? 'gated' : 'tagged'})`);
    for (const id of report.flaky_probes) lines.push(`  [${id}] FLAKY`);
    lines.push('');
  }

  // Per-category section
  lines.push('## Per-category');
  for (const cat of cats) {
    const bucket = report.per_category[cat];
    if (!bucket || bucket.total === 0) continue;
    const pct = (bucket.pass_rate * 100).toFixed(0);
    lines.push(`  ${cat}: ${bucket.passed}/${bucket.total - bucket.flaky} (${pct}%) flaky=${bucket.flaky}`);
  }
  lines.push('');

  // Aggregate footer
  const aggPct = (report.aggregate_pass_rate * 100).toFixed(0);
  const verdict = report.gated ? 'GATED PASS' : 'GATE FAIL';
  lines.push(`AGGREGATE: ${aggPct}% — ${verdict}`);

  return lines.join('\n');
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  const { report } = await runVesnaSuite({
    probesDir: flags.probesDir,
    trials: flags.trials,
  });

  // --strict promotes flaky to fail for gating purposes.
  let gated = report.gated;
  if (flags.strict && report.flaky_probes.length > 0) {
    gated = false;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...report, gated }, null, 2) + '\n');
  } else {
    process.stdout.write(formatHumanReport(report, flags.strict) + '\n');
  }

  process.exit(gated ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`vesna: ${(e as Error).message}\n`);
  if ((e as Error).stack) {
    process.stderr.write((e as Error).stack + '\n');
  }
  process.exit(2);
});
