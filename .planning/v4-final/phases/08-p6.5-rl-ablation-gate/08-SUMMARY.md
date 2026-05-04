---
phase: "8"
subsystem: intelligence
tags:
  - rl
  - ablation
  - vesna
  - decision-gate
  - ABL-01
  - ABL-02
  - ABL-03
requires:
  - "7.5"
provides:
  - "src/core/rl-scoring-disabled-counter.ts (in-memory 4-category counter, Phase-8-only sanity infra)"
  - "src/tests/integration/phase-8-rl-ablation.test.ts (A/B harness reusing Phase 6 + 6.5 probe sets)"
  - "context/specs/V4_RL_ABLATION.md (locked decision artifact — Phase 9.8 reads this)"
  - ".planning/phases/08-p6.5-rl-ablation-gate/runs/08-rl-ablation-summary.json (source-of-truth A/B numbers)"
  - "phase-6-multiplier-ablation.test.ts: PROBES + runProbe + Probe + ProbeOutcome exported"
  - "phase-6-5-cross-project-vesna.test.ts: CROSS_PROJECT_PROBES + runCrossProjectProbe extracted"
affects:
  - "src/core/hybrid-retrieval.ts:computeQMultiplier (env-var early-return)"
  - "src/intelligence/memrl-scorer.ts (all 7 exports gated)"
  - "src/intelligence/retrieval-rl.ts:updateSessionQValues (env-var gate)"
  - "src/angel/heartbeat.ts: rl-trainer + applyTemporalDecay blocks (env-var gate)"
tech-stack:
  added: []
  patterns:
    - "env-var feature flag at hot read/write callsites (no plumbing through layers)"
    - "in-memory category-keyed counter (deliberately NOT DB-backed — avoids V22 migration for Phase-8-only sanity infra)"
    - "A/B harness reuses upstream test-file probe data via export, not duplication — keeps the Phase 6 confound visible as the same evidence through a different gate path"
    - "verdict logic mirrors CONTEXT.md decision table verbatim with conservative-default at the boundary"
key-files:
  created:
    - src/core/rl-scoring-disabled-counter.ts
    - src/tests/core/rl-scoring-disabled-counter.test.ts
    - src/tests/integration/phase-8-rl-ablation.test.ts
    - .planning/phases/08-p6.5-rl-ablation-gate/runs/08-rl-ablation-summary.json
    - context/specs/V4_RL_ABLATION.md
    - .planning/phases/08-p6.5-rl-ablation-gate/08-SUMMARY.md
  modified:
    - src/core/hybrid-retrieval.ts
    - src/intelligence/memrl-scorer.ts
    - src/intelligence/retrieval-rl.ts
    - src/angel/heartbeat.ts
    - src/tests/integration/phase-6-multiplier-ablation.test.ts
    - src/tests/integration/phase-6-5-cross-project-vesna.test.ts
    - .planning/STATE.md
    - .planning/ROADMAP.md
    - .planning/REQUIREMENTS.md
key-decisions:
  - "Counter lives at src/core/rl-scoring-disabled-counter.ts as an in-memory module-level Map, NOT in src/core/telemetry-counters.ts. Reason: telemetry-counters.ts writes to the `telemetry` table whose `event_kind` column has a CHECK enum; adding a new kind would require a V22 migration. The gate is Phase-8-only sanity infra (Phase 9.8 will either delete the gate when the RL stack is deleted, or it stays as a dormant runtime toggle). Over-engineered to add a schema migration for a transient counter."
  - "Verdict logic uses aggregate `delta_pp = mean(flagged) − mean(baseline)`, not range-aware delta. Range-aware (mean(flagged) − max(baseline)) is reported as a sanity number but does NOT shift the verdict. Reason: CONTEXT.md `<decisions>.### Decision criteria` is locked on aggregate mean — the contract was set before the run."
  - "Phase 6 multiplier-ablation.test.ts and Phase 6.5 cross-project-vesna.test.ts probe data are exported (not duplicated) into the Phase 8 harness. Reason: keeps the Phase 6 confound visible as the SAME evidence through a different gate path. If the Phase 6 portion shows 0pp under the env-var gate too, that's consistent with `multiplierFlags.qvalue=false` (also 0pp at Phase 6 W2), not an independent confirmation."
  - "Confound is disclosed in V4_RL_ABLATION.md `## Confound disclosure` rather than papered over. The 14-probe surface, as constructed, doesn't fully exercise the RL stack's mutation cycle (write → propagate → decay → read on a Q-value with a non-default value). The verdict is on the available evidence; overturnable by Phase 10's richer probe suite (re-run + write a superseding decision file with `## Supersedence` header)."
  - "Plan 08-01 deviation absorbed: actual `processSessionQValues` returns void (plan assumed number). Adapted early-return to `return;` matching the actual shape. No functional difference."
requirements-completed:
  - ABL-01
  - ABL-02
  - ABL-03
duration: ~50 min
completed: 2026-04-29
---

# Phase 8 — Summary (P6.5 — RL ablation gate) — Closed 2026-04-29

**Verdict:** DELETE_ALLOWED
**Decision artifact:** `context/specs/V4_RL_ABLATION.md`

`CLAUDEX_DISABLE_RL_SCORING=1` env-var gate landed across 4 source files. A/B harness ran 14 probes × 3 trials × 2 conditions on the existing Phase 6 (11 in-process probes) + Phase 6.5 (3 cross-project probes) substrate. Both conditions passed at 100% across all trials — `delta_pp = 0`, all per-category deltas 0pp. Per CONTEXT.md decision criteria (delta ≥ -2pp), RL stack is not load-bearing on this surface; sub-phase 9.8 (RL deletion) is cleared and scheduled.

## What shipped

- **Plan 08-01 (Wave 1, commit c2c320d).** Env-flag gate across the RL surface:
  - `src/core/hybrid-retrieval.ts:computeQMultiplier` — early-return `1.0` when flag set.
  - `src/intelligence/memrl-scorer.ts` — all 7 exports (`recordRetrieval`, `recordSuccess`, `recordFailure`, `propagateQValues`, `applyTemporalDecay`, `getQValueMultiplier`, `processSessionQValues`) gated; type-safe early-return preserves each function's return shape.
  - `src/intelligence/retrieval-rl.ts:updateSessionQValues` — early-return `0` when flag set; `applyQValueReranking`, `getQValueBoosts`, `computeQValue` deliberately NOT guarded (they have zero non-test callers — confirmed in 08-RESEARCH.md; Phase 9.8 deletion candidates).
  - `src/angel/heartbeat.ts` — rl-trainer block (~lines 710-734) wrapped in env check; `applyTemporalDecay` block (~lines 1028-1042) wrapped too. Inner memrl-scorer guards from above also catch the decay path; double-gating saves the dynamic-import I/O when the flag is set.
  - **New module** `src/core/rl-scoring-disabled-counter.ts` — in-memory category-keyed counter (`qmultiplier`, `memrl-scorer`, `retrieval-rl`, `rl-trainer-heartbeat`). Deliberately NOT in `telemetry-counters.ts` (that file is DB-backed and would require a V22 migration to extend the `event_kind` CHECK enum for Phase-8-only sanity infra).
  - **New test** `src/tests/core/rl-scoring-disabled-counter.test.ts` — 4 cases (per-category increment, total across categories, reset, zero-default).

- **Plan 08-02 (Wave 2, commit bcc7829).** A/B Vesna probe harness:
  - **New test** `src/tests/integration/phase-8-rl-ablation.test.ts` — runs 14 probes × 3 trials × 2 conditions; emits `08-rl-ablation-summary.json` with mean + range + per-category + range-aware delta; sanity-checks gate-fire counter (>0 in flagged, ==0 in baseline); 3 synthetic verdict-boundary tests for the locked verdict logic.
  - **Side-effect refactor** (atomic with the harness commit): `phase-6-multiplier-ablation.test.ts` exports `PROBES`, `runProbe`, `Probe`, `ProbeOutcome`. `phase-6-5-cross-project-vesna.test.ts` extracts `CROSS_PROJECT_PROBES` (3 probe records with seedFn closures + forbidden-words pre-flight) and `runCrossProjectProbe` (fresh in-memory DB per probe, mirrors original it-block pass logic). Legacy 3 it-blocks call the runner alongside their existing assertions — zero behavioral change to Phase 6 / 6.5 gates.

- **Plan 08-03 (Wave 3, this commit).** Decision lock + phase close:
  - `context/specs/V4_RL_ABLATION.md` — locked verdict + per-condition + per-category + range-aware delta + gate-fire sanity table + confound disclosure + both implication branches preserved (REALIZED for DELETE_ALLOWED, NOT REALIZED for KEEP/KEEP_CONSERVATIVE_DEFAULT).
  - `.planning/REQUIREMENTS.md` — ABL-01..ABL-03 marked `[x]` with plan/commit references; traceability row updated to `Closed 2026-04-29 (V4_RL_ABLATION.md verdict: DELETE_ALLOWED)`.
  - `.planning/ROADMAP.md` — Phase 8 row checked + status note `CLOSED 2026-04-29 verdict DELETE_ALLOWED`; Phase 8 detail section adds `**Plans:**` listing all three plans + `**Status:** CLOSED 2026-04-29` + `**Decision artifact:**` pointer; Phase 9 detail header gets a one-line callout: *"Phase 8 verdict was DELETE_ALLOWED. Sub-phase 9.8 is scheduled accordingly."*
  - `.planning/STATE.md` — current-position pointer advanced to Phase 8.5; status block rewritten to record the verdict, the gate locations, the confound disclosure, and the W1/W2/W3 commit hashes.
  - `08-SUMMARY.md` — this file.

## Evidence summary

(See `context/specs/V4_RL_ABLATION.md` for the canonical numbers. Quoted here for quick reference.)

| Condition | Mean pass rate | Range |
|---|---:|---|
| Baseline (flag absent) | 100.00% | 100.00–100.00% |
| Flagged (CLAUDEX_DISABLE_RL_SCORING=1) | 100.00% | 100.00–100.00% |

**Aggregate delta:** 0.00pp
**Range-aware delta:** 0.00pp
**Per-category delta:** lesson 0pp, entity 0pp, constraint 0pp, handoff 0pp, cross-project 0pp
**Verdict:** DELETE_ALLOWED

**Gate-fire sanity:** flagged trials fired 49 / 49 / 49 across the qMultiplier read path; baseline trials fired 0 / 0 / 0. Counter sanity holds — the gate did intercept the path in flagged trials and did not in baseline trials.

## What did NOT ship

- Actual deletion of the RL stack — Phase 9.8 territory, conditional on this verdict (now cleared).
- Self-instrumented probe category (0 existing probes; Phase 10 fills the gap with the full ~20-probe suite).
- A counter integration with `telemetry-counters.ts` / DB-backed reporting — deliberately deferred (the gate is Phase-8-only; Phase 9.8 either deletes both or leaves the counter dormant).

## Confound disclosure

Phase 6 W2 (commit history at `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-qvalue.json`) already ran an in-process ablation via `multiplierFlags.qvalue=false` on the same 11 Phase 6 probes and recorded 0pp. Phase 8's env-var gate produces identical semantics through a different code path on those same 11 probes — so 0pp on the Phase 6 portion is *consistent evidence across two gate paths*, not an independent confirmation. The incremental signal lives in the 3 Phase 6.5 cross-project probes — but those returned 0pp too, because their pass paths flow through `assembleExperienceTier` (HYBRID equivalence in `cross-project-equivalence.ts`) and `expandSearchCrossProject` (task-shape vocabulary scoring), neither of which reads `artifacts.q_value` directly.

The qMultiplier IS exercised by the Phase 6 probes through `computeArtifactScore`, but every test artifact seeds via `createTestDbWithSession` + `createArtifact` which leaves `q_value` at its column default — so the env-var-gated `1.0` and the formula's `0.5 + (q_value ?? 0.5) = 1.0` produce identical scores. The gate is structurally active (49 fires per trial confirms this), but its *effect* on the realized scores is zero on this substrate.

**The verdict is on `delta_pp` from the available surface**, and at delta_pp = 0pp the locked rule (CONTEXT.md `<decisions>.### Decision criteria`) is DELETE_ALLOWED. The verdict is overturnable by Phase 10's full ~20-probe suite if it includes self-instrumented and historical-Q probes that DO write a non-default Q-value during setup. Until then, the available evidence + the locked contract say DELETE_ALLOWED.

## Open items rolled forward

- **Phase 9.8 (RL stack deletion)** scheduled per V4_RL_ABLATION.md `## Implications.### REALIZED — DELETE_ALLOWED`. Files queued: `src/intelligence/retrieval-rl.ts`, `src/intelligence/memrl-scorer.ts`, `src/intelligence/rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`. Schema queued: drop `q_value` from `artifacts` (V22 migration). Code queued: drop `qMultiplier` branch in `computeArtifactScore` and `qvalue` member from `MultiplierName`. Infra queued: delete `src/core/rl-scoring-disabled-counter.ts` and its test (Phase-8-only sanity infra) plus the env-var gate itself (its absence becomes the permanent state).
- **Phase 10 supersedence path** (if richer probe suite reverses the verdict): re-run `phase-8-rl-ablation.test.ts` with the broader probe set, write a superseding `V4_RL_ABLATION.md` with a `## Supersedence` header citing this file's commit hash, and document the new evidence. Phase 9.8 stays uncommitted until Phase 9 begins, leaving the supersedence path open.

## Files touched (cumulative across plans)

- `src/core/hybrid-retrieval.ts`
- `src/core/rl-scoring-disabled-counter.ts` (new)
- `src/intelligence/memrl-scorer.ts`
- `src/intelligence/retrieval-rl.ts`
- `src/angel/heartbeat.ts`
- `src/tests/core/rl-scoring-disabled-counter.test.ts` (new)
- `src/tests/integration/phase-8-rl-ablation.test.ts` (new)
- `src/tests/integration/phase-6-multiplier-ablation.test.ts` (export-only)
- `src/tests/integration/phase-6-5-cross-project-vesna.test.ts` (extract probe data + runner)
- `.planning/phases/08-p6.5-rl-ablation-gate/runs/08-rl-ablation-summary.json` (new)
- `context/specs/V4_RL_ABLATION.md` (new)
- `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`
- `.planning/phases/08-p6.5-rl-ablation-gate/08-SUMMARY.md` (this file)

## Cross-references

- ROADMAP entry: `.planning/ROADMAP.md` Phase 8 (CLOSED) + Phase 9 sub-phase 9.8 callout
- Requirements: ABL-01, ABL-02, ABL-03 (closed)
- Decision: `context/specs/V4_RL_ABLATION.md`
- Source artifact: `.planning/phases/08-p6.5-rl-ablation-gate/runs/08-rl-ablation-summary.json`
- Confound source: `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-qvalue.json`
- Per-plan summaries: not separately written — Plan 08-01 + 08-02 + 08-03 atomic commits + this phase summary jointly cover the disclosed evidence
