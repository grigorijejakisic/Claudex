/**
 * Phase 2 IDX-02 — quality metrics for the A/B/C harness.
 *
 * The decision rule (CONTEXT.md item 5) consumes ONLY the Wilson/Newcombe CI
 * tracks. Bootstrap percentiles are informational/diagnostic — surfaced in
 * RESULTS.md for analyst review, not gating logic. Specifically:
 * `AggregateMetrics.precision_at_5` (CI) is the dichotomized-success Wilson
 * CI — n = number of queries, successes = number of queries where ≥1
 * positive appeared in top-5. This is the figure CONTEXT decision rule
 * criterion 1 consumes. Bootstrap CIs on continuous per-query rates are
 * reported elsewhere as a sanity cross-check.
 *
 * Why dichotomize? At n ≈ 40-60 queries, the Newcombe delta CI on
 * paired success-counts is the textbook tool for "did fusion measurably
 * improve recall?" Macro-averaged continuous rates require resampling for
 * CIs and are noisier at small n. The two tracks coexist; the runner in
 * 02-05 reads only the Wilson track.
 */

import { wilsonCI, wilsonDeltaCI, type CI } from './wilson.js';
import type { RetrievalHit, Variant } from './retrieval.js';
import type { CorpusOrigin } from './types.js';

export interface PerQueryEval {
  query_event_id: number;
  variant: Variant;
  positives: number[];
  hits: RetrievalHit[];
  precision_at_5: number;
  recall_at_10: number;
  reciprocal_rank: number;
  origin_bucket: CorpusOrigin | 'mixed';
  latency_ms: number;
}

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

export interface AggregateMetrics {
  variant: Variant;
  origin_split: 'pooled' | CorpusOrigin;
  n: number;
  /** Wilson CI on dichotomized success indicator at top-5 — gates decision rule. */
  precision_at_5: CI;
  /** Wilson CI on dichotomized success indicator at top-10 — gates decision rule. */
  recall_at_10: CI;
  /** Continuous rate diagnostic (mean across queries) + bootstrap-ish CI. */
  mrr: { mean: number; ci_lower: number; ci_upper: number; n: number };
  latency_ms: LatencyPercentiles;
}

export interface DeltaMetrics {
  baseline: 'A_semantic';
  variant: Exclude<Variant, 'A_semantic'>;
  origin_split: 'pooled' | CorpusOrigin;
  /** Newcombe delta CI on the dichotomized p@5 success rate. */
  delta_precision_at_5: CI;
  /** Newcombe delta CI on the dichotomized r@10 success rate. */
  delta_recall_at_10: CI;
}

/* ------------------------------------------------------------------ */
/* per-query eval                                                      */
/* ------------------------------------------------------------------ */

export function evalQuery(
  query_event_id: number,
  variant: Variant,
  positives: number[],
  hits: RetrievalHit[],
  origin_bucket: CorpusOrigin | 'mixed',
  latency_ms: number,
): PerQueryEval {
  const positiveSet = new Set(positives);
  let firstHitRank = Infinity;
  let inTop5 = 0;
  let inTop10 = 0;
  for (const h of hits) {
    if (positiveSet.has(h.episode_event_id)) {
      if (h.rank < firstHitRank) firstHitRank = h.rank;
      if (h.rank <= 5) inTop5++;
      if (h.rank <= 10) inTop10++;
    }
  }
  const precision_at_5 = inTop5 / 5;
  const recall_at_10 = positives.length > 0 ? inTop10 / positives.length : 0;
  const reciprocal_rank = firstHitRank === Infinity ? 0 : 1 / firstHitRank;
  return {
    query_event_id,
    variant,
    positives,
    hits,
    precision_at_5,
    recall_at_10,
    reciprocal_rank,
    origin_bucket,
    latency_ms,
  };
}

/* ------------------------------------------------------------------ */
/* aggregation                                                         */
/* ------------------------------------------------------------------ */

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function latencyPercentiles(samples: number[]): LatencyPercentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function meanWithBootstrapCI(values: number[], seed = 4242): {
  mean: number;
  ci_lower: number;
  ci_upper: number;
  n: number;
} {
  if (values.length === 0) return { mean: 0, ci_lower: 0, ci_upper: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // Lightweight bootstrap (250 resamples) seeded for determinism.
  let s = seed >>> 0;
  function rand(): number {
    s = (s + 0x6D2B79F5) >>> 0;
    let r = s;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  }
  const samples: number[] = [];
  for (let i = 0; i < 250; i++) {
    let acc = 0;
    for (let j = 0; j < values.length; j++) {
      acc += values[Math.floor(rand() * values.length)];
    }
    samples.push(acc / values.length);
  }
  samples.sort((a, b) => a - b);
  return {
    mean,
    ci_lower: percentile(samples, 0.025),
    ci_upper: percentile(samples, 0.975),
    n: values.length,
  };
}

/**
 * Aggregate per-query metrics into a single variant×origin_split bucket.
 * Successes for the dichotomized indicator: count queries where any
 * positive appeared in top-k.
 */
export function aggregate(
  perQuery: PerQueryEval[],
  variant: Variant,
  originSplit: 'pooled' | CorpusOrigin,
): AggregateMetrics {
  const filtered =
    originSplit === 'pooled'
      ? perQuery.filter(q => q.variant === variant)
      : perQuery.filter(q => q.variant === variant && q.origin_bucket === originSplit);

  const n = filtered.length;
  const successesP5 = filtered.filter(q => q.precision_at_5 > 0).length;
  const successesR10 = filtered.filter(q => q.recall_at_10 > 0).length;
  const mrrValues = filtered.map(q => q.reciprocal_rank);
  const latencies = filtered.map(q => q.latency_ms);

  return {
    variant,
    origin_split: originSplit,
    n,
    precision_at_5: wilsonCI(successesP5, n),
    recall_at_10: wilsonCI(successesR10, n),
    mrr: meanWithBootstrapCI(mrrValues),
    latency_ms: latencyPercentiles(latencies),
  };
}

/**
 * Newcombe delta CI between baseline (A) and variant (B or C). Uses the
 * dichotomized-success counts on the SAME query set — the figure CONTEXT
 * item 5 criterion 1 consumes.
 */
export function deltaCI(
  baseline: AggregateMetrics,
  variant: AggregateMetrics,
): DeltaMetrics {
  if (baseline.variant !== 'A_semantic') {
    throw new Error(`deltaCI baseline must be A_semantic, got ${baseline.variant}`);
  }
  if (variant.variant === 'A_semantic') {
    throw new Error(`deltaCI variant must not be A_semantic`);
  }
  const sBaselineP5 = Math.round(baseline.precision_at_5.point * baseline.n);
  const sVariantP5 = Math.round(variant.precision_at_5.point * variant.n);
  const sBaselineR10 = Math.round(baseline.recall_at_10.point * baseline.n);
  const sVariantR10 = Math.round(variant.recall_at_10.point * variant.n);
  return {
    baseline: 'A_semantic',
    variant: variant.variant,
    origin_split: variant.origin_split,
    delta_precision_at_5: wilsonDeltaCI(sBaselineP5, baseline.n, sVariantP5, variant.n),
    delta_recall_at_10: wilsonDeltaCI(sBaselineR10, baseline.n, sVariantR10, variant.n),
  };
}
