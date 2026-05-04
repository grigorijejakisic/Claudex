---
phase: 7
plan: 07-03
title: Behavioral A/B scaffold + STATE/ROADMAP/REQUIREMENTS update + phase close
subsystem: planning
tags: [framing, fram-04, fram-05, ab-scaffold, phase-close]
requires: [07-02]
provides: [phase-7-structural-close, phase-7-ab-scaffold]
affects:
  - .planning/phases/07-p6-framing-rewrite-advisory-voice/07-BEHAVIORAL-AB.md
  - .planning/phases/07-p6-framing-rewrite-advisory-voice/07-SUMMARY.md
  - .planning/REQUIREMENTS.md
  - .planning/ROADMAP.md
  - .planning/STATE.md
tech-stack:
  added: []
  patterns: [loose-1-week-ab, investigate-dont-revert-on-weak-evidence]
key-files:
  created:
    - .planning/phases/07-p6-framing-rewrite-advisory-voice/07-BEHAVIORAL-AB.md
    - .planning/phases/07-p6-framing-rewrite-advisory-voice/07-SUMMARY.md
  modified:
    - .planning/REQUIREMENTS.md
    - .planning/ROADMAP.md
    - .planning/STATE.md
key-decisions:
  - Loose 1-week behavioral A/B (no env-flag toggle) per CONTEXT.md
  - Pre-merge baseline notes filled in at merge (frozen reference for end-of-week comparison)
  - End-of-week verdict signed by user, due 2026-05-06
  - Investigate-don't-revert-on-weak-evidence rule — hard revert only on active regressions
  - Phase 7 structural close decoupled from subjective A/B verdict
  - Phase 7.5 unblocked structurally (depends on framing being locked, not on verdict signed)
requirements-completed:
  - FRAM-04
duration: 3 min
completed: 2026-04-29
---

# Phase 7 Plan 03: A/B scaffold + phase close Summary

Ship the loose 1-week behavioral A/B scaffold with pre-merge baseline notes filled in, close FRAM-01..FRAM-04 in REQUIREMENTS.md, update STATE.md and ROADMAP.md to reflect Phase 7 structural close, and write the phase-level `07-SUMMARY.md`. Phase 7.5 (handoff format redesign) now structurally unblocked.

## Execution

- **Duration:** ~3 min
- **Tasks executed:** 4/4
- **Files created:** 2 (`07-BEHAVIORAL-AB.md`, `07-SUMMARY.md`)
- **Files modified:** 3 (`REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`)
- **Atomic commit:** 1 (phase-close commit lands all 5 file changes together)

## What changed

### Task 07-03-01 — `07-BEHAVIORAL-AB.md` scaffold

Created at `.planning/phases/07-p6-framing-rewrite-advisory-voice/07-BEHAVIORAL-AB.md` with four sections per CONTEXT.md spec:

1. **Pre-merge baseline notes** — filled in at merge: imperative-frame surfaces seen frequently (escalation prefixes, `**Correct approach:**`, `STOP NOW`/`Wrap up`/`Do NOT start`), how agent behavior felt under those framings (rule-following on borderline cases, abrupt task-abort under pressure messages), and what the rewrite should subjectively shift (reasoning *from* prior observation, judgment calls on borderline cases, graceful handoff intent).
2. **Week-of-use observation log** — empty template for user fill-in.
3. **End-of-week subjective scoring** — table by session shape (debug / feature work / design discussion / endsession+handoff), evidence levels (weak/medium/strong), regression flags.
4. **Verdict + carve-outs** — `pass/fail/extend` per CONTEXT.md; investigate-don't-revert-on-weak-evidence rule; pre-locked carve-outs from `07-VESNA-RESULT.md` (preamble's `not instructions`, `formatClaudexReadySection`'s meta-instruction).

Mechanism: loose 1-week interpretation locked per CONTEXT.md (no env-flag toggle). Window begins 2026-04-29 (this commit); verdict due 2026-05-06.

### Task 07-03-02 — REQUIREMENTS.md FRAM-01..FRAM-04 close

`.planning/REQUIREMENTS.md`:
- Lines 77-80: FRAM-01..FRAM-04 changed from `[ ]` to `[x]`.
- Line 190 traceability row: `| FRAM-01..FRAM-04 | Phase 7 (P6) | Pending |` → `| FRAM-01..FRAM-04 | Phase 7 (P6) | Complete (07-VESNA gate PASS 8/8 2026-04-29; scaffold pending end-of-week verdict) |`.

FRAM-05 row (`Phase 7 (P6) | Pending`) intentionally unchanged — it tracks the end-of-week subjective verdict, which lands in a follow-up commit signed by user.

### Task 07-03-03 — `07-SUMMARY.md` authored

Phase-level summary at `.planning/phases/07-p6-framing-rewrite-advisory-voice/07-SUMMARY.md` mirroring `06.5-SUMMARY.md`'s shape. Sections: status, goal recap, plans landed, what changed in code (with before/after table), what did NOT change, Vesna gate results (links `07-VESNA-RESULT.md`), behavioral A/B status, tests, LOC delta, carve-outs, follow-up, Phase 7.5 unblocked, atomic commits.

### Task 07-03-04 — STATE.md + ROADMAP.md updates

**STATE.md:**
- `Current Phase` updated from `6.5 (COMPLETE)` to `7 (COMPLETE structural; A/B verdict pending)`.
- `Current Phase Name` updated to `P6 — Framing rewrite (advisory voice)`.
- `Status` rewritten with full Phase 7 close detail.
- `Last Activity Description` rewritten with W1/W2/W3 summary.
- Session Continuity section updated with Phase 7 close + verdict-due date.
- New `### Phase 7 completion notes — 2026-04-29` section appended above the existing 6.5 notes (W1 commits + W2 deviations + W3 deliverables + atomic-commit list + Phase 7.5 unblock note).
- Progress percent advanced from 47% to 50% (top-of-document overview line).

**ROADMAP.md:**
- Top-level checklist row: `- [ ] **Phase 7: P6 — Framing rewrite**` → `- [x] **Phase 7: P6 — Framing rewrite**`.
- Progress table row: `| 7. P6 — Framing rewrite | 0/3 | Planned (2026-04-30) | - |` → `| 7. P6 — Framing rewrite | 3/3 | Complete (structural; verdict pending end-of-week) | 2026-04-29 |`.
- Phase 7 detail section: 3 plan rows changed from `[ ]` to `[x]`; new `**Status:**` paragraph documents structural close + SC#1 PASS at 8/8 + verdict-due date + Phase 7.5 unblock.

## must-haves checklist

- [x] `07-BEHAVIORAL-AB.md` exists with 4 sections, pre-merge baseline filled in, end-of-week sections templated
- [x] `07-VESNA-RESULT.md` exists from Plan 07-02 and is referenced in `07-SUMMARY.md`
- [x] `07-SUMMARY.md` exists, lists all 3 plans, references gate result
- [x] FRAM-01..FRAM-04 all `[x]` in REQUIREMENTS.md
- [x] ROADMAP.md Phase 7 row + detail section reflect 3/3 plans complete
- [x] STATE.md current_phase advanced to 7, completion notes appended
- [x] All 5 file changes (07-BEHAVIORAL-AB.md, 07-SUMMARY.md, REQUIREMENTS.md, ROADMAP.md, STATE.md) in one atomic commit (this plan's phase-close commit)
- [x] Phase 7.5 unblocked per ROADMAP dependency chain

## Deviations from Plan

None - plan executed exactly as written. Pre-merge baseline notes filled in inline; STATE/ROADMAP/REQUIREMENTS edits matched the planned shape; no architectural decisions needed.

**Total deviations:** 0.
**Impact:** None.

## Authentication Gates

None — no external services touched.

## Issues Encountered

None.

## Next Phase Readiness

Phase 7 STRUCTURALLY COMPLETE 2026-04-29. Phase 7.5 (handoff format redesign — hybrid YAML+ADR replacing 372-line schema with ~15 lines) is now unblocked.

Two follow-ups still owed by Phase 7 (not blocking Phase 7.5):
1. **End-of-week behavioral A/B verdict** — due 2026-05-06; user fills in `07-BEHAVIORAL-AB.md` sections 2/3/4, signs the verdict, commits. This commit closes FRAM-05 (subjective dimension) and updates the ROADMAP Phase 7 row's status note from `verdict pending end-of-week` to `verdict signed: pass/fail/extend YYYY-MM-DD`.
2. **STATE.md update with verdict outcome** — appended to the Phase 7 completion notes section.

If verdict is `fail` with active regressions: rollback per Plan 07-03's Rollback section (revert Plan 07-01's commits, mark Phase 7 `[~] partial-corrective-pending`, schedule Phase 7-corrective). If `extend`: no rollback; extend window 3-7 days.
