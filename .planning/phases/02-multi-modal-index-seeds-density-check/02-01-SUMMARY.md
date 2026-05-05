---
phase: 02-multi-modal-index-seeds-density-check
plan: 01
subsystem: storage/migrations
tags: [v5, phase2, idx-01, sidecar, sqlite, migration]
requires: [phase-1-substrate]
provides: [v26-schema, episodic_index_error_fingerprint]
affects: [src/core/migration-steps.ts, src/core/migrations.ts]
tech-stack:
  added: []
  patterns: [sidecar-inverted-index]
key-files:
  created:
    - src/tests/adapters/episodic-events/error-fingerprint-migration.test.ts
  modified:
    - src/core/migration-steps.ts
    - src/core/migrations.ts
    - src/tests/adapters/episodic-events/schema-migration.test.ts
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
  - "V26 introduces the FIRST sidecar pattern in the v5 substrate: per-row metadata in episodic_events.metadata_json + inverted-index sidecar table."
  - "Phase 1's no-ALTER-on-episodic_events contract preserved — V26 only creates a NEW table."
  - "corpus_origin CHECK enum closed to ('phase1_organic','v4_backfill') — Phase 5 may add more in a future migration if it adopts this pattern."
  - "Test pin sweep: 12 user_version-pinned tests de-pinned to TARGET_USER_VERSION so future schema bumps don't require a manual sweep."
requirements-completed: [IDX-01]
duration: "10 min"
completed: "2026-05-04"
---

# Phase 2 Plan 1: V26 Error-Fingerprint Sidecar Migration Summary

V26 schema migration creating the `episodic_index_error_fingerprint` sidecar table — the inverted-index storage Plans 02-02/03/04 will read and write — using the locked DDL from CONTEXT item 6, the closed `corpus_origin` enum from item 2, the three required indexes, registration in both the migration runner and the fresh-DB fall-through, and 9 unit tests asserting shape, idempotency, CHECK enforcement, FK declaration, and Phase 1 V25 invariance.

## DDL committed

```sql
CREATE TABLE IF NOT EXISTS episodic_index_error_fingerprint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shingle_hash TEXT NOT NULL,
  episode_event_id INTEGER NOT NULL REFERENCES episodic_events(id),
  ts_epoch INTEGER NOT NULL,
  project TEXT NOT NULL,
  corpus_origin TEXT NOT NULL CHECK (corpus_origin IN ('phase1_organic','v4_backfill')),
  schema_version SMALLINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_epev_efp_shingle      ON episodic_index_error_fingerprint(shingle_hash);
CREATE INDEX IF NOT EXISTS idx_epev_efp_event        ON episodic_index_error_fingerprint(episode_event_id);
CREATE INDEX IF NOT EXISTS idx_epev_efp_project_ts   ON episodic_index_error_fingerprint(project, ts_epoch);
```

`migrateV25toV26` is exported from `src/core/migration-steps.ts`. The function guards on `hasTable(db, 'episodic_index_error_fingerprint')` for early-return idempotency on top of the IF-NOT-EXISTS DDL — same pattern as `migrateV24toV25`.

## Migration runner registration

Two sites bumped in `src/core/migrations.ts`:

1. `TARGET_USER_VERSION` constant: 25 → 26.
2. Step-table entry `[25, () => { migrateV25toV26(db); }]` appended after V25.
3. Fall-through fresh-DB block bumped: a new `if (currentUv < 26) { migrateV25toV26(db); db.pragma('user_version = 26'); }` appended.

## V25 → V26 transition pattern (for Phase 3 and beyond)

The CONTEXT.md item 6 specifics noted the sidecar pattern set here informs Phase 3 (which will likely build 2-3 more sidecars). The pattern is:

1. **Per-row payload lives in `episodic_events.metadata_json`** — the writer attaches a typed feature object (here: `error_fingerprint`) under a stable key. No ALTER TABLE on `episodic_events`.
2. **Inverted-index sidecar table** — name `episodic_index_<modality>_<feature>`. Required columns:
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - The feature key (here `shingle_hash TEXT`) — the JOIN/lookup column.
   - `episode_event_id INTEGER NOT NULL REFERENCES episodic_events(id)` — FK to the substrate (declared, not enforced; this codebase runs FKs off by default).
   - `ts_epoch INTEGER NOT NULL` — denormalized for fast range scans.
   - `project TEXT NOT NULL` — denormalized for project-scoped retrieval.
   - `corpus_origin TEXT NOT NULL CHECK (...)` — closed enum tagging which corpus the row came from. Mandatory for any sidecar that ingests both Phase 1 organic data and v4 backfill data; CONTEXT item 2's known-limitation discipline.
   - `schema_version SMALLINT NOT NULL DEFAULT 1` — present from day one so a future format bump is straightforward.
3. **Indexes** — minimum three: `(feature_key)` for lookup, `(episode_event_id)` for parent-side joins, `(project, ts_epoch)` for project-scoped time-range queries.
4. **Migration step** — single `db.exec(...)` block with IF NOT EXISTS DDL + early-return idempotency guard via `hasTable`. Wraps no transaction — pure DDL, atomic at the SQLite level.
5. **Bump TARGET_USER_VERSION + register in step-table + add to fall-through fresh-DB block.** All three sites, no exceptions.

Phase 3's three or so additional sidecars (affect, structural-shape, others) should follow this shape verbatim. Anything that wants to deviate (e.g. a sidecar that rebuilds via SQLite triggers) needs a CONTEXT-level justification.

## Authentication Gates

None.

## Deviations from Plan

**[Rule 1 - Bug] Test pin sweep: de-pin literal user_version assertions to TARGET_USER_VERSION** — Found during: post-Task-2 full-suite test run | Issue: 14 tests across 12 files (`migration-v17-v18`, `migration-v2v3`, `migration/v17-reopen`, `migrations-v19/v20/v21/v22/v23`, `sqlite-vec-loader`, `curated-context`, `embed-pipeline`, `recall-server`) failed with `expected 26 to be 25` because they pin user_version to a literal `25`, which became stale the moment Phase 2 bumped TARGET_USER_VERSION. The Phase 1 schema-migration test was already de-pinned to `TARGET_USER_VERSION`; Phase 1 left the rest behind. | Fix: imported `TARGET_USER_VERSION` and replaced `toBe(25)` with `toBe(TARGET_USER_VERSION)` in each file. The two unrelated `toBe(25)` lines (`recall-server.test.ts:112` was a `limit` assertion, `crud-modules.test.ts:220` was an `observation_count` assertion) were left alone. | Files modified: 12 test files (listed in frontmatter `key-files.modified`). | Verification: full suite went from 49 failures → 27 (matches Phase 1's documented 27-failure baseline of llama-* + phase-5-full-gate). | Commit hash: `907f9fc`.

**Total deviations:** 1 auto-fixed (Rule 1: bug). **Impact:** Net positive — every future schema bump no longer requires a manual sweep across these test files. Behavioral surface unchanged. The two unrelated literal `25`s in the codebase were not touched (they assert different domain values, not user_version).

## Verification

- `bun run build` clean (no TypeScript errors).
- `bun run test src/tests/adapters/episodic-events/error-fingerprint-migration.test.ts` → 9/9 PASS.
- `bun run test src/tests/adapters/episodic-events/` → 49/49 PASS (Phase 1 substrate tests preserved).
- Full `bun run test` → 3281 passing, 27 pre-existing failures (llama-* + phase-5-full-gate, all from master baseline pre-Phase-2).
- Manual: `pragma table_info(episodic_index_error_fingerprint)` confirms the 7-column shape; `pragma table_info(episodic_events)` confirms the V25 13-column shape is byte-identical post-V26.

## Issues Encountered

None directly tied to Plan 02-01. The 27 remaining full-suite failures are unchanged from the master baseline noted in Phase 1's STATE (`llama-client.test.ts`, `llama-server-supervisor.test.ts`, `phase-5-full-gate.test.ts`).

## Next Phase Readiness

**Plan 02-01 complete.** Sidecar table is on disk in V26; Plan 02-02 (the fingerprinter and ingest-time wiring) and Plan 02-03 (the explicit one-time backfill) can layer on top of it.

Ready for Plan 02-02.
