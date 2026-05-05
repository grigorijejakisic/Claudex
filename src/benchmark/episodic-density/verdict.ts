/**
 * Phase 2 IDX-02 / IDX-04 — verdict module.
 *
 * Pure consumer of `HarnessRunResult.decision_rule_inputs`. Returns one of
 * three verdicts (GREEN_LIGHT, SCOPE_DOWN, KILL). The decision rule from
 * CONTEXT.md item 5 is cited verbatim in the JSDoc below — non-negotiable
 * per team-lead #1. No mutation of state, no I/O. The runner in
 * `runner.ts` calls this module BEFORE persisting the results.json and
 * BEFORE applying side effects (probe move, flag flip) — ordering is the
 * empirical-phase discipline (team-lead #4).
 *
 * /====================================================================
 *  CONTEXT.md item 5 — Decision rule (verbatim, locked BEFORE measurement)
 * ====================================================================/
 *
 * ## 5. Decision rule — locked BEFORE measurement runs
 *
 * Empirical-phase discipline: this rule is committed to CONTEXT.md and
 * PLAN.md before the harness is built. **No moving goalposts after we
 * see results.**
 *
 * **GREEN-LIGHT Phase 3 — proceed with full multi-handle retrieval cutover:**
 *
 * ALL three must hold on the **held-out test set**:
 * 1. RRF-fusion has measurable improvement over semantic-only — minimum
 *    **+5pp on either precision@5 OR recall@10**, AND the **Wilson 95% CI
 *    lower bound on the delta is ≥ 0** (i.e., the improvement is not
 *    statistically indistinguishable from zero at our sample size). The
 *    AND-CI-bound is the discipline that prevents green-lighting on noise
 *    — at n≈40-60 pairs, raw point-deltas of +5pp can be inside the CI
 *    of zero.
 * 2. Density at scale produces signal — ≥30% of high-similarity pairs
 *    (per #4) are intra-project recurrent.
 * 3. Latency p99 of fused retrieval < 2× semantic-only baseline. Cost
 *    discipline: a marginally-better signal that doubles tail latency is
 *    not worth shipping.
 *
 * **SCOPE-DOWN to advisory — Phase 3 ships, but lighter than originally planned:**
 * Improvement exists on specific subsets (e.g. only Python stack traces,
 * only one project) but not broadly. Phase 3 ships an **advisory-only
 * surface** ("you've hit a similar error before, see episode X") without
 * aggressive RRF fusion in the production retrieval path. Phase 5 density
 * abstraction is de-scoped accordingly (advisory, not abstraction).
 *
 * **KILL — pivot or stop:**
 * No measurable improvement (criteria 1 fails on held-out CI bound) OR
 * density is pure noise (criteria 2 fails). Phase 3 plan is rewritten or
 * the multi-handle thesis is reconsidered at the milestone level.
 */

import type { HarnessRunResult } from './harness.js';

export type VerdictKind = 'GREEN_LIGHT' | 'SCOPE_DOWN' | 'KILL' | 'BLOCKED';

export interface CriterionCheck {
  name:
    | 'criterion_1_fusion_improvement'
    | 'criterion_2_density_signal'
    | 'criterion_3_latency_budget';
  passed: boolean;
  observed: number;
  threshold: number;
  evidence: string;
  applies_to: 'criterion_1' | 'criterion_2' | 'criterion_3';
}

export interface Verdict {
  kind: VerdictKind;
  criteria: {
    criterion_1: CriterionCheck;
    criterion_2: CriterionCheck;
    criterion_3: CriterionCheck;
  };
  reasoning: string;
  computed_at_ts_epoch: number;
  decision_rule_quote: string;
  /** Set on BLOCKED kind — explains why measurement was unable to run. */
  blocked_reason?: string;
}

export const DECISION_RULE_QUOTE = `## 5. Decision rule — locked BEFORE measurement runs

Empirical-phase discipline: this rule is committed to CONTEXT.md and PLAN.md before the harness is built. **No moving goalposts after we see results.**

**GREEN-LIGHT Phase 3 — proceed with full multi-handle retrieval cutover:**

ALL three must hold on the **held-out test set**:
1. RRF-fusion has measurable improvement over semantic-only — minimum **+5pp on either precision@5 OR recall@10**, AND the **Wilson 95% CI lower bound on the delta is ≥ 0** (i.e., the improvement is not statistically indistinguishable from zero at our sample size). The AND-CI-bound is the discipline that prevents green-lighting on noise — at n≈40-60 pairs, raw point-deltas of +5pp can be inside the CI of zero.
2. Density at scale produces signal — ≥30% of high-similarity pairs (per #4) are intra-project recurrent.
3. Latency p99 of fused retrieval < 2× semantic-only baseline. Cost discipline: a marginally-better signal that doubles tail latency is not worth shipping.

**SCOPE-DOWN to advisory — Phase 3 ships, but lighter than originally planned:**
Improvement exists on specific subsets (e.g. only Python stack traces, only one project) but not broadly. Phase 3 ships an **advisory-only surface** ("you've hit a similar error before, see episode X") without aggressive RRF fusion in the production retrieval path. Phase 5 density abstraction is de-scoped accordingly (advisory, not abstraction).

**KILL — pivot or stop:**
No measurable improvement (criteria 1 fails on held-out CI bound) OR density is pure noise (criteria 2 fails). Phase 3 plan is rewritten or the multi-handle thesis is reconsidered at the milestone level.`;

const FUSION_DELTA_THRESHOLD = 0.05;
const DENSITY_INTRA_PROJECT_THRESHOLD = 0.30;
const LATENCY_RATIO_THRESHOLD = 2.0;

interface DeltaInput {
  delta: number;
  ci_lower: number;
  ci_upper: number;
}

function passesPerMetric(d: DeltaInput): boolean {
  // INVARIANT (enforced by 02-04 schema): the metric whose `delta` cleared
  // 5pp and the metric whose `ci_lower` we check are co-located in the
  // SAME fused_*_minus_semantic_* object (one for p@5, one for r@10).
  // Cross-metric drift is structurally impossible by construction — we
  // read both fields from the same struct, so `(delta_p5 >= 0.05 AND
  // ci_lower_r10 >= 0)` is literally unwritable. Therefore the criterion-1
  // logic is: for each metric object independently, test (delta >= 0.05
  // AND ci_lower >= 0); criterion PASSES iff at least one metric object
  // passes BOTH halves. Do NOT rewrite this as a max-then-pick — the
  // per-object structure is the discipline.
  return d.delta >= FUSION_DELTA_THRESHOLD && d.ci_lower >= 0;
}

export function computeVerdict(
  inputs: HarnessRunResult['decision_rule_inputs'],
  opts?: { ts_epoch?: number },
): Verdict {
  const computed_at_ts_epoch = opts?.ts_epoch ?? Math.floor(Date.now() / 1000);

  // Criterion 1 — fusion improvement (CI-binding discipline)
  const p5 = inputs.fused_p5_minus_semantic_p5;
  const r10 = inputs.fused_r10_minus_semantic_r10;
  const p5Passes = passesPerMetric(p5);
  const r10Passes = passesPerMetric(r10);
  const c1Passed = p5Passes || r10Passes;
  const observedDelta = Math.max(p5.delta, r10.delta);
  const criterion_1: CriterionCheck = {
    name: 'criterion_1_fusion_improvement',
    passed: c1Passed,
    observed: observedDelta,
    threshold: FUSION_DELTA_THRESHOLD,
    evidence: `delta_p5=${p5.delta.toFixed(4)} (CI lower ${p5.ci_lower.toFixed(4)}); delta_r10=${r10.delta.toFixed(4)} (CI lower ${r10.ci_lower.toFixed(4)}); n=${inputs.held_out_test_n}; CI-binding ${c1Passed ? 'satisfied by ' + (p5Passes ? 'p@5' : 'r@10') : 'failed both metrics'}`,
    applies_to: 'criterion_1',
  };

  // Criterion 2 — density signal
  const c2Passed = inputs.intra_project_share >= DENSITY_INTRA_PROJECT_THRESHOLD;
  const criterion_2: CriterionCheck = {
    name: 'criterion_2_density_signal',
    passed: c2Passed,
    observed: inputs.intra_project_share,
    threshold: DENSITY_INTRA_PROJECT_THRESHOLD,
    evidence: `intra_project_share=${inputs.intra_project_share.toFixed(4)} (threshold 0.30)`,
    applies_to: 'criterion_2',
  };

  // Criterion 3 — latency budget
  const c3Passed = inputs.p99_fused_over_p99_semantic < LATENCY_RATIO_THRESHOLD;
  const criterion_3: CriterionCheck = {
    name: 'criterion_3_latency_budget',
    passed: c3Passed,
    observed: inputs.p99_fused_over_p99_semantic,
    threshold: LATENCY_RATIO_THRESHOLD,
    evidence: `p99(C) / p99(A) = ${inputs.p99_fused_over_p99_semantic.toFixed(4)} (threshold 2.0)`,
    applies_to: 'criterion_3',
  };

  // Verdict assembly per CONTEXT item 5
  let kind: VerdictKind;
  if (c1Passed && c2Passed && c3Passed) {
    kind = 'GREEN_LIGHT';
  } else if (!c1Passed || !c2Passed) {
    kind = 'KILL';
  } else {
    kind = 'SCOPE_DOWN';
  }

  const reasoning = (() => {
    const c1 = `Criterion 1 ${criterion_1.passed ? 'PASSED' : 'FAILED'} (${criterion_1.evidence})`;
    const c2 = `Criterion 2 ${criterion_2.passed ? 'PASSED' : 'FAILED'} (${criterion_2.evidence})`;
    const c3 = `Criterion 3 ${criterion_3.passed ? 'PASSED' : 'FAILED'} (${criterion_3.evidence})`;
    let suffix = '';
    if (kind === 'GREEN_LIGHT') {
      suffix = 'Verdict: GREEN_LIGHT — full multi-handle retrieval cutover proceeds in Phase 3.';
    } else if (kind === 'SCOPE_DOWN') {
      suffix = 'Verdict: SCOPE_DOWN — fusion has signal but cost discipline blocks full cutover; advisory-only path forward per CONTEXT item 5.';
    } else {
      suffix = 'Verdict: KILL — no measurable signal or density is noise; Phase 3 plan rewritten at user-approval gate.';
    }
    return `${c1}. ${c2}. ${c3}. ${suffix}`;
  })();

  return {
    kind,
    criteria: { criterion_1, criterion_2, criterion_3 },
    reasoning,
    computed_at_ts_epoch,
    decision_rule_quote: DECISION_RULE_QUOTE,
  };
}

/**
 * Build a BLOCKED verdict surface for cases where the harness throws
 * before it can produce decision_rule_inputs (e.g. corpus floor not met).
 * Returned verbatim to callers; runner persists it to results.json with no
 * side effects fired.
 */
export function blockedVerdict(reason: string, opts?: { ts_epoch?: number }): Verdict {
  const computed_at_ts_epoch = opts?.ts_epoch ?? Math.floor(Date.now() / 1000);
  const stub: CriterionCheck = {
    name: 'criterion_1_fusion_improvement',
    passed: false,
    observed: 0,
    threshold: FUSION_DELTA_THRESHOLD,
    evidence: 'BLOCKED — measurement did not run',
    applies_to: 'criterion_1',
  };
  return {
    kind: 'BLOCKED',
    criteria: {
      criterion_1: stub,
      criterion_2: { ...stub, name: 'criterion_2_density_signal', threshold: DENSITY_INTRA_PROJECT_THRESHOLD, applies_to: 'criterion_2' },
      criterion_3: { ...stub, name: 'criterion_3_latency_budget', threshold: LATENCY_RATIO_THRESHOLD, applies_to: 'criterion_3' },
    },
    reasoning: `BLOCKED — ${reason}`,
    computed_at_ts_epoch,
    decision_rule_quote: DECISION_RULE_QUOTE,
    blocked_reason: reason,
  };
}
