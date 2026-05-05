---
phase: 02-multi-modal-index-seeds-density-check
plan: 05
subsystem: benchmark/verdict-runner
tags: [v5, phase2, idx-02, idx-04, verdict, runner, kill, empirical-result]
requires: [phase-1-substrate, v26-schema, error-fingerprint-module, populated-sidecar, measurement-harness]
provides: [verdict-module, runner, results-files, vesna-probes]
affects:
  - src/benchmark/episodic-density/verdict.ts
  - src/benchmark/episodic-density/runner.ts
  - src/benchmark/episodic-density/cli.ts
  - src/shared/constants.ts
  - src/benchmark/vesna/probes/.disabled/episodic-fingerprint-fires.json
  - src/benchmark/vesna/probes/.disabled/fusion-non-regression.json
tech-stack:
  added: []
  patterns: [strict-ordered-side-effects, atomic-file-write, verdict-driven-flag-flip]
key-files:
  created:
    - src/benchmark/episodic-density/verdict.ts
    - src/benchmark/episodic-density/runner.ts
    - src/benchmark/vesna/probes/.disabled/episodic-fingerprint-fires.json
    - src/benchmark/vesna/probes/.disabled/fusion-non-regression.json
    - src/tests/benchmark/episodic-density/verdict.test.ts
    - .planning/phases/02-multi-modal-index-seeds-density-check/02-RESULTS.md
    - .planning/phases/02-multi-modal-index-seeds-density-check/02-results.json
  modified:
    - src/benchmark/episodic-density/cli.ts
    - src/shared/constants.ts
key-decisions:
  - "Verdict module is a pure function. No I/O, no clock dependency past opts.ts_epoch. Decision rule cited verbatim in JSDoc + DECISION_RULE_QUOTE constant; CONTEXT item 5 reaches `Verdict.decision_rule_quote` for inclusion in 02-RESULTS.md."
  - "Runner enforces strict ordering by source-text construction: harness -> verdict -> atomicWrite RESULTS_JSON -> atomicWrite RESULTS_MD -> ensureProbeAt + setErrorFingerprintFlag. Static-text test in verdict.test.ts mechanically asserts this; fs mtime test confirms constants.ts mutation occurred AFTER results files when the verdict drove a flip."
  - "BLOCKED verdict surface for the corpus-floor-not-met case (harness throws). Runner catches, persists a BLOCKED results.json + .md, fires NO side effects. Operator runs `backfill` first."
  - "On KILL/SCOPE_DOWN: probes stay in .disabled/, flag flips to false, backfill data retained — CONTEXT item 7 negative-result handling enforced mechanically by the runner."
  - "Ordering test: tried fs vi.spyOn — blocked by 'Cannot redefine property' in non-configurable ESM bindings. Reverted to a hybrid (static source-text check + on-disk mtime check) which catches the failure mode (side effects landing before results) without requiring runtime fs interception."
requirements-completed: [IDX-02, IDX-04]
duration: "30 min"
completed: "2026-05-04"
---

# Phase 2 Plan 5: Verdict + Runner + RESULTS Summary

Pure verdict module (consumes `HarnessRunResult.decision_rule_inputs`), strict-ordered runner (harness -> verdict -> persistence -> side effects), Vesna probes pre-staged in `.disabled/`, 02-RESULTS.md + 02-results.json on disk, ordering tests, and a live measurement against the operator's DB that produced verdict **KILL**.

## Observed verdict

**KILL.** Live measurement against the operator's `~/.claudex/db/claudex.db` with the seed=42 default and 135 fingerprinted episodes (19 projects, 2.7× the 50-event floor) produced:

| # | Criterion | Threshold | Observed | Passed |
|---|-----------|-----------|----------|--------|
| 1 | Fusion improvement (max(Δp@5,Δr@10) ≥ +5pp AND CI lower ≥ 0 on the same metric) | 0.05 / CI≥0 | +0.10 (best, p@5) | **NO** |
| 2 | Density signal (intra-project share ≥ 30%) | 0.30 | 0.234 | **NO** |
| 3 | Latency budget (p99 fused / p99 semantic < 2.0) | 2.0 | 0.893 | YES |

Verdict drivers (the figures that drove the KILL):

- **delta_p5 = +0.10** with **CI lower = -0.157** (point estimate cleared the +5pp threshold but the Newcombe 95% CI lower bound on the delta is well below zero — at n=20 held-out test pairs, a +10pp point estimate is statistically indistinguishable from zero).
- **delta_r10 = -0.05** with **CI lower = -0.274** (recall@10 actually got *worse* under fusion in this measurement — though again with a CI that crosses zero, so not measurably worse either).
- **intra_project_share = 0.234 < 0.30** — density at our scale is fundamentally project-bounded noise; high-similarity pairs cross projects more often than they recur within a single project's error history.
- **p99(C) / p99(A) = 0.89** — fusion has NO cost penalty (fusion's p99 is actually slightly lower than semantic-only's p99, because the in-memory cosine baseline has its own variance). Criterion 3 passed comfortably; not the limiting factor.

The **n=20 test set** is small. The decision rule's CI-binding discipline correctly rejects this lift as statistical noise. CONTEXT item 5 nailed it ahead of time: "at n≈40-60 pairs, raw point-deltas of +5pp can be inside the CI of zero." Our held-out test set is even smaller (~20 because pair labeling on 135 events with the strict ≥3-frame-overlap rule produces a modest pair count); the CI binding is the discipline that prevents shopping a +10pp point estimate that the math says could be zero.

## Probe + flag state after side effects

- **Vesna probes**: both `episodic-fingerprint-fires.json` and `fusion-non-regression.json` remain in `src/benchmark/vesna/probes/.disabled/`. `bun run vesna` loads 17 probes (unchanged from baseline) — confirmed AGGREGATE 100% GATED PASS post-run.
- **Feature flag**: `DEFAULT_CONFIG.features.error_fingerprint` flipped **true → false** in `src/shared/constants.ts`. Future tool_result writes do not compute fingerprints by default; the flag can be set explicitly to true on a per-call basis or via project config.
- **Backfill data**: RETAINED. `episodic_index_error_fingerprint` holds 10,678 rows; 187 `episodic_events` rows have `metadata_json.error_fingerprint` populated. Destructive cleanup is forbidden by CONTEXT item 7.
- **Code**: `src/core/error-fingerprint.ts`, `src/benchmark/episodic-density/*`, and the V26 schema migration all stay in the codebase. The flag is the kill switch; the substrate is the learning artifact.

## Pointer to RESULTS

- `.planning/phases/02-multi-modal-index-seeds-density-check/02-RESULTS.md` — human-readable measurement report (CONTEXT item 5 verbatim, criterion checks, pooled + per-corpus_origin metric tables, latency, density signal, verdict reasoning, next-steps).
- `.planning/phases/02-multi-modal-index-seeds-density-check/02-results.json` — machine-readable mirror (`{schema_version: 1, generated_at_ts_epoch, harness, verdict}`). Phase 3 baseline if multi-handle is reconsidered.
- `.planning/phases/02-multi-modal-index-seeds-density-check/02-03-corpus-audit.md` — corpus dry-run audit (135 / 19 projects).

## Phase 3 implications

The multi-handle retrieval cutover Phase 3 originally proposed is **not justified** by Phase 2's measurement. The empirical-phase discipline says: do not flip Phase 3 to GREEN_LIGHT on a +10pp point estimate when the CI on that lift crosses zero. Per CONTEXT item 5 KILL handling and the user-approval gate:

**Options to escalate to user-approval gate before Phase 3 starts:**

1. **Re-plan Phase 3 with a different index** — error-fingerprint did not produce statistically-significant lift over a fingerprint-free baseline at our scale. Affect signal (sentiment / frustration markers from organic content) and structural-shape (turn-pattern hashing, intent-shift detection) are deferred candidates per CONTEXT.md `<deferred>`. Either could be tried with the same harness shape; whether either is more likely to clear the +5pp + CI bar is an empirical question the planner should frame for discussion.
2. **Stack-trace-aware tokenizer for the semantic embedder** — listed in CONTEXT KILL-pivot-options. The hypothesis: arctic-embed2's semantic signal may be muddied by token-bag noise from long stack traces; a tokenizer that treats stack frames as structured features could improve Variant A's baseline AND make the fusion lift clearer (one way or the other).
3. **Abandon multi-handle, lean on density alone in Phase 5** — but Phase 2's density check ALSO failed (intra-project share 23.4% < 30%), so density-at-scale is itself in question. Phase 5 may need to be re-scoped to "advisory only" or pivoted to a different signal.
4. **Rerun measurement on a larger corpus** — the n=20 test set is small. The corpus has 135 fingerprinted events; the strict pair-labeler rule (same outer_exception, ≥3 frame overlap, different session_id) yields modest pair counts. A more permissive labeling rule (e.g. ≥2 frames) would expand the test set but weaken the ground truth. CONTEXT item 5 explicitly forbids re-tuning the decision rule after seeing results — but the corpus / labeler tuning IS a different question that could be reopened at the user-approval gate.

The user-approval gate is the right place to choose between these options. Plan 02-05 SHIPS as a successful empirical-phase outcome — the deliverable is the verdict, the substrate, and this analysis.

## Operator notes (deviations + surprises)

**[Rule 1 - Bug] Vesna probe loader does NOT recurse into subdirs — `.disabled/` is excluded by readdirSync's flat semantics**, which is exactly what we want. Confirmed at execution time: `bun run vesna` lists 17 probes (3+3+3+3+3+2 across categories), and the runner's enable-on-GREEN_LIGHT path moves probe files from `.disabled/` to the parent dir. Exposes itself only when the parent dir contains the file. | Files: src/benchmark/vesna/loader.ts (read-only). | Verification: vesna pass rate unchanged.

**[Rule 1 - Bug] Initial ordering test attempted to vi.spyOn(fs, 'renameSync') — blocked by 'Cannot redefine property'** | Issue: vitest's vi.spyOn cannot redefine non-configurable properties on the `fs` import binding. | Fix: pivoted to a hybrid ordering check — static text scan of `runner.ts` (asserting the literal call sequence in `runFullPhase2Measurement`) + an on-disk mtime check (`constants.ts.mtime >= max(results.mtime)` when the verdict triggers a flag flip). Together these catch both refactor-introduced reordering and runtime ordering inversions. | Verification: 10/10 verdict.test.ts cases pass. | Commit hash: `894f899`.

**Surprise: density check failed with the operator's actual corpus** — The fingerprinter found enough signal to label 9 test pairs (n=20 across the bidirectional eval) but the intra-project share landed at 23%. CONTEXT item 4's 30% threshold is now empirically informed: "≥30%" was a reasonable hypothesis; measured reality came in below it. Pivot decisions: see Phase 3 implications above.

**Negative result is the deliverable, not the failure** — CONTEXT item 7 verbatim. Phase 2 SHIPS as a successful empirical-phase outcome. The harness is preserved at `src/benchmark/episodic-density/` for Phase 5 to reuse, the substrate stays clean, and the verdict logic is mechanical so any future re-run produces the same shape of artifact.

**Phase 5 reusability**: the harness orchestrator's contract (input `Database`, output `HarnessRunResult` with `decision_rule_inputs`) is intentionally generic. Phase 5 (the second empirical phase, density-based abstraction) reuses this shape; the only customizations are (a) different decision-rule criteria in a separate verdict module and (b) a different similarity / cluster definition in `density.ts` if the abstraction surface differs from the recall surface.

## Verification

- `bun run build` clean.
- `bun run test src/tests/benchmark/episodic-density/verdict.test.ts` → 10/10 PASS.
- `bun run test` full suite → 3368 passing, 27 pre-existing baseline failures, no new regressions.
- `bun run vesna` → 17/17, AGGREGATE 100% GATED PASS (probes correctly excluded from gate).
- `node dist/benchmark/episodic-density/cli.cjs measure` → exited 0 with verdict KILL; produced 02-RESULTS.md (6677 bytes) + 02-results.json (14625 bytes).
- 02-RESULTS.md contains the CONTEXT item 5 verbatim block (`grep -c '+5pp on either' 02-RESULTS.md` → 1).
- `error_fingerprint: false` confirmed in `src/shared/constants.ts`.
- Sidecar row count post-verdict: 10,678 (matches pre-verdict — backfill data retained).

## Issues Encountered

None directly tied to Plan 02-05. The KILL verdict is a successful empirical-phase outcome, not an issue.

## Phase 2 Readiness for Closure

**All 5 plans complete.** Phase 2 ships as an empirical phase with a KILL verdict — the deliverable is the measurement, the substrate, and the analysis. The user-approval gate before Phase 3 is the correct place to decide between the four next-step options listed above (different index, stack-trace-aware tokenizer, abandon multi-handle, or rerun on larger corpus).

Phase 1 substrate is preserved. Phase 4 (Angel reduction) and Phase 5 (density-based abstraction) plans may need re-scoping in light of:
- Density at scale failing the intra-project share test
- Multi-handle thesis under reconsideration

Phase 3 plan is **NOT** ready to start — the user-approval gate must run first.

Ready for **phase transition** (post-user-approval).
