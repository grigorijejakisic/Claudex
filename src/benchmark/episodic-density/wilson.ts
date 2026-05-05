/**
 * Phase 2 IDX-01 / IDX-02 — Wilson 95% confidence-interval module.
 *
 * Pure compute. No I/O, no clock, no random.
 *
 * The decision rule (CONTEXT.md item 5 of
 * `.planning/phases/02-multi-modal-index-seeds-density-check/02-CONTEXT.md`)
 * binds to Wilson CI lower-bound checks at n ≈ 40-60 pairs, where Wald
 * normal-approximation intervals are unsafe. Two functions:
 *
 *   - wilsonCI(s, n, z?)             — standard Wilson score interval for a
 *                                      single binomial proportion.
 *   - wilsonDeltaCI(s1, n1, s2, n2)  — CI on the DELTA (p2 - p1) using
 *                                      Newcombe's method 10 (the published
 *                                      independent-proportions hybrid score).
 *
 * IMPORTANT — paired-vs-independent caveat (per checker-02-04 verification):
 * The harness evaluates Variant A and Variant C on the SAME query set, so
 * the dichotomized success vectors are PAIRED (positively correlated across
 * variants). Applying Newcombe method 10 (independent form) to paired data
 * yields conservatively WIDER intervals — i.e., it makes GREEN_LIGHT HARDER,
 * not easier. This biases AGAINST false green-light, which is the empirically
 * honest direction for an empirical phase. Tango's paired score (Stat Med
 * 1998) would be tighter but adds within-query correlation modeling; the
 * conservative independent-form choice here is deliberate. A future
 * revision could switch to the paired score for tighter CIs once the
 * multi-handle thesis has cleared the conservative bar.
 */

/** z value for 95% CI (two-sided). 1.959963984540054 to double precision. */
export const WILSON_Z_95 = 1.959964 as const;

export interface CI {
  point: number; // point estimate
  lower: number; // lower bound at z (default 95%)
  upper: number; // upper bound at z (default 95%)
  n: number;     // sample size
}

/**
 * Wilson score interval for a binomial proportion.
 * `successes <= n`; both must be non-negative integers.
 *
 * Returns `{point:0, lower:0, upper:0, n:0}` when n=0 (never NaN). For a
 * proportion CI the bounds are intrinsically clipped to [0, 1] — no manual
 * clamping needed because the closed-form Wilson keeps them inside.
 */
export function wilsonCI(successes: number, n: number, z: number = WILSON_Z_95): CI {
  if (n <= 0) return { point: 0, lower: 0, upper: 0, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const halfWidth = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  const lower = Math.max(0, center - halfWidth);
  const upper = Math.min(1, center + halfWidth);
  return { point: p, lower, upper, n };
}

/**
 * Wilson-style CI on the DELTA between two independent proportions p2 - p1
 * via Newcombe's method 10 (the standard reference for delta-of-proportions
 * when sample sizes can be small).
 *
 * Implementation:
 *   1. Compute Wilson CI on p1 → (l1, u1).
 *   2. Compute Wilson CI on p2 → (l2, u2).
 *   3. Lower = (p2 - p1) - sqrt((p1 - l1)^2 + (u2 - p2)^2)
 *   4. Upper = (p2 - p1) + sqrt((u1 - p1)^2 + (p2 - l2)^2)
 *
 * Returns the delta CI. Unlike the proportion CI, the delta CI is allowed
 * to span [-1, +1] — DO NOT clamp.
 *
 * The `n` field is `min(n1, n2)` (descriptive only — the math is not
 * symmetric in the two sample sizes, and CONTEXT decision rule criterion 1
 * uses ci_lower regardless of which n drove the bound).
 */
export function wilsonDeltaCI(
  s1: number,
  n1: number,
  s2: number,
  n2: number,
  z: number = WILSON_Z_95,
): CI {
  if (n1 <= 0 || n2 <= 0) return { point: 0, lower: 0, upper: 0, n: 0 };
  const ci1 = wilsonCI(s1, n1, z);
  const ci2 = wilsonCI(s2, n2, z);
  const p1 = ci1.point;
  const p2 = ci2.point;
  const diff = p2 - p1;
  const lower = diff - Math.sqrt((p1 - ci1.lower) ** 2 + (ci2.upper - p2) ** 2);
  const upper = diff + Math.sqrt((ci1.upper - p1) ** 2 + (p2 - ci2.lower) ** 2);
  return { point: diff, lower, upper, n: Math.min(n1, n2) };
}
