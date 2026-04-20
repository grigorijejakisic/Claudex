---
phase: 02-p1-artifact-table-unification
plan: 02-03
subsystem: database
tags: [migration, v17, stale-review, markdown, gate]

requires:
  - phase: 01-p0-crystallization
    provides: Decision 8 + STOR-05 (stale-review flow spec + keyword list)

provides:
  - scanStaleRows(db) — heuristic keyword scan returning StaleMatch[]
  - writeStaleReview / parseStaleReview / getStaleIds — round-trip markdown I/O
  - migrate:v17:stale-scan CLI stub

affects:
  - 02-05-migration-runner (calls parseStaleReview + getStaleIds inside Phase B tx)

tech-stack:
  added: []
  patterns:
    - "Git-tracked review file as authoritative handshake between heuristic + human + migration runner."
    - "Strict parser: missing file or malformed line throws with actionable message (aborts migrate:v17:apply)."

key-files:
  created:
    - src/core/migration/v17-stale-scan.ts
    - src/core/migration/stale-review-parser.ts
    - src/tests/core/migration/v17-stale.test.ts
  modified:
    - src/cli/migrate.ts (add migrate:v17:stale-scan subcommand routing + entry)

key-decisions:
  - "Keyword list locked at exactly the 3 CONTEXT §specifics strings. scanStaleRows case-insensitive via SQLite LIKE on ASCII; test asserts 'gemma 4 31b' lowercase also matches."
  - "Heuristic matches: decision defaults to stale; human flips to keep to veto. Manual additions: decision must be stale (no 'keep' in manual section, parser rejects)."
  - "contentPreview collapses whitespace (\\s+ → single space) and caps at 120 chars so the markdown file stays grep-friendly and PR-reviewable."

patterns-established:
  - "File format is regex-matched line by line. Header + section headings + HTML comments + blank lines are all skipped. Only `- id=... | status=... | content=...` lines are parsed."
  - "Section tracking: parser only accepts entries after it has encountered the corresponding heading — bare entries outside any section throw."

requirements-completed:
  - STOR-05

duration: 6 min
completed: 2026-04-20
---

# Phase 2 Plan 02-03: Stale-Review Flow Summary

**Two-phase git-tracked review handshake: heuristic scan for 3 CONTEXT-spec keywords produces a human-reviewable markdown file; strict parser surfaces the `stale`-flagged legacy ids to the migration runner's Phase B tx.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-20T09:45:40Z
- **Completed:** 2026-04-20T09:51:20Z
- **Tasks:** 5
- **Files modified:** 4 (3 created, 1 edited)

## Accomplishments

- `scanStaleRows(db)` returns `StaleMatch[]` with deterministic `legacyId ASC` ordering, tolerant of the legacy table being absent.
- `writeStaleReview` emits the canonical markdown with header, heuristic section, manual-additions section, and placeholder comment.
- `parseStaleReview` is strict: missing file → `"missing"` error; malformed line → error with line number; manual-section entry with `status=keep` → error (manual-only-stale invariant).
- `getStaleIds` resolves heuristic `stale` + manual `stale` into a `Set<number>` ready for `UPDATE artifact SET status='stale' WHERE id IN (...)` inside Phase B.
- CLI subcommand `migrate:v17:stale-scan` produces the file from a live DB for the pre-migration review commit.
- 16 Vitest cases — all green.

## Task Commits

1. **Tasks 03-01-01 through 03-01-04** (v17-stale-scan.ts + stale-review-parser.ts + CLI stub + tests, bundled) — `8908c5c` (feat)
2. **Task 03-01-05** (pre-commit the stale-review.md for the live-DB P1 run) — DEFERRED to Plan 02-05's dry-run pass. Plan explicitly states: "Plan author does NOT commit a hand-crafted stale-review.md here — that is Plan 02-05's responsibility during the first dry-run on the real DB."

**Plan metadata:** (pending — committed with SUMMARY.md)

## Files Created/Modified

- `src/core/migration/v17-stale-scan.ts` — 72 lines. `STALE_KEYWORDS` constant + `scanStaleRows()`.
- `src/core/migration/stale-review-parser.ts` — 175 lines. Writer + strict parser + `getStaleIds()`.
- `src/tests/core/migration/v17-stale.test.ts` — 210 lines. 16 cases.
- `src/cli/migrate.ts` — +35 lines. `v17StaleScanMain` + routing for `migrate:v17:stale-scan`.

## Decisions Made

- "Case-insensitive" at the scan layer means Node-side `toLowerCase()` comparison for `triggers[]` population (the SQL `LIKE` is already ASCII-case-insensitive by default). This lets the test assert `'gemma 4 31b'` (all lowercase) matches `'Gemma 4 31B'`.
- Parser rejects HTML comments only when they start with `<!--` — content lines embedding `<!--` inside quoted content would still match the line regex, so no false rejection for edge content. (No such content exists in-spec.)
- Manual-section entries have no `triggers=[...]` field; regex makes that group optional.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixture cross-contamination**
- **Found during:** Task 03-01-04 (running the test suite)
- **Issue:** The original "produces preview with newlines collapsed and 120-char cap" test seeded two PCC rows into the same in-memory DB (`seedPcc` called twice). That produced 2 matching rows, not the expected 1, because both rows contained the keyword.
- **Fix:** Removed the first unrelated seed call — the test now seeds only the row whose preview shape it asserts against.
- **Files modified:** src/tests/core/migration/v17-stale.test.ts
- **Verification:** `bun run test -- v17-stale` → 16/16 green.
- **Committed in:** 8908c5c (same commit as the rest of Plan 02-03)

---

**Total deviations:** 1 auto-fixed (Rule 1 bug in test fixture).
**Impact on plan:** Trivial — test-only fix, no production-code impact.

## Issues Encountered

None beyond the auto-fixed test above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Wave 1 is now complete (02-01, 02-02, 02-03 all shipped and green).
- Wave 2 is unblocked: Plan 02-04 (DDL + triggers) can consume `KIND_MAPPING` from 02-01; Plan 02-05 (runner) can consume `createAndVerifyBackup` from 02-02 and `parseStaleReview` + `getStaleIds` from 02-03.
- No known blockers for Wave 2 sequential execution.

## Self-Check

- File on disk: `[ -f .planning/phases/02-p1-artifact-table-unification/02-03-stale-review-SUMMARY.md ]` — verified post-write.
- Git commit present: `git log --grep="02-03"` returns `8908c5c feat(02-03): stale-review scan + markdown round-trip + CLI stub`.
- All 16 tests pass: `bun run test -- v17-stale` green.
- Build clean: `bun run build` green.

## Self-Check: PASSED

---
*Phase: 02-p1-artifact-table-unification*
*Completed: 2026-04-20*
