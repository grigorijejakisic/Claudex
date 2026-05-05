---
phase: 04-angel-reduction
plan: 09
subsystem: angel
tags: [angel, cleanup, orphan-symbols, soft-no-op, phase-4]

requires:
  - phase: 04-02
    provides: Site A deletion (the orphan symbols this plan cleans up were Site A's dependencies)
  - phase: 04-03
    provides: Site B deletion (signature change consequence)
  - phase: 04-04
    provides: Site C deletion
  - phase: 04-05
    provides: Layer 1 tombstone (this plan cleans up below the tombstone)
provides:
  - Soft-no-op TickResult.sessions_processed / patterns_extracted with Phase 4 comment
  - src/angel/skill-writer.ts deleted (zero surviving callers)
  - markSessionProcessed deleted from session-monitor.ts (zero surviving production callers)
  - getUnprocessedSessions retained with Phase 4 note explaining dead-feedback-loop
  - session-monitor.test.ts updated (inlined the INSERT that markSessionProcessed performed)
affects: [phase-7-retirement]

tech-stack:
  added: []
  patterns:
    - "Soft no-op vs. hard delete decision: when a result-type field is read by observability surfaces, soft no-op (always 0) avoids breaking those consumers; when a function has zero surviving callers AND its inverse semantics are easy to inline at the test site, hard delete + test-side inline is cleaner than carrying dead code with a TODO."
    - "Asymmetric orphan handling: paired functions (markSessionProcessed + getUnprocessedSessions) are not necessarily both orphan-eligible. The reader can survive while the writer dies; document the resulting feedback loop honestly so Phase 7 retirement sees the problem space."

key-files:
  created: []
  modified:
    - src/angel/heartbeat.ts
    - src/angel/session-monitor.ts
    - src/tests/angel/session-monitor.test.ts
  deleted:
    - src/angel/skill-writer.ts

key-decisions:
  - "Soft no-op result.sessions_processed and result.patterns_extracted with a 3-line Phase 4 comment in the TickResult initializer. Not hard-deleting because two downstream gates in heartbeat.ts (lines ~696, ~715) read these fields as sentinels; cleaning those up is broader scope and Phase 7's job."
  - "Hard-delete src/angel/skill-writer.ts entirely (vs. leaving with a tombstone). Plan 09 Task 2 step 2 says 'if grep returns no production callers: delete'. Both findSkillByDomain and writeSkillFile were write-side utilities only the deleted extractor used; preserving them as dead code violates the Phase 4 reduction principle."
  - "Hard-delete markSessionProcessed (vs. leaving with a tombstone). Plan 09 Task 3 step 2 says 'if zero callers: delete'. The sole production caller died with Site A; the test fixture's call site was easy to inline (4-line INSERT directly into session_events). The angel_processed event_type itself stays in the schema — Phase 7 retires it together with the legacy table."
  - "Keep getUnprocessedSessions and document the dead-feedback-loop in its JSDoc. Heartbeat.ts:283 still uses it as the loop driver for directive extraction + curated-context extraction. With no live writer of angel_processed events, the same sessions are returned every tick — but both downstream subsystems are idempotent (per-session dedup happens internally), so the cost is bounded."

patterns-established:
  - "End-of-phase orphan-symbol sweep: after a multi-site deletion phase, do a cleanup pass to (a) remove utilities that were exclusively writers for the deleted code, (b) document feedback loops where readers survive but writers died, (c) decide soft no-op vs. hard delete for result-type fields based on observability surface impact."

requirements-completed: [AR-01]

duration: 5 min
completed: 2026-05-05
---

# Phase 4 Plan 09: cleanup — orphan symbols + soft-no-op + dead feedback loop

**`result.sessions_processed` and `result.patterns_extracted` get a Phase 4 'dead' comment in the TickResult initializer (soft no-op preserved). `src/angel/skill-writer.ts` deleted (zero surviving callers). `markSessionProcessed` deleted from `session-monitor.ts` with the test-side call inlined as a raw INSERT. `getUnprocessedSessions` retained with a JSDoc explaining the dead-feedback-loop now that no production code writes `angel_processed` events.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-05T16:48Z
- **Completed:** 2026-05-05T16:53Z
- **Tasks:** 3 (per Plan 09 task layout)
- **Files modified:** 3
- **Files deleted:** 1

## Accomplishments

- `src/angel/heartbeat.ts`: 3-line Phase 4 comment added to TickResult initializer above the dead `sessions_processed` / `patterns_extracted` fields.
- `src/angel/skill-writer.ts` deleted (119 lines). Both exports (findSkillByDomain, writeSkillFile) were write-side utilities only the deleted Site A extractor used.
- `src/angel/session-monitor.ts`: `markSessionProcessed` deleted (16 lines); `getUnprocessedSessions` JSDoc rewritten with a Phase 4 note documenting the dead-feedback-loop.
- `src/tests/angel/session-monitor.test.ts`: import line trimmed; test fixture's `markSessionProcessed(db, 'processed-1', 'test-proj')` call replaced with a 4-line direct INSERT into `session_events` so the test still exercises the angel_processed semantics it was checking.
- `bun run build` clean. `bun run test` — 27 pre-existing failures unchanged, 3380 / 3415 passing. `bun run vesna` 18/18 PASS at 100%.

## Task Commits

1. `088c819` — chore(04-09): mark sessions_processed / patterns_extracted as Phase 4 dead
2. `e794e49` — chore(04-09): delete src/angel/skill-writer.ts (orphaned with Site A)
3. `d8e6a25` — chore(04-09): delete markSessionProcessed; document getUnprocessedSessions feedback loop

## Deviations from Plan

### [Rule 1 - Bug] Asymmetric handling of getUnprocessedSessions vs markSessionProcessed

- **Found during:** Task 3 grep (re-checking the orphan status of both functions).
- **Issue:** Plan 09 Task 3 frames the two functions as a pair: "If only the deleted Phase-2 extraction loop in heartbeat.ts called these (now zero callers post-plan-02): delete both functions." But `getUnprocessedSessions` IS still called from heartbeat.ts:283 (the directive-extraction loop driver). Only `markSessionProcessed` is fully orphaned.
- **Fix:** Asymmetric handling. Delete `markSessionProcessed` (zero production callers); keep `getUnprocessedSessions` and add a Phase 4 note JSDoc explaining the resulting dead-feedback-loop. The plan's "if a surviving caller exists" branch (step 3.3) covers this.
- **Verification:** Build clean; tests pass; the JSDoc note honestly documents the dead loop for Phase 7 retirement to see.

### [Rule 1 - Bug] Inline the markSessionProcessed INSERT in the test instead of dropping the test case

- **Found during:** Task 3 walkthrough (deciding what to do with the test case at line 78 that calls markSessionProcessed).
- **Issue:** Plan 09 Task 3 step 2.3 says "drop those cases" if the test references the deleted symbol. But the test case is testing `getUnprocessedSessions`'s correct behavior when a session has been marked processed — that's still a valid behavioral assertion of the surviving function.
- **Fix:** Replace the deleted helper's call with the equivalent raw INSERT into session_events directly in the test. The test still exercises the same code path; the deletion is invisible at the assertion level.
- **Verification:** 9 / 9 cases in session-monitor.test.ts pass.

**Total deviations:** 2 — both Rule 1 (planner discretion within Plan 09's instruction). Neither affects the cleanup deliverable.

## Authentication Gates

None.

## Issues Encountered

None.

## Next Phase Readiness

**Phase 4 (Angel reduction) is structurally complete.** All 9 plans shipped:
- Wave 1 (Plan 01): V28 schema cutoff
- Wave 2 (Plans 02/03/04): three deletion sites closed
- Wave 3 (Plans 05/06/07): three layers of cutoff signal + ship gate
- Wave 4 (Plans 08/09): surface-map audit trail + orphan-symbol cleanup

Final state:
- `bun run build`: clean
- `bun run test`: 3380 / 3415 passing (27 pre-existing failures unchanged from baseline; net -32 test count from extraction-test deletions)
- `bun run vesna`: 18 / 18 PASS at 100%
- Phase 4 codepath: extraction-time pattern creation is structurally impossible at three layers (read-time tombstones, build-time regression tests, runtime V28 trigger)

**Ready for user-approval gate.** ROADMAP Phase 4 entry should move from `[ ]` to `[x]`. CLAUDE.md "17/17 PASS at 100%" line should be updated to "18/18 PASS at 100%". `.planning/STATE.md` should advance position from "Phase 4 (next; pending discuss)" to "Phase 4 (shipped); next: Phase 6". After the user-approval gate fires, `/gsd:complete-milestone` archive workflow can run, or work proceeds to Phase 6 (crash-resilient episode boundary).
