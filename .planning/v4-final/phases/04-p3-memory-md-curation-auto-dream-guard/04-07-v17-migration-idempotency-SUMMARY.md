---
phase: 04-p3-memory-md-curation-auto-dream-guard
plan: 04-07
subsystem: core/migrations + cc-hooks (DB open path)
tags: [v17-migration, idempotency, session_events, hook-regression, initializeSchema, user_version, views, sqlite]

requires:
  - plan: 02 (V17 migration apply, 2026-04-20 10:40 UTC)
    provides: Live V17 schema with 6 legacy tables renamed to `_old` + views installed on the original names
provides:
  - Version-aware `initializeSchema` that skips V16-era DDL on post-V17 DBs (prevents `CREATE INDEX ... ON <view>` throws)
  - `user_version` no longer demotes 17 → 16 on every DB re-open
  - `src/tests/core/migration/v17-reopen.test.ts` — guard test for any future post-VN re-open regression
affects: [Every CC hook on every project — write path restored; Phase 4 soak now unblocked on the write-path side (Angel resilience separately landed in 04-06)]

tech-stack:
  added: []
  patterns:
    - Version-aware initializeSchema — read `user_version` first, branch on `>= 17`, skip DDL blocks that target tables now replaced by views
    - Never-demote-pragma pattern — read current value before writing, only write if new value is higher

key-files:
  created:
    - src/tests/core/migration/v17-reopen.test.ts
    - .planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-07-v17-migration-idempotency-PLAN.md
    - .planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-07-v17-migration-idempotency-SUMMARY.md
  modified:
    - src/core/migrations.ts — initializeSchema is now version-aware; user_version write is conditional

key-decisions:
  - "Chose the 'better fix' (version-aware initializeSchema) over the minimum
    fix (try/catch around migrateV15toV16 only). The minimum fix was insufficient:
    the new v17-reopen test revealed that `db.exec(SCHEMA_V3)` at line 181
    ALSO contains `CREATE INDEX ... ON learnings/decisions/critical_rules/...`
    which are ALL V17 views. SCHEMA_V3 is a single `exec()` batch — any throw
    aborts the batch and skips subsequent legitimate statements. Wrapping
    individual call sites in try/catch would have masked the SCHEMA_V3 issue
    silently; the version-aware skip addresses the class of bug, not the
    single observed symptom."
  - "On post-V17 DBs, re-exec `TELEMETRY_SCHEMA` and `TEAM_COORDINATION_SCHEMA`
    (orthogonal to the V17 consolidation) and `migrateV16toV17` DDL (pure
    IF NOT EXISTS on the artifact kernel). Keeps fresh-V17 clones
    bootstrap-able without being re-stripped — those statements don't touch
    the views. Skipped: migrateV14toV15, migrateV15toV16, rebuildStaleFts5,
    SCHEMA_V3, migrateSchemaFixes."
  - "`db.pragma('user_version = 16')` is now gated on `currentUv < 16`. The
    unconditional write was a secondary bug: once the V15→V16 throw was
    fixed, every hook open would have silently demoted V17 DBs back to 16.
    runMigrations' early-return gate is `>= 16`, so demotion would not break
    the fast-path immediately, but it would corrupt any future `>= 17`
    version gate. Findings section 'Other related bugs noticed' flagged
    this — landing it in the same plan is cheaper than a follow-up."
  - "Did NOT backfill the 3.5 days of missing hook data. Explicit direction
    from team-lead handoff: data loss accepted. Telemetry, signals,
    thread_state, retrieval_events, checkpoint_tracking all repopulate
    naturally. session_messages in-flight coordination potentially lost,
    low impact."
  - "Did NOT touch the running Angel (PID 15212). Its DB handle was opened
    pre-regression and is valid; this is strictly a DB-open-path fix.
    Fresh CC sessions and re-opened Angel processes will exercise the fix
    naturally."

patterns-established:
  - "Version-aware schema init: `const currentUv = (db.pragma('user_version')
    as Array<{user_version:number}>)[0]?.user_version ?? 0;` followed by
    `if (currentUv >= N) { /* skip */ }` branches. Reusable for any future
    VN→VN+1 that re-shapes tables into views."
  - "Re-open idempotency test pattern: seed pre-migration DB + run real
    migration runner + close + re-open via production `openDatabase` path +
    assert no-throw + exercise a representative write. Every future plan
    that introduces a view/rename should add one of these."

test-deltas:
  baseline: "2556/2577 passing, 21 pre-existing failures (20 llama-server-supervisor + 2 llama-client + 1 flaky e2e-flows)"
  after: "2573/2593 passing, 20 pre-existing failures (one e2e-flows flake happened to pass this run)"
  new: "3 tests in v17-reopen.test.ts — all passing"
  regressions: "Zero. All 20 failures are the same pre-existing llama-server-supervisor + llama-client failures documented in 04-06 SUMMARY and STATE.md."

---

# Plan 04-07: V17 Migration Idempotency Fix

## What shipped

### Root cause (recap)

On a post-V17 DB, `initializeSchema` (called by every `openDatabase`) hit
two fatal throws in sequence — V15→V16's `CREATE INDEX ... ON
project_curated_context(...)` and SCHEMA_V3's `CREATE INDEX ... ON
learnings/decisions/critical_rules/...`. SQLite refuses to index views.
Both throws escaped to `wrapHook`'s catch, CC received `{}` stdout,
zero rows written.

Live-reproduced before the fix (see `04-07-debug-findings.md` for full
evidence chain).

### Fix — version-aware initializeSchema

Three changes to `src/core/migrations.ts`:

1. Read `user_version` after `runMigrations` returns. Compute `isPostV17`.
2. If `!isPostV17`: run the existing DDL block (`migrateV14toV15` →
   `migrateV15toV16` → `migrateV16toV17` → `rebuildStaleFts5` →
   `SCHEMA_V3` → `TELEMETRY_SCHEMA` → `TEAM_COORDINATION_SCHEMA` →
   observations_fts rebuild → `migrateSchemaFixes`) as before.
3. If `isPostV17`: skip the V16-era DDL entirely; only re-assert
   `migrateV16toV17` (artifact kernel DDL; fully idempotent, doesn't
   touch views), `TELEMETRY_SCHEMA`, `TEAM_COORDINATION_SCHEMA`.
4. `db.pragma('user_version = 16')` at function end is now gated on
   `currentUv < 16` — no more silent demotion of V17 DBs.

Commit: `b6056f6 fix(04-07-01): version-aware initializeSchema — skip V16-era DDL on V17 DBs`

### Guard test

`src/tests/core/migration/v17-reopen.test.ts` — 285 lines, self-contained:
seed a V16 DB with one row per legacy kind, run the real V17 migration
runner, close, then re-open via the production `openDatabase` path and
assert:

- open does not throw
- `session_events` INSERT via the re-opened handle returns `changes == 1`
- `user_version` stays at 17 post-open

All 3 passing. Each would have failed loudly had this test existed
before the V17 migration applied.

Commit: `c670379 test(04-07-02): post-V17 re-open idempotency fixture`

## Live spot-check evidence

**Before fix** (read at 2026-04-24T09:09Z, still frozen per findings):
last hook-written session_events row at 2026-04-20T10:38:16Z.

**After fix built into `dist/`** (~2026-04-24T09:17Z):

```
session_id=9e93e1ee-2ea8-4c64-aa80-46aab7737796 | event_type=command         | 2026-04-24T09:19:44Z
session_id=9e93e1ee-2ea8-4c64-aa80-46aab7737796 | event_type=test_run        | 2026-04-24T09:19:32Z
session_id=b94bef90-38da-45fb-9573-43a60ee3cadc | event_type=file_create     | 2026-04-24T09:19:34Z
session_id=3a939eaf-c830-4bd5-a0c2-51efdd166ace | event_type=intent_classification | 2026-04-24T09:19:27Z
session_id=9e93e1ee-2ea8-4c64-aa80-46aab7737796 | event_type=file_edit       | 2026-04-24T09:18:25Z
```

Multiple sessions across multiple projects all writing hook-event types
(`command`, `test_run`, `file_create`, `file_edit`, `intent_classification`)
that are produced exclusively by the CC hook handlers — not by Angel or
the MCP server. Before the fix, every one of these hook invocations
silently returned `{}` with zero rows written. Post-fix, every CC hook
path exercises the new version-aware `initializeSchema` and succeeds.

Ship criterion from team-lead task satisfied: `MAX(timestamp_epoch) FROM
session_events` returned a row from 2026-04-24 post-fix (multiple rows,
from multiple sessions).

## Test outcomes

- `bun run build`: clean, ~58ms esbuild, hook smoke tests all pass (24/24).
- `bun run test`: 2573 passing / 2593 total / 20 failed. All 20 failures
  are the known pre-existing `llama-server-supervisor` + `llama-client`
  suite (documented in 04-06 SUMMARY as non-regressions). One flaky
  `e2e-flows` test that counts toward the 21-baseline happened to pass
  this run.
- `v17-reopen.test.ts`: 3/3 new tests passing.
- No non-pre-existing failures. No tests that previously passed are now
  failing.

## Deferred / NOT done

- **Data backfill**: 3.5 days of hook writes lost. Per team-lead handoff,
  not backfilled. Telemetry and observability tables repopulate from new
  activity. No recoverable data.
- **Observability audit of empty `catch {}` in `session-events.ts`**:
  Flagged in findings "Other related bugs noticed (flagged, NOT chased)".
  Pattern is defensible for non-throwing primitives but hid the
  view-indexing error in this case. Tracked for P5/P6 verification-
  methodology backlog.
- **Hook-binary smoke test at release time**: Findings recommended running
  every hook bundle against a V17 fixture with a canned payload as part of
  the build. The existing build smoke test covers hook-invoke-doesn't-throw
  but not hook-writes-succeed. Worth adding. Not in this plan's scope.
- **ROADMAP.md / STATE.md Phase 4 close**: Separate step under 04-05 SUMMARY.
- **LoCoMo re-kick / soak retry**: Orchestrator follow-up.

## Separate-bug cross-references

- **04-06 Angel resilience**: Shipped in parallel. Addressed a separate
  failure class (silent Angel death from unhandled heartbeat exceptions).
  04-06 explicitly flagged the session_events write-path regression as
  out-of-scope and pointed to this plan as its parallel fix.
- **LongMemEval gate** (session 54 handoff): Was showing 89.6% on a
  stalled LongMemEval — Phase 4 gate evaluation blocked on
  (a) 04-06 Angel resilience (done), (b) this write-path fix (done now),
  (c) fresh soak run post-fix (not in 04-07 scope).

## Files touched

- `src/core/migrations.ts` — initializeSchema version-aware branching (64 insertions, 35 deletions)
- `src/tests/core/migration/v17-reopen.test.ts` — new file (285 lines)
- `.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-07-v17-migration-idempotency-PLAN.md` — plan
- `.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-07-v17-migration-idempotency-SUMMARY.md` — this file

## Commit log

```
c670379 test(04-07-02): post-V17 re-open idempotency fixture
b6056f6 fix(04-07-01): version-aware initializeSchema — skip V16-era DDL on V17 DBs
```
