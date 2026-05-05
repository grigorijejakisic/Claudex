---
phase: 04-angel-reduction
plan: 04
subsystem: angel
tags: [angel, heartbeat, site-c, llm-synthesis, dedup, score-absorption, phase-4]

requires:
  - phase: 04-01
    provides: V28 trigger guard (catches accidental remnant INSERTs from regression)
  - phase: 04-02
    provides: pattern-extractor.ts deletion + heartbeat Site A removal — exemplar surgical-delete pattern
provides:
  - Site C (heartbeat lesson-synthesis loop) structurally deleted
  - Score-absorption + DELETE-absorbed-row mechanics preserved in the merge loop
  - callLocalLLM import dropped from heartbeat.ts (last in-file caller deleted with Site C)
  - heartbeat-regression.test.ts narrowed: definitiveOutcomes regression dropped; process-guard + services-down regressions preserved
affects: [04-06, 04-07, phase-7-retirement]

tech-stack:
  added: []
  patterns:
    - "Differentiating housekeeping from extraction-time abstraction: dedup mechanics that absorb scores via UPDATE-then-DELETE are housekeeping; LLM synthesis that overwrites the lesson column with a 'combined abstract principle' is extraction-time abstraction (the parable's edge cleanly drawn)."
    - "When the only in-module caller of an imported symbol dies with the deletion, drop the import too — keeps the module's import surface honest."

key-files:
  created: []
  modified:
    - src/angel/heartbeat.ts
    - src/tests/angel/heartbeat-regression.test.ts

key-decisions:
  - "Keep the heartbeat-regression.test.ts file (vs. delete entirely). The process-guard and services-down-interval describe blocks test surfaces that survive Phase 4 unchanged. Deleting the file would lose that coverage; trimming the definitiveOutcomes block is the surgical move."
  - "Drop callLocalLLM from the llama-client import in heartbeat.ts. Site C was its only caller in this file (the surviving callLocalLLM uses live in domain-classifier.ts and curated-context-extractor.ts). Keeping the import would generate a noUnusedImports warning if strict linting is added later."
  - "Drop the totalAbsorbed local — it was incremented in the deleted lesson-rewrite path and not used anywhere else. Removing it eliminates the warning + makes the surviving loop body honest about what it tracks."
  - "The score-absorption UPDATE and DELETE survive the V28 trigger because it only blocks INSERT. The AFTER DELETE FTS5 sync trigger (experience_patterns_ad) keeps experience_patterns_fts in sync after the DELETE — already verified in Plan 04-01's V28 test that FTS5 sync is preserved."

patterns-established:
  - "Multi-site reduction protocol completed: Plan 02 closed Site A (Angel-side LLM extraction); Plan 03 closed Site B (hook-side regex extraction); Plan 04 closed Site C (heartbeat lesson synthesis). All three sites identified in Phase 4 CONTEXT.md are now structurally gone."

requirements-completed: [AR-01, AR-03, AR-05]

duration: 4 min
completed: 2026-05-05
---

# Phase 4 Plan 04: Site C surgical kill — heartbeat lesson-synthesis loop

**Heartbeat merge loop's LLM-driven `synthesizedLesson` computation + paired `UPDATE experience_patterns SET lesson = ?` deleted; dedup + score absorption survive. `callLocalLLM` import dropped (last caller deleted). `heartbeat-regression.test.ts` narrowed to drop the now-orphaned `definitiveOutcomes` regression cases.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-05T16:30Z
- **Completed:** 2026-05-05T16:34Z
- **Tasks:** 2 (per Plan 04 task layout)
- **Files modified:** 2

## Accomplishments

- `src/angel/heartbeat.ts`: synthesizedLesson local + try/catch LLM call (lines ~1097–1112) deleted; lesson UPDATE (lines ~1128–1132) deleted; totalAbsorbed local dropped; callLocalLLM dropped from llama-client import. Block shrank by ~25 lines net.
- `src/tests/angel/heartbeat-regression.test.ts`: `definitiveOutcomes` describe block (5 cases) deleted; top JSDoc updated; surviving 11 cases (process-guard + services-down-interval) all pass.
- Verifications: `bun run build` clean; `grep synthesizedLesson` ZERO matches; `grep "UPDATE experience_patterns SET lesson"` ZERO matches; `findSimilarPatterns` import preserved; `score = score + ?` preserved.
- Full suite: 3376 / 3411 passing (test count drop of 5 = the 5 deleted definitiveOutcomes cases). 27 pre-existing failures unchanged.
- Vesna 17/17 PASS preserved.

## Task Commits

1. `f20112a` — feat(04-04): delete Site C lesson-synthesis from heartbeat merge loop
2. `65e69cb` — test(04-04): drop definitiveOutcomes regression cases from heartbeat-regression.test.ts

## Deviations from Plan

### [Rule 1 - Bug] Drop callLocalLLM from llama-client import

- **Found during:** Task 1 verification (`grep callLocalLLM src/angel/heartbeat.ts` after deleting Site C).
- **Issue:** Plan 04 step 4 says "Re-grep and document the remaining count in the commit message" but doesn't direct what to do with a now-zero count. The import becomes dead code.
- **Fix:** Drop callLocalLLM from the import block. The other three llama-client imports (checkLlamaServerHealth, isCloudModel, LLAMA_MODEL_ALIAS) survive — they're used by the service-down detection path elsewhere in heartbeat.ts.
- **Files modified:** `src/angel/heartbeat.ts`.
- **Verification:** Build clean.

### [Rule 1 - Bug] Drop totalAbsorbed local

- **Found during:** Task 1.
- **Issue:** The original loop computed `totalAbsorbed += m.score` inside the per-merge-target loop. The variable was used nowhere else (no log, no return, no UPDATE) — looks like dead code from an earlier iteration.
- **Fix:** Removed the variable and the increment line.
- **Files modified:** `src/angel/heartbeat.ts`.

**Total deviations:** 2 — both Rule 1 (auto-fixed). Both are import / dead-local cleanup that follows naturally from the deletion. None affect Plan 04's deliverable shape.

## Authentication Gates

None.

## Issues Encountered

None — all 2 tasks completed; full test suite holds steady at 27 pre-existing failures; Vesna 17/17 PASS.

## Next Phase Readiness

**Wave 2 (Plans 02/03/04) shipped.** All three Phase 4 deletion sites are now structurally gone:
- Site A — Angel-side LLM extractor (Plan 02)
- Site B — hook-side regex extractor (Plan 03)
- Site C — heartbeat LLM lesson synthesis (Plan 04)

**Ready for Wave 3 (Plans 05/06/07).** The remaining work:
- Plan 05: Layer 1 — JSDoc tombstone on `createPattern` in `src/intelligence/experience-patterns.ts` (the function survives, exported for fixtures/migrations/Phase-7 retirement; tombstone documents that it has no live production caller after Phase 4).
- Plan 06: Layer 2 — `src/tests/intelligence/extraction-deleted.test.ts` regression guard (4 assertions catching resurrection of Sites A/B/C).
- Plan 07: Vesna probe SC-V5-2 / VAL-02 (extraction-must-not-fire post-Phase-4).

The 88 inflated `experience_patterns` rows remain untouched — Phase 7 owns retirement direction.
