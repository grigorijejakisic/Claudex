---
phase: 03-p2-directive-detector
plan: 05
subsystem: testing
tags: [precision-harness, compare-runs, runbook, dryRun, joint-precision]

requires:
  - phase: 03-p2-directive-detector
    provides: extractDirectivesFromSession with dryRun (Plan 03-01); fixture JSONLs (Plan 03-03); prompt assets (Plan 03-02)
provides:
  - `run-precision.ts` — precision harness driving every fixture candidate through detector in dryRun mode; emits joint_precision + per-field + per-family + per-scope metrics
  - `compare-runs.ts` — markdown diff between any two run JSONs; filters per-family to |Δ|>2pp; always shows per-scope (universal gets scrutiny)
  - `runbook.md` — RESEARCH §1.6 iteration decision tree (ship ≥92% / noise-bound 88–92% / 3-cycle tune <88% / escalate) with copy-paste commands
  - Per-run JSON output under `fixtures/runs/<iso>_<tag>.json` with full decision record
  - Summary-line verdict: ship / noise-bound / tune
affects: [03-06 calibration runs this harness across all cycles + measurement]

tech-stack:
  added: []
  patterns:
    - In-memory DB seeding exercises production code path without requiring a processCandidate() API split
    - Run-JSON is the audit artifact — timestamped, tagged, diffable across cycles
    - Runbook codifies the decision tree in markdown so iteration is reproducible across agents

key-files:
  created:
    - src/benchmarks/directive-detector/run-precision.ts
    - src/benchmarks/directive-detector/compare-runs.ts
    - src/benchmarks/directive-detector/runbook.md
  modified: []

key-decisions:
  - "Seed throwaway in-memory DBs rather than refactor detector around a processCandidate() contract — simpler, zero new API surface"
  - "Per-family compare-runs filter at |Δ|>2pp to keep diffs readable; per-scope always rendered"
  - "Runbook decision tree lives with the harness, not in PLAN — it's a runtime tool, not a plan artifact"

patterns-established:
  - "dryRun mode as the bench-harness contract: the same module runs in production and measurement"
  - "Content-addressed output by ISO timestamp enables longitudinal comparison without manual naming"
  - "Verdict line at end of run — single summary signal for auto-orchestrate"

requirements-completed:
  - EXTR-04

duration: ~25min
completed: 2026-04-20
---

# Plan 03-05: Precision Harness + Compare-Runs + Runbook Summary

**Precision harness driving the fixture through the detector in dryRun mode. Emits joint_precision + per-field + per-family + per-scope metrics as timestamped JSON. Compare-runs diff tool + runbook decision tree codify the 3-cycle tuning loop. Powered every Plan 03-06 calibration cycle.**

## Performance

- **Completed:** 2026-04-20
- **Tasks:** 3 (run-precision, compare-runs, runbook)
- **Files created:** 3
- **Files modified:** 0

## Accomplishments

- `run-precision.ts` seeds a throwaway in-memory DB per candidate with its ±2-turn context, calls `extractDirectivesFromSession(dryRun=true)`, emits full decisions[] alongside aggregate metrics.
- Metrics exported: `joint_precision`, `is_directive_precision`, `scope_precision_given_correct`, `polarity_precision_given_correct`, `per_regex_family`, `per_scope`, `confusion_matrix`.
- `compare-runs.ts` produces a markdown diff of two runs — filters per-family to |Δ|>2pp; per-scope always shown.
- `runbook.md` codifies the 3-cycle iteration tree with per-branch commands.
- Verdict line (`ship` / `noise-bound` / `tune`) written to stdout for orchestration.

## Task Commits

1. **Harness + compare + runbook** — `5d05806` (feat: precision harness + compare-runs + iteration runbook)

## Files Created/Modified

- `src/benchmarks/directive-detector/run-precision.ts` — main harness
- `src/benchmarks/directive-detector/compare-runs.ts` — per-run markdown diff
- `src/benchmarks/directive-detector/runbook.md` — iteration decision tree

## Decisions Made

- Declined the alternative of refactoring detector around a `processCandidate()` entry point. The in-memory DB seeding pattern exercises the exact production write-path minus the commits, and avoids adding API surface future phases might inherit.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None at ship. Plan 03-06 Cycle-1 threshold sweep later revealed that temperature=0 LLM responses are deterministic, so threshold-only sweeps can be simulated from a single confirm-call trace without re-running the LLM — captured in 03-CALIBRATION.md.

## Next Phase Readiness

- Harness is the measurement instrument for Plan 03-06.
- Later fixture-scoring enhancement (honoring `scope_excluded_from_scoring: true` label-row flag) added during the 2026-04-22 post-relabel run so labels with unknowable scope don't penalize the detector.

---
*Phase: 03-p2-directive-detector*
*Completed: 2026-04-20*
