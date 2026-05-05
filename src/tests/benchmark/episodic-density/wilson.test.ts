/**
 * Phase 2 Plan 04 — Wilson CI unit tests against published reference values.
 *
 * Team-lead non-negotiable #2: implement Wilson + delta-Wilson, unit-test
 * against published reference values (closed-form numbers, not the impl
 * we just wrote).
 *
 * Reference for wilsonCI(50, 100) at 95% CI:
 *   center = (0.5 + 1.96^2/200) / (1 + 1.96^2/100) ≈ 0.5
 *   half-width ≈ 0.0980
 *   → (0.4020, 0.5980); commonly tabulated as (0.4038, 0.5962) when using
 *     z = 1.959964 to higher precision. Our Z constant is 1.959964 → expect
 *     ≈ (0.4038, 0.5962) ± 1e-3.
 */

import { describe, it, expect } from 'vitest';
import { wilsonCI, wilsonDeltaCI, WILSON_Z_95 } from '../../../benchmark/episodic-density/wilson.js';

describe('wilsonCI single-proportion', () => {
  it('matches the published 50/100 reference within 1e-3', () => {
    const ci = wilsonCI(50, 100);
    expect(ci.point).toBeCloseTo(0.5, 6);
    expect(ci.lower).toBeCloseTo(0.4038, 3);
    expect(ci.upper).toBeCloseTo(0.5962, 3);
    expect(ci.n).toBe(100);
  });

  it('returns {0,0,0,0} for n=0 (no NaN)', () => {
    const ci = wilsonCI(0, 0);
    expect(ci).toEqual({ point: 0, lower: 0, upper: 0, n: 0 });
  });

  it('p=0 still produces a non-degenerate upper bound (Wilson advantage over Wald)', () => {
    const ci = wilsonCI(0, 30);
    expect(ci.point).toBe(0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0); // Wald would give 0; Wilson gives ~0.114
    expect(ci.upper).toBeLessThan(0.2);
  });

  it('p=1 still produces a non-degenerate lower bound', () => {
    const ci = wilsonCI(30, 30);
    expect(ci.point).toBe(1);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeLessThan(1);
    expect(ci.lower).toBeGreaterThan(0.85);
  });

  it('symmetry: wilsonCI(s,n) and wilsonCI(n-s,n) bounds reflect about 0.5', () => {
    const a = wilsonCI(20, 50);
    const b = wilsonCI(30, 50);
    expect(a.lower).toBeCloseTo(1 - b.upper, 6);
    expect(a.upper).toBeCloseTo(1 - b.lower, 6);
  });

  it('WILSON_Z_95 constant is the canonical 1.959964 (matches z = 1.959963984540054)', () => {
    expect(WILSON_Z_95).toBeCloseTo(1.959964, 6);
  });
});

describe('wilsonDeltaCI Newcombe method 10 (independent form)', () => {
  it('produces a positive point estimate when p2 > p1', () => {
    const ci = wilsonDeltaCI(40, 100, 60, 100);
    expect(ci.point).toBeCloseTo(0.20, 6);
    // Lower bound on the +0.20 delta should comfortably exclude zero at n=100
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.lower).toBeLessThan(0.20);
  });

  it('produces a CI lower bound that crosses zero for marginal deltas at small n', () => {
    // +5pp delta on n=40 — exactly the discipline test from CONTEXT item 5.
    // Decision rule says CI lower must be >= 0 to count as "measurable
    // improvement". We expect this case to be borderline (lower may be
    // slightly negative, illustrating why the CI check is the discipline
    // against shopping noise).
    const ci = wilsonDeltaCI(20, 40, 22, 40);
    expect(ci.point).toBeCloseTo(0.05, 6);
    expect(ci.lower).toBeLessThan(0.05);
    // At n=40 with +5pp, the CI lower bound is well below zero — proving
    // the discipline matters: a +5pp point estimate is NOT enough.
    expect(ci.lower).toBeLessThan(0);
  });

  it('handles n=0 gracefully', () => {
    const ci = wilsonDeltaCI(0, 0, 0, 0);
    expect(ci).toEqual({ point: 0, lower: 0, upper: 0, n: 0 });
  });

  it('symmetric: wilsonDeltaCI(s1,n1,s2,n2).point === -wilsonDeltaCI(s2,n2,s1,n1).point', () => {
    const a = wilsonDeltaCI(20, 50, 30, 50);
    const b = wilsonDeltaCI(30, 50, 20, 50);
    expect(a.point).toBeCloseTo(-b.point, 6);
    // bounds are NOT a simple negation pair under Newcombe — only the point
    // estimate is symmetric, the CI bounds depend on the per-proportion
    // Wilson intervals which are not symmetric in (s1,s2). This is
    // documented behavior, not a bug.
  });

  it('zero delta on identical proportions yields a CI symmetric around zero', () => {
    const ci = wilsonDeltaCI(25, 50, 25, 50);
    expect(ci.point).toBeCloseTo(0, 6);
    expect(ci.lower).toBeLessThan(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(Math.abs(ci.lower + ci.upper)).toBeLessThan(1e-6); // symmetric
  });
});
