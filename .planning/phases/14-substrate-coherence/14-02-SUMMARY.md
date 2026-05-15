---
phase: 14
plan: "02"
subsystem: schema-migration
tags:
  - schema
  - migration
  - v34
  - project-column-unification
  - wave-1
dependency_graph:
  requires:
    - 14-01 (handoff schema + migrator branch)
  provides:
    - migrateV33toV34 (project_id → project on artifact + transcript_chunk_v6)
    - migrateV34toV33 (reverse migration)
    - V34 schema canonical (fresh DBs come up at project column directly)
  affects:
    - All V17 artifact callers
    - All transcript_chunk_v6 callers
    - production-shape-v32.db fixture
    - 14-06 (picks up from here on memory-md-writer.ts _epoch scope)
tech_stack:
  added: []
  patterns:
    - SQLite ALTER TABLE ... RENAME COLUMN (3.25+; better-sqlite3 ships 3.40+)
    - hasColumn guard for idempotent migrations on pre-existing project column
    - schema_versions column-aware INSERT (handles old DBs missing applied_at_epoch)
    - View audit: drops INSTEAD OF triggers, drops+recreates learnings view, recreates triggers
key_files:
  created:
    - src/tests/core/migration/migrations-v33-v34.test.ts
  modified:
    - src/core/migration-steps.ts (migrateV33toV34 + migrateV34toV33)
    - src/core/migrations.ts (TARGET_USER_VERSION=34, step-table [33], initializeSchema UV guard)
    - src/core/migration/v17-ddl.ts (ARTIFACT_KERNEL_DDL + EXPRESSION_INDEXES_DDL: project_id→project)
    - src/core/migration/v17-runner.ts (INSERT column: project_id→project)
    - src/core/migration/v17-triggers.ts (generateInsertTriggerSql INSERT column)
    - src/core/migration/kind-mapping.ts (KernelCol type + all col entries)
    - src/core/schema.ts (transcript_chunk_v6 DDL + index)
    - src/intelligence/directive-detector.ts (WHERE + INSERT)
    - src/angel/transcript-chunker.ts (INSERT)
    - src/angel/memory-md-writer.ts (SQL + type annotation; project_id only, _epoch untouched)
    - src/ingestion/upsert-chunk.ts (INSERT + ON CONFLICT SET)
    - src/mcp/recall-server.ts (4 query references)
    - scripts/snapshot-fresh-schema.ts (INSERT column)
    - .planning/fixtures/production-shape-v32.db (rebuilt at V34)
    - 15+ test fixture files (SQL column refs + UV assertions)
decisions:
  - "Column-existence guard (hasColumn) added to migrateV33toV34: fresh DBs skip rename because initializeSchema+applyV17DDL already create artifact with project column directly (EXPRESSION_INDEXES_DDL updated to match)"
  - "schema_versions INSERT uses column-aware path: checks for applied_at_epoch column before including it, since old runMigrations paths create schema_versions without that column"
  - "View audit pattern: learnings VIEW SQL contains artifact.project_id reference; migration drops INSTEAD OF triggers, drops view, recreates view with project, recreates triggers from sqlite_master"
  - "TARGET_USER_VERSION bumped to 34 (was 32 at plan start; 33 was 14-01's version)"
  - "initializeSchema UV guard: if artifact has project_id column, run migrateV33toV34; else (fresh DB with project column) just set user_version=34 directly"
metrics:
  duration: "~90 minutes (continuation session; prior session handled tasks 1-6)"
  completed_date: "2026-05-15"
  tasks: 7
  files_changed: 30+
---

# Phase 14 Plan 02: project_id → project Column Unification Summary

Renames `artifact.project_id` and `transcript_chunk_v6.project_id` to `project` via a reversible SQLite ALTER TABLE ... RENAME COLUMN migration (V33→V34), plus a comprehensive caller sweep across all production code and test fixtures.

## What Was Built

The V17 artifact kernel and `transcript_chunk_v6` used `project_id` while every other project-scoped table used `project`. Cross-table queries silently failed. This plan eliminated the discrepancy.

**Migration layer:** `migrateV33toV34` in `migration-steps.ts` guards column existence (idempotent against fresh DBs), audits and recreates indexes/triggers/views that reference `project_id`, bumps UV to 34, and writes to `schema_versions` with a column-aware INSERT. `migrateV34toV33` is the symmetric reverse.

**DDL layer:** `v17-ddl.ts` ARTIFACT_KERNEL_DDL and EXPRESSION_INDEXES_DDL updated so fresh DBs created via `applyV17DDL` already have `project` column directly (no rename needed). `schema.ts` SCHEMA_V3 for `transcript_chunk_v6` updated.

**Caller sweep:** 10 production files updated — `v17-runner.ts`, `v17-triggers.ts`, `kind-mapping.ts`, `directive-detector.ts`, `transcript-chunker.ts`, `memory-md-writer.ts` (project_id scope only), `upsert-chunk.ts`, `recall-server.ts`.

**Test sweep:** 15+ test fixture files updated — SQL `project_id` column references in CREATE TABLE DDL, INSERT statements, SELECT queries, and UV assertions. `production-shape-v32.db` fixture rebuilt at V34.

**New tests:** `migrations-v33-v34.test.ts` — 10 tests covering forward migration, data integrity, index audit, view/trigger audit, round-trip, idempotency, incremental migration path.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] EXPRESSION_INDEXES_DDL in v17-ddl.ts still referenced project_id**
- **Found during:** Task 6 (test failures)
- **Issue:** When `applyV17DDL` runs on a fresh DB, `artifact` is created with `project` column (new ARTIFACT_KERNEL_DDL), but EXPRESSION_INDEXES_DDL still had `ON artifact(project_id, ...)` — failing with "no such column: project_id"
- **Fix:** Updated all 10 index references in EXPRESSION_INDEXES_DDL from `project_id` to `project`
- **Files modified:** `src/core/migration/v17-ddl.ts`
- **Commit:** `60a6ccc`

**2. [Rule 1 - Bug] migrateV33toV34 throwing on fresh DBs (no project_id column to rename)**
- **Found during:** Task 6 (migrations-v32.test.ts UV=34 assertion failing)
- **Issue:** `runMigrations` step-table called `migrateV33toV34` unconditionally; on fresh DBs where `applyV17DDL` already created `artifact` with `project` column, the ALTER TABLE RENAME COLUMN failed
- **Fix:** Added `hasColumn(db, 'artifact', 'project_id')` and `hasColumn(db, 'transcript_chunk_v6', 'project_id')` guards — rename only when old column exists
- **Files modified:** `src/core/migration-steps.ts`, `src/core/migrations.ts`
- **Commit:** `60a6ccc`

**3. [Rule 1 - Bug] schema_versions column mismatch on old upgraded DBs**
- **Found during:** Task 6 (DEBUG_MIGRATIONS revealed "table schema_versions has no column named applied_at_epoch")
- **Issue:** Old DBs created via the V3-V17 runMigrations path have `schema_versions` without `applied_at_epoch` column. The INSERT in migrateV33toV34 failed silently causing step-table to stop at V33
- **Fix:** Added column-existence check before INSERT — uses two-column form if `applied_at_epoch` exists, otherwise falls back to version-only INSERT; wrapped in try/catch as non-critical
- **Files modified:** `src/core/migration-steps.ts`
- **Commit:** `60a6ccc`

**4. [Rule 2 - Missing functionality] View audit for learnings VIEW**
- **Found during:** Task 3 analysis (learnings VIEW SQL references `artifact.project_id`)
- **Issue:** `migrateV33toV34` renames the artifact column but the learnings VIEW DDL cached in sqlite_master still says `artifact.project_id`
- **Fix:** Added view audit block — finds views with project_id in SQL, drops their INSTEAD OF triggers, drops+recreates the view with project, recreates triggers
- **Files modified:** `src/core/migration-steps.ts`
- **Commit:** `011752a`

**5. [Rule 2 - Missing callers] Additional production callers found during broad audit**
- **Found during:** Task 7 sweep
- **Issue:** `upsert-chunk.ts`, `recall-server.ts`, `heartbeat.test.ts`, `v17-ddl.test.ts`, `sessions-indexer.test.ts` had project_id SQL refs not in the plan's explicit file list
- **Fix:** Swept all identified files
- **Files modified:** `src/ingestion/upsert-chunk.ts`, `src/mcp/recall-server.ts` + test files
- **Commit:** `c61e34b`

**6. [Rule 2 - Missing callers] Additional test fixtures found during full test run**
- **Found during:** Task 7 test run
- **Issue:** `backfill-archive.test.ts`, `reranker-fitness-check.test.ts`, `phase-8/10-wire-test.test.ts`, all deliberation-surfacing benchmark tests, `snapshot-fresh-schema.ts`, and `production-shape-v32.db` fixture had project_id SQL refs
- **Fix:** Swept all files; rebuilt production-shape-v32.db fixture via `node scripts/build-production-shape-snapshot.cjs`
- **Files modified:** 10 test/script/fixture files
- **Commit:** `da11cb0`

## Self-Check

**Files exist:**
- [x] `src/tests/core/migration/migrations-v33-v34.test.ts`
- [x] `.planning/fixtures/production-shape-v32.db` (rebuilt)
- [x] `.planning/phases/14-substrate-coherence/14-02-SUMMARY.md`

**Commits exist:**
- [x] `011752a` feat(phase-14-02): update v17-runner, v17-triggers, kind-mapping + add view audit
- [x] `43bbd80` feat(phase-14-02): sweep production callers
- [x] `ab3006f` test(phase-14-02): sweep test fixtures
- [x] `c61e34b` fix(phase-14-02): sweep additional callers found during broad audit
- [x] `60a6ccc` test(phase-14-02): add V33→V34 migration test suite + fix EXPRESSION_INDEXES_DDL + UV bump
- [x] `da11cb0` test(phase-14-02): complete project_id→project sweep + rebuild fixture

## Self-Check: PASSED

All 7 tasks complete. Remaining test failures (36 total) are all pre-existing: llama-* (20), context-pull-cues-p13 (8), phase-5-full-gate (7, missing SUMMARY files), phase-12 float comparison (1). Zero new regressions introduced by this plan.
