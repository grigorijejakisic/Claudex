---
phase: 03-p2-directive-detector
plan: 01
subsystem: intelligence
tags: [directive-detector, regex, llm-confirm, dedup, vec0, artifact]

requires:
  - phase: 02-p1-artifact-table-unification
    provides: artifact kernel + kind registry (directive_rule writes here)
provides:
  - Pure module `extractDirectivesFromSession(db, sessionId, projectId, opts?)`
  - 12-family directive regex pre-filter (`DIRECTIVE_REGEX_FAMILIES`) + `stripCodeBlocks` helper
  - Config module with locked defaults (`thresholdGeneral=0.70`, `thresholdUniversal=0.85`, `dedupCosineThreshold=0.80`, `model=glm-5.1:cloud`)
  - LLM confirmer integration returning `{is_directive, confidence, polarity, scope, suggested_title, normalized_text, reasoning}`
  - vec0 top-3 dedup with LLM relation classification + 4-branch write policy (fresh INSERT / restatement UPDATE / opposite INSERT + annotate / related INSERT + annotate)
  - `dryRun` mode returning full DetectionRecord without DB writes (used by Plan 03-05 harness)
affects: [03-02, 03-03, 03-04, 03-05, 03-06, phase-10-rule-lifecycle]

tech-stack:
  added: []
  patterns:
    - Regex-pre-filter + LLM-confirm gating (high-precision extraction)
    - vec0 cosine dedup via `l2DistanceToCosine(d) = 1 - d*d/2`
    - 4-branch relation-aware write-path keyed on LLM-classified `same_scope|opposite_polarity|related_but_distinct|unrelated`
    - Session-scope dedup spans all same-project sessions (not just source session)

key-files:
  created:
    - src/intelligence/directive-detector.ts
    - src/intelligence/directive-detector-config.ts
    - src/intelligence/directive-detector-regex.ts
    - src/tests/intelligence/directive-detector.test.ts
    - src/tests/intelligence/directive-schema.test.ts
  modified: []

key-decisions:
  - "Reject outright on universal-under-gate; no downgrade to project (Q1)"
  - "`project_id = source_session.project` even for universal scope (Q2)"
  - "Dedup scope filter is strict: `scope=?` (no cross-scope dedup) (Q3)"
  - "Session-scope dedup spans all same-project sessions (Q4)"
  - "reinforcements[] slide-window cap at 50 (drop oldest)"

patterns-established:
  - "Pure-module detector: db + ids + opts → {candidates, confirmed, inserted, updated, skipped, errors}. Callable from heartbeat (03-04) or harness (03-05) identically."
  - "Artifact data-JSON shape snapshotted across all 4 write-paths in `directive-schema.test.ts` — this is the P2↔P8 handoff contract."

requirements-completed:
  - EXTR-01
  - EXTR-02

duration: ~1 day (planning + implementation)
completed: 2026-04-20
---

# Plan 03-01: Detector Core Summary

**Pure-module directive detector — 12 regex families + glm-5.1:cloud confirmer + vec0 top-3 relation-aware dedup with 4-branch write policy. Writes `artifact(kind='directive_rule', ...)` rows; no heartbeat wiring yet (03-04).**

## Performance

- **Completed:** 2026-04-20
- **Tasks:** 6 (regex module, config, main detector, write-path, schema test, unit tests)
- **Files created:** 5
- **New tests:** 48 (all pass)

## Accomplishments

- Regex pre-filter operates only on code-block-stripped user text; assistant text never scanned.
- ±2-turn un-stripped context assembled for the confirmer so code context isn't lost.
- Confirmer rejects on `!is_directive || confidence < thresholdGeneral || (scope==='universal' && confidence < thresholdUniversal)`.
- Dedup: top-3 same-scope, same-project cosine lookup; ≥0.80 triggers LLM relation classification; write routes to one of 4 branches.
- `dryRun: true` option returns full decision record without writes — enables Plan 03-05's precision harness.
- All 4 artifact.data shapes (`fresh`, `restatement`, `opposite_polarity`, `related_but_distinct`) snapshot-tested.

## Task Commits

1. **All 6 tasks** — `9548d34` (feat: detector core — regex + LLM confirm + dedup + write)

Single squash commit per the implementation landing pattern; substructure preserved in the PLAN tasks + test files.

## Files Created/Modified

- `src/intelligence/directive-detector.ts` (827 lines) — main module; `extractDirectivesFromSession` entry point
- `src/intelligence/directive-detector-config.ts` (36 lines) — `DirectiveDetectorConfig` + `loadConfig(overrides?)`
- `src/intelligence/directive-detector-regex.ts` (66 lines) — 12 regex families + `stripCodeBlocks`
- `src/tests/intelligence/directive-detector.test.ts` (499 lines) — unit tests
- `src/tests/intelligence/directive-schema.test.ts` (261 lines) — schema contract test

## Decisions Made

- Inline `loadPromptAssets()` stub with eventually-fixture shape — Plan 03-02 swaps it to file-backed.
- vec0 distance conversion via explicit `l2DistanceToCosine(d) = 1 - d*d/2` helper with unit test for boundary cases (d=0, d=√2, d=2), confirming `embedText()` output is unit-normalized.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None. 48/48 new tests green; no regressions on the 2020 pre-existing test suite.

## Next Phase Readiness

- Detector is callable. Plan 03-02 replaces inline stubs with file-backed prompt assets.
- Plan 03-04 wires this into the Angel heartbeat.
- Plan 03-05 exercises it in dryRun mode via the precision harness.

---
*Phase: 03-p2-directive-detector*
*Completed: 2026-04-20*
