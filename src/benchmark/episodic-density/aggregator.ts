/**
 * Phase 2.1 — milestone-level event-sourced aggregator helpers.
 *
 * The aggregator file at `.planning/aggregates/multi-handle.json` is
 * **strictly append-only** (CONTEXT.md decision 4d binding). Each phase
 * appends exactly the entries it produced. Existing entries are NEVER
 * modified — the bound-experience invariant requires that history
 * remain readable as written.
 *
 * Schema rules:
 *   - Top-level: `{schema_version, question, bound_experiences: BoundExperience[]}`
 *   - Each entry: `{phase, labeler, date, n, verdict, conditions, metrics}`
 *   - `phase` is a string ID (e.g. '2', '2.1-strict', '2.1-relaxed')
 *   - `labeler` is the LabelerTier string (Phase 2's entry uses 'strict_3frame')
 *   - `date` is ISO-8601 (YYYY-MM-DD)
 *   - `verdict` is one of: 'GREEN_LIGHT' | 'SCOPE_DOWN' | 'KILL' | 'BLOCKED'
 *   - `conditions` and `metrics` are open-shape objects (forward-compatible)
 *
 * NO `winning`, `current_consensus`, `primary`, `combined` key at the
 * top level. Aggregate IS the array; consumers iterate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Verdict } from './verdict.js';
import type { HarnessRunResult } from './harness.js';

export type AggregatorVerdict = 'GREEN_LIGHT' | 'SCOPE_DOWN' | 'KILL' | 'BLOCKED';

export interface BoundExperience {
  phase: string;            // '2', '2.1-strict', '2.1-relaxed', ...
  labeler: string;          // 'strict_3frame', 'relaxed_2frame'
  date: string;             // ISO-8601 date YYYY-MM-DD
  n: number;                // held-out test set size; 0 if BLOCKED
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
  'does multi-handle retrieval (semantic + non-semantic) improve recall over semantic-only at our scale?';

export const AGGREGATOR_PATH = path.resolve(
  process.cwd(),
  '.planning',
  'aggregates',
  'multi-handle.json',
);

/* ------------------------------------------------------------------ */
/* Atomic write — try/finally cleans up .tmp on rename throw          */
/* ------------------------------------------------------------------ */

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, contents);
  // Checker NOTE 2 binding (02.1-VERIFICATION.md): on rename throw,
  // remove the .tmp file in a `finally` so partial-failure does not
  // leak .tmp.PID files into .planning/aggregates/. The alternative
  // (leave .tmp behind for forensics) is rejected.
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone — fine */
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Load / build helpers                                                 */
/* ------------------------------------------------------------------ */

export function loadAggregator(filePath: string = AGGREGATOR_PATH): AggregatorFile {
  if (!fs.existsSync(filePath)) {
    return { schema_version: 1, question: AGGREGATOR_QUESTION, bound_experiences: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AggregatorFile;
  // Light shape validation — caller responsibility to preserve schema.
  if (!Array.isArray(parsed.bound_experiences)) {
    throw new Error(
      `loadAggregator: ${filePath} is not a valid AggregatorFile (missing bound_experiences array)`,
    );
  }
  return parsed;
}

/**
 * Build Phase 2's bound-experience entry from Phase 2's published
 * `02-results.json`. Pure function over JSON parse — no DB, no clock.
 *
 * Phase 2 used the OLD two-tier corpus_origin scheme (phase1_organic
 * / v4_backfill); we do NOT re-classify Phase 2's metrics under the
 * three-tier scheme — the published bound experience is what was
 * published (CONTEXT.md `Deferred Ideas`).
 */
export function buildPhase2Entry(phase2ResultsJson: unknown): BoundExperience {
  type Phase2Json = {
    generated_at_ts_epoch?: number;
    harness?: {
      ts_epoch?: number;
      pairs?: { test?: number; total?: number };
      decision_rule_inputs?: HarnessRunResult['decision_rule_inputs'];
      corpus_size?: Record<string, unknown>;
      density?: { intra_project_share?: number };
      metrics?: { pooled?: { A?: { latency_ms?: { p99?: number } }; C?: { latency_ms?: { p99?: number } } } };
    };
    verdict?: { kind?: AggregatorVerdict };
  };
  const j = phase2ResultsJson as Phase2Json;
  const ts = j.harness?.ts_epoch ?? j.generated_at_ts_epoch ?? 0;
  const date = ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : 'unknown';
  const n = j.harness?.decision_rule_inputs?.held_out_test_n ?? j.harness?.pairs?.test ?? 0;
  const dri = j.harness?.decision_rule_inputs;
  return {
    phase: '2',
    labeler: 'strict_3frame',
    date,
    n,
    verdict: j.verdict?.kind ?? 'BLOCKED',
    conditions: {
      corpus_size: j.harness?.corpus_size ?? {},
      pair_set_total: j.harness?.pairs?.total ?? 0,
      pair_set_test: j.harness?.pairs?.test ?? 0,
      auto_labeler_precision: 'pre-2.1: not stratified by corpus_origin (Phase 2 audit at 02-03-corpus-audit.md)',
      corpus_origin_scheme: 'phase1_organic / v4_backfill (legacy two-tier)',
    },
    metrics: {
      delta_precision_at_5: dri?.fused_p5_minus_semantic_p5 ?? null,
      delta_recall_at_10: dri?.fused_r10_minus_semantic_r10 ?? null,
      intra_project_share: dri?.intra_project_share ?? null,
      p99_fused_over_p99_semantic: dri?.p99_fused_over_p99_semantic ?? null,
    },
  };
}

/**
 * Build a Phase 2.1 bound-experience entry from a tier-tuple. Pure.
 */
export function buildPhase21Entry(
  tier: 'strict_3frame' | 'relaxed_2frame',
  harness: HarnessRunResult,
  verdict: Verdict,
  auditSummary: { tier_total: { valid: number; sampled: number }; per_stratum: Record<string, { valid: number; sampled: number }> } | null,
  date: string,
): BoundExperience {
  const phaseId = tier === 'strict_3frame' ? '2.1-strict' : '2.1-relaxed';
  return {
    phase: phaseId,
    labeler: tier,
    date,
    n: harness.decision_rule_inputs.held_out_test_n,
    verdict: verdict.kind,
    conditions: {
      corpus_size: harness.corpus_size,
      pair_set_total: harness.pairs.total,
      pair_set_test: harness.pairs.test,
      seed: harness.pairs.seed,
      auto_labeler_precision: auditSummary
        ? {
            tier_total: `${auditSummary.tier_total.valid}/${auditSummary.tier_total.sampled}`,
            per_stratum: auditSummary.per_stratum,
          }
        : 'audit pending — re-render after audit completes',
      corpus_origin_scheme:
        'three-tier phase-anchored (v4_backfill / phase1_organic_pre_phase2_close / phase1_organic_post_phase2_close)',
    },
    metrics: {
      delta_precision_at_5: harness.decision_rule_inputs.fused_p5_minus_semantic_p5,
      delta_recall_at_10: harness.decision_rule_inputs.fused_r10_minus_semantic_r10,
      intra_project_share: harness.decision_rule_inputs.intra_project_share,
      p99_fused_over_p99_semantic: harness.decision_rule_inputs.p99_fused_over_p99_semantic,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Append helpers                                                       */
/* ------------------------------------------------------------------ */

function entryKey(e: { phase: string; labeler: string }): string {
  return `${e.phase}::${e.labeler}`;
}

/**
 * Append entries idempotently, preserving append-only invariant.
 *
 *  - If aggregator file does not exist, create it with the question
 *    header. If `opts.phase2ResultsJson` is provided, seed Phase 2's
 *    entry first; then append the new entries.
 *  - For each new entry: skip if (phase, labeler) tuple already exists
 *    (idempotency); otherwise push to tail.
 *  - Existing entries are NEVER mutated — schema test in Plan 02.1-04
 *    Task 6 byte-equal-asserts.
 *  - Atomic write.
 *
 * Returns the count of NEW entries appended this call (0..N+1, where
 * the +1 is the seeded Phase 2 entry on first run).
 */
export function appendBoundExperiences(
  newEntries: BoundExperience[],
  opts?: {
    phase2ResultsJson?: unknown;
    filePath?: string;
  },
): number {
  const filePath = opts?.filePath ?? AGGREGATOR_PATH;
  const exists = fs.existsSync(filePath);
  let aggregator: AggregatorFile = exists
    ? loadAggregator(filePath)
    : { schema_version: 1, question: AGGREGATOR_QUESTION, bound_experiences: [] };

  let appended = 0;
  const knownKeys = new Set(aggregator.bound_experiences.map(entryKey));

  // Seed Phase 2 entry on first run if provided.
  if (!exists && opts?.phase2ResultsJson != null) {
    const phase2 = buildPhase2Entry(opts.phase2ResultsJson);
    const key = entryKey(phase2);
    if (!knownKeys.has(key)) {
      aggregator.bound_experiences.push(phase2);
      knownKeys.add(key);
      appended++;
    }
  }

  // Append new entries (skip duplicates by tuple).
  for (const entry of newEntries) {
    const key = entryKey(entry);
    if (knownKeys.has(key)) continue;
    aggregator.bound_experiences.push(entry);
    knownKeys.add(key);
    appended++;
  }

  atomicWrite(filePath, JSON.stringify(aggregator, null, 2));
  return appended;
}
