---
phase: 02-multi-modal-index-seeds-density-check
plan: 04
subsystem: benchmark/measurement
tags: [v5, phase2, idx-01, idx-02, idx-04, wilson, newcombe, rrf, density, harness]
requires: [phase-1-substrate, v26-schema, error-fingerprint-module, populated-sidecar]
provides: [measurement-harness, decision-rule-inputs, density-signal, wilson-ci, retrieval-variants]
affects:
  - src/benchmark/episodic-density/wilson.ts
  - src/benchmark/episodic-density/pair-labeling.ts
  - src/benchmark/episodic-density/retrieval.ts
  - src/benchmark/episodic-density/metrics.ts
  - src/benchmark/episodic-density/density.ts
  - src/benchmark/episodic-density/harness.ts
tech-stack:
  added: []
  patterns: [wilson-ci, newcombe-method-10, rrf-fusion, jaccard-on-shingles, dichotomized-success-indicator]
key-files:
  created:
    - src/benchmark/episodic-density/wilson.ts
    - src/benchmark/episodic-density/pair-labeling.ts
    - src/benchmark/episodic-density/retrieval.ts
    - src/benchmark/episodic-density/metrics.ts
    - src/benchmark/episodic-density/density.ts
    - src/benchmark/episodic-density/harness.ts
    - src/tests/benchmark/episodic-density/wilson.test.ts
    - src/tests/benchmark/episodic-density/pair-labeling.test.ts
    - src/tests/benchmark/episodic-density/metrics.test.ts
    - src/tests/benchmark/episodic-density/density.test.ts
    - src/tests/benchmark/episodic-density/harness.test.ts
  modified: []
key-decisions:
  - "Wilson formula closed-form: center = (p + z²/(2n)) / (1 + z²/n); halfWidth = z·sqrt(p(1-p)/n + z²/(4n²)) / (1 + z²/n). Validated against published (50/100) reference (0.4038, 0.5962) ± 1e-3."
  - "Newcombe method 10 (independent form) applied to paired data is conservatively wider; documented in wilson.ts JSDoc per checker-02-04 verification — biases AGAINST false green-light."
  - "Variant A is bag-of-words cosine over raw_content (NOT production hybrid-retrieval). Production retrieval ranks artifacts (not episodic_events) and the apples-to-apples requirement for measurement dominates the realism question — A's role is baseline, not realism. Plan 02-05 / Phase 3 keep this decoupled."
  - "Variant B score = overlap_count / |query_shingles| (Tversky-asymmetric). Fast, monotone, fine for ranking; CONTEXT discretion."
  - "Variant C uses RRF k=60 constant. Learned weights deferred to Phase 3 per CONTEXT discretion."
  - "Decision rule consumes ONLY the dichotomized-success Wilson + Newcombe track from metrics.ts. Bootstrap CIs on continuous per-query rates are diagnostic — surfaced in RESULTS.md but never gating logic. JSDoc at top of metrics.ts documents this verbatim per checker-02-04 Note 2."
  - "Density similarity is Jaccard over the SHINGLE space (NOT embedding space). Internally consistent with Variant B's retrieval scoring so decision rule criteria 1 and 2 reference the same similarity space."
  - "Per-metric pairing invariant: decision_rule_inputs has fused_p5_minus_semantic_p5 and fused_r10_minus_semantic_r10 as separate objects, each with delta+ci_lower+ci_upper. The verdict module in 02-05 must AND the ci_lower with the delta of the SAME metric — cross-metric drift is structurally impossible by construction. Per checker-02-04 verification Note 3."
requirements-completed: [IDX-01, IDX-02, IDX-04]
duration: "30 min"
completed: "2026-05-04"
---

# Phase 2 Plan 4: A/B/C Measurement Harness Summary

Six pure modules (Wilson CI, pair labeling, three retrieval variants, metrics with Wilson/Newcombe + bootstrap, density signal, top-level orchestrator) plus 5 test files (40 cases) that turn the corpus from Plan 02-03 into the numbers Plan 02-05's verdict module consumes. Read-only against the corpus; deterministic on a fixed seed.

## Final algorithm choices

| Module | Choice | Reasoning |
|--------|--------|-----------|
| Wilson 95% z | 1.959964 | Canonical to 6 places. |
| Wilson formula | Standard closed-form | Validated against (50/100) -> (0.4038, 0.5962) reference. |
| Delta CI | Newcombe method 10 (independent form) | Conservative when applied to paired data — biases against false green-light. Tango paired-score deferred to a future revision. |
| Pair labeling | CONTEXT item 2 verbatim — same outer_exception, ≥3 frame overlap, different session_id | Auto-labeling without human judgment; 20-pair manual spot-check (operator) validates. |
| Train/test split | 80/20, Mulberry32 PRNG seeded with 42 | Deterministic across machines; sort-by-(a,b) before shuffle ensures input-order independence. |
| Variant A | In-memory bag-of-words cosine over raw_content | Apples-to-apples baseline over the same corpus as B and C; deliberately fingerprint-free so any C-over-A lift reflects fingerprint signal. |
| Variant B | Sidecar SQL lookup ranked by `overlap_count / max(\|query_shingles\|, 1)` | Tversky-asymmetric — monotone, fast, CONTEXT discretion. |
| Variant C | RRF fusion of A and B with k=60 | CONTEXT canonical k. Learned weights deferred. |
| Quality (gating) | Wilson CI on dichotomized success indicator (top-k contains ≥1 positive) | The textbook tool for "did fusion measurably improve recall?" at n ≈ 40-60 queries. |
| Quality (diagnostic) | Macro-mean continuous metrics + 250-resample bootstrap CI | Honest reporting — RESULTS.md surfaces both, but only Wilson reaches `computeVerdict`. |
| Latency | Median / p95 / p99 percentile (linear interp) | Point estimates only — CONTEXT criterion 3 needs the ratio, not a CI on it. |
| Density similarity | Jaccard over shingle sets | Same space as Variant B retrieval — internally consistent. |
| Density noise floor | 95th-percentile of 1000 random pairs (seeded 4242) | CONTEXT item 4 verbatim. |
| Cluster threshold | noise_floor + 2σ | CONTEXT item 4 verbatim. |
| Cluster classification | Union-find K=2 (weak) / K≥5 (strong) | O(n α(n)); CONTEXT discretion. |

## Decision rule (CONTEXT.md item 5; cited verbatim — non-negotiable per team-lead #1)

> ## 5. Decision rule — locked BEFORE measurement runs
>
> Empirical-phase discipline: this rule is committed to CONTEXT.md and PLAN.md before the harness is built. **No moving goalposts after we see results.**
>
> **GREEN-LIGHT Phase 3 — proceed with full multi-handle retrieval cutover:**
>
> ALL three must hold on the **held-out test set**:
> 1. RRF-fusion has measurable improvement over semantic-only — minimum **+5pp on either precision@5 OR recall@10**, AND the **Wilson 95% CI lower bound on the delta is ≥ 0** (i.e., the improvement is not statistically indistinguishable from zero at our sample size). The AND-CI-bound is the discipline that prevents green-lighting on noise — at n≈40-60 pairs, raw point-deltas of +5pp can be inside the CI of zero.
> 2. Density at scale produces signal — ≥30% of high-similarity pairs (per #4) are intra-project recurrent.
> 3. Latency p99 of fused retrieval < 2× semantic-only baseline. Cost discipline: a marginally-better signal that doubles tail latency is not worth shipping.
>
> **SCOPE-DOWN to advisory — Phase 3 ships, but lighter than originally planned:**
> Improvement exists on specific subsets (e.g. only Python stack traces, only one project) but not broadly. Phase 3 ships an **advisory-only surface** ("you've hit a similar error before, see episode X") without aggressive RRF fusion in the production retrieval path. Phase 5 density abstraction is de-scoped accordingly (advisory, not abstraction).
>
> **KILL — pivot or stop:**
> No measurable improvement (criteria 1 fails on held-out CI bound) OR density is pure noise (criteria 2 fails). Phase 3 plan is rewritten or the multi-handle thesis is reconsidered at the milestone level. SUMMARY.md is honest about this and explains what we'd try next: different index? semantic-with-trick (e.g. stack-trace-aware tokenization)? abandon multi-handle and lean on density alone in Phase 5? Decision is escalated to user-approval gate before Phase 3 starts.

## Per-metric pairing invariant for the verdict consumer (checker-02-04 Note 3)

Verdict logic in 02-05 must AND the `ci_lower` with the `delta` of the SAME metric. Per-metric pairing is enforced by the schema — `fused_p5_minus_semantic_p5` and `fused_r10_minus_semantic_r10` are separate objects, each with `delta`, `ci_lower`, `ci_upper`. The harness output structure makes the wrong evaluation `(delta_p5 ≥ +0.05 AND ci_lower_r10 ≥ 0)` literally impossible to write by accident — fields are paired by metric. 02-05's verdict.ts must include a load-bearing comment near the criterion-1 evaluation reaffirming this invariant for future maintainers.

## Authentication Gates

None.

## Deviations from Plan

**[Rule 1 - Bug] Variant A reuses production hybrid-retrieval — replaced with in-memory cosine over raw_content** — Found during: harness wiring | Issue: the plan suggested reusing `hybridSearchSync` from `src/core/hybrid-retrieval.ts`, but that fn returns `ScoredArtifact[]` keyed by `artifacts.id`, not `episodic_events.id`. The harness corpus is `IndexedEvent[]` from episodic_events; mapping artifact IDs back to episode IDs is not 1:1 and would silently corrupt the apples-to-apples baseline. | Fix: implemented Variant A as bag-of-words cosine over `raw_content` keyed on episode_event_id. Documented in `retrieval.ts` JSDoc that this stays explicitly fingerprint-free, so any C-over-A lift reflects fingerprint signal rather than implementation drift between paths. Production retrieval realism is a Phase 3 concern, not a Phase 2 measurement concern. | Files modified: `src/benchmark/episodic-density/retrieval.ts` (planning intent only — never wrote the buggy version). | Verification: harness smoke test (60-event fixture) shows A/B/C all populated with sensible point estimates (A p@5 ≈ 0.62, B p@5 ≈ 0.77, C p@5 ≈ 0.68) — neither degenerate-zero nor degenerate-one. | Commit hash: `50a6304`.

**[Rule 1 - Bug] Determinism harness test compared wall-clock latency** — Found during: harness.test.ts initial run | Issue: the structural determinism check tried to compare full `JSON.stringify(result)` between two runs, but `latency_ms.{p50,p95,p99}` and `decision_rule_inputs.p99_fused_over_p99_semantic` are wall-clock-derived and naturally jitter. | Fix: deep-clone-and-zero the latency fields and the latency-derived ratio before comparison; the structural outputs (corpus_size, pairs split, metric points + CIs, deltas, density, decision_rule_inputs except p99 ratio) remain byte-equal under a fixed seed. | Files modified: `src/tests/benchmark/episodic-density/harness.test.ts`. | Verification: 4/4 harness tests now pass. | Commit hash: `7655812` (folded with test commit).

**Total deviations:** 2 auto-fixed (Rule 1, Rule 1). **Impact:** None to spec semantics. Variant A's spec compliance with the empirical baseline is improved, not degraded.

## Pointer to where Plan 02-05 consumes decision_rule_inputs

`harness.ts` exports `HarnessRunResult.decision_rule_inputs`:

```typescript
{
  held_out_test_n: number;
  fused_p5_minus_semantic_p5: { delta: number; ci_lower: number; ci_upper: number };
  fused_r10_minus_semantic_r10: { delta: number; ci_lower: number; ci_upper: number };
  intra_project_share: number;
  p99_fused_over_p99_semantic: number;
}
```

Plan 02-05's `computeVerdict(inputs)` reads these fields and returns one of `GREEN_LIGHT | SCOPE_DOWN | KILL`. The fields are pre-paired by metric — verdict.ts cannot accidentally cross-pair `delta_p5` with `ci_lower_r10`.

## Verification

- `bun run build` clean.
- `bun run test src/tests/benchmark/episodic-density/wilson.test.ts` → 11/11.
- `bun run test src/tests/benchmark/episodic-density/pair-labeling.test.ts` → 10/10.
- `bun run test src/tests/benchmark/episodic-density/metrics.test.ts` → 9/9.
- `bun run test src/tests/benchmark/episodic-density/density.test.ts` → 6/6.
- `bun run test src/tests/benchmark/episodic-density/harness.test.ts` → 4/4.
- `bun run test src/tests/benchmark/episodic-density/` → 50/50 (above + 10 from 02-03 backfill).
- Full `bun run test` → 3358 passing, 27 pre-existing baseline failures, no new regressions.

## Issues Encountered

None directly tied to Plan 02-04.

## Next Phase Readiness

**Plan 02-04 complete.** Plan 02-05 (verdict + runner + RESULTS) lands the consumer of `decision_rule_inputs`, persists 02-RESULTS.md + 02-results.json to disk, applies verdict-driven side effects (Vesna probe activation/disablement + flag flip), and emits the SUMMARY for the phase.

Ready for Plan 02-05.
