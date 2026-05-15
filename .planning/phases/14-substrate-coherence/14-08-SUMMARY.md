---
phase: 14
plan: 08
subsystem: assembly
tags: [multi-agent, handoff, session-continuity, back-compat]
dependency_graph:
  requires: []
  provides: [multi-agent-ACTIVE-md-visibility, renderSessionContinuity-directory-api]
  affects: [assembler.ts-P2.5-callsite, sections.test.ts-renderSessionContinuity-block]
tech_stack:
  added: []
  patterns: [filename-regex-enumeration, oldest-first-truncation, byte-identical-back-compat]
key_files:
  created: []
  modified:
    - src/assembly/sections.ts
    - src/assembly/assembler.ts
    - src/tests/assembly/sections.test.ts
decisions:
  - Function signature changed from file-path to directory-path; assembler.ts updated to pass getHandoffsDir() result directly instead of appending /ACTIVE.md
  - Single-file ACTIVE.md path inlined verbatim (not refactored through renderHandoffBlock) to guarantee byte-identical output for AC-5
  - Over-budget truncation uses linear scan per drop (not sort-then-slice) to keep the oldest-first semantics deterministic across equal-epoch ties
metrics:
  duration: ~25min
  completed: 2026-05-15
  tasks: 4
  files: 3
---

# Phase 14 Plan 08: Multi-Agent ACTIVE*.md Visibility Summary

Multi-agent ACTIVE*.md enumeration in `renderSessionContinuity` — filename-regex-driven glob over the handoffs directory, oldest-first budget truncation, byte-identical single-file back-compat.

## What Was Built

`renderSessionContinuity` previously read only the literal `ACTIVE.md` file. Operators running parallel agents (e.g., big-mozzy-v2 with `ACTIVE.md` + `ACTIVE-agent2.md`) had their secondary handoffs permanently invisible at session-start.

### Changes

**`src/assembly/sections.ts`**

Added `listHandoffFiles(handoffsDir)` — a file-local helper that:
- Returns empty array when `handoffsDir` does not exist (non-throwing).
- Uses `fs.readdirSync` filtered by strict lowercase regex `^ACTIVE(?:-([a-z0-9][a-z0-9_-]*))?\.md$`.
- Parses each matched file via `parseHandoffHeader`; skips files that fail validation.
- Returns entries with `{ filePath, agentId, createdAt, content, header }`.
- Sorts: untagged `ACTIVE.md` first (`agentId === null`), then tagged entries by `agentId` ASC.

Rewrote `renderSessionContinuity(handoffsDir?, _sessionsDir?)`:
- Now accepts a directory path (not a specific file path).
- N=0: returns null (back-compat with "no handoff" behavior).
- N=1, untagged: renders byte-identical to pre-Plan-14-08 (AC-5 enforced). Source label `session-continuity (ACTIVE.md)`.
- N=1, tagged: renders with `### Agent <id>` prefix. Source label `session-continuity (ACTIVE*.md)`.
- N>1: renders each as a `### Agent <id>` sub-block (untagged primary has no `### Agent` prefix). One `## Session Continuity` heading. Blocks concatenated with `\n\n`. Source label `session-continuity (ACTIVE*.md)`.
- Over-budget (>1200 chars): drops oldest-by-`created_at_epoch_ms` first, repeats until under cap or single block remains. Remaining single block truncates at 1197 chars + `...`.
- Operator Gates (Fix #3): rendered per-handoff, never cross-agent.

Added `renderHandoffBlock(entry, agentPrefix)` — private helper for multi-entry rendering.

**`src/assembly/assembler.ts`**

Updated P2.5 callsite: passes `getHandoffsDir(params.projectDir)` directly to `renderSessionContinuity` instead of `path.join(getHandoffsDir(...), 'ACTIVE.md')`.

**`src/tests/assembly/sections.test.ts`**

- Updated all existing `renderSessionContinuity` tests to use directory-based calling convention.
- Added `writeAgentHandoff(handoffsDir, agentId, frontmatter, body)` helper.
- Added 10 new test cases (AC-8):
  1. Two handoffs → two `### Agent` blocks under one heading, correct ordering.
  2. Three agents sorted by agentId ASC after untagged primary.
  3. Over-budget drops oldest by `created_at_epoch_ms` first.
  4. Missing `created_at_epoch_ms` sorts as oldest (epoch 0).
  5. `ACTIVE-Foo.md` uppercase agent → ignored (returns null).
  6. `ACTIVE-.md` empty agent → ignored (returns null).
  7. Back-compat byte-identical: single `ACTIVE.md` uses `(ACTIVE.md)` source label, no `### Agent` header.
  8. Each handoff's gates render under its own block, not crossing.
  9. Malformed agent file silently skipped; valid primary still surfaces.
  10. Multi-file source label is `session-continuity (ACTIVE*.md)`.

## Acceptance Criteria Verification

- AC-1: `listHandoffFiles` enumerates all `ACTIVE*.md` matching the strict lowercase regex. Verified by tests 5, 6 (negative) and tests 1-4 (positive).
- AC-2: Multiple handoffs render as `### Agent <id>` sub-blocks under one `## Session Continuity`. Verified by tests 1, 2.
- AC-3: Untagged `ACTIVE.md` renders without `### Agent` prefix; ordering puts it first. Verified by tests 1, 2, 7.
- AC-4: Over-budget drops oldest-by-`created_at_epoch_ms` first; missing epoch sorts as oldest. Verified by tests 3, 4.
- AC-5: Single-file `ACTIVE.md` byte-identical to pre-Plan-14-08 (source label, no `### Agent`, same structure). Verified by test 7.
- AC-6: Each handoff's Operator Gates render under its block only. Verified by test 8.
- AC-7: Malformed handoff files silently skipped. Verified by test 9.
- AC-8: All 10 new tests pass; existing 65 tests still pass (75 total). PASS.
- AC-9: Build clean. Full assembly suite: 214 passing + 3 pre-existing failures in `deliberation-surface.test.ts` caused by plan-14-02's `project_id` column rename already in the working directory — NOT introduced by plan 14-08. No new regressions.

## Deviations from Plan

None — plan executed exactly as written.

The assembler.ts update (not in the plan's `files_modified` list) was a required Rule 3 fix: the caller signature changed from file-path to directory-path, so the call site had to be updated. This is the kind of mechanical follow-through the plan implied in its `key_links` → `assembler.ts call site (P2.5 priority)`.

## Pre-existing Failures (Out of Scope)

`deliberation-surface.test.ts`: 3 failures, all `SqliteError: table transcript_chunk_v6 has no column named project_id`. These are caused by plan 14-02's `v17-runner.ts` + `v17-triggers.ts` changes already present in the working directory (another Wave 1 worker). Not introduced by plan 14-08. Per plan instructions: ignored.

## Self-Check: PASSED

Files exist:
- src/assembly/sections.ts — contains `listHandoffFiles`, `renderHandoffBlock`, `renderSessionContinuity` (directory-based).
- src/assembly/assembler.ts — callsite passes `handoffsDir` not `handoffPath`.
- src/tests/assembly/sections.test.ts — 75 tests, 10 new.

Commits exist:
- `4da8dd3` — feat(phase-14-08): multi-agent ACTIVE*.md visibility in renderSessionContinuity.

Build: PASS (bun run build green, all 26 hooks smoke-tested).
Tests: 75/75 PASS on plan-touched file. Assembly suite: 214/217 pass; 3 pre-existing out-of-scope failures.
