---
phase: 01-storage-layer
plan: 01
subsystem: database
tags: [sqlite, better-sqlite3, wal, fts5, migration, schema]

requires:
  - phase: 00-project-setup
    provides: shared utilities (constants, paths, config)
provides:
  - SQLite connection lifecycle (openDatabase, closeDatabase)
  - Complete v3 schema DDL (9 tables + telemetry + FTS5 + triggers + indexes)
  - v2 migration function (migrateFromV2)
  - v2 database detection (detectV2Database)
  - Database type re-export for downstream consumers
affects: [01-02-observation-store, 01-03-session-store, all-storage-consumers]

tech-stack:
  added: [better-sqlite3]
  patterns: [plain-functions-with-db-param, template-literal-sql-constants, idempotent-schema-creation]

key-files:
  created:
    - src/core/storage.ts
    - src/core/migrations.ts
    - src/tests/core/storage.test.ts
    - src/tests/core/migrations.test.ts

key-decisions:
  - "ATTACH/DETACH outside transaction boundary: SQLite forbids ATTACH inside explicit transactions"
  - "WARM->COLD conversion during copy step (not post-copy): v3 CHECK constraint rejects WARM values"
  - "Non-JSON files_modified converted to '[]' during copy, then fixed from v2 source in step 7"

patterns-established:
  - "Plain functions with db: Database as first param (not class methods)"
  - "Template literal constants for SQL DDL (SCHEMA_V3, TELEMETRY_SCHEMA)"
  - "IF NOT EXISTS on all CREATE for idempotency"
  - "Non-throwing close/detect functions via try/catch"

requirements-completed: [STOR-01, STOR-02, STOR-03, STOR-05, STOR-08]

duration: 5min
completed: 2026-03-10
---

# Phase 1 Plan 1: Database Foundation Summary

**SQLite connection lifecycle with WAL/PRAGMAs, complete v3 schema DDL (9 tables + FTS5 + telemetry), and v2 migration with ATTACH/DETACH and data format conversion**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-10T22:11:33Z
- **Completed:** 2026-03-10T22:17:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- SQLite connection lifecycle with WAL mode, NORMAL sync, 10k cache, and foreign keys enforced
- Complete v3 schema: observations, sessions, pressure_scores, learnings, decisions, thread_state, checkpoint_tracking, schema_versions, checkpoint_meta, telemetry + FTS5 + 3 triggers + 11 indexes
- v2 migration with ATTACH/DETACH, data copy, table archiving, format conversion, and schema version recording
- 22 tests covering PRAGMAs, close behavior, transaction rollback, schema creation, FTS5 sync, v2 migration, and database detection

## Task Commits

Each task was committed atomically:

1. **Task 1: SQLite connection lifecycle and schema DDL** - `5739d69` (feat)
2. **Task 2: Tests for storage lifecycle, schema creation, and v2 migration** - `c043e1b` (test)

## Files Created/Modified
- `src/core/storage.ts` - openDatabase (WAL/PRAGMAs), closeDatabase (non-throwing), Database type re-export
- `src/core/migrations.ts` - initializeSchema (full DDL), migrateFromV2 (9-step migration), detectV2Database (path scanning)
- `src/tests/core/storage.test.ts` - 7 tests for connection lifecycle, PRAGMAs, close, transaction rollback
- `src/tests/core/migrations.test.ts` - 15 tests for schema creation, FTS5 sync, v2 migration, detect

## Decisions Made
- ATTACH/DETACH must be outside the transaction wrapper because SQLite forbids ATTACH inside explicit transactions
- WARM temperature values converted to COLD during the pressure_scores copy step (not post-copy) because the v3 CHECK constraint rejects WARM
- Non-JSON files_modified values converted to '[]' during observation copy, then fixed from v2 source data in migration step 7

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ATTACH/DETACH outside transaction boundary**
- **Found during:** Task 2 (migrateFromV2 tests)
- **Issue:** SQLite does not allow ATTACH DATABASE inside an explicit transaction, causing "database v2 is locked" error
- **Fix:** Moved ATTACH before db.transaction() and DETACH into finally block after transaction
- **Files modified:** src/core/migrations.ts
- **Verification:** All 5 migrateFromV2 tests pass
- **Committed in:** c043e1b (Task 2 commit)

**2. [Rule 1 - Bug] WARM->COLD conversion during copy**
- **Found during:** Task 2 (pressure_scores migration test)
- **Issue:** v3 pressure_scores table has CHECK (temperature IN ('HOT', 'COLD')); v2 data with 'WARM' was silently skipped by INSERT OR IGNORE
- **Fix:** Added CASE expression in copy SQL to convert non-HOT/COLD values to 'COLD'
- **Files modified:** src/core/migrations.ts
- **Verification:** pressure_scores migration test confirms WARM->COLD conversion
- **Committed in:** c043e1b (Task 2 commit)

**3. [Rule 1 - Bug] Non-JSON files_modified handling during copy**
- **Found during:** Task 2 (files_modified migration test)
- **Issue:** v2 observations with comma-separated files_modified fail v3's json_valid CHECK constraint
- **Fix:** Used CASE WHEN json_valid() in copy SQL, then read original values from v2.observations in step 7 for conversion
- **Files modified:** src/core/migrations.ts
- **Verification:** files_modified test confirms comma-separated values converted to JSON arrays
- **Committed in:** c043e1b (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (3 bugs)
**Impact on plan:** All auto-fixes necessary for correctness. The v2 migration steps from the Architecture spec assumed no CHECK constraints on v3 tables during migration; the fixes handle the constraint interactions correctly. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Database foundation is complete; openDatabase + initializeSchema provides the initialized database for all subsequent storage modules
- Plan 01-02 (observation store) and Plan 01-03 (session store) can proceed with db: Database parameter pattern established here
- All 70 project tests pass (22 new + 48 existing)

## Self-Check: PASSED

All files verified on disk. All commits verified in git log.

---
*Phase: 01-storage-layer*
*Completed: 2026-03-10*
