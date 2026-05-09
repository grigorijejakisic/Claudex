---
phase: 11-polish-land-v6-properly
plan: 01
subsystem: routing
tags: [polish, regression-fix, gemini-review-closure]
requires: []
provides:
  - "Routing null-body coalesce: queryText falls back through query_text ?? rows[0]?.body ?? '' (non-throwing on NULL body / drift schema)"
  - "Telemetry-bypass isolation: incrementRerankerFallbackCounter wrapped in inner try/catch — telemetry exception never short-circuits bi-encoder fallback"
  - "Time-distance candidate ordering: ORDER BY ABS(created_at_epoch_ms - ?) ASC LIMIT 20 picks 20 temporally closest, not 20 earliest by turn_index"
  - "3 regression tests asserting all 3 fixes against pre-fix code shapes"
affects:
  - "11-04 wire-test (harness B-arm = direct call to routeFromArtifact — Gemini-flagged bugs are now closed before harness re-bind)"
tech-stack:
  added: []
  patterns:
    - "ABS(timestamp - anchor) ASC ORDER BY for window-bounded nearest-N selection"
    - "Inner try/catch isolation for non-critical telemetry inside outer error-handling catch"
key-files:
  created: []
  modified:
    - "src/retrieval/transcript-routing.ts (3 surgical edits — coalesce, telemetry isolation, ORDER BY)"
    - "src/tests/retrieval/transcript-routing.test.ts (3 new describe blocks; total 12 tests, was 9)"
key-decisions:
  - "Coalesce-to-empty-string is the chosen non-throwing degraded path — alternative (skip the candidate) was rejected because it changes result-set semantics on a NULL-body row from `degraded but present` to `dropped`, which is a stronger silent-fail."
  - "Time-window absolute-distance ordering changes which 20 chunks are kept when the window contains > 20. Re-sort by (turn_index, sub_index) in-JS preserves downstream iteration ergonomics."
  - "Null-body regression test uses NULLABLE schema variant (CREATE TABLE without NOT NULL) to model production drift shape — the production schema enforces NOT NULL but historical drift / direct PRAGMA-bypass writes can produce NULL rows."
requirements-completed: [POLISH-01]
duration: "23 min"
completed: "2026-05-09"
---

# Phase 11 Plan 01: Routing fixes (POLISH-01) Summary

**One-liner:** Three Gemini routing findings closed in `src/retrieval/transcript-routing.ts` — null-body coalesce, telemetry-write isolation, time-distance candidate ordering — plus three regression tests asserting the fixes against pre-fix code shapes.

**Duration:** 23 min (started 21:57Z, ended 22:00Z 2026-05-09)
**Tasks:** 3 (source fixes, regression tests; one combined commit per logical change)
**Files modified:** 2 (1 source, 1 test)
**Commits:** 2 (`af9a5ca` source fixes, `b91b3d2` regression tests)

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Null-body coalesce + telemetry-bypass isolation in transcript-routing.ts | `af9a5ca` | src/retrieval/transcript-routing.ts |
| 2 | Switch candidate-fetch SQL to absolute time-distance ordering | `af9a5ca` (same commit — co-located surgical fixes) | src/retrieval/transcript-routing.ts |
| 3 | Three regression tests asserting the three fixes | `b91b3d2` | src/tests/retrieval/transcript-routing.test.ts |

Tasks 1+2 were committed together because they touch the same file with surgical fixes co-located by scope; the plan permits this discretion ("planner judges based on logical cohesion ... routing 1-line fixes likely one commit").

## Verification

- `bun run build` exits 0.
- `bunx vitest run src/tests/retrieval/transcript-routing.test.ts` — 12 tests pass (was 9 + 3 new).
- `grep -nE "ORDER BY ABS\(created_at_epoch_ms" src/retrieval/transcript-routing.ts` matches 1 line.
- `grep -nE "try\s*\{[\s\S]*?incrementRerankerFallbackCounter" src/retrieval/transcript-routing.ts` matches 1 inner-try block.
- `grep -c "incrementRerankerFallbackCounter" src/retrieval/transcript-routing.ts` returns 1 (single call site, now wrapped).
- No public-API drift — `routeFromArtifact` and `routeFromArtifacts` keep their Plan 10-01 signatures.

## Deviations from Plan

None — plan executed exactly as written. The only minor adjustment: Task 1's null-body test fixture builds a NULLABLE schema variant (production schema enforces NOT NULL on body) to model the drift shape Gemini flagged; the alternative (mocking row results) would couple the test to internal implementation details rather than asserting the contract.

## Issues Encountered

None.

## Next Phase Readiness

11-02 (assembly fixes) and 11-03 (ingestion + tests + lint + snapshot + WIR) are independent of 11-01 — Wave 1 plans run in parallel by the wave structure but were executed serially in this single-context execution. Ready for 11-02.
