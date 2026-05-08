import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runReplication, type RunReplicationOpts } from './harness.js';
import { computeReplicationVerdict, poolReplications } from './verdict.js';
import { appendReplication, appendPooledSummary, type AppendOpts } from './aggregator.js';
import { loadProbes } from './probe-loader.js';
import type { ReplicationRunResult, ReplicationSummary, BindVerdict } from './types.js';
import type { Probe } from './probe-schema.js';

export interface BindingMeasurementOpts {
  db: Database;
  replications: number;
  labelPrefix: string;
  useBiEncoderOnly: boolean;
  topK?: number;
  probesDir?: string;
  project?: string;
  /** Skip aggregator + report writes — for --dry-run. */
  noAggregatorWrite?: boolean;
  agentFetcher?: typeof fetch;
  judgeFetcher?: typeof fetch;
  rerankerFetcher?: typeof fetch;
  embeddingFetcher?: typeof fetch;
  aggregatorOpts?: AppendOpts;
  onProbeStart?: RunReplicationOpts['onProbeStart'];
  onProbeComplete?: RunReplicationOpts['onProbeComplete'];
  onReplicationComplete?: (label: string, verdict: BindVerdict) => void;
}

export interface BindingMeasurementResult {
  replications: ReplicationRunResult[];
  per_replication_verdicts: Array<{
    label: string;
    verdict: BindVerdict;
    ci: { lower: number; upper: number; point: number };
  }>;
  pooled: ReplicationSummary;
  reportPath?: string;
}

const SUBSTRATE_CHECK_SQL = `SELECT COUNT(*) as n FROM transcript_chunk_v6`;

/**
 * Sanity gate: vec_transcript_chunks_v6 must have rows for B-arm to be meaningful.
 * Throws with operator-actionable guidance if the substrate is empty.
 */
export function checkSubstrate(db: Database): { chunk_count: number } {
  try {
    const row = db.prepare(SUBSTRATE_CHECK_SQL).get() as { n: number };
    if (row.n === 0) {
      throw new Error(
        `transcript_chunk_v6 has 0 rows. Run \`bun run backfill:transcripts\` first ` +
          `to seed the substrate, then re-run the benchmark.`,
      );
    }
    return { chunk_count: row.n };
  } catch (err) {
    if (err instanceof Error && err.message.includes('no such table')) {
      throw new Error(
        `transcript_chunk_v6 table missing — V32 migration not applied. ` +
          `Inspect ~/.claudex/db/claudex.db schema before running this benchmark.`,
      );
    }
    throw err;
  }
}

/**
 * Orchestrates a binding measurement: N replications × locked probe-set.
 */
export async function runBindingMeasurement(
  opts: BindingMeasurementOpts,
): Promise<BindingMeasurementResult> {
  if (opts.replications < 1) {
    throw new Error(`replications must be ≥ 1; got ${opts.replications}`);
  }
  if (!opts.noAggregatorWrite) {
    checkSubstrate(opts.db);
  }

  const probes: Probe[] = loadProbes(opts.probesDir);
  const replications: ReplicationRunResult[] = [];
  const per_replication_verdicts: BindingMeasurementResult['per_replication_verdicts'] = [];

  for (let i = 0; i < opts.replications; i++) {
    const label = `${opts.labelPrefix}${i + 1}`;
    const result = await runReplication(opts.db, probes, {
      replication_label: label,
      useBiEncoderOnly: opts.useBiEncoderOnly,
      topK: opts.topK,
      project: opts.project,
      agentFetcher: opts.agentFetcher,
      judgeFetcher: opts.judgeFetcher,
      rerankerFetcher: opts.rerankerFetcher,
      embeddingFetcher: opts.embeddingFetcher,
      onProbeStart: opts.onProbeStart,
      onProbeComplete: opts.onProbeComplete,
    });
    const { verdict, delta_ci } = computeReplicationVerdict(result);
    if (!opts.noAggregatorWrite) {
      appendReplication(result, verdict, delta_ci, opts.aggregatorOpts);
    }
    replications.push(result);
    per_replication_verdicts.push({ label, verdict, ci: delta_ci });
    opts.onReplicationComplete?.(label, verdict);
  }

  const pooled = poolReplications(replications);
  if (!opts.noAggregatorWrite && replications.length > 1) {
    appendPooledSummary(pooled, opts.aggregatorOpts);
  }

  let reportPath: string | undefined;
  if (!opts.noAggregatorWrite) {
    const date = new Date().toISOString().slice(0, 10);
    reportPath = path.resolve(process.cwd(), 'context', 'measurements', `${date}-deliberation-surfacing.md`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, renderRunReport(replications, per_replication_verdicts, pooled));
  }

  return { replications, per_replication_verdicts, pooled, reportPath };
}

function renderRunReport(
  reps: ReplicationRunResult[],
  perRep: BindingMeasurementResult['per_replication_verdicts'],
  pooled: ReplicationSummary,
): string {
  const repBaselines = reps.map((r) => `${r.replication_label}=${r.retrieval_baseline}`).join(', ');
  return [
    `# Deliberation-surfacing run report`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `Retrieval baselines per replication: ${repBaselines || '—'}.`,
    ``,
    `## Per-replication verdicts`,
    ``,
    ...perRep.map((p) => `- **${p.label}**: ${p.verdict} (Δ CI ${p.ci.lower.toFixed(4)} .. ${p.ci.upper.toFixed(4)})`),
    ``,
    `## Pooled verdict`,
    ``,
    `**${pooled.verdict}** at n=${pooled.pooled_n}, Δ CI [${pooled.delta_ci.lower.toFixed(4)}, ${pooled.delta_ci.upper.toFixed(4)}]`,
    ``,
    `## Per-kind descriptive breakdown (NOT a gate)`,
    ``,
    `| Kind | Summary pass rate | Transcript pass rate | Δ |`,
    `|------|-------------------|----------------------|---|`,
    ...pooled.per_kind.map(
      (k) => `| ${k.kind} | ${k.summary_pass_rate.toFixed(3)} | ${k.transcript_pass_rate.toFixed(3)} | ${k.delta.toFixed(3)} |`,
    ),
    ``,
  ].join('\n');
}
