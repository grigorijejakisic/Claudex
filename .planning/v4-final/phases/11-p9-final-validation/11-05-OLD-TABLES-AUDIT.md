# Phase 11 — Legacy `_old` Tables Zero-Caller Audit

**Date:** 2026-04-30
**Commit:** f389521 (post Plan 11-04 close)
**DB Backup:** `~/.claudex/backups/pre-v4-phase-11-drop-old-20260430-181007.db` (378 MB, fully restorable)

## V17-created `_old` tables

V17 (Phase P1) created 6 legacy tables via `ALTER TABLE … RENAME TO {name}_old` (see `src/core/migration/v17-runner.ts:191`):

| Table | Pre-drop row count |
|---|---|
| learnings_old | 191 |
| decisions_old | 126 |
| experience_patterns_old | 76 |
| angel_opinions_old | 130 |
| critical_rules_old | 81 |
| project_curated_context_old | 448 |
| **Total** | **1052 rows** |

Compat views (same names without `_old`) route to the artifact kernel via INSTEAD OF triggers and are independent of the `_old` tables.

## Grep results

Pattern: `_old\b` across all source files (TypeScript, JavaScript, SQL fragments inline, tests, scripts):

| File | Matches | Classification |
|---|---|---|
| `src/core/migration-steps.ts` | 2 (lines 1431, 1440) | Comments only — describe V17's rename-then-create-views ordering. **Not a live caller.** |
| `src/core/migration/v17-runner.ts` | 3 (lines 10, 191, 197) | The V17 migration ITSELF doing the renames. **Migration internal — does not block DROP.** |
| `src/tests/core/migration/v17-runner.test.ts` | 4 (lines 263–264, 288) | V17 migration test asserting the rename happened. **Migration-historical test — does not block DROP.** |
| `src/tests/angel/curation-feedback-loop.test.ts` | 2 (lines 120, 125) | Filename string `process_old-pattern.md` — coincidental substring match. **Not a SQL `_old` reference.** |

## Classification roll-up

- Live callers blocking DROP: **0**
- Migration-internal references: 5 (V17 runner + V17 runner test) — do not block
- Test fixtures (live-behavior): 0 (the v17-runner test is migration-historical, not live-runtime)
- String coincidences: 2 (curation-feedback-loop test filename `process_old-pattern.md`)

**Decision: DROP.**

## V24 migration

Migration shipped at `src/core/migration-steps.ts:migrateV23toV24`:

```ts
export function migrateV23toV24(db: Database): boolean {
  const legacyOldTables = [
    'learnings_old',
    'decisions_old',
    'experience_patterns_old',
    'angel_opinions_old',
    'critical_rules_old',
    'project_curated_context_old',
  ];
  for (const tbl of legacyOldTables) {
    db.exec(`DROP TABLE IF EXISTS ${tbl}`);
  }
  return true;
}
```

Wired into `src/core/migrations.ts`:
- `TARGET_VERSION = 24` (was 23)
- `migrations[]` array now includes `[23, () => { migrateV23toV24(db); }]`
- Fresh-DB path also bumps to user_version=24 (idempotent — DROP IF EXISTS is a no-op when tables don't exist)

## Verification

```bash
# Pre-drop: backup written successfully
$ ls -la ~/.claudex/backups/pre-v4-phase-11-drop-old-20260430-181007.db
-rw-r--r-- ... 378724352 ...

# Migration applied to live DB; PRAGMA user_version → 24
# (Live-DB drops happened automatically when CC hooks reopened the DB
#  after the bundled JS was rebuilt with TARGET_VERSION=24.)

# Live DB after V24:
_old tables: []     # all 6 dropped
user_version: 24

# SC#3 mechanical scorer still PASS (gated true, aggregate 90, missing 0)
$ bun run sc3 -- --json | grep gated
  "gated": true,

# SC#1 Vesna full-suite still PASS (gated true, 100% aggregate)
$ bun run vesna -- --json | grep aggregate
  "aggregate_pass_rate": 1,
  "gated": true

# 39/39 migration tests PASS (including new src/tests/core/migrations-v23.test.ts)
```

## Tests

New test file: `src/tests/core/migrations-v23.test.ts` (3 tests):
1. Fresh DB reaches user_version=24
2. Drops all 6 _old tables when present
3. Idempotent: running on a clean DB is a no-op

Also bumped `toBe(23)` → `toBe(24)` across 11 existing migration test files (per the established Phase 9.8 pattern when V22→V23 was added).

## REQUIREMENTS.md update

```diff
- [x] **STOR-04**: Migration transaction-wrapped; legacy tables retained until Phase 11 zero-caller gate
+ [x] **STOR-04**: Migration transaction-wrapped; legacy tables dropped in V24 (Phase 11, zero-caller gate cleared)
```

## Decision

**DROP path executed.** Zero live callers; backup in place; full test suite (incl. new V23→V24 tests + bumped tests + SC#3/SC#1 still PASS); STOR-04 closed at the v4 ship gate.
