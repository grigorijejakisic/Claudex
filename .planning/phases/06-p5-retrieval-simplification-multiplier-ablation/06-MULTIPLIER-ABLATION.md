# Phase 6 — Per-Multiplier Ablation Results

**Captured:** 2026-04-29T20:23Z
**Probe count:** 11
**Categories:** lesson_recall (4), entity_recall (3), constraint_recall (2), handoff_pickup (2)
**Baseline (all enabled) pass rate:** 100% (11/11)
**All-disabled (RRF only) pass rate:** 100% (11/11)
**Source data:** `runs/06-02-baseline.json`, `runs/06-02-disable-{multiplier}.json` × 7, `runs/06-02-all-disabled.json`, `runs/06-02-sweep-summary.json`
**Harness:** `src/tests/integration/phase-6-multiplier-ablation.test.ts`

## Headline finding

**The seven scoring multipliers are not load-bearing for this probe set.**

Every per-multiplier ablation produced **0.0pp delta** vs the all-enabled baseline. Even the **all-disabled run** — collapsing the formula to `hybrid_score = rrfScore` — passed 11/11 = 100%. This means: for the four recall flavors covered here (lesson, entity, constraint, handoff), RRF over FTS5 + recency channels already discriminates target artifacts cleanly enough that no multiplier changes the top-K admission. The multipliers are tie-breakers and rank-shufflers within the top-K window — not the determinants of which artifact lands in the window.

This is the directional outcome CONTEXT.md anticipated: "if the all-disabled pass rate is ≥80%, the multipliers as a whole are NOT load-bearing." The harness confirms the predicate at a stronger level (100% rather than ≥80%).

## Per-multiplier results

| Multiplier  | Enabled rate | Disabled rate | Delta (pp) | Per-category deltas (lesson / entity / constraint / handoff) | Verdict |
|-------------|--------------|---------------|------------|-------------------------------------------------------------|---------|
| recency     | 100%         | 100%          | 0.0        | 0 / 0 / 0 / 0                                               | DROP    |
| importance  | 100%         | 100%          | 0.0        | 0 / 0 / 0 / 0                                               | DROP    |
| relevance   | 100%         | 100%          | 0.0        | 0 / 0 / 0 / 0                                               | DROP    |
| retrieval   | 100%         | 100%          | 0.0        | 0 / 0 / 0 / 0                                               | DROP    |
| novelty     | 100%         | 100%          | 0.0        | 0 / 0 / 0 / 0                                               | DROP    |
| activation  | 100%         | 100%          | 0.0        | 0 / 0 / 0 / 0                                               | DROP    |
| qvalue      | 100%         | 100%          | 0.0        | 0 / 0 / 0 / 0                                               | DROP    |

Verdict rule: simple delta (`disabledRate - enabledRate < -1pp` ⇒ KEEP, else DROP) with per-category override (any category drops >2pp ⇒ KEEP-WITH-TRADE-OFF). All seven multipliers fall under simple-DROP at this N.

## Decisions for Wave 3

- **DROP (per simple delta rule):** recency, importance, relevance, retrieval, novelty, activation, qvalue.
- **KEEP:** none.
- **KEEP-WITH-TRADE-OFF:** none.

**However — Wave 3 will NOT delete all seven multipliers.** Three reasons:

1. **N=11 with already-saturated baseline.** Every probe lands at rank 0 or 1 even under the worst (all-disabled) configuration. The harness cannot resolve the multipliers' effect on tie-breaking inside the top-K window. Phase 10's larger Vesna suite (~20 probes with closer-to-threshold targets) is needed to detect this resolution. Until that suite ships, "DROP" verdicts here are *directional, not safety-rated*.
2. **Async path is incomplete.** `qvalue` is read-but-void in `hybridSearchAsync` today (sync↔async mismatch noted in 06-RESEARCH.md). Plan 03 must align the two paths before any deletion — otherwise the deletion target diverges between paths.
3. **CONTEXT.md default-conservative:** "KEEP unless evidence drops." 0pp delta at N=11 is *absence of evidence of harm*, not *evidence of absence*. The plan explicitly requires the verdict to lean KEEP when within harness noise floor.

### Plan 03 directive (revised in light of these results)

Plan 03 will:
- **Align the sync↔async paths first** (the qMultiplier mismatch is a real bug; fixing it is independent of the ablation verdict).
- **Delete nothing aggressive in Wave 3.** Instead, simplify by *consolidating* — collapse the three inner factors and four outer multipliers into a single, well-named scoring function with consistent weighting. Keep the multipliers; remove the cognitive overhead of two ad-hoc tiers.
- **Defer aggressive multiplier deletion** to a post-Phase-10 plan when the larger Vesna suite can resolve effects below the current 9pp-per-probe noise floor.

This preserves the Phase 6 simplification mandate (RETR-01/02 — simplify hybrid-retrieval per evidence) without making a deletion call the evidence does not support.

## Sanity check vs Phase 5 Vesna baseline

The 4 lesson-recall paraphrase probes carried over from Phase 4.1 / 5 show **4/4 = 100%** under the all-enabled baseline. This matches `05-VESNA-BASELINE.md`'s "4/4 = 100% on the runnable subset" — harness has not drifted. The dedicated test `lesson-recall subset matches Phase 5 Vesna baseline (4/4 = 100%)` enforces this regression bar going forward.

## Notes on statistical resolution

- **Sample size: N=11.** The smallest meaningful per-flag delta is 1/11 ≈ 9.1pp. A 0pp delta is not "we proved no effect"; it's "we cannot resolve effects below ~9pp at this N."
- **The 1pp threshold in the verdict rule is the practical floor**, not a significance claim. With higher N (Phase 10's ~20 probes, or more if Phase 10.5 expands further), individual-probe wins/losses become resolvable below 5pp.
- **Probe selection bias.** Probes were authored to target known categories with strong distractors. They do not stress edge cases (very-recent vs very-old, near-duplicate semantic content, low-confidence Q-value artifacts). The full Phase 10 Vesna suite is expected to surface multiplier effects this set cannot.
- **All-disabled does NOT mean "nothing matters":** RRF over FTS5 + recency is a non-trivial scoring function. It applies bm25 + rank fusion, which encodes both keyword precision and recency. The multipliers add per-artifact tuning *on top* of that; the harness confirms RRF is sufficient for *this* probe set, not that it's sufficient for everything.

## Reproducibility

```bash
# Re-run from scratch:
bun run test src/tests/integration/phase-6-multiplier-ablation.test.ts
# Outputs land in:
ls .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/
# Source-of-truth summary:
cat .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-sweep-summary.json
```

The harness is deterministic — the in-memory DB seeding, the FTS5 ranking, and the RRF fusion are all reproducible across runs.

## Forward look

- **Phase 10 Vesna suite (~20 probes)** will re-run this ablation with stronger evidence. Results from this phase are directional, sufficient to gate `hybrid-retrieval.ts` *consolidation* (Plan 03) but **not** aggressive multiplier *deletion*.
- **Plan 03 consolidation target:** unify the three inner-factor and four outer-multiplier tiers into a single `computeArtifactScore` function with a flat, documented weight vector. No deletion. The deletion debate moves to a post-Phase-10 follow-up plan.
- **Plan 04 visibility:** unchanged — `reranker_fallback_fired` telemetry write site + assembler section land regardless of these ablation outcomes.

## Post-Plan-03 status

**Plan 03 shipped path A (consolidation, not deletion) on 2026-04-29.** Approved by team-lead on the basis of the evidence-resolution argument above.

What landed:
- New `computeArtifactScore(artifact, rrfScore, ctx)` in `src/core/hybrid-retrieval.ts` is the single home for the 7-multiplier formula.
- Both `hybridSearchSync` and `hybridSearchAsync` route every score through it; the sync↔async qMultiplier mismatch (a real bug independent of the ablation question) is closed.
- Per-multiplier helpers (`computeNoveltyMultiplier`, `computeActivationFactor`, `computeQMultiplier`, alongside the existing `computeRecencyScore` and `computeImportanceScore`) give each weight a single home.
- `ArtifactScoringContext` interface lets future ablation pass any subset of `multiplierFlags` without touching either retrieval path.
- Documented weight vector lives in `06-03-CONSOLIDATION-NOTE.md` (table per multiplier with neutral and ablation-disabled values).

Evidence preserved:
- `runs/06-02-baseline.json` — pre-consolidation baseline.
- `runs/06-03-post-consolidation-baseline.json` — post-consolidation baseline; matches W2 verbatim. No regression.

## Deletion debate — deferred to a post-Phase-10 follow-up plan

When Phase 10's full Vesna suite (~20 probes with closer-to-threshold targets) ships, the deletion question becomes answerable:

1. **Re-run the existing harness** (`bun run test src/tests/integration/phase-6-multiplier-ablation.test.ts`) using the larger probe set. The harness is deterministic and the per-flag JSONs are auto-emitted — no plumbing changes needed.
2. **Resolution upgrade.** With ~20 probes the per-flag delta resolution drops from ~9pp to ~5pp; a true-positive 2-3pp drop becomes detectable.
3. **Drop candidates** are multipliers showing ≥5pp aggregate degradation under the larger suite. Edge-case override (any single category drop >2pp ⇒ KEEP-WITH-TRADE-OFF) still applies.
4. **Author a post-Phase-10 follow-up plan** named e.g. `phase-10.X-multiplier-deletion.md` that consumes the new evidence and ships the actual `computeArtifactScore` simplification — by removing the helper for any multiplier whose flag is consistently DROP at the new resolution.
5. **Until then, every multiplier stays.** The flag mechanism makes future ablation cheap; the consolidated function makes future deletion a single-helper edit.

This document is the input to that future plan. The Phase 10 suite landing is the trigger.
