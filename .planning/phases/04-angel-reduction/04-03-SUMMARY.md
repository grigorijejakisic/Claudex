---
phase: 04-angel-reduction
plan: 03
subsystem: intelligence
tags: [intelligence, experience-scoring, correction-detection, site-b, hook-side, regex-extraction, phase-4]

requires:
  - phase: 04-01
    provides: V28 trigger guard catches accidental remnant INSERTs from regression
  - phase: 04-02
    provides: precedent for surgical-delete + relocate-survivor protocol
provides:
  - Site B (hook-side regex-driven extraction) structurally deleted
  - applyExperienceFeedback narrowed to scoring + flag rotation only
  - extractLessonFromUserCorrection / extractPatternFromAssistantText deleted from correction-detection.ts
  - findCausalEvent / storeCausalAttribution preserved (Phase 7 retirement may use them)
  - experience-detection.test.ts renamed to correction-signal.test.ts; extraction-tests dropped; 56 surviving cases pass
affects: [04-04, 04-06, 04-07, phase-7-retirement]

tech-stack:
  added: []
  patterns:
    - "Function-narrowing in place: when a multi-step function loses one of its steps, the surviving function keeps its name (still describes what it does) and gets a top-of-file JSDoc note explaining the contract narrowed."
    - "Test split-rename: when a test file covers two surfaces and one is deleted, rename the file (`--follow` preserves blame) rather than leaving a misnamed survivor or splitting+deleting."

key-files:
  created:
    - src/tests/intelligence/correction-signal.test.ts
  deleted:
    - src/tests/intelligence/experience-detection.test.ts
  modified:
    - src/intelligence/experience-scoring.ts
    - src/intelligence/correction-detection.ts

key-decisions:
  - "Preserve findCausalEvent + storeCausalAttribution exports in correction-detection.ts even though no live caller remains. Phase 7 retirement tooling may surface causal attributions on existing pattern rows; storeCausalAttribution does an UPDATE, not INSERT, so the V28 trigger does not gate it."
  - "Prefix unused parameters lastAssistantText / config with underscore. The Stop hook calls applyExperienceFeedback with these args; changing the signature would force a hook edit that is out of Plan 03 scope and would noisy the per-task commit boundary."
  - "Renumber surviving steps (was 1/2/3, now 1/2). The original step 1 is gone; renumbering the comments matches the new function shape rather than leaving gap-numbered comments that confuse future readers."
  - "Keep the function name `applyExperienceFeedback`. The narrowed contract still applies — it provides feedback (score deltas) on already-extracted patterns and rotates the injected/awaiting flags. The plan explicitly allows this and the alternative (rename to `applyExperienceScoreFeedback`) would be Plan 03 scope creep."
  - "Restructured top-of-file JSDoc on correction-detection.ts to honestly describe the narrowed surface. Did NOT rename the file — `correction-detection` still describes what it does (detect correction signals + run causal attribution)."

patterns-established:
  - "Multi-site reduction protocol continued: Plan 02 killed Site A (Angel-side LLM extraction); Plan 03 kills Site B (hook-side regex extraction); Plan 04 kills Site C (heartbeat synthesis loop). Each plan's per-task commits + SUMMARY are independently reviewable."
  - "Step-block deletion + import-list trim is a single-task surgical pattern. The other tasks (deleting old test files, splitting tests, retargeting mocks) follow naturally from it."

requirements-completed: [AR-01, AR-03]

duration: 7 min
completed: 2026-05-05
---

# Phase 4 Plan 03: Site B surgical kill — hook-side regex-driven extraction

**`applyExperienceFeedback` step 1 (correction_flagged → createPattern) deleted; `extractLessonFromUserCorrection` and `extractPatternFromAssistantText` deleted from `correction-detection.ts`; old `experience-detection.test.ts` renamed to `correction-signal.test.ts` with 56 surviving cases.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-05-05T16:24Z
- **Completed:** 2026-05-05T16:30Z
- **Tasks:** 3 (per Plan 03 task layout)
- **Files modified:** 2
- **Files created:** 1
- **Files deleted:** 1

## Accomplishments

- `src/intelligence/experience-scoring.ts`: step 1 (lines 64–112) + 6 unused imports removed; signature preserved with `_lastAssistantText` / `_config` underscore-prefixed; top docblock and step numbering updated. Function shrank from 211 → 160 lines.
- `src/intelligence/correction-detection.ts`: `extractLessonFromUserCorrection`, `extractPatternFromAssistantText`, plus their 5 helper-const arrays and the `ExtractionInput` / `redactContent` imports deleted. File shrank from 408 → 215 lines.
- `src/tests/intelligence/experience-detection.test.ts` (683 lines) renamed to `src/tests/intelligence/correction-signal.test.ts` (357 lines). Surviving cases: detectCorrectionSignal positive (29 cases) + negative (10 cases), behavioral detection (file thrashing 4 + loop detection 5), buildToolSignature (8). Total 56 tests, all PASS.
- `bun run build` clean. `bun run test` — 27 pre-existing failures unchanged, 3381 / 3416 passing (test count drop of 36 = the 36 deleted extraction-test cases).

## Task Commits

1. `a1d56a2` — feat(04-03): trim Site B step 1 from applyExperienceFeedback
2. `ebe06f7` — feat(04-03): delete extractLessonFromUserCorrection + extractPatternFromAssistantText
3. `a18adc1` — test(04-03): split experience-detection.test.ts into correction-signal.test.ts (git-detected rename, 52% similarity)

## Deviations from Plan

### [Rule 1 - Bug] Underscore-prefix unused params instead of dropping from signature

- **Found during:** Task 1 verification (build check after deleting step 1).
- **Issue:** Plan 03 step 1 says to "delete the entire step-1 block" but doesn't specify what to do with the now-unused parameters `lastAssistantText` and `config`. Dropping them from the signature would force a Stop hook caller edit that's out of Plan 03 scope.
- **Fix:** Prefix both with underscore (`_lastAssistantText`, `_config`) and document in the JSDoc that they're preserved for caller compatibility. The Stop hook call site doesn't change.
- **Files modified:** `src/intelligence/experience-scoring.ts`.
- **Verification:** Build clean.

### [Rule 1 - Bug] Restructure step numbering in surviving comments

- **Found during:** Task 1.
- **Issue:** Original comments numbered "1. Pattern extraction", "2. Topic-aware score feedback", "3. Promote injected → awaiting". After deleting step 1, leaving the survivors as "2. ..." and "3. ..." would confuse future readers.
- **Fix:** Renumber to "1. Topic-aware score feedback" and "2. Promote injected → awaiting".
- **Files modified:** `src/intelligence/experience-scoring.ts`.

### [Rule 1 - Bug] Plan task description listed wrong line numbers for some imports

- **Found during:** Task 1 (reading the file end-to-end).
- **Issue:** Plan 03 step 1 step 1.2 says to "remove `createPattern` from the destructured list" — but the destructured list at lines 17–23 also imported `classifyPatternScope` which Plan 03 also deletes (it was only used by step 1's classifyPatternScope call), and `findCausalEvent` / `storeCausalAttribution` from `'./correction-detection.js'` (line 26) which were also only used by step 1.
- **Fix:** Removed `createPattern`, `classifyPatternScope` from the experience-patterns destructure; removed `findCausalEvent`, `storeCausalAttribution`, `extractLessonFromUserCorrection`, `extractPatternFromAssistantText` from the correction-detection destructure. Also dropped `detectEnrichmentProvider` and `CC_CAPABILITIES` (only step 1 used them).
- **Files modified:** `src/intelligence/experience-scoring.ts`.
- **Verification:** Build clean; suite drops only the expected 36 extraction-test cases.

**Total deviations:** 3 — all Rule 1 (auto-fixed). All trivial: parameter underscoring, comment renumbering, more aggressive import trimming than the plan literally stated. None affect Plan 03's deliverable shape.

## Authentication Gates

None.

## Issues Encountered

None — all 3 tasks completed; full test suite holds steady at 27 pre-existing failures.

## Next Phase Readiness

**Ready for Plan 04-04.** Sites A and B are structurally gone. Site C (heartbeat synthesis loop in `src/angel/heartbeat.ts:1090–1149`) is the last extraction-time pattern-creation path. Plan 04 deletes the LLM synthesis call + lesson rewrite while preserving the dedup/score-absorption mechanics (those are housekeeping, not abstraction).
