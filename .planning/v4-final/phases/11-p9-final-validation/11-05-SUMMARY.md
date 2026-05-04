---
phase: 11
plan: 05
subsystem: db/migrations
tags: [stor-04, v24, legacy-cleanup]
requires: ["11-01", "11-02", "11-03", "11-04"]
provides: []
affects:
  - src/core/migration-steps.ts
  - src/core/migrations.ts
  - 11 migration test files (toBe(23) → toBe(24))
key-files:
  created:
    - src/tests/core/migrations-v23.test.ts
    - .planning/phases/11-p9-final-validation/11-05-OLD-TABLES-AUDIT.md
  modified:
    - src/core/migration-steps.ts (added migrateV23toV24)
    - src/core/migrations.ts (TARGET_VERSION 23→24, registered V23→V24 step, fresh-DB stamp)
    - src/tests/core/migrations-v22.test.ts (toBe(23) → toBe(24))
    - src/tests/core/migrations-v21.test.ts
    - src/tests/core/migrations-v20.test.ts
    - src/tests/core/migrations-v19.test.ts
    - src/tests/core/migration-v17-v18.test.ts
    - src/tests/core/migration-v2v3.test.ts
    - src/tests/core/migration/v17-reopen.test.ts
    - src/tests/core/curated-context.test.ts
    - src/tests/core/sqlite-vec-loader.test.ts
    - src/tests/embeddings/embed-pipeline.test.ts
    - src/tests/mcp/recall-server.test.ts
    - .planning/REQUIREMENTS.md (STOR-04 updated)
key-decisions:
  - DROP path executed — zero-caller audit showed no live callers of `*_old` tables
  - DB backup written at ~/.claudex/backups/pre-v4-phase-11-drop-old-20260430-181007.db (378MB)
  - V24 migration is idempotent — DROP IF EXISTS is a no-op on already-migrated / fresh DBs
  - 6 _old tables (1052 rows total) dropped from live DB; user_version 23 → 24
  - SC#3 still PASS (gated true) post-V24; SC#1 still 100% post-V24 — no functional regression
requirements-completed:
  - STOR-04
duration: ~15 min
completed: 2026-04-30
---

# Phase 11 Plan 05: STOR-04 Zero-Caller Audit + V24 Drop

Legacy `*_old` tables retained as a V17 safety belt are dropped in V24 after the zero-caller audit confirmed no live runtime callers. STOR-04 closes at the v4 ship gate.

## Outcome

- Audit: zero live callers (`src/core/migration-steps.ts:1431,1440` are comments; `src/core/migration/v17-runner.ts` is V17 itself; tests are migration-historical; one filename string is coincidental).
- DB backup: 378MB at `~/.claudex/backups/pre-v4-phase-11-drop-old-20260430-181007.db`.
- Migration: `migrateV23toV24` shipped; live DB stamped at `user_version = 24`; `_old` tables empty (DROP IF EXISTS for all 6).
- Tests: new `src/tests/core/migrations-v23.test.ts` (3 tests) + 11 existing migration tests bumped to `toBe(24)`. Migration test bundle: 39/39 PASS.
- Post-drop verification: SC#3 still gated true at aggregate 90; SC#1 Vesna still 100%; no functional regression.

## Self-Check: PASSED

- 11-05-OLD-TABLES-AUDIT.md exists on disk
- src/tests/core/migrations-v23.test.ts exists on disk
- migrateV23toV24 exported from migration-steps.ts
- TARGET_VERSION = 24 in migrations.ts
- Live DB user_version = 24 (verified via `db.pragma('user_version')`)
- DB backup exists at ~/.claudex/backups/pre-v4-phase-11-drop-old-*.db
- bun run vesna gated true; bun run sc3 gated true
- REQUIREMENTS.md STOR-04 updated to "dropped in V24"

## Next

Wave 4: Plan 11-06 (LongMemEval + LoCoMo archival vibe-check, NON-GATING).
