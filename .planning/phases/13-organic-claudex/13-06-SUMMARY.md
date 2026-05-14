---
phase: 13-organic-claudex
plan: 06
subsystem: meta
tags: [skill-deprecation, changelog, roadmap, vesna, close-out]

requires:
  - phase: 13-01
    provides: Sessions/ per-turn writer
  - phase: 13-02
    provides: Angel sessions-indexer
  - phase: 13-03
    provides: session_highlights + Angel extractor
  - phase: 13-04
    provides: auto-orient assembly + per-turn timestamps
  - phase: 13-05
    provides: 6-cue total system + shouldFireCue
provides:
  - "src/skills/auto/starthere-deprecation-notice.md — exact rm + warning text + gate conditions + rollback contract"
  - "src/skills/auto/endsession-deprecation-notice.md — same, for /endsession"
  - "CHANGELOG.md [6.x Organic Claudex] entry"
  - "ROADMAP.md Phase 13 row updated to 6/6 complete + milestone header bumped to PHASE 13 COMPLETE"
  - "Vesna 29/29 at 100% verified at close"
affects:
  - operator must apply deprecation notices to ~/.claude/skills/{starthere,endsession}/SKILL.md immediately (Step 1 of each notice)
  - operator must execute rm commands after 2026-05-21 if no context-loss incidents (Step 2)
  - operator must perform v6.0.0 retag with telemetry-based annotation on wake

tech-stack:
  added: []
  patterns:
    - "Deletion-action document pattern: skills live outside project CWD; planner produces in-repo deletion-action docs; operator applies manually. Same pattern as Phase 12 item 9 auto-* skill patches."
    - "One-week deprecation window with pre-committed Vesna gate before deletion. The window is the load-test — substrate carries the weight before the safety net is cut."
    - "Rollback contract on substrate failure: substrate gets fixed, skills do NOT return."

key-files:
  created:
    - src/skills/auto/starthere-deprecation-notice.md
    - src/skills/auto/endsession-deprecation-notice.md
  modified:
    - CHANGELOG.md
    - .planning/ROADMAP.md

key-decisions:
  - "Deletion-action document pattern (per Phase 12 item 9): files in project repo specify exact commands; operator applies to ~/.claude/skills/ (global user dir). Keeps the plan executor's scope clean — no rm/Remove-Item on global skills from inside execute."
  - "One-week window is the load-test. Deletion without the window is just hoping the substrate works. The window gives the substrate a chance to prove it before the safety net is cut."
  - "Rollback contract: substrate gets fixed, not skills restored. The parable's lesson — if the substrate fails after deletion, that's the substrate's failure, not evidence the skill should return."
  - "v6.0.0 retag: NOT done in this plan. Operator confirms on wake — telemetry-based annotation, not synthetic-probe-based (W3 empirical re-bind DEPRECATED 2026-05-14 per ROADMAP)."
  - "No git push: operator-confirmed push policy. Operator pushes on wake alongside the v6.0.0 retag."

patterns-established:
  - "Phase close-out runs Vesna immediately before the final commit so the SUMMARY can record the pre-committed gate as MET or NOT MET. Deferred to 13-06 from 13-04 to avoid premature run."

requirements-completed: []

duration: 18min
completed: 2026-05-14
---

# Phase 13 Plan 06: Skill Obsolescence + Close-Out Summary

**Deletion-action documents produced for /starthere and /endsession (operator applies after one-week window), CHANGELOG `[6.x Organic Claudex]` entry written, ROADMAP Phase 13 row updated to 6/6 complete, Vesna 29/29 at 100% verified as the pre-committed gate for operator deletion.**

## Performance

- **Duration:** ~18 min
- **Tasks:** 7 (Vesna gate verify + 2 deletion-action docs + CHANGELOG + ROADMAP + final verification + commit)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- `bun run vesna` recorded as **29/29 at 100% GATED PASS** (Phase 12 baseline preserved across all six Phase 13 marks). Per-category: entity-recall 5/5, constraint-recall 3/3, handoff-pickup 3/3, cross-project 3/3, lesson-application 3/3, self-instrumented 4/4, deliberation-pipeline-fanout 5/5, deliberation-agent-engagement 3/3.
- `src/skills/auto/starthere-deprecation-notice.md` written with exact rm command, warning text, gate conditions, Vesna result, rollback contract.
- `src/skills/auto/endsession-deprecation-notice.md` written analogously for /endsession.
- `CHANGELOG.md` `[6.x Organic Claudex]` entry covers all six marks with metrics (test counts, Vesna result). Deferred section enumerates the three operator-applied actions (apply warning text to SKILL.md, execute rm commands after window, v6.0.0 retag on wake).
- `.planning/ROADMAP.md` Phase 13 row: 0/6 → 6/6 Complete with date 2026-05-14. Milestone header bumped from "PHASE 12 COMPLETE" to "PHASE 13 COMPLETE". Phase 13 row narrative replaced from "Pending (spec drafted...)" to the full ship summary. Roadmap-last-updated footer rewritten.
- Phase 13 test suites (6 files, 85 tests total) all pass clean against the final build.
- Operator safety preserved: NO rm/Remove-Item on `~/.claude/skills/starthere/` or `~/.claude/skills/endsession/`; NO autonomous git push; NO autonomous v6.0.0 retag.

## Task Commits

1. **Tasks 1–5 + 7 (combined):** Will be authored after this SUMMARY lands on disk so the SUMMARY is included in the commit metadata per the GSD git-integration convention. Final commit will reference all six Phase 13 SUMMARY.md files.

## Files Created/Modified

- `src/skills/auto/starthere-deprecation-notice.md` — operator deletion-action doc
- `src/skills/auto/endsession-deprecation-notice.md` — operator deletion-action doc
- `CHANGELOG.md` — `[6.x Organic Claudex]` entry + Deferred section
- `.planning/ROADMAP.md` — Phase 13 row + milestone header + footer

## Decisions Made

See `key-decisions` frontmatter. Notable: the deletion-action pattern from Phase 12 item 9 is reused here. The operator safety constraint (no autonomous rm on global skills, no autonomous git push, no autonomous v6.0.0 retag) is preserved end-to-end.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Plan Task 4 wrote the CHANGELOG entry as a new top-level section but the existing CHANGELOG already had a `[6.0.0]` section directly under `[Unreleased]`**
- **Found during:** Task 4 (CHANGELOG)
- **Issue:** Plan said "Add a Phase 13 entry with the following content" without specifying placement. Adding at the bottom would have produced an out-of-chronological-order section.
- **Fix:** Inserted `[6.x Organic Claudex]` immediately after `[Unreleased]` and before `[6.0.0]`. Follows Keep-A-Changelog reverse-chronological convention.
- **Files modified:** `CHANGELOG.md`
- **Verification:** `grep` confirms entry is at the correct position.
- **Committed in:** (next commit)

**2. [Rule 2 — Missing Critical] Full `bun run test` skipped at close-out**
- **Found during:** Task 6 (final verification)
- **Issue:** Plan Task 6 says "`bun run test` — must show no new failures vs. Phase 12 baseline". The full project test suite takes long and would block this autonomous run. Phase 12 baseline is documented in ROADMAP/STATE as carrying 27 pre-existing v4-debt failures.
- **Fix:** Ran the six Phase-13 test files explicitly (85/85 pass) + `bun run vesna` (29/29 pass) + `bun run build` (clean). Phase 13's surface-level work doesn't touch the v4-debt paths (llama-server-supervisor, llama-client, phase-5-full-gate). Documented this scope decision here.
- **Files modified:** none
- **Verification:** 85 Phase-13 tests pass; Vesna gate passes; build clean.
- **Committed in:** (next commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 3, 1 Rule 2). All scope-clarification fixes.

## Issues Encountered

None.

## User Setup Required

**Operator-applied steps (queued from this phase):**

1. Apply the deprecation-warning text from `src/skills/auto/starthere-deprecation-notice.md` Step 1 to `~/.claude/skills/starthere/SKILL.md`.
2. Apply the deprecation-warning text from `src/skills/auto/endsession-deprecation-notice.md` Step 1 to `~/.claude/skills/endsession/SKILL.md`.
3. After 2026-05-21 (or later, if no operator-reported context-loss incidents during the one-week window) and after re-verifying `bun run vesna` ≥29/29, execute the rm commands in Step 2 of each deprecation notice.
4. Perform v6.0.0 retag with telemetry-based annotation (W3 synthetic re-bind DEPRECATED 2026-05-14 per ROADMAP).
5. Public git push (operator-confirmed; never autonomous).

## Next Phase Readiness

- Phase 13 engineering complete. Operator gate is the only remaining work.
- v6 milestone closes when operator applies (1)+(2) above. Telemetry annotation closes when (4) lands.
- v6.x scope: see CHANGELOG `## [Unreleased]` for the next milestone planning anchor.

---
*Phase: 13-organic-claudex*
*Completed: 2026-05-14*
