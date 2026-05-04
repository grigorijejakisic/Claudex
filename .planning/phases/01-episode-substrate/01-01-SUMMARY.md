---
phase: 01-episode-substrate
plan: 01
subsystem: database
tags: [sqlite, migration, schema, episodic-events, provenance, episode-substrate]

requires:
  - phase: pre-v5
    provides: V24 schema baseline (drop legacy *_old tables) - the substrate this V25 step builds on
provides:
  - V25 episodic_events table with closed-enum provenance CHECK constraint
  - 4 supporting indexes (session_turn_ts, project_ts, provenance, parent_event_id)
  - migrateV24toV25 step registered in runMigrations + initializeSchema fresh-DB tail
  - TARGET_USER_VERSION bumped 24 -> 25
affects: [01-02, 01-03, 01-04, phase-2, phase-3, phase-4, phase-6, phase-7]

tech-stack:
  added: []
  patterns:
    - "Append-only event substrate with provenance-as-row-attribute (closed CHECK enum) for structural Mem0-trap impossibility"
    - "metadata_json JSON1 column as schema-stability lever - Phase 2/3 add modality-specific fields without ALTER TABLE"

key-files:
  created:
    - src/tests/adapters/episodic-events/schema-migration.test.ts
  modified:
    - src/core/migration-steps.ts
    - src/core/migrations.ts
    - src/tests/core/curated-context.test.ts
    - src/tests/core/migration-v17-v18.test.ts
    - src/tests/core/migration-v2v3.test.ts
    - src/tests/core/migration/v17-reopen.test.ts
    - src/tests/core/migrations-v19.test.ts
    - src/tests/core/migrations-v20.test.ts
    - src/tests/core/migrations-v21.test.ts
    - src/tests/core/migrations-v22.test.ts
    - src/tests/core/migrations-v23.test.ts
    - src/tests/core/sqlite-vec-loader.test.ts
    - src/tests/embeddings/embed-pipeline.test.ts
    - src/tests/mcp/recall-server.test.ts

key-decisions:
  - "Treat plan's 'SCHEMA_VERSION = 25' literal as TARGET_USER_VERSION = 25; left semantic SCHEMA_VERSION = 300 in src/shared/constants.ts untouched"
  - "Append migrateV24toV25 to migration-steps.ts and add an initializeSchema tail bump 24->25 mirroring the existing V23->V24 pattern"
  - "Embed CHECK constraint inline in CREATE TABLE rather than separate trigger - locks the closed-enum contract at DDL level"
  - "All four idx_epev_* indexes ship in this plan even though Phase 1 is write-only - the indexes are cheap on insert and Phase 3 retrieval needs them ready"

patterns-established:
  - "V25 episode-substrate DDL: id, session_id, project, ts_epoch, turn_number, type, source, content, provenance(CHECK), parent_event_id(self-FK), content_hash, metadata_json, schema_version - locked column order"
  - "Migration step registration: import in migrations.ts, [N, () => migrateNtoN+1(db)] step-table entry, tail bump in initializeSchema for fresh-DB paths"

requirements-completed: [EPI-01, EPI-02, EPI-06]

duration: 7 min
completed: 2026-05-04
---

# Phase 1 Plan 01: V25 episode_events substrate migration

**V25 schema migration ships episodic_events table with closed-enum provenance CHECK + 4 indexes, registered in both runMigrations and initializeSchema fresh-DB tail.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-04T20:51:12Z
- **Completed:** 2026-05-04T20:58:20Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments

- New `episodic_events` table created via `migrateV24toV25` with the locked 13-column shape and `provenance IN ('organic','injected','tool_result','environmental')` CHECK constraint.
- Four indexes (`idx_epev_session_turn_ts`, `idx_epev_project_ts`, `idx_epev_provenance`, `idx_epev_parent`) ready for Phase 3 retrieval.
- Migration is idempotent on V25 DBs and chains cleanly from any V0-V24 starting point through `runMigrations` and the `initializeSchema` fresh-DB tail.
- 10 new schema tests pass; 12 existing migration tests bumped from `user_version=24` to `25`; full migration suite (156 tests across 13 files) green.

## Task Commits

Each task was committed atomically:

1. **Task 1: migrateV24toV25 + register in runner + bump TARGET_USER_VERSION** - `cf6bfaf` (feat)
2. **Task 2: Schema migration tests** - `99b5675` (test)

## Files Created/Modified

- `src/core/migration-steps.ts` - Added `migrateV24toV25` (DDL with CHECK constraint + 4 indexes; idempotent via IF NOT EXISTS).
- `src/core/migrations.ts` - Imported `migrateV24toV25`, added step-table entry `[24, () => { migrateV24toV25(db); }]`, bumped `TARGET_USER_VERSION` 24 -> 25, added fresh-DB tail bump `if (currentUv < 25) ...`.
- `src/tests/adapters/episodic-events/schema-migration.test.ts` - New file, 10 tests covering shape, indexes, CHECK enum, idempotency, legacy preservation, defaults, NOT NULL, self-FK, TARGET_USER_VERSION.
- 12 existing migration test files - mechanical bump from `user_version=24` to `25` to track the new ceiling.

## Follow-on extension landed in Plan 01-02 (commit `a0ad303`)

V25 was extended in-place during Plan 01-02 to also rebuild the `telemetry` table with `'episodic_write_failure'` added to the `event_kind` CHECK enum. CONTEXT.md mandates that dual-write rollback must produce a queryable telemetry row — that's a Phase 1 substrate requirement, not optional. Codebase precedent is exact: V19→V20 already extended the telemetry CHECK enum to add `reranker_fallback`, and V20→V21 did it again for `cross_project_*`. Same rebuild-and-copy pattern applies here, with idempotency probe `telemetryAcceptsEpisodicWriteFailure(db)`.

This is a follow-on increment to V25, not a contradiction — both plans honor the same substrate goal: "the V25 episode substrate INCLUDING its observability is one coherent unit." Splitting the enum extension into a separate V26-just-for-CHECK would have been migration churn for no benefit.

Mechanics:
- `migrateV24toV25` in `src/core/migration-steps.ts` extended (commit `a0ad303`)
- `TELEMETRY_SCHEMA` in `src/core/schema.ts` updated to include `'episodic_write_failure'`
- All 156 prior migration tests continue to pass (V20/V21 telemetry rebuild tests + V25 idempotency tests)
- The 10 V25 schema-migration tests do NOT assert on the CHECK enum's exact values, so no test updates were required
- Approved by team-lead under autonomous mandate; documented in 01-02-SUMMARY.md as a Rule 4 architectural deviation

## Final DDL Committed

```sql
CREATE TABLE IF NOT EXISTS episodic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  ts_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  turn_number INTEGER,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('organic','injected','tool_result','environmental')),
  parent_event_id INTEGER REFERENCES episodic_events(id),
  content_hash TEXT NOT NULL,
  metadata_json TEXT,
  schema_version SMALLINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_epev_session_turn_ts ON episodic_events(session_id, turn_number, ts_epoch);
CREATE INDEX IF NOT EXISTS idx_epev_project_ts     ON episodic_events(project, ts_epoch);
CREATE INDEX IF NOT EXISTS idx_epev_provenance     ON episodic_events(provenance);
CREATE INDEX IF NOT EXISTS idx_epev_parent         ON episodic_events(parent_event_id);
```

## V24 -> V25 Transition Pattern (for Phase 2/3 reference)

If a future phase needs another SQLite-only DDL migration:

1. Append `migrateVNtoVN+1(db: Database): boolean` at the bottom of `src/core/migration-steps.ts`. Use `db.exec(...)` for all DDL; use `IF NOT EXISTS` everywhere; return `true` on success.
2. Add the import to `src/core/migrations.ts` (alphabetical order in the `migrate*` import block from `migration-steps.js`).
3. Add the step-table entry `[N, () => { migrateVNtoVN+1(db); }]` after the previous one - the key is the FROM version.
4. Bump `TARGET_USER_VERSION` constant in `migrations.ts` from `N` to `N+1`.
5. Add a tail bump in `initializeSchema` mirroring the existing V23->V24 / V24->V25 pattern so fresh-DB paths (which take the early-return in `runMigrations` when no `observations` table exists) get the migration applied + `user_version` stamped.
6. Update every existing test pinned to the old `user_version=N` integer literal to `N+1` (`grep -rn "toBe(N)\|user_version.*N" src/tests`). The `diagnostics/format.test.ts` fixture is orthogonal to migration version - leave it alone unless its semantic meaning changed.

## Decisions Made

- **TARGET_USER_VERSION vs SCHEMA_VERSION naming.** The plan literal `SCHEMA_VERSION = 25` conflicts with the existing `SCHEMA_VERSION = 300` constant in `src/shared/constants.ts` (semantic version stamped into `schema_versions` table). Bumped `TARGET_USER_VERSION` (the actual PRAGMA `user_version` migration gate) from 24 to 25 in `src/core/migrations.ts`; left semantic `SCHEMA_VERSION = 300` untouched. Documented as deviation below; messaged team-lead at the start.
- **Index list shipped in Plan 01.** The plan's CONTEXT.md specifies 5 indexes (PK + 4 secondaries). The PK is implicit from `INTEGER PRIMARY KEY AUTOINCREMENT`. The 4 secondaries (`idx_epev_*`) are created in this plan even though no reader exists in Phase 1 - cheap on insert, Phase 3 needs them ready.
- **`schema_version` column default = 1.** Hard-coded `DEFAULT 1` at the column level so callers don't need to specify it. Bumping is reserved for breaking metadata_json contract changes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Plan called for `SCHEMA_VERSION = 25` in `src/shared/constants.ts`; the existing constant is unrelated**
- **Found during:** Task 1 (Add migrateV24toV25 + register + bump SCHEMA_VERSION)
- **Issue:** Plan said "bump SCHEMA_VERSION from 24 to 25" in `src/shared/constants.ts`, but that file has `SCHEMA_VERSION = 300` (semantic version stamped into `schema_versions` table). The runtime migration gate is `TARGET_USER_VERSION = 24` in `src/core/migrations.ts` (PRAGMA `user_version`). The plan's verification step (`runMigrations` creating the new table) requires `TARGET_USER_VERSION` to advance, not `SCHEMA_VERSION`.
- **Fix:** Bumped `TARGET_USER_VERSION` 24 -> 25 in `src/core/migrations.ts`. Left semantic `SCHEMA_VERSION = 300` in `src/shared/constants.ts` untouched. The plan author conflated the two constants.
- **Files modified:** `src/core/migrations.ts`
- **Verification:** All 156 migration tests across 13 files pass; the new test file's `expect(TARGET_USER_VERSION).toBe(25)` assertion passes.
- **Committed in:** `cf6bfaf`

**2. [Rule 1 - Bug] 12 existing migration tests pinned to `expect(...).toBe(24)` for user_version**
- **Found during:** Task 1 verification (full vitest suite)
- **Issue:** When `TARGET_USER_VERSION` advances, every test that asserts the post-migration `user_version` integer literal goes red. This is the established pattern in this codebase (each prior phase's plan also bumped these literal assertions).
- **Fix:** Mechanical sweep of `expect(...).toBe(24)` -> `expect(...).toBe(25)` across `src/tests/core/{curated-context,migration-v17-v18,migration-v2v3,migrations-v19..v23,sqlite-vec-loader}.test.ts`, `src/tests/core/migration/v17-reopen.test.ts`, `src/tests/embeddings/embed-pipeline.test.ts`, `src/tests/mcp/recall-server.test.ts`. The diagnostics/format.test.ts fixture string `"user_version=24"` is orthogonal - left alone.
- **Files modified:** 12 test files
- **Verification:** All 156 migration-related tests pass; full suite delta is -22 failures vs baseline (49 -> 27, all 27 remaining are pre-existing in llama-server-supervisor, llama-client, and phase-5-full-gate tests - unrelated to this plan).
- **Committed in:** `cf6bfaf`

---

**Total deviations:** 2 auto-fixed (1 blocking-misnomer, 1 bug-class).
**Impact on plan:** Both deviations were necessary for the plan's verification commands to pass. No scope creep; no new files outside the plan's `files_modified` whitelist.

## Issues Encountered

None directly tied to Plan 01-01. The full vitest suite has 27 pre-existing failures across 3 test files (`llama-client.test.ts`, `llama-server-supervisor.test.ts`, `phase-5-full-gate.test.ts`) that were already failing on master at commit `19383b5` (verified by stash-and-rerun). These are orthogonal to V25 schema work; the next phase's verifier should NOT treat them as Phase 1 regressions.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **Plan 01-02** (wrapper-parser + dual-write user/assistant) can start immediately: the `episodic_events` table exists, the closed-enum CHECK constraint is enforced, and the migration is idempotent.
- **Plans 01-03 / 01-04** are downstream of 01-02 (which creates `src/core/episodic-events.ts`); they don't depend on additional schema.
- The substrate is empty by design - no backfill of `conversation_turns` rows. Phase 2's empirical investigation runs against whatever corpus accumulates after Plan 01-02 ships.

---
*Phase: 01-episode-substrate*
*Plan: 01*
*Completed: 2026-05-04*
