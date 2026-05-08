---
phase: 07-v4-coexistence-migration-ship
plan: 01
subsystem: schema
tags: [migration, V30, learnings, provenance]
requires: []
provides:
  - V30 schema migration
  - learnings.provenance column with closed-enum CHECK
affects:
  - src/core/migration-steps.ts
  - src/core/migrations.ts
  - src/core/schema.ts
  - src/tests/core/migrations-v30.test.ts
  - src/tests/core/migrations-v29.test.ts
  - src/tests/core/migration/v28-trigger.test.ts
tech-stack:
  added: []
  patterns:
    - "Closed-enum CHECK constraint mirroring episodic_events.provenance"
    - "View-mode skip for V17 collapsed tables (new with this plan)"
key-files:
  created:
    - src/tests/core/migrations-v30.test.ts
  modified:
    - src/core/migration-steps.ts
    - src/core/migrations.ts
    - src/core/schema.ts
    - src/tests/core/migrations-v29.test.ts
    - src/tests/core/migration/v28-trigger.test.ts
key-decisions:
  - "migrateV29toV30 skips when learnings is a V17 view (Rule 3 deviation, see below)"
  - "ADD COLUMN DEFAULT 'organic' is sufficient for backfill on better-sqlite3 3.46+; UPDATE WHERE NULL kept as defensive no-op"
requirements-completed:
  - MIG-01
  - MIG-02
  - MIG-04
  - MIG-05
duration: ~25 min
completed: 2026-05-08
---

# Phase 7 Plan 01: V30 schema migration for learnings.provenance — Summary

V30 schema bump lands `learnings.provenance TEXT NOT NULL DEFAULT 'organic' CHECK (provenance IN ('organic','injected','tool_result','environmental'))` with byte-for-byte enum match against `episodic_events.provenance` (V25). Substrate for Plan 07-03's write-path filter.

**Duration:** ~25 min (start 13:03 UTC, end 13:13 UTC)
**Tasks:** 3
**Files touched:** 5 (1 created, 4 modified, plus 1 follow-up bug-fix to migration-steps.ts after view-mode discovery)

## Tasks completed

| # | Task | Commit |
|---|---|---|
| 1 | Implement migrateV29toV30 in migration-steps.ts | 2d486f9 |
| 2 | Register V30 in migrations.ts + add fresh-DB DDL to schema.ts | 2d486f9 |
| 3 | Add migrations-v30.test.ts regression test (8 cases) | 2d486f9 |
| Fix | Skip ALTER on V17 view-mode + update v28-trigger.test.ts assertions | acb8ab9 |

## Deviations from Plan

**[Rule 3 - Blocking] V17 view-mode collision**
- Found during: Task 3 verification (full test suite)
- Issue: Plan assumed `learnings` is always a real table. V17 collapsed `learnings/decisions/experience_patterns/etc.` into VIEWS over the `artifact` kernel. SQLite forbids ALTER on a view. 5 tests broke (`v17-reopen.test.ts`, `migration-v17-v18.test.ts`, `migration-v2v3.test.ts`).
- Fix: `migrateV29toV30` now reads `sqlite_master.type` first; if `learnings` is a view, returns `false` (no-op). View-mode DBs route provenance discipline through the JSON `data` column on the artifact kernel. The write-path filter from Plan 07-03 operates upstream of the INSTEAD OF trigger and is sufficient for the Mem0-trap closure regardless of view-vs-table shape.
- Files modified: `src/core/migration-steps.ts:2018-2022`
- Commit: `acb8ab9`

**[Rule 1 - Bug] V29 + V28-trigger test assertions stale**
- Found during: full-suite run after V30 advanced TARGET_USER_VERSION
- Issue: `migrations-v29.test.ts` and `v28-trigger.test.ts` had `expect(TARGET_USER_VERSION).toBe(29)` and `expect(user_version).toBe(29)` — these became stale once V30 advanced the target.
- Fix: Replaced with `toBeGreaterThanOrEqual(29)` so the V29-specific behavior is tested without coupling to the global target version.
- Files modified: `src/tests/core/migrations-v29.test.ts`, `src/tests/core/migration/v28-trigger.test.ts`
- Verification: full suite at 3456 passing / 27 failures (pre-existing baseline)

**Total deviations:** 2 auto-fixed (1 R3 blocking, 1 R1 bug). **Impact:** plan execution converged on the published baseline; no scope creep.

## Verification results

- `bun run build` — clean (~70ms)
- `bun run vitest run src/tests/core/migrations-v30.test.ts` — 8/8 PASS
- `bun run vitest run src/tests/core/migrations-v29.test.ts` — 7/7 PASS
- `bun run vitest run src/tests/core/migrations.test.ts` — 26/26 PASS
- **Full suite baseline post-merge: 3456 passing / 27 failing / 8 skipped (3491 total).** The 27 failures are the pre-existing baseline (`llama-client`, `llama-server-supervisor`, `phase-5-full-gate`) — unchanged from Phase 6's published baseline. Cite this number in Plan 07-03 as the reference baseline for the "no NEW regressions" gate.

## Issues Encountered

None blocking. View-mode discovery handled in-flight per Rule 3.

## Next Phase Readiness

Plan 07-03 unblocked. Plan 07-02 ran in parallel (same Wave 1) — see 07-02-SUMMARY.md.
