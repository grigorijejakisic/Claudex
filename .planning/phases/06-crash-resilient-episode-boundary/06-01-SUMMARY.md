---
phase: 06-crash-resilient-episode-boundary
plan: 01
subsystem: schema
tags: [schema, migration, v29, episode-boundary, phase-6]

requires: []
provides:
  - migrateV28toV29 function (idempotent)
  - episode_boundary_cursor table (project, session_id PK + 2 indexes)
  - sessions.last_heartbeat_ts INTEGER NULL column
  - sessions.last_jsonl_write_ts INTEGER NULL column
  - V29 fresh-DB DDL in schema.ts
  - V28->V29 regression test (7 assertions)
affects: [phase-6-plan-02, phase-6-plan-03, phase-6-plan-04, phase-6-plan-05]

tech-stack:
  added: []
  patterns:
    - "ALTER TABLE ADD COLUMN idempotency via try/catch (SQLite has no IF NOT EXISTS for columns) — same pattern as .claude/rules/schema-migration.md"
    - "Soft FK without PRAGMA foreign_keys flip: last_close_event_id references episodic_events.id but enforcement is left to application logic, not SQLite. Phase 6 boundary detector uses heartbeat-compare-before-cleanup as the durability invariant."
    - "Fresh-DB DDL + incremental migration converge on identical schema. Both paths (initializeSchema -> SCHEMA_V3 + dedicated cursor DDL block, runMigrations -> migrateV28toV29) end at PRAGMA user_version=29 with the same columns and indexes."

key-files:
  created:
    - src/tests/core/migrations-v29.test.ts
  modified:
    - src/core/migration-steps.ts
    - src/core/migrations.ts
    - src/core/schema.ts
  deleted: []

key-decisions:
  - "last_close_event_id is a soft FK (no PRAGMA foreign_keys flip in V29). Schema-wide FK enforcement is a separate decision deferred per CONTEXT; Phase 6's durability guarantee comes from the heartbeat-compare-before-cleanup invariant in the boundary detector (plan 04), not SQLite-side referential integrity."
  - "Both fresh-DB (schema.ts) and incremental (migration-steps.ts) DDL get the partial index `WHERE last_close_event_id IS NOT NULL` on idx_ebc_close_event. The cursor row's natural state during a live session is last_close_event_id IS NULL; we don't want every active row in that index. Phase 7 retirement / replay queries that JOIN against episodic_events are the index consumers."
  - "Idempotency check uses substring scan of the sessions DDL (`sessionsSql.includes('last_heartbeat_ts')`) rather than PRAGMA table_info. Cheaper, equivalent for our use case (column names are unique and unambiguous), and matches the existing migration-steps.ts pattern."

requirements-completed: [EBD-05]

duration: 3 min
completed: 2026-05-05
---

# Phase 6 Plan 01: V29 schema migration Summary

**V29 lands the Phase 6 boundary substrate: new `episode_boundary_cursor` table for crash-replay state per (project, session_id), plus two nullable INTEGER columns on `sessions` (`last_heartbeat_ts`, `last_jsonl_write_ts`) bumped by lifecycle hooks and the JSONL watcher. Idempotent migrateV28toV29 + fresh-DB DDL in schema.ts converge on identical structure. V29 is the only schema change in Phase 6 — plans 02-05 only INSERT/UPDATE existing tables.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-05T20:39Z
- **Completed:** 2026-05-05T20:43Z
- **Tasks:** 3
- **Files modified:** 3
- **Files created:** 1

## Accomplishments

- `src/core/migration-steps.ts`: `migrateV28toV29` exported (62 lines including docblock). Body:
  - Existence-check guard (returns false if cursor table + both sessions columns already present).
  - `CREATE TABLE IF NOT EXISTS episode_boundary_cursor` with PK (project, session_id), columns last_processed_jsonl_offset/last_processed_event_ts_epoch (INTEGER NOT NULL DEFAULT 0), last_close_event_id (INTEGER NULL).
  - 2 indexes: `idx_ebc_session(session_id)` + partial `idx_ebc_close_event(last_close_event_id) WHERE last_close_event_id IS NOT NULL`.
  - Two `ALTER TABLE sessions ADD COLUMN` (last_heartbeat_ts, last_jsonl_write_ts) wrapped in try/catch.
- `src/core/migrations.ts`:
  - `TARGET_USER_VERSION` bumped 28 -> 29.
  - `migrateV28toV29` added to import list (line 49 area).
  - `[28, () => { migrateV28toV29(db); }]` appended to migrations array.
  - New fresh-DB block in initializeSchema: `if (currentUv < 29) { migrateV28toV29(db); db.pragma('user_version = 29'); }`.
- `src/core/schema.ts`:
  - sessions DDL gets `last_heartbeat_ts INTEGER` and `last_jsonl_write_ts INTEGER` appended.
  - `episode_boundary_cursor` CREATE TABLE + 2 indexes block added immediately after the sessions index.
- `src/tests/core/migrations-v29.test.ts` (new, 88 lines):
  - 7 vitest assertions: TARGET=29, fresh-DB cursor table exists, fresh-DB sessions columns exist, user_version=29 after init, idempotency, PK enforcement, last_close_event_id NULL allowed.

## Task Commits

1. `7220a7c` — feat(06-01): add migrateV28toV29 with episode_boundary_cursor + sessions liveness columns
2. `6390efc` — feat(06-01): register V29 migration + fresh-DB DDL for cursor table and sessions columns
3. `07ffbad` — test(06-01): V29 migration regression test (7 assertions)

## Verification Results

- `bun run build`: clean.
- `bun run test src/tests/core/migrations-v29.test.ts`: 7/7 pass (58ms).
- `bun run test src/tests/core/migrations*.test.ts`: 58/58 pass across 6 files (V19, V20, V21, V22, V23, full migrations).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- Plan 02 unblocked: chokidar dep + jsonl-watcher / pid-liveness / thresholds modules can now reference `episode_boundary_cursor` and `sessions.last_jsonl_write_ts` columns directly (schema is in production).
- Plans 03-05 unblocked sequentially via wave dependencies.

Ready for **06-02-PLAN.md** (chokidar runtime dep + watcher modules).
