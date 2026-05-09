import { wilsonDeltaCI, type CI } from './wilson.js';
import type {
  ReplicationRunResult,
  BindVerdict,
  ReplicationSummary,
  PerProbeOutcome,
  McNemarVerdict,
} from './types.js';

/**
 * Per-replication BindVerdict via Wilson/Newcombe CI on Δ(transcript − summary).
 *
 * CONTEXT decision 4 (locked):
 *   - Wilson lower > 0 → POSITIVE
 *   - Wilson upper < 0 → NEGATIVE
 *   - lower ≤ 0 AND upper ≥ 0 → INCONCLUSIVE (CI brackets zero)
 */
export function computeReplicationVerdict(result: ReplicationRunResult): {
  verdict: BindVerdict;
  delta_ci: CI;
} {
  const n = result.probe_count;
  const ci = wilsonDeltaCI(result.summary_pass_count, n, result.transcript_pass_count, n);
  const verdict =
    ci.lower > 0 ? 'POSITIVE' :
    ci.upper < 0 ? 'NEGATIVE' :
    'INCONCLUSIVE';
  return { verdict, delta_ci: ci };
}

/**
 * Pooled-across-replications verdict + descriptive per-kind breakdown.
 *
 * CONTEXT decision 4: pool by summing pass counts across replications,
 * treat as one binomial-vs-binomial comparison at n_pooled = sum of probe_count.
 *
 * Per-kind breakdown is DESCRIPTIVE ONLY — CONTEXT additional_locks rules
 * out per-kind binding gates ("the pooled cross-kind verdict is the gate").
 */
export function poolReplications(results: ReplicationRunResult[]): ReplicationSummary {
  if (results.length === 0) {
    return {
      replications: [],
      total_probes: 0,
      pooled_summary_pass_count: 0,
      pooled_transcript_pass_count: 0,
      pooled_n: 0,
      delta_ci: { point: 0, lower: 0, upper: 0, n: 0 },
      verdict: 'INCONCLUSIVE',
      per_kind: [],
    };
  }
  const total_probes = results.reduce((s, r) => s + r.probe_count, 0);
  const pooled_summary = results.reduce((s, r) => s + r.summary_pass_count, 0);
  const pooled_transcript = results.reduce((s, r) => s + r.transcript_pass_count, 0);
  const ci = wilsonDeltaCI(pooled_summary, total_probes, pooled_transcript, total_probes);
  const verdict =
    ci.lower > 0 ? 'POSITIVE' :
    ci.upper < 0 ? 'NEGATIVE' :
    'INCONCLUSIVE';
  return {
    replications: results.map((r) => r.replication_label),
    total_probes,
    pooled_summary_pass_count: pooled_summary,
    pooled_transcript_pass_count: pooled_transcript,
    pooled_n: total_probes,
    delta_ci: ci,
    verdict,
    per_kind: perKindBreakdown(results),
  };
}

export function perKindBreakdown(results: ReplicationRunResult[]) {
  const kinds: Array<'a' | 'b' | 'c' | 'd' | 'e'> = ['a', 'b', 'c', 'd', 'e'];
  return kinds.map((kind) => {
    let s_pass = 0;
    let t_pass = 0;
    let n = 0;
    for (const r of results) {
      for (const o of r.outcomes) {
        if (o.kind !== kind) continue;
        n++;
        if (o.summary_judge.probe_pass) s_pass++;
        if (o.transcript_judge.probe_pass) t_pass++;
      }
    }
    return {
      kind,
      summary_pass_rate: n > 0 ? s_pass / n : 0,
      transcript_pass_rate: n > 0 ? t_pass / n : 0,
      delta: n > 0 ? (t_pass - s_pass) / n : 0,
      descriptive_only: true as const,
    };
  });
}

// ---------------------------------------------------------------------------
// POLISH-09 — paired-McNemar exact test (replaces poolReplications semantics)
// ---------------------------------------------------------------------------

/**
 * Paired-McNemar exact test on per-probe paired pass/fail patterns across
 * r1 + r2. Replaces the pseudoreplication-prone `poolReplications` shape.
 *
 * Per 11-CONTEXT.md § Methodology critique #2:
 *   - Pre-commit minimum-discordant-pair threshold (default 5).
 *   - Below the threshold → INCONCLUSIVE regardless of p-value.
 *
 * Per 11-CONTEXT.md § Implementation Decisions: OR-aggregate r1 + r2 per
 * probe (probe passes B-arm iff EITHER replication's B-arm passes). This
 * captures the strictest discordant-pair signal — the alternative
 * (require both replications to pass) is too strict given known judge
 * variance.
 *
 * Verdict:
 *   - p < 0.05 AND b_only > a_only → BIND_POSITIVE
 *   - p < 0.05 AND a_only > b_only → BIND_NEGATIVE
 *   - else                          → INCONCLUSIVE
 */
export function pairedMcNemar(
  outcomes: PerProbeOutcome[],
  options: { min_discordant_threshold?: number } = {},
): McNemarVerdict {
  const minThreshold = options.min_discordant_threshold ?? 5;

  let a_only = 0;
  let b_only = 0;
  for (const o of outcomes) {
    const a_pass = o.r1_a_arm_pass || o.r2_a_arm_pass;
    const b_pass = o.r1_b_arm_pass || o.r2_b_arm_pass;
    if (a_pass && !b_pass) a_only++;
    else if (b_pass && !a_pass) b_only++;
    // Concordant pairs (both pass or both fail) drop out of McNemar.
  }
  const discordant_pairs = a_only + b_only;

  // McNemar exact: under H0 (no difference), b_only ~ Binomial(discordant_pairs, 0.5).
  // Two-sided p-value: 2 × P(X ≤ min(a_only, b_only) | n=discordant_pairs, p=0.5).
  let p_value = 1.0;
  if (discordant_pairs > 0) {
    const k = Math.min(a_only, b_only);
    p_value = Math.min(1, 2 * binomialCdf(k, discordant_pairs, 0.5));
  }

  let verdict: McNemarVerdict['verdict'];
  if (discordant_pairs < minThreshold) {
    verdict = 'INCONCLUSIVE';
  } else if (p_value < 0.05 && b_only > a_only) {
    verdict = 'BIND_POSITIVE';
  } else if (p_value < 0.05 && a_only > b_only) {
    verdict = 'BIND_NEGATIVE';
  } else {
    verdict = 'INCONCLUSIVE';
  }

  // Per-replication breakdown for transparency (descriptive, not a binding gate).
  const by_replication: McNemarVerdict['by_replication'] = ([1, 2] as const).map((r) => {
    let a_pass = 0;
    let b_pass = 0;
    for (const o of outcomes) {
      if (r === 1) {
        if (o.r1_a_arm_pass) a_pass++;
        if (o.r1_b_arm_pass) b_pass++;
      } else {
        if (o.r2_a_arm_pass) a_pass++;
        if (o.r2_b_arm_pass) b_pass++;
      }
    }
    return { replication: r, a_pass, b_pass, n: outcomes.length };
  });

  return {
    a_only,
    b_only,
    discordant_pairs,
    p_value,
    min_discordant_threshold: minThreshold,
    verdict,
    by_replication,
  };
}

// Binomial CDF — exact, not approximation. n is small (≤ 60), no numerical issues.
function binomialCdf(k: number, n: number, p: number): number {
  let cdf = 0;
  for (let i = 0; i <= k; i++) cdf += binomialPmf(i, n, p);
  return cdf;
}
function binomialPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  return Math.exp(logCombination(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}
function logCombination(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let log = 0;
  for (let i = 1; i <= k; i++) log += Math.log(n - i + 1) - Math.log(i);
  return log;
}
