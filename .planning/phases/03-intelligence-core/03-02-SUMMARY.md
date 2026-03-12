---
phase: 03-intelligence-core
plan: 02
subsystem: intelligence
tags: [decision-capture, thread-tracker, learnings-promoter, regex, gist-extraction]

requires:
  - phase: 03-01
    provides: "3-tier semantic dedup (isDuplicate, findDuplicate, normalizeForDedup)"
  - phase: 01
    provides: "Storage layer (decisions CRUD, thread CRUD, learnings CRUD)"
provides:
  - "Stage 1 model-agnostic decision capture with 4-tier regex extraction"
  - "Thread tracker with exchange accumulation, gist extraction, summary construction"
  - "Cross-session learnings promoter with dedup and 50-per-project cap"
affects: [hook-wiring, checkpoint-engine, assembly-pipeline]

tech-stack:
  added: []
  patterns: [tier-based-regex-extraction, stateful-tracker-class, promotion-upsert]

key-files:
  created:
    - src/intelligence/decision-capture.ts
    - src/intelligence/thread-tracker.ts
    - src/intelligence/learnings-promoter.ts
    - src/tests/intelligence/decision-capture.test.ts
    - src/tests/intelligence/thread-tracker.test.ts
    - src/tests/intelligence/learnings-promoter.test.ts
  modified: []

key-decisions:
  - "Tier 3 rejection regex uses lookahead instead of trailing word boundary (comma/apostrophe in patterns)"
  - "Thread tracker collapses tool entries in key_exchanges (only user/agent roles persisted)"
  - "Topic set once per session (not overwritten by subsequent messages)"
  - "Cap enforcement uses distinct test data to avoid Jaccard dedup false positives in tests"

patterns-established:
  - "Decision capture: Tier 1-4 regex -> filler rejection -> code fence skip -> dedup -> store"
  - "Thread tracker: after_tool accumulates, after_turn flushes with gist extraction"
  - "Learnings: findDuplicate -> promote existing or insert new -> cap enforcement"

requirements-completed: [INTL-01, INTL-04, INTL-05, INTL-06, INTL-07, INTL-09]

duration: 4min
completed: 2026-03-12
---

# Phase 03 Plan 02: Decision Capture, Thread Tracker, Learnings Promoter Summary

**Stage 1 decision capture, thread tracker, and learnings promoter — the intelligence core**

## Performance

- **Duration:** 4 min
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- Decision capture: 4-tier model-agnostic regex (confirmation, direction, rejection, explicit)
- Filler rejection and code fence skip prevent false positives
- Thread tracker: after_tool accumulation, after_turn flush with gist extraction
- Rolling 8-entry key_exchanges window with FIFO eviction
- Learnings promoter: semantic dedup, promotion increment, 50-per-project cap
- 69 new tests (28 + 27 + 14), all 96 intelligence tests passing, 326 total

## Task Commits

1. **Task 1: Stage 1 decision capture** - `93c5c73` (feat, combined commit)
2. **Task 2: Thread tracker** - `93c5c73` (feat, combined commit)
3. **Task 3: Learnings promoter** - `93c5c73` (feat, combined commit)

## Files Created/Modified
- `src/intelligence/decision-capture.ts` - 4-tier regex extraction with dedup
- `src/intelligence/thread-tracker.ts` - Stateful tracker with gist extraction and summary
- `src/intelligence/learnings-promoter.ts` - Promotion flow with cap enforcement
- `src/tests/intelligence/decision-capture.test.ts` - 28 tests for all tiers, filler, dedup
- `src/tests/intelligence/thread-tracker.test.ts` - 27 tests for accumulation, gists, window
- `src/tests/intelligence/learnings-promoter.test.ts` - 14 tests for dedup, promotion, cap

## Deviations from Plan

- Combined all 3 tasks into a single commit (all independent files, no dependencies between tasks)
- Tier 3 rejection regex uses lookahead `(?=\s|$)` instead of `\b` to handle patterns ending with punctuation

## Self-Check: PASSED

All 6 files verified present. Commit 93c5c73 verified in git log.

---
*Phase: 03-intelligence-core*
*Completed: 2026-03-12*
