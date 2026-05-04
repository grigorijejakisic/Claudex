# 02-04-PLAN Statistical Verification

**Verdict: PASS WITH NOTES**

The math is sound. Wilson single-proportion is canonical; Newcombe-style delta CI formula is correctly transcribed; reference test values verified by hand against published Wilson examples. Three clarifications below should be settled before execute.

## What I verified by hand

- `wilsonCI(50,100)` → (0.4038, 0.5962) ✓ matches canonical Wilson example.
- `wilsonDeltaCI(40,100,60,100)`: p1=0.4 → Wilson (0.30940, 0.49800); p2=0.6 → (0.50200, 0.69060). Delta=0.20, ci_lower = 0.20 − √((0.4−0.30940)² + (0.69060−0.6)²) = 0.20 − 0.12814 ≈ +0.0719 ✓ matches plan's "ci_lower > 0" assertion. Test value defensible.
- Wilson formulas in Task 1 (center, halfWidth) match Wilson 1927 closed form. Z=1.959964 is correct for 95% (not 1.96 truncated).
- Plan does NOT use Wald approximation or Clopper-Pearson — explicit Wilson, as CONTEXT mandates.

## Note 1 — Newcombe method 10 is the INDEPENDENT-proportions formula; the harness produces PAIRED data

Newcombe (Stat Med 1998) catalog: method 10 is the hybrid-score method for **independent** proportions. Method 11 / Tango's paired-score is the analog for paired data. Task 6 step 3 evaluates A and C on **the same query set** → the dichotomized-success vectors are paired, not independent.

Using independent method 10 on paired data is **conservatively wider** than the correct paired method (it ignores within-query correlation, which is positive across variants). At n=40–60 this widens CI lower bound — i.e., it makes green-light HARDER, not easier. This is defensible empirical-phase discipline (anti false-positive), but it is a methodological deviation from textbook-correct.

**Recommended clarification before execute:** add one line to wilson.ts JSDoc making the choice explicit: "We use the independent-proportions form even though our A/C vectors are paired; this is a conservative bias against green-light by design. A future revision could switch to Tango's paired score for tighter CIs." That keeps the discipline visible.

## Note 2 — "Macro-average + bootstrap CI" framing in Task 4 is muddled

Task 4 Note section says "Choose macro-average with bootstrap CI… we expose both — wilsonCI on dichotomized… bootstrap on continuous." Two parallel tracks is fine, but the prose conflates them. The decision rule (CONTEXT item 5 criterion 1) consumes only the **dichotomized Wilson** track. The bootstrap track is informational.

**Recommended clarification:** explicit one-liner in metrics.ts top JSDoc: "AggregateMetrics.precision_at_5 (CI) is the dichotomized-success Wilson CI — n = number of queries, successes = number of queries where ≥1 positive appeared in top-5. This is the figure CONTEXT decision rule criterion 1 consumes. Bootstrap CIs on continuous per-query rates are reported elsewhere as a sanity cross-check."

## Note 3 — CI-to-metric binding is implicit in 02-04, must be enforced in 02-05

Plan 02-04 correctly exposes `fused_p5_minus_semantic_p5` and `fused_r10_minus_semantic_r10` as separate objects, each with `delta`, `ci_lower`, `ci_upper`. CONTEXT item 5 criterion 1 requires: (delta_p5 ≥ +0.05 AND ci_lower_p5 ≥ 0) OR (delta_r10 ≥ +0.05 AND ci_lower_r10 ≥ 0). The harness output structure makes the wrong evaluation `(delta_p5 ≥ +0.05 AND ci_lower_r10 ≥ 0)` literally impossible to write by accident — fields are paired by metric. Good.

**Recommended clarification:** add to 02-04-SUMMARY.md output a sentence stating "Verdict logic in 02-05 must AND the ci_lower with the delta of the SAME metric. Per-metric pairing is enforced by the schema." Tells the next-plan author what invariant they're consuming.

## Goal-backward verdict

If executed faithfully, this harness produces statistical machinery whose green-light verdict can be trusted to gate Phase 3. Wilson is correct; the delta CI formula is correct (modulo paired-vs-independent conservatism, which biases toward not-shipping); test reference values are correct; per-metric pairing prevents the cross-metric ambiguity team-lead flagged. Three documentation clarifications, no formula changes.
