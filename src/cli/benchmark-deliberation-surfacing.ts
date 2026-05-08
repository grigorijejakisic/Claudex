#!/usr/bin/env bun
/**
 * P9 binding-measurement CLI.
 *
 * Usage:
 *   bun run benchmark:deliberation-surfacing [options]
 *
 * Options:
 *   --replications=N       Replication count (default 2; ≥2 binding minimum)
 *   --label=PREFIX         Replication label prefix (default 'r')
 *   --bi-encoder-only      Use bi-encoder fallback only (skip cross-encoder rerank)
 *   --probes-dir=PATH      Override locked probe directory (testing only)
 *   --top-k=N              Top-K transcript spans for B-arm (default 5)
 *   --project=NAME         Hybrid-retrieval project scope (default claudex-v3)
 *   --dry-run              Run with mocked Ollama transports; no aggregator writes
 *   --help                 Show usage
 *
 * Exit codes:
 *   0 — replications completed; verdict reported on stdout
 *   1 — hard failure
 *   2 — substrate not yet seeded (operator must run backfill first)
 */
import { openDatabase, closeDatabase } from '../core/storage.js';
import { getDbPath } from '../shared/paths.js';
import { runBindingMeasurement } from '../benchmark/deliberation-surfacing/runner.js';

interface CliFlags {
  replications: number;
  labelPrefix: string;
  biEncoderOnly: boolean;
  probesDir?: string;
  topK: number;
  project: string;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    replications: 2,
    labelPrefix: 'r',
    biEncoderOnly: false,
    topK: 5,
    project: 'claudex-v3',
    dryRun: false,
    help: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--bi-encoder-only') flags.biEncoderOnly = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--replications=')) {
      const n = parseInt(a.split('=')[1], 10);
      flags.replications = Number.isFinite(n) && n >= 1 ? n : 2;
    } else if (a.startsWith('--label=')) flags.labelPrefix = a.split('=')[1];
    else if (a.startsWith('--probes-dir=')) flags.probesDir = a.split('=')[1];
    else if (a.startsWith('--top-k=')) {
      const n = parseInt(a.split('=')[1], 10);
      flags.topK = Number.isFinite(n) && n >= 1 ? n : 5;
    } else if (a.startsWith('--project=')) flags.project = a.split('=')[1];
  }
  return flags;
}

export function buildDryRunFetchers() {
  const agentFetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ message: { content: 'mock agent response — dry-run' } }), { status: 200 });
  const judgeFetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        message: {
          content:
            '{"prong_1":{"verdict":"FAIL","justification":"dry-run"},"prong_2":{"verdict":"FAIL","justification":"dry-run"},"prong_3":{"verdict":"FAIL","justification":"dry-run"}}',
        },
      }),
      { status: 200 },
    );
  const rerankerFetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ scores: [], indices: [] }), { status: 200 });
  const embeddingFetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ embeddings: [new Array(1024).fill(0)] }), { status: 200 });
  return { agentFetcher, judgeFetcher, rerankerFetcher, embeddingFetcher };
}

const HELP_TEXT = `P9 binding-measurement CLI

Usage:
  bun run benchmark:deliberation-surfacing [options]

Options:
  --replications=N       Replication count (default 2)
  --label=PREFIX         Replication label prefix (default 'r')
  --bi-encoder-only      Skip cross-encoder rerank
  --probes-dir=PATH      Override locked probe directory
  --top-k=N              Top-K transcript spans (default 5)
  --project=NAME         Hybrid-retrieval project scope (default claudex-v3)
  --dry-run              Mocked Ollama transports; no aggregator writes
  --help                 Show this help
`;

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const db = openDatabase(getDbPath());
  try {
    const dryFetchers = flags.dryRun ? buildDryRunFetchers() : {};
    const result = await runBindingMeasurement({
      db,
      replications: flags.replications,
      labelPrefix: flags.labelPrefix,
      useBiEncoderOnly: flags.biEncoderOnly,
      topK: flags.topK,
      probesDir: flags.probesDir,
      project: flags.project,
      noAggregatorWrite: flags.dryRun,
      ...dryFetchers,
      onReplicationComplete: (label, verdict) => {
        process.stdout.write(`[${label}] verdict: ${verdict}\n`);
      },
    });
    process.stdout.write(`\nPooled verdict: ${result.pooled.verdict}\n`);
    process.stdout.write(
      `Pooled Δ CI: [${result.pooled.delta_ci.lower.toFixed(4)}, ${result.pooled.delta_ci.upper.toFixed(4)}]\n`,
    );
    if (result.reportPath) {
      process.stdout.write(`Report written: ${result.reportPath}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.message.includes('0 rows')) return 2;
    return 1;
  } finally {
    closeDatabase(db);
  }
}

if (require.main === module) {
  main()
    .then((c) => process.exit(c))
    .catch((e) => {
      process.stderr.write(String(e) + '\n');
      process.exit(1);
    });
}
