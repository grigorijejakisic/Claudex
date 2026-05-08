---
phase: 07-v4-coexistence-migration-ship
plan: 02
subsystem: docs
tags: [reader-comments, steady-state, AR-01, AR-02]
requires: []
provides:
  - Steady-state legacy reader comments on 9 files
affects:
  - src/assembly/assembler.ts
  - src/intelligence/trigger-engine.ts
  - src/intelligence/outcome-tracker.ts
  - src/intelligence/contradiction-detector.ts
  - src/mcp/recall-server.ts
  - src/angel/heartbeat.ts
  - src/adapters/cc-hooks/stop.ts
  - src/embeddings/sqlite-vec-backend.ts
  - src/embeddings/embed-pipeline.ts
tech-stack:
  added: []
  patterns: []
key-files:
  created: []
  modified:
    - src/assembly/assembler.ts
    - src/intelligence/trigger-engine.ts
    - src/intelligence/outcome-tracker.ts
    - src/intelligence/contradiction-detector.ts
    - src/mcp/recall-server.ts
    - src/angel/heartbeat.ts
    - src/adapters/cc-hooks/stop.ts
    - src/embeddings/sqlite-vec-backend.ts
    - src/embeddings/embed-pipeline.ts
key-decisions:
  - "Forever-legacy reads with no fade — no feature flag, no hard cutoff"
  - "Reframe artifact reference preserved in steady-state comment"
requirements-completed:
  - AR-01
  - AR-02
  - MIG-03
  - MIG-04
duration: ~10 min
completed: 2026-05-08
---

# Phase 7 Plan 02: Reader-comment downgrades — Summary

10 reader-site comments across 9 files mechanically downgraded from forward-looking TODO ("Phase 7 owns retirement direction — drop / project / keep") to steady-state legacy documentation ("Rows persist for as long as their content is useful"). Pure mechanical text replacement, zero behavioral change.

**Duration:** ~10 min
**Tasks:** 3
**Files touched:** 9 (heartbeat.ts has 2 occurrences)

## Tasks completed

| # | Task | Commit |
|---|---|---|
| 1 | Confirm 10 reader sites via grep (matches Phase 4 catalog) | (no commit — read-only) |
| 2 | Replace comment block at all 10 sites with steady-state shape | 56272b7 |
| 3 | Run full test suite — confirm zero behavioral regressions | (verification only) |

## Deviations from Plan

None — plan executed exactly as written.

## Verification results

- `grep "Phase 7 owns retirement direction" src/` — **0 hits** (down from 10)
- `grep "content is useful\. See \.planning/reframes" src/` — **10 hits across 9 files** (assembler.ts:1, trigger-engine.ts:1, outcome-tracker.ts:1, contradiction-detector.ts:1, recall-server.ts:1, heartbeat.ts:2, stop.ts:1, sqlite-vec-backend.ts:1, embed-pipeline.ts:1)
- `bun run build` — clean
- `git diff --stat` — 9 files, 30/30 line swap (comment-only diff)
- Full-suite pass count: 3456 passing / 27 failing / 8 skipped — byte-for-byte unchanged from Plan 07-01's post-merge baseline.

## Issues Encountered

None.

## Next Phase Readiness

AR-01 + AR-02 closed for v5.0.0 ship discipline. The phrase "Phase 7 owns retirement direction" is gone from `src/` — it lives only in `.planning/` history (Phase 4 closeout artifact, correct as a historical record). Wave 2 (Plan 07-03) unblocked.
