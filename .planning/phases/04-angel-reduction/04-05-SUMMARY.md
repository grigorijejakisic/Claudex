---
phase: 04-angel-reduction
plan: 05
subsystem: intelligence
tags: [intelligence, experience-patterns, tombstone, layer-1-cutoff, phase-4]

requires:
  - phase: 04-02
    provides: Site A deletion — first of the three deletion sites the tombstone references
  - phase: 04-03
    provides: Site B deletion
  - phase: 04-04
    provides: Site C deletion
provides:
  - Module-level Phase 4 tombstone in src/intelligence/experience-patterns.ts
  - createPattern @phase4_status JSDoc preamble
  - Layer 1 of the 3-layer cutoff signal
affects: [04-06, 04-07, phase-7-retirement]

tech-stack:
  added: []
  patterns:
    - "Read-time tombstone: when a function survives a deletion as a tool for fixtures + retirement work, prepend its JSDoc with a status marker that names the surviving callers and points at the runtime backstop. Future readers landing in the file see the contract immediately."

key-files:
  created: []
  modified:
    - src/intelligence/experience-patterns.ts

key-decisions:
  - "Use @phase4_status as a structured tag in the JSDoc preamble. It is greppable (`grep '@phase4_status'`), distinct from generic prose, and pairs with future @phaseN_status tags Phase 7+ may add for other legacy modules."
  - "Treat Plan 05 Task 2 (delete createTipAndStrategy / generalizeLessonToStrategy) as a no-op. Neither function exists anywhere in the repository (verified via grep across the entire tree, not just src/). They were deleted in an earlier phase. Preserving plan-task fidelity here would mean inventing functions to delete — wrong move."
  - "Did NOT add tombstones to read-only callers (findMatchingPatterns, updatePatternScore, etc.). Per Plan 05 instruction: the load-bearing markers are the module-level + createPattern tombstones; per-export markers would clutter without paying their way."

patterns-established:
  - "Three-layer cutoff signal complete: Layer 1 (read-time JSDoc tombstone, this plan), Layer 2 (regression test, Plan 06), Layer 3 (V28 schema trigger, Plan 04-01). Each layer addresses a different reader: humans reading the file, CI running tests, the SQLite engine processing INSERTs."

requirements-completed: [AR-03]

duration: 3 min
completed: 2026-05-05
---

# Phase 4 Plan 05: Layer 1 cutoff — module + createPattern JSDoc tombstones

**`src/intelligence/experience-patterns.ts` module docblock and `createPattern` JSDoc updated with Phase 4 read-only-legacy tombstones. Plan 05 Task 2 (delete `createTipAndStrategy` / `generalizeLessonToStrategy`) is a no-op — neither function exists in the repository.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-05T16:34Z
- **Completed:** 2026-05-05T16:38Z
- **Tasks:** 2 (Task 1 = both tombstones in one commit; Task 2 = verified no-op)
- **Files modified:** 1

## Accomplishments

- Module-level docblock at `src/intelligence/experience-patterns.ts:1–35` rewritten to open with a "Phase 4 status: read-only-legacy" section. The section names the three deleted sites (with plan references), names the three legitimate callers, and explicitly says "Do NOT call createPattern from production code. The trigger will RAISE FAIL." The original ExpeL-scoring documentation is preserved beneath under "Original surface (still accurate for the read paths)".
- `createPattern` JSDoc (line ~363) prepended with `@phase4_status read-only-legacy` and a Phase 4 reduction note. Original parameter docs and behavior notes preserved beneath.
- `bun run build` clean. Full suite holds steady at 27 pre-existing failures, 3376 / 3411 passing.
- Plan 05 verify checks all pass:
  - `grep -c "Phase 4" src/intelligence/experience-patterns.ts` → 5 (≥5 required)
  - `grep -n "Phase 4 status: read-only-legacy"` → 1 match
  - `grep -n "@phase4_status"` → 1 match
  - `grep -n "2026-05-05-multi-handle-kill.md"` → 2 matches (≥2 required)

## Task Commits

1. `532fe75` — docs(04-05): tombstone experience-patterns module + createPattern (Layer 1 cutoff)
   (Single commit covers both tasks; Task 2 was a no-op so it does not warrant its own commit.)

## Deviations from Plan

### [Rule 1 - Bug] Plan 05 Task 2 is a no-op

- **Found during:** Task 2 step 1 (the grep for `createTipAndStrategy`).
- **Issue:** Plan 05 Task 2 directs deletion of `createTipAndStrategy` (and conditionally `generalizeLessonToStrategy`). Neither function exists anywhere in the repository — verified via `grep -rn` across the whole tree. The only matches are in `04-05-PLAN.md` itself.
- **Fix:** Skip Task 2 entirely; document the verified-empty grep in this SUMMARY's deviations + the Task 1 commit message. CONTEXT.md surveyed orphan writers that were already gone before Phase 4 started.
- **Files modified:** none (and that's the correct outcome).
- **Verification:** `grep -rn "createTipAndStrategy\|generalizeLessonToStrategy" .` returns matches only in `04-05-PLAN.md`.

**Total deviations:** 1 — a documented Task 2 no-op. Plan 05's deliverable shape (Layer 1 tombstone) is fully achieved by Task 1.

## Authentication Gates

None.

## Issues Encountered

None.

## Next Phase Readiness

**Ready for Plan 04-06 (Layer 2 — extraction-deleted.test.ts regression guard).** Layers 1 (this plan) and 3 (V28 trigger, Plan 04-01) are now in place; Layer 2 is the build-time guard that catches resurrection at CI. Plan 06 also inverts `experience-patterns-e2e.test.ts` per CONTEXT.md Camp I.
