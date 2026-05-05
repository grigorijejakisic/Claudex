---
phase: 04-angel-reduction
plan: 01
subsystem: database
tags: [sqlite, migration, schema, v28, experience-patterns, trigger, layer-3-cutoff, phase-4]

requires:
  - phase: pre-phase-4
    provides: V27 schema baseline (three-tier corpus_origin partition) — the substrate this V28 step builds on
provides:
  - V28 marker bump (TARGET_USER_VERSION 27 → 28) acknowledging the Phase 4 cutoff contract
  - per-connection temp.session_pragmas (key/value) sidecar created in initializeSchema
  - per-connection TEMP TRIGGER experience_patterns_insert_blocked raising RAISE(FAIL) unless allow_legacy_pattern_insert pragma is set
  - allowLegacyPatternInsert / blockLegacyPatternInsert helpers in src/tests/helpers/test-db.ts
  - Camp III fixture pragma calls applied in 8 existing test files
  - 9-case vitest suite verifying trigger + pragma + idempotency + FTS5-sync regression
affects: [04-02, 04-03, 04-04, 04-05, 04-06, 04-07, 04-08, 04-09, phase-7-retirement]

tech-stack:
  added: []
  patterns:
    - "TEMP-trigger + TEMP-table per-connection guard against legacy table writes (SQLite forbids permanent triggers from referencing temp objects, so the gate must be installed at connection-open time)"
    - "Generic session_pragmas key/value sidecar reusable by Phase 7 retirement work for other legacy tables (learning, decision, transcript_chunk) with different keys"
    - "Marker-only V28 migration: no DDL, just user_version bump; the actual gating mechanism lives in initializeSchema where it can install per-connection temp objects"

key-files:
  created:
    - src/tests/core/migration/v28-trigger.test.ts
  modified:
    - src/core/migration-steps.ts
    - src/core/migrations.ts
    - src/tests/helpers/test-db.ts
    - src/tests/adapters/cc-hooks/experience-warning-triggers.test.ts
    - src/tests/assembly/worker-context.test.ts
    - src/tests/embeddings/embed-pipeline.test.ts
    - src/tests/integration/experience-patterns-e2e.test.ts
    - src/tests/intelligence/experience-patterns.test.ts
    - src/tests/intelligence/outcome-tracker.test.ts
    - src/tests/intelligence/trigger-engine.test.ts
    - src/tests/mcp/recall-server.test.ts

key-decisions:
  - "TEMP TRIGGER, not permanent trigger. SQLite forbids a permanent-schema trigger from referencing temp.session_pragmas. The trigger is installed by code in initializeSchema on every connection open, so production opens, test createTestDb, and any future direct openDatabase consumer all get gated identically."
  - "Marker-only migrateV27toV28 (no DDL body). The user_version bump 27 → 28 is the on-disk acknowledgment that this DB has accepted the Phase 4 cutoff. The gating DDL must NOT live in a migration step because TEMP objects do not persist across re-opens."
  - "Install order: TEMP table + TEMP trigger creation runs at the END of initializeSchema, AFTER experience_patterns has been created (SCHEMA_V3 / post-V17 path). hasTable('experience_patterns') guard skips installation when the table is replaced by a V17 view."
  - "Camp III fixture pragma additions land in Plan 01, not deferred to a later plan, because (a) the test-db helpers ship in Plan 01 and (b) without the calls 95 existing tests fail under V28, blocking Plans 02-09."
  - "Did not bump SCHEMA_VERSION (300) in src/shared/constants.ts — it is the semantic version constant, not a TARGET_USER_VERSION mirror. Phase 1 Plan 01 set the same precedent."

patterns-established:
  - "Three-layer cutoff signal for legacy-table writes: (1) JSDoc tombstone on the writer function, (2) regression-guard test asserting writer is not called, (3) schema-level TEMP-trigger raising RAISE(FAIL) on default INSERT. Layer 3 ships in Plan 01; Layers 1+2 ship in Plans 04 + 06."
  - "session_pragmas as a generic per-connection override sidecar: rather than a table-specific override (legacy_insert_overrides_for_experience_patterns), use a key/value table where future Phase 7 retirement work for other legacy tables can register additional keys without schema churn."

requirements-completed: [AR-03]

duration: 14 min
completed: 2026-05-05
---

# Phase 4 Plan 01: V28 marker migration + TEMP-trigger cutoff on experience_patterns

**V28 marker (user_version 27 → 28) plus a per-connection TEMP TABLE + TEMP TRIGGER pair installed in `initializeSchema` that blocks any INSERT into `experience_patterns` unless the test/migration caller opts in via `temp.session_pragmas`.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-05-05T16:03:36Z
- **Completed:** 2026-05-05T16:17:16Z
- **Tasks:** 4 (per Plan 01 task layout)
- **Files modified:** 11
- **Files created:** 1

## Accomplishments

- `migrateV27toV28` registered as a marker-only migration (no DDL body); `TARGET_USER_VERSION` bumped 27 → 28; runMigrations step-table + initializeSchema fresh-DB tail both updated.
- `initializeSchema` now installs `temp.session_pragmas (key TEXT PRIMARY KEY, value TEXT)` and the `experience_patterns_insert_blocked` BEFORE INSERT TEMP TRIGGER on every connection (guarded by `hasTable('experience_patterns')` so V17 view-active DBs are correctly skipped).
- `allowLegacyPatternInsert(db)` / `blockLegacyPatternInsert(db)` exported from `src/tests/helpers/test-db.ts` with JSDoc explaining the Phase 4 contract.
- New test file `src/tests/core/migration/v28-trigger.test.ts` ships 9 passing cases covering: TARGET_USER_VERSION reach, trigger presence, temp-table presence, INSERT-blocked default, INSERT-allowed-with-pragma, re-block-after-clear, fresh-connection re-block (per-connection TEMP semantics), runMigrations idempotency, and FTS5-sync regression on the existing AFTER INSERT trigger.
- 8 existing test files patched with `allowLegacyPatternInsert(db)` calls in their `beforeEach` (or local `createDb` helpers) so the V28 trigger does not regress legitimate seeding paths: experience-warning-triggers, worker-context, embed-pipeline, experience-patterns-e2e, experience-patterns, outcome-tracker, trigger-engine, recall-server.
- Full test suite: 3438 / 3473 passing (vs 3370 / 3473 baseline pre-fixture-patch); 27 pre-existing failures remain in `llama-client`, `llama-server-supervisor`, and `phase-5-full-gate` test files — verified pre-existing via `git stash` + re-run on master baseline (none related to V28 or Plan 01 work).

## Task Commits

Each task was committed atomically:

1. `8e31f63` — feat(04-01): V28 marker migration + TEMP-trigger guard on experience_patterns
   - migrateV27toV28 (no-op marker), TARGET_USER_VERSION bump, runMigrations step-table entry, initializeSchema fresh-DB tail block, TEMP table + TEMP trigger installation in initializeSchema.
2. `35d1d9d` — feat(04-01): add allowLegacyPatternInsert / blockLegacyPatternInsert helpers
   - Two test-db exports plus a Phase 4 JSDoc note at the top of the file.
3. `83edf39` — test(04-01): V28 trigger / pragma / idempotency / FTS5 sync regression suite
   - 9-case vitest file at `src/tests/core/migration/v28-trigger.test.ts`.
4. `731bc99` — test(04-01): apply allow_legacy_pattern_insert pragma in Camp III fixtures
   - 8 test files patched (~31 net insertions).

## Deviations from Plan

### [Rule 1 - Bug] TEMP TRIGGER, not permanent trigger

- **Found during:** Task 2 verification (running `v28-trigger.test.ts` after wiring TEMP table into initializeSchema and adding the trigger DDL inside `migrateV27toV28`).
- **Issue:** SQLite refuses to create the trigger: `trigger experience_patterns_insert_blocked cannot reference objects in database temp`. Plan 01 specifies the trigger MUST WHEN-clause-check `temp.session_pragmas`, but a permanent-schema trigger is forbidden from doing so.
- **Fix:** Trigger created as a **TEMP TRIGGER** alongside the TEMP TABLE inside `initializeSchema()`. `migrateV27toV28` becomes a no-op marker that bumps `user_version` to 28 (the on-disk acknowledgment that this DB has accepted the Phase 4 cutoff). The TEMP trigger is re-installed on every connection open, which matches the per-connection scope CONTEXT.md requires.
- **Files modified:** `src/core/migration-steps.ts`, `src/core/migrations.ts`, `src/tests/core/migration/v28-trigger.test.ts` (test query updated to `sqlite_temp_master`).
- **Verification:** All 9 v28-trigger tests pass; FTS5 AFTER INSERT trigger still fires on permitted INSERTs.
- **Commit:** `8e31f63`

### [Rule 3 - Blocking] Camp III fixture pragma additions in 8 test files

- **Found during:** Task 4 verification (running full suite after the new test passed).
- **Issue:** 95 existing tests across 8 files seed `experience_patterns` rows directly (`createPattern()` or raw INSERT). Without the pragma helper applied, those tests trip the V28 trigger and fail — blocking Plans 02-09 from running on a green suite.
- **Fix:** `beforeEach`/`createDb`-helper calls in 8 files now invoke `allowLegacyPatternInsert(db)` (or the equivalent inline INSERT into `temp.session_pragmas` when the file uses a local createDb).
- **Files modified:** `src/tests/adapters/cc-hooks/experience-warning-triggers.test.ts`, `src/tests/assembly/worker-context.test.ts`, `src/tests/embeddings/embed-pipeline.test.ts`, `src/tests/integration/experience-patterns-e2e.test.ts`, `src/tests/intelligence/experience-patterns.test.ts`, `src/tests/intelligence/outcome-tracker.test.ts`, `src/tests/intelligence/trigger-engine.test.ts`, `src/tests/mcp/recall-server.test.ts`.
- **Verification:** Pattern-using tests pass; suite drops from 95 → 0 V28-related failures. The work is the "Test/fixture impact: ~1 line in beforeEach for [those files]" item explicitly recorded in `04-CONTEXT.md`'s Test Posture section.
- **Commit:** `731bc99`

### [Rule 1 - Bug] FTS5 MATCH query token in v28-trigger.test.ts

- **Found during:** Task 4 verification.
- **Issue:** The plan's exact verification suggestion used `MATCH 'unique-trigger-text'`, which the FTS5 tokenizer splits on hyphens into three tokens. The middle token `trigger` is interpreted as a column reference (because the FTS5 table has a `trigger_context` column), giving `no such column: trigger`.
- **Fix:** Replaced with hyphen-free `'uniquetriggertoken'` for the same single-token MATCH semantic.
- **Verification:** FTS5 sync test now passes.
- **Commit:** `83edf39`

**Total deviations:** 3 — all Rule 1/3 (auto-fixed), no Rule 4 architectural decisions required.
**Impact:** None on Plan 01 deliverable shape. The TEMP-trigger fix preserves the design intent (per-connection override) while complying with SQLite's trigger-reference rules. Camp III fixtures unblock Plans 02-09. FTS5 fix is a test-only cosmetic adjustment.

## Authentication Gates

None.

## Issues Encountered

None — all 4 tasks completed with verifications passing. The 27 pre-existing test failures (`llama-client`, `llama-server-supervisor`, `phase-5-full-gate`) are unrelated to Plan 01 (verified by `git stash` + re-running on master baseline).

## Next Phase Readiness

**Ready for Plan 04-02.** Plan 01 ships the schema + helper foundation that downstream plans rely on:
- The TEMP trigger raises `RAISE(FAIL)` on any production code path that attempts `INSERT INTO experience_patterns` without the override pragma — so when Plans 02-04 delete the three Site A/B/C writers, any accidental remnant gets caught at runtime.
- Plan 06's `extraction-deleted.test.ts` regression guard relies on the trigger blocking would-be writes (and deliberately does NOT call `allowLegacyPatternInsert`).
- Plan 02 (Site A — Angel `pattern-extractor.ts`) and Plan 03 (Site B — `experience-scoring.ts` step 1) and Plan 04 (Site C — heartbeat synthesis loop) can proceed in parallel as Wave 2 plans.
