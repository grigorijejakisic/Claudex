---
phase: 14
plan: "14-05"
subsystem: angel/boundary
tags: [session-lifecycle, boundary-detector, telemetry, migration, single-owner]
dependency-graph:
  requires: [14-01, 14-02, 14-06]
  provides: [single-owner-session-end, session-end-action-telemetry, v36-migration]
  affects: [heartbeat, session-start, sessions, telemetry, migrations]
tech-stack:
  added: [SessionEndReason type, recordSessionEndAction, promoteSessionToCompleted, fireEndOfSessionActions, migrateV35toV36, migrateV36toV35, session_end_action event kind]
  patterns: [single-owner lifecycle, ordered action chain with per-action telemetry, additive CHECK constraint extension via table-recreate]
key-files:
  created: [.planning/phases/14-substrate-coherence/14-05-AUDIT.md]
  modified:
    - src/angel/boundary/boundary-detector.ts
    - src/angel/heartbeat.ts
    - src/adapters/cc-hooks/session-start.ts
    - src/core/sessions.ts
    - src/core/migrations.ts
    - src/core/migration-steps.ts
    - src/core/schema.ts
    - src/observability/telemetry.ts
    - src/observability/types.ts
    - src/tests/angel/boundary/boundary-detector.test.ts
    - src/tests/angel/heartbeat.test.ts
    - src/tests/core/migration/migrations-v33-v34.test.ts
    - src/tests/core/migrations-v32.test.ts
    - src/tests/integration/phase-8-wire-test.test.ts
    - src/tests/integration/phase-10-wire-test.test.ts
decisions:
  - "Single-owner invariant: only boundary-detector.ts writes status='completed'; heartbeat + session-start delegate via promoteSessionToCompleted"
  - "Idempotency guard uses telemetry-presence check (session_end_action / action=session_summary) rather than status check — cursor.ts already writes status='completed' in-transaction, so a status guard would prevent the action chain from firing"
  - "session_end_action INSERT is outside transaction in all callers (matching existing cursor.ts telemetry pattern) — prevents CHECK constraint violation from rolling back closes"
  - "migrateV35toV36 uses table-recreate pattern (mirrors V19-V21 etc.) — SQLite cannot ALTER a CHECK constraint"
  - "initializeSchema requires explicit V36 guard: fresh DBs create telemetry directly from TELEMETRY_SCHEMA (includes session_end_action) so runMigrations incremental path never fires; user_version=36 must be stamped separately"
  - "Date.now() used directly for ended_at_epoch_ms (ms-precision); Math.floor(Date.now()/1000) explicitly not used"
metrics:
  duration: "~3 sessions total"
  completed: "2026-05-16"
  tasks: 8
  files_changed: 15
---

# Phase 14 Plan 14-05: Single-Owner Session-End Lifecycle Summary

**One-liner:** Angel boundary-detector becomes sole writer of `status='completed'` via ordered 5-step action chain with per-action telemetry, V35→V36 migration extending the CHECK constraint, and `promoteSessionToCompleted` delegated from heartbeat + session-start.

## What Was Built

### Task 1 — Audit deliverable (14-05-AUDIT.md)
Identified all production writers of `sessions.status='completed'`: boundary-detector (cursor.ts already owned this correctly), heartbeat.ts (2 direct UPDATE sites), session-start.ts (1 direct UPDATE site), stop.ts (confirmed: no status write). Cursor.ts write kept; 3 writes migrated to delegation pattern.

### Tasks 2–5 — Core implementation

**`promoteSessionToCompleted(db, sessionId, reason)`** in boundary-detector.ts:
- Idempotency guard: SELECT for existing `session_end_action` telemetry with `action='session_summary'`
- If `status='completed'` already set: reads existing `ended_at_epoch_ms` (avoids overwriting cursor.ts timestamp)
- Otherwise: writes `Date.now()` to `status='completed'` + `ended_at_epoch_ms`
- Then calls `fireEndOfSessionActions`

**`fireEndOfSessionActions(db, sessionId, endedAt, reason)`**: 5 ordered actions, each in isolated try/catch with `recordSessionEndAction` telemetry:
1. `session_summary` — idempotency anchor record
2. `pattern_extraction` — extractDirectivesFromSession + classifySessionDomains
3. `highlights_extraction` — extractHighlightsForSession with Sessions/ file check
4. `memory_md_regeneration` — curateMemoryMd
5. `lesson_pointer_update` — listLessonsForProject + ensurePointerId per lesson

**`recordSessionEndAction(db, params)`** in telemetry.ts: non-throwing; pre-V36 DBs silently swallow via catch (additive pattern matching Plan 14-01).

**`SessionEndActionDetail`** and `'session_end_action'` added to types.ts EventKind union + EventKindDetailMap.

**`'session_end_action'`** added to schema.ts TELEMETRY_SCHEMA CHECK constraint.

### Task 4 — Heartbeat + session-start migration

**heartbeat.ts**: Both direct `UPDATE sessions SET status='completed'` sites replaced with `promoteSessionToCompleted`:
- Auto-close escalated-idle path: `promoteAC(ctx.db, session.session_id, 'explicit_close')`
- Orphan-close 4d path: `promoteOrphan(ctx.db, o.session_id, 'crash_recovered')`
- Post-boundary-tick block: queries recently-completed sessions missing action telemetry, calls `promoteSessionToCompleted` per session via Promise.allSettled

**session-start.ts**: Orphan recovery block replaced direct UPDATE with `await promoteSessionToCompleted(ctx.db, orphan.session_id, 'crash_recovered').catch(() => {})`

**sessions.ts**: `endSession()` marked `@deprecated` with migration guidance (no production callers use status='completed').

### Tasks 5–6 — V35→V36 migration

**migration-steps.ts**:
- `telemetryAcceptsSessionEndAction(db)` probe function
- `migrateV35toV36(db)`: table-recreate pattern (rename, drop indexes, create with V36 schema, copy rows via `timestamp_epoch_ms`, drop old table, stamp version=36). Idempotent.
- `migrateV36toV35(db)`: reverse migration; drops `session_end_action` rows

**migrations.ts**: `TARGET_USER_VERSION` 35→36, `[35, migrateV35toV36]` entry added, V36 guard block in `initializeSchema()`.

### Tasks 6–7 — Tests (26 total)
- boundary-detector.test.ts: 10 new tests (idempotency, ordering, outcome, action isolation, skip behavior, reason recording, multi-agent independence) + 6 pre-existing
- heartbeat.test.ts: 2 new tests (action chain fires for recently-completed; does not re-fire for already-promoted) + 8 pre-existing

### Task 8 — Build + sweep + version assertion fixes
5 test files contained hardcoded `toBe(35)` assertions (migrations-v33-v34, migrations-v32, phase-8-wire-test, phase-10-wire-test). Updated to `toBe(36)`. Added V36 guard to `initializeSchema` to stamp user_version on fresh DBs (root cause: fresh DBs bypass incremental migration path entirely).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] initializeSchema never stamps user_version=36 on fresh DBs**
- **Found during:** Task 8 — version assertion tests failed even after TARGET_USER_VERSION was bumped
- **Issue:** Fresh DBs create all tables from DDL directly; `runMigrations` returns early (no `observations` table → version=0 path exits). The V35→V36 migration entry in the migrations array is never reached. `migrateV35toV36` itself also returns early (telemetry already has session_end_action in its DDL). Result: fresh DB stuck at version=35.
- **Fix:** Added explicit `if (currentUv < 36)` guard block in `initializeSchema()` mirroring the V34 and V35 blocks. Calls `migrateV35toV36` (idempotent no-op on fresh DBs) then stamps `user_version=36`.
- **Files modified:** src/core/migrations.ts
- **Commit:** b1c11e9

## Final Audit

**project_id regressions:** Zero in plan-touched files. All `project_id` references in migration-steps.ts are pre-existing V33→V34 migration code.

**bare `*_epoch` regressions:** Zero introduced by Plan 14-05. Pre-existing `last_processed_event_ts_epoch` and `timestamp_epoch` column references in boundary-detector.ts and heartbeat.ts are outside this plan's scope.

**`Date.now()` for ended_at_epoch_ms:** Confirmed — `const endedAt = Date.now()` used directly, not `Math.floor(Date.now()/1000)`.

## Commits

| Hash | Description |
|------|-------------|
| 272118e | docs(phase-14-05): Task 1 — audit all writers of sessions.status='completed' |
| 1e83ef3 | feat(phase-14-05): Tasks 2-5 — single-owner session-end promotion + telemetry migration |
| 5e65afb | test(phase-14-05): Tasks 6+7 — ordered chain + idempotency + heartbeat path tests |
| b1c11e9 | chore(14-14-05): Task 8 — bump version assertions to 36, stamp initializeSchema |

## Self-Check: PASSED
