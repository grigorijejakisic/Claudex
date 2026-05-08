---
phase: 08-transcript-ingestion-substrate
plan: 01
subsystem: schema-migration
tags: [v6, transcript-substrate, schema, migration, vec0]
requires: []
provides: [migrateV31toV32, transcript_chunk_v6, vec_transcript_chunks_v6, V32 regression tests]
affects: [08-02, 08-03, 08-04, 08-05]
tech-stack:
  added: []
  patterns: [closed-enum CHECK, additive migration, vec0 silent-skip, fresh-DB convergence]
key-files:
  created:
    - src/tests/core/migrations-v32.test.ts
  modified:
    - src/core/migration-steps.ts
    - src/core/migrations.ts
    - src/core/schema.ts
    - src/tests/core/migrations-v31.test.ts
key-decisions:
  - "V32 is purely additive — legacy artifact-kernel `transcript_chunk` slot untouched per CONTEXT decision 3."
  - "SCHEMA_VERSION constant (300) NOT bumped — that constant tracks the v3 schema-family transition, not user_version. V25–V31 followed the same pattern; V32 follows it."
requirements-completed: [TRX-05]
duration: 21 min
completed: 2026-05-08
---

# Phase 8 Plan 01: V32 schema migration Summary

V32 lands the v6 transcript-chunk substrate as a purely additive migration: `transcript_chunk_v6` metadata table (10 columns, 2 indexes + 1 unique on `(session_id, turn_index, role, sub_index)`) and `vec_transcript_chunks_v6` vec0 virtual table (1024-dim arctic-embed2 native). `TARGET_USER_VERSION` bumped 31→32; migrations dispatch + initializeSchema fresh-DB convergence both updated.

## What changed

- **migrateV31toV32** added at end of `src/core/migration-steps.ts` (~70 lines). Idempotent via `SELECT 1 FROM sqlite_master WHERE name='transcript_chunk_v6'`. Wraps vec0 creation in try/catch + `loadSqliteVec` reachability check (mirrors migrateV14toV15 silent-skip pattern).
- **`src/core/migrations.ts`**: dispatch entry `[31, () => { migrateV31toV32(db); }]`, `TARGET_USER_VERSION = 32`, fresh-DB `if (currentUv < 32)` block in initializeSchema, version-map JSDoc updated for V25–V32.
- **`src/core/schema.ts`**: `transcript_chunk_v6` DDL added inside SCHEMA_V3 alongside `episode_boundary_cursor` (line ~146) so fresh-DB initialization reaches V32 shape via SCHEMA_V3 + the `if (currentUv < 32)` migration call.
- **`migrateV14toV15` table list** extended with `vec_transcript_chunks_v6` so the fresh-DB pre-V17 path also creates the vec0 table.
- **V32 test file** at `src/tests/core/migrations-v32.test.ts` — 13 tests covering: TARGET_USER_VERSION assertion, base-table fresh-DB column shape + indexes + CHECK constraints + UV=32, V17-collapsed migration (`buildV17V32Fixture` helper) + legacy-slot-untouched assertion, idempotent re-run, initializeSchema↔runMigrations shape convergence (Plan 06-01 invariant).
- **`migrations-v31.test.ts` stale-version assertions relaxed** from `toBe(31)` to `toBeGreaterThanOrEqual(31)` — the V31 migration logic is unchanged, the assertions were pinning the wrong constant.

## Verification

- `bun run build` exits 0 (~70ms).
- `bun run vitest run src/tests/core/migrations-v32.test.ts` — 13/13 pass.
- `bun run vitest run src/tests/core/` — 567/567 core tests pass (full regression — no V25–V31 migration step, learnings-write-path-v17, V17-runner, V17-reopen, V17-naming-convention, V28-trigger, or related test regressed).
- WIR-01 fixture coverage: V17-collapsed + base-table fresh-DB both exercise the EXPORTED `migrateV31toV32` function directly.

## Deviations from Plan

**[Rule 1 — Bug] Three pre-existing migrations-v31.test.ts assertions hard-coded `toBe(31)`** — Found during: Task 2 regression run | Issue: assertions pinned `TARGET_USER_VERSION === 31`, `UV === 31` after `initializeSchema`, `UV === 31` after `runMigrations` from V30 — all three would have to be updated for every future migration ceiling bump. The V31 migration *step* and view-mode logic still work; only the literal-version assertions were stale. | Fix: relaxed three assertions to `toBeGreaterThanOrEqual(31)` (matching the pattern V29/V30 tests already use) | Files modified: `src/tests/core/migrations-v31.test.ts` | Verification: V31 + V32 + learnings-write-path-v17 + full core suite all pass | Commit hash: 49c449f.

**[Rule 1 — Bug] Plan asked for SCHEMA_VERSION constant bump in `src/shared/constants.ts`** — Found during: Task 1 reading | Issue: the plan said "bump SCHEMA_VERSION lockstep — find the v5.0.1 / V31 line and bump to V32." But `SCHEMA_VERSION = 300` tracks the v3 schema-family transition (separate from `PRAGMA user_version`); per `migrations.ts` line 92's comment, the two version trackers serve different purposes. None of V25 (Phase 1), V28 (Phase 4), V29 (Phase 6), V30/V31 (Phase 7) bumped `SCHEMA_VERSION` — the constant has been at `300` since v00. There is no "v5.0.1 / V31 line" in `constants.ts`. | Fix: skipped the SCHEMA_VERSION bump to preserve the established convention; documented here. | Files modified: none beyond the plan-prescribed user_version path | Verification: full core test suite passes (would have caught any `SCHEMA_VERSION`-vs-`user_version` divergence via `migrateFromV2` / `detectV2Database` paths).

**Total deviations:** 2 auto-fixed (1 stale-test bug, 1 plan-ambiguity bug). **Impact:** None on V32 substrate correctness. Both deviations align with the v5/v6 codebase conventions already in place.

## Authentication Gates

None — all DDL is local SQLite.

## Issues Encountered

None.

## Next Phase Readiness

Ready for Plan 08-02 (chunkTranscript + upsertChunk + parseWrappers redaction). The V32 substrate is in place; 08-02 builds on top of it without touching schema.

**Duration:** 21 min
**Tasks completed:** 2/2
**Files created:** 1 (V32 regression test)
**Files modified:** 4
**Commits:** 1 (`49c449f feat(08-01): V32 migration ...`)
