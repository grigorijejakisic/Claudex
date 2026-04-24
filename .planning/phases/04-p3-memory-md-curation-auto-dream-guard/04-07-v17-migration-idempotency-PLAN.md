---
plan_id: 04-07
phase: 4
wave: 5
depends_on:
  - 04-06
files_modified:
  - src/core/migrations.ts
  - src/tests/core/migration/v17-reopen.test.ts
autonomous: true
requirements:
  - CUR-01
---

# Plan 04-07: V17 Migration Idempotency Fix

## Objective

Close the critical, system-wide regression diagnosed in
`04-07-debug-findings.md`: every CC hook has been a silent no-op for ~3.5 days
because `initializeSchema` re-runs `migrateV15toV16(db)` unconditionally, which
attempts `CREATE INDEX ... ON project_curated_context(...)` against what V17
has already replaced with a view. SQLite cannot index views → throw → caught
by `wrapHook` top-level try/catch → `{}` to stdout, stderr invisible to CC →
row never written.

The fix is mechanical and narrowly scoped: wrap the V15→V16 call symmetric to
the existing V16→V17 wrap, and stop `initializeSchema` from demoting a V17
DB's `user_version` back to 16. Add the missing test that exercises the
post-V17 re-open path.

Findings are authoritative; this plan does NOT re-investigate. It lands (1)
the guard, (2) the user_version fix, (3) the missing test. (4) is optional
and only attempted if (1)-(3) complete with >1h headroom.

## Must-haves (goal-backward)

- **Guard 1 — V15→V16 try/catch**: `migrateV15toV16(db)` call inside
  `initializeSchema` (`src/core/migrations.ts:165`) is wrapped in
  `try { ... } catch { /* post-V17: view blocks index, non-fatal */ }`,
  symmetric to the existing V16→V17 wrap at line 172. The DDL is idempotent
  on fresh/pre-V17 DBs and guaranteed-harmless to fail on post-V17 DBs (the
  table has been replaced with a view; the index is not needed, the view
  reads from `project_curated_context_old` which still has the indexes).
- **Guard 2 — don't demote user_version**: `db.pragma('user_version = 16')`
  at `src/core/migrations.ts:201` must NOT demote a V17 DB. Replace with
  a conditional: read current `user_version` first, only write `= 16` if
  current value is `< 16`. Prevents every hook re-open from silently
  setting 17 → 16.
- **New test — post-V17 re-open**: `src/tests/core/migration/v17-reopen.test.ts`.
  Exercises the missing path: migrate a fresh DB through to V17 exactly as
  prod does, close, then re-open via `openDatabase` and assert no-throw +
  successful write via a hook-style INSERT + `user_version` stays at 17.
  Without this test, any future migration that introduces a post-VN
  re-open defect slips the 2556-test suite the same way V15→V16 did.
- **Build passes**: `bun run build` compiles cleanly (~70ms, esbuild).
- **Tests don't regress**: `bun run test` baseline is 2556/2577 passing with
  21 pre-existing failures (llama-server-supervisor + 1 e2e-flows flake).
  The new re-open test must pass. No other regressions.
- **Live spot-check**: After the fix lands and is rebuilt, trigger a real
  CC hook path (e.g., invoke `dist/adapters/cc-hooks/session-end.cjs` with
  a canned SessionEnd payload OR let a fresh CC session exercise it) and
  confirm `session_events` accepts writes. Query
  `SELECT MAX(timestamp_epoch) FROM session_events` against
  `~/.claudex/db/claudex.db` — expect a row dated 2026-04-24. If still
  frozen at 2026-04-20T10:38Z, the fix didn't land.

## Non-goals / out of scope

- **Backfilling the 3.5 days of missing hook data.** Data loss accepted per
  team-lead handoff. Telemetry / signals / thread_state repopulate
  naturally. `session_messages` in-flight coordination lost — low impact.
- **Touching the running Angel (PID 15212).** Angel's DB handle was opened
  pre-regression and is valid; this is a DB-open-path fix. Fresh CC
  sessions exercise the fix.
- **Kicking benchmarks.** LoCoMo re-kick and soak retry are separate
  follow-ups handled by orchestrator.
- **Editing ROADMAP.md or STATE.md** beyond the quick-task completion row.
  Phase 4 close is a separate step under 04-05 SUMMARY.
- **Observability audit of empty `catch {}` patterns in
  `src/core/session-events.ts`.** Flagged in findings section "Other related
  bugs noticed (flagged, NOT chased)" — tracked for a future verification
  methodology backlog item, not this plan.
- **Version-aware `initializeSchema` rewrite** (findings "Better fix").
  Only attempted as task 04-07-04 if tasks 01–03 land with >1h headroom.
  If skipped here, it's a P5/P6 follow-up, NOT a blocker.

## Tasks

<task id="04-07-01">
  <subject>Guard V15→V16 call + fix user_version demotion in initializeSchema</subject>
  <description>
Edit `src/core/migrations.ts` `initializeSchema` function. Two changes, both
in-function:

1. Line 165 — wrap `migrateV15toV16(db)` in try/catch symmetric to the
   existing V16→V17 wrap one line below:

   ```ts
   // current (broken on post-V17 DBs — indexes a view):
   migrateV15toV16(db);

   // fix:
   try { migrateV15toV16(db); } catch { /* post-V17: view blocks index, non-fatal */ }
   ```

2. Line 201 — replace the unconditional
   `db.pragma('user_version = 16')` with a conditional that does not
   demote a higher version:

   ```ts
   // current (broken — demotes V17 DBs every re-open):
   db.pragma('user_version = 16');

   // fix:
   const currentUv = (db.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version ?? 0;
   if (currentUv < 16) db.pragma('user_version = 16');
   ```

   The shape mirrors the existing reads of user_version elsewhere in this
   file (lines 75–76). Do not introduce a new helper — keep it inline and
   local for reviewability.

Rebuild bundles (`bun run build`) so hook bundles pick up the fix.

Verify by running the existing migration test suite — the V15→V16 and V17
tests MUST still pass, and none must regress.

Commit: `fix(04-07-01): guard V15→V16 re-run + stop demoting user_version`
  </description>
</task>

<task id="04-07-02">
  <subject>Add post-V17 re-open test fixture</subject>
  <description>
New file: `src/tests/core/migration/v17-reopen.test.ts`.

Shape (matching `src/tests/core/migration/v17-runner.test.ts` patterns):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runV17Migration } from '../../../core/migration/v17-runner.js';
import { writeStaleReview } from '../../../core/migration/stale-review-parser.js';
import { openDatabase } from '../../../core/storage.js';
import type { EmbedderLike } from '../../../core/migration/v17-embed-stage.js';

function mkTempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-reopen-')); }
function makeFakeEmbedder(): EmbedderLike {
  return { embedBatch: async (texts) => texts.map((t) => Array.from({ length: 1024 }, (_, i) => (t.length + i) / 2048)) };
}
// seedV16Db + seedRowsIntoV16 — copy the helpers from v17-runner.test.ts, or
// import if refactor is in scope; for this plan copy is simplest.

describe('initializeSchema idempotency — post-V17 re-open', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkTempDir();
    dbPath = path.join(tmp, 'source.db');
    // Arrange: bring a fresh DB up to V17 exactly as prod does
    const db = seedV16Db(dbPath);
    seedRowsIntoV16(db);
    db.close();
    // Apply the real V17 runner
    return runV17Migration({
      dbPath,
      backupDir: path.join(tmp, 'backups'),
      staleReviewPath: path.join(tmp, 'stale.md'),
      embedder: makeFakeEmbedder(),
      dryRun: false,
    }).then((r) => {
      if (r.verdict !== 'PASS') throw new Error(`setup failed: ${JSON.stringify(r.errors)}`);
    });
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it('openDatabase does not throw on a post-V17 DB', () => {
    expect(() => {
      const db = openDatabase(dbPath);
      db.close();
    }).not.toThrow();
  });

  it('session_events INSERT succeeds after re-open', () => {
    const db = openDatabase(dbPath);
    try {
      // session_events shape matches src/core/session-events.ts recordEvent
      const result = db.prepare(`
        INSERT INTO session_events (session_id, event_type, project, detail, timestamp_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-session', 'test_event', 'p', '{}', Math.floor(Date.now() / 1000));
      expect(result.changes).toBe(1);
    } finally {
      db.close();
    }
  });

  it('user_version stays at 17 after openDatabase (does not demote)', () => {
    const db = openDatabase(dbPath);
    try {
      const uv = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
      expect(uv).toBe(17);
    } finally {
      db.close();
    }
  });
});
```

Notes for the executor:

- If `seedV16Db` / `seedRowsIntoV16` are not exported, copy the functions
  verbatim from `v17-runner.test.ts` — don't refactor (out of scope).
- If the `session_events` schema column names differ at insert time,
  check `src/core/schema.ts` for the canonical DDL — the columns above
  match what `src/core/session-events.ts` uses today.
- Assertions should be strict — if the re-open throws, the test must fail
  clearly pointing at the view-indexing error.

Commit: `test(04-07-02): post-V17 re-open idempotency fixture`
  </description>
</task>

<task id="04-07-03">
  <subject>Build, full test suite, live spot-check against real DB</subject>
  <description>
1. `bun run build` — must compile cleanly (~70ms). Bundles
   `dist/adapters/cc-hooks/session-end.cjs` etc. must regenerate. Record
   elapsed time + bundle sizes for the SUMMARY.

2. `bun run test` — full vitest run. Baseline: 2556/2577 pass; 21
   pre-existing failures (llama-server-supervisor* + 1 e2e-flows flake).
   Required outcomes:
   - New re-open test: 3/3 passing.
   - No other passing test becomes failing.
   - Total count moves to 2559/2580 (or equivalent — new fixture adds
     3 tests).
   Capture the vitest summary for the SUMMARY.

3. Live spot-check against the real DB:
   - Take the last-known-bad timestamp on `session_events`:
     `SELECT MAX(timestamp_epoch) FROM session_events` (expected
     stale at 2026-04-20T10:38:16Z before fix).
   - Exercise the bundled hook: either
     a) invoke `node dist/adapters/cc-hooks/session-end.cjs` with a canned
        SessionEnd JSON payload on stdin (use the same shape the findings
        repro used — search findings for the payload example), OR
     b) wait for a fresh CC session to tick through SessionStart or
        UserPromptSubmit naturally (any hook write serves as proof).
   - Re-query `MAX(timestamp_epoch)`. Expect a row from 2026-04-24. If
     still 2026-04-20, the fix did NOT land — follow the failure
     protocol in the SUMMARY (notify team-lead, do NOT claim done).

4. Record the before/after values in the SUMMARY. Exit code + stderr from
   the hook invocation (path a) should be clean — stdout `{}` is still
   expected (hooks always emit empty JSON), stderr should be silent.

5. Do NOT kill the running Angel (PID 15212 per handoff). The fix is a
   DB-open-path fix; Angel's handle is pre-regression and valid.

This task has no commit of its own — outputs are evidence captured in the
04-07 SUMMARY.md.
  </description>
</task>

<task id="04-07-04">
  <subject>[OPTIONAL] Version-aware initializeSchema (only if tasks 01-03 leave >1h headroom)</subject>
  <description>
Only attempt if tasks 01–03 completed within ~2h total. Otherwise skip and
leave a follow-up pointer in the SUMMARY.

Read `PRAGMA user_version` once at the top of `initializeSchema`. Only call
the specific VN→VN+1 migration steps that are actually needed for the
current version. Specifically:

- If `user_version >= 17`: skip V14→V15, V15→V16, V16→V17 entirely. The
  DB is already migrated. Still load sqlite-vec (per-connection
  requirement). Still run `rebuildStaleFts5`, the SCHEMA_V3 idempotent
  creates, and `migrateSchemaFixes` — those guard themselves and are
  cheap/safe.
- If `user_version == 16`: skip V14→V15, V15→V16. Only run V16→V17 DDL
  stub.
- If `user_version < 16`: existing behavior.

Existing `runMigrations` already does version-gated migration via the
PRAGMA; the duplicate calls in `initializeSchema` exist as a "fresh-DB
belt and braces" for the V14→V15 vec0 pattern. The fresh-DB path (where
`observations` is absent and `runMigrations` early-returns without
touching user_version) needs V14→V15 and V15→V16 to run once to create
tables — the natural gate is "user_version started at 0 AND we just ran
the fresh-DB init". In practice: check `user_version` AFTER
`runMigrations` returns; if still 0 (genuine fresh DB), run V14→V15 and
V15→V16 unconditionally; else use the version-gated logic above.

Add one more test to `v17-reopen.test.ts`: assert that after a re-open,
`migrateV15toV16` is NOT called (check via a spy OR by asserting no
`CREATE INDEX` errors in a captured stderr — the simpler check is fine).

Commit: `refactor(04-07-04): version-aware initializeSchema`

If skipped, note it in the SUMMARY as a P5/P6 follow-up candidate.
  </description>
</task>

<task id="04-07-05">
  <subject>SUMMARY + atomic commits</subject>
  <description>
Write `.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-07-v17-migration-idempotency-SUMMARY.md`
matching the shape of 04-06-angel-resilience-SUMMARY.md. Cover:

- Root cause recap (pointer to findings file, don't duplicate)
- Two guards landed (V15→V16 try/catch + user_version conditional) with
  commit SHAs
- New test fixture added (commit SHA) + what it asserts
- Task 04 outcome (shipped OR deferred as follow-up, with rationale)
- `bun run build` + `bun run test` evidence (timings, test counts,
  baseline comparison: 2556/2577 → 2559/2580 expected)
- Live spot-check results: before/after `MAX(timestamp_epoch)` on
  `session_events`, exit codes, stderr cleanliness
- Explicit data-loss acknowledgement: 3.5 days of hook writes lost per
  team-lead directive, NOT backfilled
- Separate-bug cross-references: Angel resilience plan 04-06 ships in
  parallel; this plan addresses the write-path regression flagged as
  out-of-scope in 04-06
- Follow-ups NOT done here: observability audit of empty
  `catch {}` in `session-events.ts`, version-aware `initializeSchema`
  if task 04 was skipped, hook-binary smoke test at release time

Commits (atomic, per repo convention — check `git log --oneline -15`
for the `fix(04-06-XX): ...` style):

- `fix(04-07-01): guard V15→V16 re-run + stop demoting user_version`
- `test(04-07-02): post-V17 re-open idempotency fixture`
- `refactor(04-07-04): version-aware initializeSchema` (if shipped)
- `docs(04-07): SUMMARY for V17 migration idempotency fix`

Do NOT commit `.planning/STATE.md` — the /gsd:quick driver handles that
in a separate final commit.
  </description>
</task>

## Verification

- `src/core/migrations.ts:165` has `try { migrateV15toV16(db); } catch { }`
- `src/core/migrations.ts:201` reads user_version and only writes `= 16` when
  current value is `< 16`
- `src/tests/core/migration/v17-reopen.test.ts` exists and has 3 passing
  assertions (open-no-throw, INSERT succeeds, user_version stays 17)
- `bun run build` compiles cleanly
- `bun run test` finishes with baseline pass count + 3 new tests passing
  (2559/2580 or equivalent); no non-pre-existing failures
- `SELECT MAX(timestamp_epoch) FROM session_events` returns a row from
  2026-04-24 post-fix (live evidence the fix landed)
- Atomic commits landed per task per repo convention
- `04-07-v17-migration-idempotency-SUMMARY.md` written
- Running Angel (PID 15212) untouched
- No backfill of missing hook data attempted
- ROADMAP.md and STATE.md (Phase 4 close section) untouched
