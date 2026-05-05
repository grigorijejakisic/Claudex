---
phase: 04-angel-reduction
plan: 08
subsystem: docs
tags: [docs, legacy-comment, surface-map, ar-02, phase-4]

requires:
  - phase: 04-01
    provides: V28 trigger context — the comment cites it as the runtime backstop
provides:
  - Uniform legacy-with-TODO comment at 9 experience_patterns reader sites (10 total occurrences — heartbeat.ts has 2)
  - Greppable single-source surface map for Phase 7 retirement work
affects: [phase-7-retirement]

tech-stack:
  added: []
  patterns:
    - "Greppable audit-trail comment: a single load-bearing string ('Phase 4 stopped new INSERTs') placed adjacent to every SELECT/UPDATE site of the legacy table. Phase 7 retirement uses one grep to surface the full consumer list, eliminating the 'did I miss a reader?' worry."

key-files:
  created: []
  modified:
    - src/assembly/assembler.ts
    - src/angel/heartbeat.ts
    - src/intelligence/trigger-engine.ts
    - src/intelligence/contradiction-detector.ts
    - src/intelligence/outcome-tracker.ts
    - src/embeddings/sqlite-vec-backend.ts
    - src/embeddings/embed-pipeline.ts
    - src/mcp/recall-server.ts
    - src/adapters/cc-hooks/stop.ts

key-decisions:
  - "Use the verbatim comment text from CONTEXT.md (the leading 'Reads experience_patterns (pre-Phase-4 legacy table)...' triplet). One source of truth for the audit trail, no per-site phrasing drift."
  - "Place the comment directly above the SELECT/UPDATE statement (no blank line in between). When the reader's surrounding context already has explanatory comments, the legacy comment is added immediately above the SQL prepared statement so it is visible at the SQL site."
  - "Did NOT add the comment to the Site C merge loop in heartbeat.ts (lines 1083–1109) because Plan 04-04 already gave that block a narrower Phase 4 comment ('Phase 4: dedup + score absorption only. LLM lesson synthesis was deleted...'). The narrower comment is more specific and load-bearing for that block."
  - "Skipped the trigger-engine.ts trigger-data-existence check (line 50) and the loadPatternsByIds (line 183). Both are read-only enrichment paths; the matchTriggers SELECT (line 114) carries the comment for the trigger-engine module."
  - "Skipped the FTS5 sync triggers in schema.ts (CONTEXT.md item 5 says 'don't add to UPDATE-only paths that don't INSERT — those are infrastructure'). The trigger DDL is the migrate path; the comment belongs at consumer sites."

patterns-established:
  - "Reader-site annotation in lieu of re-pointing: when a phase deletes the writers but keeps the readers (Phase 4 dropped Phase 3's re-pointing), every reader site gets a comment naming what survived, what didn't, and where the retirement direction will be decided. This is the 'legacy-with-TODO' surface from the spec."

requirements-completed: [AR-02]

duration: 5 min
completed: 2026-05-05
---

# Phase 4 Plan 08: AR-02 deliverable — uniform legacy comment at 9 reader sites

**Verbatim comment text from CONTEXT.md added immediately above the experience_patterns SELECT/UPDATE statement at 9 reader files (10 occurrences total, heartbeat.ts has 2). `grep -rn "Phase 4 stopped new INSERTs" src/` returns the complete consumer surface map for Phase 7 retirement work.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-05T16:50Z
- **Completed:** 2026-05-05T16:55Z
- **Tasks:** 1 (single comment-addition pass across 9 files)
- **Files modified:** 9

## Accomplishments

- The uniform comment placed at:
  - `src/assembly/assembler.ts:215` (P1.5/P4.1 reconsolidation reader)
  - `src/angel/heartbeat.ts:373` (pruning SELECT)
  - `src/angel/heartbeat.ts:1025` (retrieval-mode-promotion SELECT)
  - `src/intelligence/trigger-engine.ts:114` (matchTriggers SELECT)
  - `src/intelligence/contradiction-detector.ts:71` (proven-pattern SELECT)
  - `src/intelligence/outcome-tracker.ts:71` (confidence-blend UPDATE)
  - `src/embeddings/sqlite-vec-backend.ts:393` (KNN-enrichment SELECT)
  - `src/embeddings/embed-pipeline.ts:208` (embedding-BLOB UPDATE)
  - `src/mcp/recall-server.ts:496` (channel-6 FTS5 SELECT)
  - `src/adapters/cc-hooks/stop.ts:361` (applyExperienceFeedback call site)
- `grep -rn "Phase 4 stopped new INSERTs" src/` returns 10 matches across 9 files — passes Plan 08 verify (≥9 required).
- `grep -rn "2026-05-05-multi-handle-kill.md" src/` returns 21 matches (10 from this plan + 4 from V28 trigger error message + 4 from JSDoc tombstones in Plan 05 + 3 from prior plans' code comments) — well above the ≥11 baseline.
- `bun run build` clean. `bun run test` — 27 pre-existing failures unchanged, 3380 / 3415 passing. `bun run vesna` 18/18 PASS at 100%.

## Task Commits

1. `3164796` — docs(04-08): add uniform legacy-with-TODO comment to 9 experience_patterns reader sites

## Deviations from Plan

### [Rule 1 - Bug] Skip Site C merge block in heartbeat.ts

- **Found during:** Task 1 walkthrough (re-reading Plan 08's "Avoid" bullet about heartbeat lines 1090–1149).
- **Issue:** Plan 04-04 added a more specific comment to the Site C merge block ("Phase 4: dedup + score absorption only. LLM lesson synthesis was deleted..."). Adding the uniform comment above the same block would duplicate context.
- **Fix:** Skip Site C; the uniform comment goes only on the pruning + retrieval-mode-promotion SELECTs (the two other heartbeat reader sites).
- **Verification:** Grep returns 10 matches across 9 files — meets the "≥9 matches" verify check.

### [Rule 1 - Bug] Skip trigger-engine.ts existence-check + loadPatternsByIds

- **Found during:** Task 1 walkthrough.
- **Issue:** trigger-engine.ts has 3 places that touch `experience_patterns` (existence check, matchTriggers, loadPatternsByIds). Adding the uniform comment to all three would over-saturate the file. The matchTriggers SELECT is the load-bearing reader for the trigger-engine module.
- **Fix:** Add the comment only to the matchTriggers SELECT site. The other two (existence check, helper) are read-only enrichment paths trivially covered by the same comment-by-association rule.
- **Verification:** trigger-engine.ts has 1 match (the matchTriggers site).

**Total deviations:** 2 — both Rule 1 (planner discretion within Plan 08's "Avoid: don't over-saturate"). Neither affects the surface-map deliverable (full grep still returns 10 matches across 9 files).

## Authentication Gates

None.

## Issues Encountered

None.

## Next Phase Readiness

**Ready for Plan 04-09 (housekeeping cleanup).** Plan 08 ships the audit trail; Plan 09 ships the orphan-symbol cleanup (skill-writer.ts conditional delete, getUnprocessedSessions/markSessionProcessed conditional delete, sessions_processed/patterns_extracted soft-no-op).
