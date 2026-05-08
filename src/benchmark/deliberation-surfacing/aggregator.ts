import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReplicationRunResult, BindVerdict, ReplicationSummary } from './types.js';
import { renderAggregatorMarkdown } from './aggregator-renderer.js';

/**
 * V6 P9 — append-only aggregator for deliberation-surfacing.
 *
 * CONTEXT additional_locks: existing entries are NEVER modified. Each closed
 * phase appends rows; markdown derived from JSON; Interpretive History
 * prepended by closing phases. Mirrors src/benchmark/episodic-density/aggregator.ts.
 */

export type AggregatorVerdict =
  | 'GREEN_LIGHT'    // BindVerdict: POSITIVE
  | 'SCOPE_DOWN'     // (legacy v5; not used by P9 but kept for schema compatibility)
  | 'KILL'           // BindVerdict: NEGATIVE
  | 'BLOCKED'        // (legacy v5)
  | 'INCONCLUSIVE';  // BindVerdict: INCONCLUSIVE — new in v6 P9

export function bindVerdictToAggregator(v: BindVerdict): AggregatorVerdict {
  if (v === 'POSITIVE') return 'GREEN_LIGHT';
  if (v === 'NEGATIVE') return 'KILL';
  return 'INCONCLUSIVE';
}

export interface BoundExperience {
  phase: string;
  labeler: string;
  date: string;
  n: number;
  verdict: AggregatorVerdict;
  conditions: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

export interface AggregatorFile {
  schema_version: 1;
  question: string;
  bound_experiences: BoundExperience[];
}

export const AGGREGATOR_QUESTION =
  'does verbatim transcript context surface deliberation-conditional engagement that summary-only context does not, at our scale?';

export const AGGREGATOR_PATH_JSON = path.resolve(
  process.cwd(),
  '.planning',
  'aggregates',
  'deliberation-surfacing.json',
);

export const AGGREGATOR_PATH_MD = path.resolve(
  process.cwd(),
  '.planning',
  'aggregates',
  'deliberation-surfacing.md',
);

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, contents);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

export function loadAggregator(jsonPath: string = AGGREGATOR_PATH_JSON): AggregatorFile {
  if (!fs.existsSync(jsonPath)) {
    return { schema_version: 1, question: AGGREGATOR_QUESTION, bound_experiences: [] };
  }
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const parsed = JSON.parse(raw) as AggregatorFile;
  if (parsed.schema_version !== 1) {
    throw new Error(`Unsupported schema_version ${parsed.schema_version}`);
  }
  return parsed;
}

export interface AppendOpts {
  jsonPath?: string;
  mdPath?: string;
  isoDate?: string;
}

/**
 * Appends a single replication's BoundExperience entry. Rebuilds the .md
 * from the updated .json. Prior bound_experiences are byte-preserved.
 */
export function appendReplication(
  result: ReplicationRunResult,
  perReplicationVerdict: BindVerdict,
  perReplicationCI: { lower: number; upper: number; point: number },
  opts: AppendOpts = {},
): BoundExperience {
  const jsonPath = opts.jsonPath ?? AGGREGATOR_PATH_JSON;
  const mdPath = opts.mdPath ?? AGGREGATOR_PATH_MD;
  const isoDate = opts.isoDate ?? new Date().toISOString().slice(0, 10);

  const file = loadAggregator(jsonPath);

  const entry: BoundExperience = {
    phase: `9-${result.replication_label}`,
    labeler: `three_prong_rubric_${result.judge_model.replace(/[^a-zA-Z0-9]/g, '_')}`,
    date: isoDate,
    n: result.probe_count,
    verdict: bindVerdictToAggregator(perReplicationVerdict),
    conditions: {
      replication_label: result.replication_label,
      agent_model: result.agent_model,
      judge_model: result.judge_model,
      retrieval_baseline: result.retrieval_baseline,
      probe_set_directory: '.planning/phases/09-empirical-measurement/probes',
      pre_commitment_anchor_commit: '09-CONTEXT.md@00ab2bb',
    },
    metrics: {
      summary_pass_count: result.summary_pass_count,
      transcript_pass_count: result.transcript_pass_count,
      delta_pass_rate: (result.transcript_pass_count - result.summary_pass_count) / result.probe_count,
      delta_ci_lower: perReplicationCI.lower,
      delta_ci_upper: perReplicationCI.upper,
      delta_ci_point: perReplicationCI.point,
      started_at_iso: result.started_at_iso,
      completed_at_iso: result.completed_at_iso,
    },
  };

  file.bound_experiences.push(entry);
  atomicWrite(jsonPath, JSON.stringify(file, null, 2) + '\n');
  const mdContents = renderAggregatorMarkdown(file, mdPath);
  atomicWrite(mdPath, mdContents);
  return entry;
}

/**
 * Appends a pooled-across-replications "9-pooled" entry. Called by the runner
 * after all replications complete.
 */
export function appendPooledSummary(
  summary: ReplicationSummary,
  opts: AppendOpts = {},
): BoundExperience {
  const jsonPath = opts.jsonPath ?? AGGREGATOR_PATH_JSON;
  const mdPath = opts.mdPath ?? AGGREGATOR_PATH_MD;
  const isoDate = opts.isoDate ?? new Date().toISOString().slice(0, 10);

  const file = loadAggregator(jsonPath);

  const entry: BoundExperience = {
    phase: `9-pooled-${summary.replications.join('+')}`,
    labeler: 'three_prong_rubric_pooled',
    date: isoDate,
    n: summary.pooled_n,
    verdict: bindVerdictToAggregator(summary.verdict),
    conditions: {
      replications: summary.replications,
      pooling_method: 'sum_pass_counts_across_replications_via_wilsonDeltaCI',
      pre_commitment_anchor_commit: '09-CONTEXT.md@00ab2bb',
    },
    metrics: {
      pooled_summary_pass_count: summary.pooled_summary_pass_count,
      pooled_transcript_pass_count: summary.pooled_transcript_pass_count,
      delta_pass_rate:
        summary.pooled_n > 0
          ? (summary.pooled_transcript_pass_count - summary.pooled_summary_pass_count) / summary.pooled_n
          : 0,
      delta_ci_lower: summary.delta_ci.lower,
      delta_ci_upper: summary.delta_ci.upper,
      delta_ci_point: summary.delta_ci.point,
      per_kind: summary.per_kind,
    },
  };

  file.bound_experiences.push(entry);
  atomicWrite(jsonPath, JSON.stringify(file, null, 2) + '\n');
  const mdContents = renderAggregatorMarkdown(file, mdPath);
  atomicWrite(mdPath, mdContents);
  return entry;
}
