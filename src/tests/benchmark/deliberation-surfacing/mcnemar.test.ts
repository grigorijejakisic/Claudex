/**
 * POLISH-09 — paired-McNemar exact test regression coverage.
 *
 * Tests the methodology-clean replacement for poolReplications.
 * 11-CONTEXT.md § Methodology critique #2 locks: pre-committed
 * minimum-discordant-pair threshold; INCONCLUSIVE below the threshold
 * regardless of p-value.
 */

import { describe, it, expect } from 'vitest';
import { pairedMcNemar } from '../../../benchmark/deliberation-surfacing/verdict.js';
import type { PerProbeOutcome } from '../../../benchmark/deliberation-surfacing/types.js';

function probe(
  id: string,
  r1a: boolean,
  r1b: boolean,
  r2a: boolean,
  r2b: boolean,
): PerProbeOutcome {
  return {
    probe_id: id,
    r1_a_arm_pass: r1a,
    r1_b_arm_pass: r1b,
    r2_a_arm_pass: r2a,
    r2_b_arm_pass: r2b,
  };
}

describe('pairedMcNemar — exact test on probe pass/fail patterns (POLISH-09)', () => {
  it('clear B-arm dominance with sufficient discordant pairs → BIND_POSITIVE', () => {
    // 30 probes: 5 concordant-pass, 5 concordant-fail, 18 b_only, 2 a_only.
    // discordant_pairs = 20; b_only = 18 vs a_only = 2; binomial p << 0.05.
    const outcomes: PerProbeOutcome[] = [];
    for (let i = 0; i < 5; i++) outcomes.push(probe(`con-pass-${i}`, true, true, true, true));
    for (let i = 0; i < 5; i++) outcomes.push(probe(`con-fail-${i}`, false, false, false, false));
    for (let i = 0; i < 18; i++) outcomes.push(probe(`b-only-${i}`, false, true, false, true));
    for (let i = 0; i < 2; i++) outcomes.push(probe(`a-only-${i}`, true, false, true, false));
    const r = pairedMcNemar(outcomes);
    expect(r.discordant_pairs).toBe(20);
    expect(r.b_only).toBe(18);
    expect(r.a_only).toBe(2);
    expect(r.p_value).toBeLessThan(0.05);
    expect(r.verdict).toBe('BIND_POSITIVE');
  });

  it('insufficient discordant pairs → INCONCLUSIVE regardless of p-value', () => {
    // 30 probes: 28 concordant, 2 b_only, 0 a_only — discordant_pairs = 2 < 5.
    const outcomes: PerProbeOutcome[] = [];
    for (let i = 0; i < 28; i++) outcomes.push(probe(`con-${i}`, true, true, true, true));
    for (let i = 0; i < 2; i++) outcomes.push(probe(`b-only-${i}`, false, true, false, true));
    const r = pairedMcNemar(outcomes);
    expect(r.discordant_pairs).toBe(2);
    expect(r.verdict).toBe('INCONCLUSIVE');
  });

  it('A-arm dominance → BIND_NEGATIVE', () => {
    const outcomes: PerProbeOutcome[] = [];
    for (let i = 0; i < 18; i++) outcomes.push(probe(`a-only-${i}`, true, false, true, false));
    for (let i = 0; i < 2; i++) outcomes.push(probe(`b-only-${i}`, false, true, false, true));
    const r = pairedMcNemar(outcomes);
    expect(r.verdict).toBe('BIND_NEGATIVE');
    expect(r.a_only).toBe(18);
    expect(r.b_only).toBe(2);
  });

  it('discordant pairs above threshold but insufficient effect → INCONCLUSIVE', () => {
    // 6 b_only + 4 a_only = 10 discordant; binomial(min=4, n=10, p=0.5) two-sided ≈ 0.75 > 0.05.
    const outcomes: PerProbeOutcome[] = [];
    for (let i = 0; i < 6; i++) outcomes.push(probe(`b-only-${i}`, false, true, false, true));
    for (let i = 0; i < 4; i++) outcomes.push(probe(`a-only-${i}`, true, false, true, false));
    const r = pairedMcNemar(outcomes);
    expect(r.discordant_pairs).toBe(10);
    expect(r.verdict).toBe('INCONCLUSIVE'); // p > 0.05
  });

  it('configurable minimum-discordant threshold via options', () => {
    const outcomes: PerProbeOutcome[] = [];
    for (let i = 0; i < 6; i++) outcomes.push(probe(`b-only-${i}`, false, true, false, true));
    for (let i = 0; i < 1; i++) outcomes.push(probe(`a-only-${i}`, true, false, true, false));
    // discordant_pairs = 7; b_only=6, a_only=1; binomial p ≈ 0.124 > 0.05.
    expect(pairedMcNemar(outcomes, { min_discordant_threshold: 5 }).verdict)
      .toBe('INCONCLUSIVE'); // p > 0.05 even with threshold met
    expect(pairedMcNemar(outcomes, { min_discordant_threshold: 10 }).verdict)
      .toBe('INCONCLUSIVE'); // discordant_pairs < threshold
  });

  it('per-replication breakdown matches input', () => {
    const outcomes: PerProbeOutcome[] = [
      probe('p1', true, false, false, true), // r1: a-only, r2: b-only
      probe('p2', false, true, false, true), // both reps b-only
    ];
    const r = pairedMcNemar(outcomes);
    expect(r.by_replication[0].a_pass).toBe(1);
    expect(r.by_replication[0].b_pass).toBe(1);
    expect(r.by_replication[1].a_pass).toBe(0);
    expect(r.by_replication[1].b_pass).toBe(2);
    expect(r.by_replication[0].n).toBe(2);
    expect(r.by_replication[1].n).toBe(2);
  });

  it('OR-aggregation across replications: probe passes if EITHER replication passes', () => {
    // Probe passes B-arm in r1 only — under OR-aggregation B-arm passes overall;
    // A-arm fails both reps. Single discordant b-only pair.
    const outcomes: PerProbeOutcome[] = [
      probe('p1', false, true, false, false),
      probe('p2', false, false, false, true),
      probe('p3', false, true, false, true),
      probe('p4', false, false, false, true),
      probe('p5', false, true, false, false),
    ];
    const r = pairedMcNemar(outcomes);
    expect(r.b_only).toBe(5); // every probe is b_only under OR-aggregation
    expect(r.a_only).toBe(0);
    expect(r.discordant_pairs).toBe(5);
    // n=5, b=5, a=0 → p = 2 * 0.5^5 = 0.0625 > 0.05 → INCONCLUSIVE.
    // The OR-aggregation correctness signal is the discordant_pairs count + direction,
    // not the p-value (which depends on the threshold).
    expect(r.verdict).toBe('INCONCLUSIVE');
  });

  it('zero outcomes returns INCONCLUSIVE with zero discordant pairs', () => {
    const r = pairedMcNemar([]);
    expect(r.discordant_pairs).toBe(0);
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.p_value).toBe(1);
  });
});
