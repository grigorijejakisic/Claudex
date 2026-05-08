import { wilsonDeltaCI, type CI } from './wilson.js';
import type { ReplicationRunResult, BindVerdict, ReplicationSummary } from './types.js';

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
