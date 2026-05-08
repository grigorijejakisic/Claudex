import { describe, it, expect } from 'vitest';
import {
  computeReplicationVerdict,
  poolReplications,
  perKindBreakdown,
} from '../../../benchmark/deliberation-surfacing/verdict.js';
import { wilsonDeltaCI } from '../../../benchmark/deliberation-surfacing/wilson.js';
import type { ReplicationRunResult, JudgeVerdict, ProbeOutcome } from '../../../benchmark/deliberation-surfacing/types.js';

const PASS_VERDICT: JudgeVerdict = {
  prong_1: { verdict: 'PASS', justification: 'p' },
  prong_2: { verdict: 'PASS', justification: 'p' },
  prong_3: { verdict: 'PASS', justification: 'p' },
  probe_pass: true,
  raw_response: '',
};
const FAIL_VERDICT: JudgeVerdict = {
  prong_1: { verdict: 'FAIL', justification: 'f' },
  prong_2: { verdict: 'FAIL', justification: 'f' },
  prong_3: { verdict: 'FAIL', justification: 'f' },
  probe_pass: false,
  raw_response: '',
};

function makeOutcome(probeId: string, kind: ProbeOutcome['kind'], summaryPass: boolean, transcriptPass: boolean): ProbeOutcome {
  return {
    probe_id: probeId,
    kind,
    summary_arm: { arm: 'summary', probe_id: probeId, agent_model: 'm', agent_response: 'x', injected_context_summary: { artifact_count: 0, transcript_span_count: 0, retrieval_path: 'none' }, latency_ms: 0 },
    transcript_arm: { arm: 'transcript', probe_id: probeId, agent_model: 'm', agent_response: 'x', injected_context_summary: { artifact_count: 0, transcript_span_count: 0, retrieval_path: 'cross_encoder' }, latency_ms: 0 },
    summary_judge: summaryPass ? PASS_VERDICT : FAIL_VERDICT,
    transcript_judge: transcriptPass ? PASS_VERDICT : FAIL_VERDICT,
  };
}

function makeReplication(label: string, summaryPasses: number, transcriptPasses: number, n = 30): ReplicationRunResult {
  const outcomes: ProbeOutcome[] = [];
  for (let i = 0; i < n; i++) {
    const summary = i < summaryPasses;
    const transcript = i < transcriptPasses;
    outcomes.push(makeOutcome(`p-${i}`, 'a', summary, transcript));
  }
  return {
    replication_label: label,
    started_at_iso: '2026-05-08T00:00:00.000Z',
    completed_at_iso: '2026-05-08T00:01:00.000Z',
    agent_model: 'm',
    judge_model: 'j',
    probe_count: n,
    retrieval_baseline: 'cross_encoder',
    outcomes,
    summary_pass_count: summaryPasses,
    transcript_pass_count: transcriptPasses,
  };
}

describe('computeReplicationVerdict', () => {
  it('POSITIVE for large lift: summary=5, transcript=25, n=30', () => {
    const r = makeReplication('r1', 5, 25, 30);
    const { verdict, delta_ci } = computeReplicationVerdict(r);
    expect(verdict).toBe('POSITIVE');
    expect(delta_ci.lower).toBeGreaterThan(0);
  });

  it('NEGATIVE for large drop: summary=25, transcript=5, n=30', () => {
    const r = makeReplication('r1', 25, 5, 30);
    const { verdict, delta_ci } = computeReplicationVerdict(r);
    expect(verdict).toBe('NEGATIVE');
    expect(delta_ci.upper).toBeLessThan(0);
  });

  it('INCONCLUSIVE for small lift: summary=14, transcript=16, n=30 (CI brackets zero)', () => {
    const r = makeReplication('r1', 14, 16, 30);
    const { verdict, delta_ci } = computeReplicationVerdict(r);
    expect(verdict).toBe('INCONCLUSIVE');
    const ci = wilsonDeltaCI(14, 30, 16, 30);
    expect(ci.lower).toBeLessThanOrEqual(0);
    expect(ci.upper).toBeGreaterThanOrEqual(0);
  });

  it('INCONCLUSIVE for degenerate: 0/30 vs 0/30', () => {
    const r = makeReplication('r1', 0, 0, 30);
    const { verdict } = computeReplicationVerdict(r);
    expect(verdict).toBe('INCONCLUSIVE');
  });

  it('honors P2 precedent: +10pp point delta with negative Wilson lower → INCONCLUSIVE not POSITIVE', () => {
    // summary=12, transcript=15, n=30 → +10pp point delta but small n
    const r = makeReplication('r1', 12, 15, 30);
    const { verdict, delta_ci } = computeReplicationVerdict(r);
    expect(verdict).toBe('INCONCLUSIVE');
    expect(delta_ci.lower).toBeLessThanOrEqual(0);
  });
});

describe('poolReplications', () => {
  it('pools two replications via sum of pass counts', () => {
    const r1 = makeReplication('r1', 5, 25, 30);
    const r2 = makeReplication('r2', 6, 24, 30);
    const summary = poolReplications([r1, r2]);
    expect(summary.pooled_n).toBe(60);
    expect(summary.pooled_summary_pass_count).toBe(11);
    expect(summary.pooled_transcript_pass_count).toBe(49);
    expect(summary.verdict).toBe('POSITIVE');
    // Pooled CI tighter than either individual CI
    const r1ci = wilsonDeltaCI(5, 30, 25, 30);
    expect(summary.delta_ci.upper - summary.delta_ci.lower).toBeLessThan(r1ci.upper - r1ci.lower);
  });

  it('returns degenerate ReplicationSummary on empty input', () => {
    const summary = poolReplications([]);
    expect(summary.total_probes).toBe(0);
    expect(summary.verdict).toBe('INCONCLUSIVE');
    expect(summary.replications).toEqual([]);
  });
});

describe('perKindBreakdown', () => {
  it('computes per-kind summary/transcript pass rates', () => {
    const outcomes: ProbeOutcome[] = [];
    // 6 of kind a all summary_pass, 0 transcript
    for (let i = 0; i < 6; i++) outcomes.push(makeOutcome(`a-${i}`, 'a', true, false));
    // 6 of kind b all transcript_pass, 0 summary
    for (let i = 0; i < 6; i++) outcomes.push(makeOutcome(`b-${i}`, 'b', false, true));
    const r: ReplicationRunResult = {
      replication_label: 'r1',
      started_at_iso: '',
      completed_at_iso: '',
      agent_model: 'm',
      judge_model: 'j',
      probe_count: 12,
      retrieval_baseline: 'cross_encoder',
      outcomes,
      summary_pass_count: 6,
      transcript_pass_count: 6,
    };
    const breakdown = perKindBreakdown([r]);
    const a = breakdown.find((k) => k.kind === 'a')!;
    const b = breakdown.find((k) => k.kind === 'b')!;
    expect(a.summary_pass_rate).toBe(1.0);
    expect(a.transcript_pass_rate).toBe(0);
    expect(a.delta).toBe(-1.0);
    expect(b.summary_pass_rate).toBe(0);
    expect(b.transcript_pass_rate).toBe(1.0);
    expect(b.delta).toBe(1.0);
    // Other kinds: zero counts
    const c = breakdown.find((k) => k.kind === 'c')!;
    expect(c.summary_pass_rate).toBe(0);
    expect(c.transcript_pass_rate).toBe(0);
  });
});
