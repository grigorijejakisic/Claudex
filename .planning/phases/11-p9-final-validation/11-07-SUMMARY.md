---
phase: 11
plan: 07
subsystem: ship
tags: [v4, ship, close, validation-roll-up]
requires: ["11-01", "11-02", "11-03", "11-04", "11-05", "11-06"]
provides: []
affects:
  - CLAUDE.md
  - README.md
  - .planning/STATE.md
  - .planning/ROADMAP.md
  - .planning/v4.1-distribution/STUB.md
key-files:
  created:
    - .planning/phases/11-p9-final-validation/11-V4-VALIDATION.md
    - .planning/phases/11-p9-final-validation/11-CLOSE-SUMMARY.md
    - .planning/v4.1-distribution/STUB.md
  modified:
    - CLAUDE.md (v4 banner; benchmarks reframed as archival; bun run vesna + sc3 added)
    - README.md (v4 banner; benchmark numbers removed per CONTEXT line 192; ship-gate path documented)
    - .planning/STATE.md (v4 SHIPPED + Phase 11 CLOSED)
    - .planning/ROADMAP.md (Phase 10 + 11 marked [x]; v4.0.0 SHIPPED banner)
key-decisions:
  - V4_VALIDATION.md is the single source of truth for "did v4 ship cleanly?" — every SC verdict ties to evidence file
  - CLAUDE.md keeps benchmark numbers as archival-only with explicit reframe; README banner per CONTEXT verbatim
  - v4.1 stub carries forward all open REQUIREMENTS.md items + Phase 11 deferrals; no v4.1 phase pre-planning
requirements-completed: []
duration: ~10 min
completed: 2026-04-30
---

# Phase 11 Plan 07: V4_VALIDATION + Ship + v4.0.0 Tag

Final validation document tying SC#1-#4 to evidence files; CLAUDE.md/README.md updates; v4.1 stub committed; STATE/ROADMAP updated; phase-close commit + v4.0.0 tag + push.

Hard preconditions all cleared:
- 4/4 SC result files present (`11-01-SC3-RESULT.md`, `11-02-SC2-RESULT.md`, `11-03-SC4-RESULT.md`, `11-04-SC1-RESULT.md`)
- Cross-encoder reranker healthy on port 7439 (CUDA)
- DB backup exists for V24 drop
- All SC verdicts: PASS

Final ship-gate test bundle: 45/45 PASS (memory-quality 23 + sc3-cli 3 + cache-stability 12 + ups-budget 4 + migrations-v23 3).

## Self-Check: PASSED

- 11-V4-VALIDATION.md exists on disk with all 4 SC verdicts cited to evidence files
- CLAUDE.md updated (v4 banner + bun run vesna/sc3 + benchmarks reframed as archival)
- README.md updated (v4 banner verbatim from CONTEXT line 79; benchmark numbers removed per CONTEXT line 192)
- .planning/v4.1-distribution/STUB.md exists (carry-forward list populated)
- .planning/STATE.md reflects v4 SHIPPED
- .planning/ROADMAP.md Phase 10 + Phase 11 marked [x]; v4.0.0 banner added
- 11-CLOSE-SUMMARY.md exists
- v4.0.0 tag created on the close commit
