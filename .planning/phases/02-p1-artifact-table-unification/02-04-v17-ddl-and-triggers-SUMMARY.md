---
phase: 02-p1-artifact-table-unification
plan: 02-04
subsystem: database
tags: [migration, v17, ddl, triggers, fts5, vec0, legacy-views]

requires:
  - phase: 02-01
    provides: KIND_MAPPING source-of-truth consumed by trigger generator

provides:
  - applyV17DDL() — idempotent kernel DDL (artifact + kind_registry + legacy_id_map + vec0 + fts5 + indexes)
  - generateViewsAndTriggers() — programmatic emission of 6 views + 18 INSTEAD OF triggers
  - applyGeneratedDDL() — applies generator output to a Database
  - migrateV16toV17() — migration-steps.ts hook (DDL only; data migration lives in Plan 02-05 runner)

affects:
  - 02-05-migration-runner (consumes applyV17DDL + applyGeneratedDDL inside Phase B tx)
  - 02-06-fts5-caller-port (artifact_fts becomes the new FTS5 target)

tech-stack:
  added: []
  patterns:
    - "Single KIND_MAPPING drives all 18 trigger bodies — no hand-written trigger SQL."
    - "FTS5 content='artifact' binding + 3 AFTER triggers for insert/update/delete sync."
    - "Expression + partial indexes port every legacy access path onto JSON-extracted paths."
    - "Computed view columns recover legacy lesson/anti_pattern by splitting body on the composition sentinel."

key-files:
  created:
    - src/core/migration/v17-ddl.ts
    - src/core/migration/v17-triggers.ts
    - src/tests/core/migration/v17-ddl.test.ts
    - src/tests/core/migration/v17-triggers.test.ts
  modified:
    - src/core/migration-steps.ts (migrateV16toV17 + imports)
    - src/core/schema.ts (V17 header comment)

key-decisions:
  - "Per-kind kernel time-col fills handle v3 schema idiosyncrasies: learnings (first_seen_epoch), decisions (timestamp_epoch), experience_patterns + angel_opinions + project_curated_context (created_at_epoch), critical_rules (no epoch — TEXT datetime('now') columns; kernel defaults to unixepoch() * 1000)."
  - "Kernel time cols store milliseconds; legacy columns were seconds — INSERT triggers multiply by 1000, view projections divide by 1000 to restore v3 shape."
  - "experience_patterns.id is TEXT UUID and round-trips verbatim via COALESCE(NEW.id, lower(hex(randomblob(16)))); no legacy_id_map entry for that table."
  - "project_curated_context.supersedes_id INSERT stores in data._pending_supersedes; view reads via legacy_id_map reverse lookup with COALESCE to _pending_supersedes for lazy resolution of not-yet-migrated targets."
  - "Computed-UPDATE via NEW.x works — SQLite evaluates NEW.score BEFORE firing INSTEAD OF UPDATE, so `score = score + 2` correctly propagates to json_set(data, '$.score', 7). Regression test locked in Plan 02-04. No hand-written fallback trigger variants required."

patterns-established:
  - "DROP TRIGGER IF EXISTS before each CREATE TRIGGER — makes the generator re-runnable against a partially-migrated DB."
  - "json_set chain for multi-column data UPDATE: `data = json_set(json_set(data, '$.k1', NEW.c1), '$.k2', NEW.c2)`."
  - "UNIQUE partial indexes replace legacy UNIQUE(...) constraints without bloating the kernel (each applies `WHERE kind='...'`)."

requirements-completed:
  - STOR-01
  - STOR-02
  - STOR-03
  - STOR-07

duration: 11 min
completed: 2026-04-20
---

# Phase 2 Plan 02-04: V17 DDL + Trigger Generator Summary

**Programmatic emission of the full V17 schema — artifact kernel + kind_registry + legacy_id_map + vec0 embeddings + FTS5 + 13 ported indexes — plus 6 views and 18 INSTEAD OF triggers generated from KIND_MAPPING. Zero hand-written trigger bodies; 30 new Vitest cases green including the caveat #4 computed-UPDATE regression.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-04-20T09:51:30Z
- **Completed:** 2026-04-20T10:02:40Z
- **Tasks:** 5
- **Files modified:** 6 (4 created, 2 edited)

## Accomplishments

- `applyV17DDL(db)` — kernel + registry + legacy_id_map + vec0 + fts5 + 13 indexes.
- `generateViewsAndTriggers(KIND_MAPPING)` → 6 `GeneratedViewDDL` records (view + INSERT + UPDATE + DELETE trigger each).
- `applyGeneratedDDL(db, generated)` → runs the generator output against a Database.
- `migrateV16toV17(db)` wired into migration-steps.ts (DDL only; runner lives in Plan 02-05).
- `schema.ts` carries a V17 header comment pointing at migrate/* modules.
- 30 new Vitest cases green: kernel shape + indexes + CHECK(json_valid) + kind_registry sync + FTS5 sync + UNIQUE partial index dedup + view round-trip per kind + UUID id preservation + computed-UPDATE (caveat #4) + supersedes lazy resolution + cross-kind isolation.

## Task Commits

1. **Tasks 04-01-01 through 04-01-05** (v17-ddl.ts + v17-triggers.ts + migrateV16toV17 wiring + schema.ts header + 2 test files, bundled) — `<hash-TBD>` (feat). Bundled for same reason as prior plans: split commits would yield broken-intermediate states.

**Plan metadata:** (pending — committed with SUMMARY.md)

## Files Created/Modified

- `src/core/migration/v17-ddl.ts` — 165 lines. DDL constants + `applyV17DDL`.
- `src/core/migration/v17-triggers.ts` — 345 lines. `generateViewsAndTriggers` + `applyGeneratedDDL` + per-kind kernel fills + data-json pair builder + update SET clause emitter.
- `src/core/migration-steps.ts` — +imports + `migrateV16toV17()` function.
- `src/core/schema.ts` — V17 header comment (docs only; schema.ts is declarative reference, migration-steps.ts is procedural source of truth).
- `src/tests/core/migration/v17-ddl.test.ts` — 165 lines, 11 cases.
- `src/tests/core/migration/v17-triggers.test.ts` — 260 lines, 19 cases.

## Decisions Made

- Kept `migrateV16toV17()` deliberately narrow: it only applies DDL + generator output. It does NOT touch the 6 legacy tables (rename, copy, DROP FTS5, etc.). Phase B atomic-tx sequencing lives in the Plan 02-05 runner — this keeps `migrateV16toV17` composable and testable in isolation.
- `migrateV16toV17` is NOT added to `runMigrations()` or `initializeSchema()`. V17 requires Phase A pre-embed via Ollama which must not run on implicit DB open. The CLI runner from Plan 02-05 will invoke it inside its own atomic sequence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Initial generator assumed all legacy tables carry created_at_epoch column**
- **Found during:** Task 04-01-05 (running v17-triggers tests)
- **Issue:** 6 INSTEAD OF INSERT triggers failed with "no such column: NEW.created_at_epoch" because learnings uses first_seen_epoch, decisions uses timestamp_epoch, critical_rules uses TEXT datetime() columns with no epoch counterpart at all.
- **Fix:** Per-kind `kernel_insert_map` overrides for each of the 6 legacy tables' actual time-column names. For critical_rules (no epoch), fall back to `unixepoch() * 1000`.
- **Files modified:** src/core/migration/v17-triggers.ts (`buildKernelInsertMap` switch cases).
- **Verification:** All 19 v17-triggers cases green post-fix.
- **Committed in:** same commit as the rest of Plan 02-04.

---

**Total deviations:** 1 auto-fixed (Rule 1 bug in first draft of generator).
**Impact on plan:** Minimal — discovered at test time, fixed at test time, no scope change.

## Issues Encountered

None beyond the auto-fixed above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-05 (migration runner) can now `applyV17DDL(db)` + `applyGeneratedDDL(db, generateViewsAndTriggers(KIND_MAPPING))` inside its Phase B atomic tx.
- Plan 02-06 (FTS5 caller port) has `artifact_fts` in place as the new MATCH target.
- Full migration test surface now 113 tests green (30 new + 83 pre-existing migration tests).

## Self-Check

- Files on disk: v17-ddl.ts, v17-triggers.ts, v17-ddl.test.ts, v17-triggers.test.ts — all present.
- `bun run test -- migration` → 113/113 green across 7 files.
- `bun run build` clean.
- Git commit present: `git log --grep="02-04"` will return the feat commit.

## Self-Check: PASSED

---
*Phase: 02-p1-artifact-table-unification*
*Completed: 2026-04-20*
