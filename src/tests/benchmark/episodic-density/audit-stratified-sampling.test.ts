/**
 * Phase 2.1 Plan 02.1-03 — stratified-sampling audit math tests
 * (CONTEXT.md decision 3a/3b/3c).
 *
 * Asserts:
 *   - Proportional allocation per single-origin stratum.
 *   - Rounding remainder distribution lands at exactly target.
 *   - Mixed-stratum pairs reported descriptively but excluded from
 *     stratified slots.
 *   - Under-target pair count: allocation downsizes to population.
 *   - Single-origin tier (only one stratum populated).
 *   - Determinism on fixed seed.
 *   - planAudit is pure: no DB, no fs, no clock.
 */

import { describe, it, expect, vi } from 'vitest';
import { planAudit } from '../../../benchmark/episodic-density/audit.js';
import type { LabeledPair } from '../../../benchmark/episodic-density/pair-labeling.js';
import type { CorpusOrigin } from '../../../benchmark/episodic-density/types.js';

function makePair(
  a: number,
  b: number,
  origin_a: CorpusOrigin,
  origin_b: CorpusOrigin,
): LabeledPair {
  return {
    a,
    b,
    outer_exception: 'TypeError',
    overlap_frame_count: 3,
    same_project: true,
    origin_a,
    origin_b,
  };
}

function makeBatch(
  n: number,
  origin: CorpusOrigin,
  startId = 1,
): LabeledPair[] {
  const out: LabeledPair[] = [];
  for (let i = 0; i < n; i++) {
    out.push(makePair(startId + i * 2, startId + i * 2 + 1, origin, origin));
  }
  return out;
}

describe('planAudit — proportional allocation', () => {
  it('clean proportions: v4=60, pre=30, post=10, mixed=0; target=20 -> 12/6/2', () => {
    const pairs = [
      ...makeBatch(60, 'v4_backfill', 1000),
      ...makeBatch(30, 'phase1_organic_pre_phase2_close', 2000),
      ...makeBatch(10, 'phase1_organic_post_phase2_close', 3000),
    ];
    const plan = planAudit(pairs, 'strict_3frame', { target: 20, seed: 4321 });
    const byOrigin = new Map(plan.strata.map(s => [s.origin, s]));
    expect(byOrigin.get('v4_backfill')?.allocation).toBe(12);
    expect(byOrigin.get('phase1_organic_pre_phase2_close')?.allocation).toBe(6);
    expect(byOrigin.get('phase1_organic_post_phase2_close')?.allocation).toBe(2);
    expect(plan.sampled_total).toBe(20);
  });

  it('rounding remainder distribution: 33/33/34 -> 6/6/6 floor + 2 distributed -> sum=20', () => {
    const pairs = [
      ...makeBatch(33, 'v4_backfill', 1000),
      ...makeBatch(33, 'phase1_organic_pre_phase2_close', 2000),
      ...makeBatch(34, 'phase1_organic_post_phase2_close', 3000),
    ];
    const plan = planAudit(pairs, 'strict_3frame', { target: 20, seed: 4321 });
    expect(plan.sampled_total).toBe(20);
    const totalAlloc =
      plan.strata
        .filter(s => s.origin !== 'mixed')
        .reduce((acc, s) => acc + s.allocation, 0);
    expect(totalAlloc).toBe(20);
  });

  it('mixed pairs excluded from allocation but counted in plan', () => {
    const pairs = [
      ...makeBatch(30, 'v4_backfill', 1000),
      ...makeBatch(30, 'phase1_organic_pre_phase2_close', 2000),
      ...makeBatch(30, 'phase1_organic_post_phase2_close', 3000),
      // 10 mixed pairs
      makePair(4001, 4002, 'v4_backfill', 'phase1_organic_pre_phase2_close'),
      makePair(4003, 4004, 'v4_backfill', 'phase1_organic_pre_phase2_close'),
      makePair(4005, 4006, 'v4_backfill', 'phase1_organic_pre_phase2_close'),
      makePair(4007, 4008, 'v4_backfill', 'phase1_organic_post_phase2_close'),
      makePair(4009, 4010, 'v4_backfill', 'phase1_organic_post_phase2_close'),
      makePair(4011, 4012, 'phase1_organic_pre_phase2_close', 'phase1_organic_post_phase2_close'),
      makePair(4013, 4014, 'phase1_organic_pre_phase2_close', 'phase1_organic_post_phase2_close'),
      makePair(4015, 4016, 'phase1_organic_pre_phase2_close', 'phase1_organic_post_phase2_close'),
      makePair(4017, 4018, 'phase1_organic_pre_phase2_close', 'phase1_organic_post_phase2_close'),
      makePair(4019, 4020, 'phase1_organic_pre_phase2_close', 'phase1_organic_post_phase2_close'),
    ];
    const plan = planAudit(pairs, 'relaxed_2frame', { target: 20, seed: 4321 });
    const byOrigin = new Map(plan.strata.map(s => [s.origin, s]));
    // Single-origin denominator = 90; allocation summing to 20.
    expect(plan.sampled_total).toBe(20);
    expect(byOrigin.get('mixed')?.population).toBe(10);
    expect(byOrigin.get('mixed')?.allocation).toBe(0);
    expect(byOrigin.get('mixed')?.sampled.length).toBe(0);
  });

  it('under-target pair count: 4+4+4 single-origin, 0 mixed, target=20 -> sample all 12', () => {
    const pairs = [
      ...makeBatch(4, 'v4_backfill', 1000),
      ...makeBatch(4, 'phase1_organic_pre_phase2_close', 2000),
      ...makeBatch(4, 'phase1_organic_post_phase2_close', 3000),
    ];
    const plan = planAudit(pairs, 'strict_3frame', { target: 20, seed: 4321 });
    expect(plan.sampled_total).toBe(12);
    for (const stratum of plan.strata) {
      if (stratum.origin === 'mixed') continue;
      expect(stratum.allocation).toBeLessThanOrEqual(stratum.population);
    }
  });

  it('single-origin tier: 50 pairs all v4_backfill -> all 20 in v4 stratum', () => {
    const pairs = makeBatch(50, 'v4_backfill', 1000);
    const plan = planAudit(pairs, 'strict_3frame', { target: 20, seed: 4321 });
    const byOrigin = new Map(plan.strata.map(s => [s.origin, s]));
    expect(byOrigin.get('v4_backfill')?.allocation).toBe(20);
    expect(byOrigin.get('phase1_organic_pre_phase2_close')?.allocation).toBe(0);
    expect(byOrigin.get('phase1_organic_post_phase2_close')?.allocation).toBe(0);
    expect(plan.sampled_total).toBe(20);
  });
});

describe('planAudit — determinism + purity', () => {
  it('determinism: same input + same seed -> byte-equal plan.strata[i].sampled', () => {
    const pairs = [
      ...makeBatch(20, 'v4_backfill', 1000),
      ...makeBatch(20, 'phase1_organic_pre_phase2_close', 2000),
      ...makeBatch(20, 'phase1_organic_post_phase2_close', 3000),
    ];
    const a = planAudit(pairs, 'strict_3frame', { target: 20, seed: 4321 });
    const b = planAudit(pairs, 'strict_3frame', { target: 20, seed: 4321 });
    expect(JSON.stringify(a.strata.map(s => s.sampled))).toBe(
      JSON.stringify(b.strata.map(s => s.sampled)),
    );
  });

  it('different seeds shuffle differently (sanity check)', () => {
    const pairs = makeBatch(20, 'v4_backfill', 1000);
    const a = planAudit(pairs, 'strict_3frame', { target: 5, seed: 1 });
    const b = planAudit(pairs, 'strict_3frame', { target: 5, seed: 2 });
    // Sampled pairs differ across seeds (very high probability at n=20, k=5).
    expect(JSON.stringify(a.strata.find(s => s.origin === 'v4_backfill')?.sampled))
      .not.toBe(JSON.stringify(b.strata.find(s => s.origin === 'v4_backfill')?.sampled));
  });

  it('planAudit is pure: clock not consulted (Date.now spy)', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    const pairs = [
      ...makeBatch(10, 'v4_backfill', 1000),
      ...makeBatch(5, 'phase1_organic_pre_phase2_close', 2000),
    ];
    planAudit(pairs, 'strict_3frame', { target: 10, seed: 4321 });
    expect(dateSpy).not.toHaveBeenCalled();
    dateSpy.mockRestore();
  });

  it('planAudit purity by stability: identical inputs/seed across two runs produces byte-equal plan (no fs/DB side effects could vary)', () => {
    const pairs = [
      ...makeBatch(10, 'v4_backfill', 1000),
      ...makeBatch(5, 'phase1_organic_pre_phase2_close', 2000),
    ];
    const planA = planAudit(pairs, 'strict_3frame', { target: 10, seed: 4321 });
    const planB = planAudit(pairs, 'strict_3frame', { target: 10, seed: 4321 });
    expect(JSON.stringify(planA)).toBe(JSON.stringify(planB));
  });
});
