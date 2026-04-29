---
phase: 06-p5-retrieval-simplification-multiplier-ablation
plan: 06-02
subsystem: retrieval
tags: [phase-6, multiplier-ablation, retr-05, evidence, verdict, sanity-check]
requires: [06-01]
provides: [ablation-evidence, wave-3-deletion-decisions, sweep-summary-json]
affects:
  - src/tests/integration/phase-6-multiplier-ablation.test.ts
  - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-MULTIPLIER-ABLATION.md
  - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/
tech-stack:
  added: []
  patterns: [per-flag-sweep, per-category-aggregation, simple-delta-with-edge-case-override, sanity-check-vs-prior-baseline]
key-files:
  created:
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-MULTIPLIER-ABLATION.md
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-baseline.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-recency.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-importance.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-relevance.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-retrieval.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-novelty.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-activation.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-qvalue.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-all-disabled.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-sweep-summary.json
  modified:
    - src/tests/integration/phase-6-multiplier-ablation.test.ts
key-decisions:
  - decision: All 7 multipliers verdicted DROP per simple delta rule but Wave 3 will NOT aggressively delete
    rationale: "0pp delta at N=11 (resolution floor ~9pp) is absence of evidence of harm, not evidence of absence. CONTEXT.md mandates default-conservative — KEEP unless evidence drops. The full Phase 10 Vesna suite (~20 probes) is needed before aggressive deletion. Plan 03 will simplify-by-consolidation instead."
  - decision: Per-category deltas computed alongside aggregate to enable KEEP-WITH-TRADE-OFF override
    rationale: A multiplier with 0pp aggregate could still be load-bearing for one specific recall flavor. Per-category deltas catch this; the override fires when any category drops >2pp under simple-DROP. None triggered at this N, but the mechanism is in place for the Phase 10 re-run.
  - decision: All-disabled (RRF-only) sanity run included to bound combined multiplier contribution
    rationale: A 100% all-disabled rate proves RRF over FTS5 + recency is sufficient for this probe set on its own, which strengthens the "multipliers as a whole are not load-bearing for THESE probes" claim. The interpretive caveats live in 06-MULTIPLIER-ABLATION.md "Notes on statistical resolution".
  - decision: Lesson-recall sanity check enforced as a regression bar (4/4 = 100%)
    rationale: Phase 5 Vesna baseline reported 4/4 = 100% on these probes. A failing sanity check would indicate harness drift and block Wave 3. Encoded as a dedicated `it()` test so future Phase 6 / Phase 6.5 changes can't silently degrade this without flagging.
requirements-completed:
  - RETR-05 (per-multiplier ablation BEFORE bulk delete; results committed)
duration: 5 min
completed: 2026-04-29
---

# Phase 06 Plan 02: Per-Multiplier Ablation Runs + Structured Results

**One-liner.** Ran the seven-multiplier sweep on the 11-probe Phase 6 set; every flag produced 0pp delta and the all-disabled RRF-only configuration also passed 11/11 = 100% — wave 3 will simplify by consolidation, not aggressive deletion, until the Phase 10 Vesna suite can resolve effects below the current 9pp-per-probe noise floor.

## Duration

- Started: 2026-04-29 ~20:21 UTC
- Ended:   2026-04-29 ~20:26 UTC
- Wall clock: ~5 min (test runtime ~700ms; rest is interpretation + writeup)

## Tasks (3 of 3 complete)

### 06-02-01 — Per-multiplier sweep

- Replaced the W1 `describe.skip` block with the W2 sweep test.
- Generates one `it`-level pass that runs:
  - 1 baseline (all enabled) → `runs/06-02-baseline.json`
  - 7 single-multiplier-disabled runs → `runs/06-02-disable-{m}.json`
  - 1 all-disabled run → `runs/06-02-all-disabled.json`
  - 1 sweep summary aggregating baseline, all-disabled, per-flag deltas, simple verdict, edge-case override → `runs/06-02-sweep-summary.json`
- `RunRecord` now carries `perCategoryPassRate` (lesson / entity / constraint / handoff) for the KEEP-WITH-TRADE-OFF detection logic.
- Test runtime: ~700ms (in-memory DB; deterministic FTS5 + RRF).

### 06-02-02 — Verdict synthesis (06-MULTIPLIER-ABLATION.md)

- Single document at the phase directory with:
  - Headline finding (multipliers not load-bearing for THIS probe set).
  - Per-multiplier table (enabled rate, disabled rate, delta, per-category deltas, verdict).
  - **Decisions for Wave 3:** all 7 verdicted DROP per simple rule; **but Wave 3 will not delete** — explained via three reasons (N=11 saturation, async qvalue mismatch, default-conservative axiom).
  - Plan 03 directive revision (consolidate, not delete; defer aggressive deletion to post-Phase-10).
  - Sanity check vs Phase 5 baseline (4/4 = 100% confirmed; harness has not drifted).
  - Notes on statistical resolution (1pp threshold is practical floor, not significance).
  - Reproducibility section with exact `bun run test` invocation.
  - Forward look (Phase 10 Vesna suite, Plan 03 consolidation target, Plan 04 unaffected).

### 06-02-03 — Sanity check vs Phase 5 baseline

- Filtered baseline to lesson-recall flavor: 4/4 probes pass = 100%.
- Matches `05-VESNA-BASELINE.md`'s "4/4 = 100% on the runnable subset".
- Encoded as a dedicated test (`lesson-recall subset matches Phase 5 Vesna baseline (4/4 = 100%)`) so it acts as a regression bar going forward.

## Verification

### must_haves checklist

| Item | Status |
|------|--------|
| `06-MULTIPLIER-ABLATION.md` exists at the phase directory | PASS |
| Structured per-multiplier table populated (enabled / disabled / delta / per-category deltas / verdict) | PASS |
| Every multiplier in MULTIPLIERS_TO_ABLATE has a verdict | PASS (all 7 DROP per simple rule) |
| Edge-case verdicts (KEEP-WITH-TRADE-OFF) recorded if applicable | PASS (none triggered; rule is in place) |
| Baseline pass rate ≥ Phase 5 result (≥80% bar) | PASS (100% — exceeds 80% bar by 20pp) |
| Run JSON files persist under `runs/` | PASS (10 files committed) |

### Wave-end gate

- 06-MULTIPLIER-ABLATION.md exists with all 7 multipliers verdicted.
- `runs/` contains baseline + 7 disable-{m} + all-disabled + sweep-summary.
- Baseline 100% on the expanded 11-probe set (well above 80% bar).
- Atomic commit landed: `phase(06-02): per-multiplier ablation results — 11 probes, 0 dropped`.

## Deviations from Plan

**[Out-of-band — Strategic recommendation, escalated to team-lead]** Found during Task 06-02-02 verdict synthesis. The plan instructs Wave 3 to "remove these from `hybrid-retrieval.ts`" for any DROP verdict. The evidence at N=11 cannot resolve effects below ~9pp per probe. Acting on a 0pp-delta DROP verdict at this resolution would be a deletion call the evidence does not support, and conflicts with CONTEXT.md's default-conservative axiom ("KEEP unless evidence drops"). Sent a SendMessage to team-lead summarizing the evidence and proposing Plan 03 simplifies-by-consolidation rather than aggressively deletes. **No code changes made for this deviation** — only the recommendation in 06-MULTIPLIER-ABLATION.md "Decisions for Wave 3" section. The plan's deliverables (sweep + JSON + verdict markdown) are complete as specified; the strategic adjustment is a Plan 03 input, not a Plan 02 deviation in the conventional sense.

**Total deviations: 1 strategic recommendation (no code change), 0 code-level deviations.**

## Authentication Gates

None.

## Issues Encountered

**Plan 03 directive in flight.** The W2 evidence does not support the aggressive-deletion path the team-lead briefing described. Awaiting team-lead acknowledgement before starting Plan 03. **This does NOT block W2 close** — Plan 02's deliverables are complete and orthogonal to the Wave 3 deletion question.

## Next Phase Readiness

**Plan 03 is conditionally unblocked** pending team-lead's call:

- **Path A (default):** Simplify-by-consolidation per the 06-MULTIPLIER-ABLATION.md recommendation — collapse the 3-inner + 4-outer multiplier tiers into a single `computeArtifactScore`, fix the sync↔async qMultiplier mismatch, no aggressive deletion. Defer the deletion debate to a post-Phase-10 plan.
- **Path B (if team-lead overrides):** Aggressive deletion despite the evidence floor — would require explicit acknowledgement that we're acting beyond what the harness can support.

`SendMessage` sent to team-lead with the full reasoning. Plan 03 execution paused until reply.

Plans 04 / 05 / 06 are unaffected by this directional question — they cover reranker telemetry, MCP/RIF lock-down, and the SC#1 Vesna gate respectively, none of which touch the multiplier set.

## Files Touched (summary)

- 1 source-test file: `phase-6-multiplier-ablation.test.ts` (W2 sweep replaces W1 skip block; lesson-recall sanity test added).
- 1 verdict markdown: `06-MULTIPLIER-ABLATION.md`.
- 10 run JSONs under `runs/`.
- 0 production source files (per plan: "Out of scope: Any code change to `hybrid-retrieval.ts` (Wave 3)").
