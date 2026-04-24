# 04-07 Debug Findings — session_events write regression

**Status:** Root-caused. Live-reproduced. Fix scope is broad but mechanical.
**Severity:** Critical — all CC-hook DB writes have been silently failing for ~3.5 days across every project on this machine.

---

## Root cause (one paragraph)

Every time a CC hook opens the DB, `openDatabase` → `initializeSchema`
(`src/core/migrations.ts:148`) unconditionally calls `migrateV15toV16`
(`src/core/migration-steps.ts:1390`). That function issues two
`CREATE INDEX IF NOT EXISTS idx_pcc_project_* ON project_curated_context(...)`
statements. After the V17 migration applied on 2026-04-20 10:40 UTC, the
underlying table was renamed to `project_curated_context_old` and a VIEW was
installed in its place (`src/core/migration/v17-triggers.ts`, generated from
`KIND_MAPPING`). SQLite cannot index views — the statement raises
`"views may not be indexed"`. That exception escapes
`initializeSchema` (no try/catch around the call), propagates out of
`openDatabase`, and is caught by `wrapHook`'s top-level `try/catch`
(`src/adapters/cc-hooks/infrastructure.ts:233`) which writes `{}` to stdout,
logs to stderr (invisible to CC), and returns cleanly. Every hook across every
project has been a no-op since the migration — not just `session_events`. The
hook-level `recordEvent` wasn't even reached; the DB handle never got returned
to the handler.

Live-reproduced by invoking `dist/adapters/cc-hooks/session-end.cjs` with a
real SessionEnd payload against the actual DB:

```
[claudex] SessionEnd error: views may not be indexed
```

No row was inserted for the test session_id.

---

## Evidence chain

1. **All hook-written tables frozen at the same instant.** Row counts +
   `MAX(timestamp_epoch)` across every hook-written table (datetime in UTC):

   | Table                 | MAX timestamp        | Status  |
   | --------------------- | -------------------- | ------- |
   | session_events        | 2026-04-20T10:38:16Z | STUCK   |
   | sessions              | 2026-04-20T08:24:20Z | STUCK   |
   | conversation_turns    | 2026-04-20T10:31:58Z | STUCK   |
   | session_journal       | 2026-04-20T10:38:00Z | STUCK   |
   | session_signals       | 2026-04-20T10:34:35Z | STUCK   |
   | thread_state          | 2026-04-20T10:38:16Z | STUCK   |
   | retrieval_events      | 2026-04-20T08:24:21Z | STUCK   |
   | telemetry             | 2026-04-20T10:38:16Z | STUCK   |
   | action_transitions    | 2026-04-20T10:32:03Z | STUCK   |
   | session_messages      | 2026-04-20T09:25:53Z | STUCK   |

   Not a session_events-specific bug.

2. **V17 was applied at 2026-04-20 12:40 CEST = 10:40 UTC**
   (commit `18e952f feat(02): apply V17 migration to live DB — 1052 rows
   migrated; schema_version=17`). Cutoff falls inside that window (the last
   hook writes were from the same session that was running the migration).

3. **Schema confirms the view substitution.** `sqlite_master` for
   `project_curated_context` shows `type='view'`, backing table
   `project_curated_context_old` is present. V17 trigger `project_curated_context_instead_insert`
   exists as INSTEAD OF INSERT. All per-V17 design.

4. **Raw INSERT into `session_events` works** (from node scripts outside the
   hook path): table accepts writes, schema shape is correct. I landed id
   64208 as a probe during investigation.

5. **What IS still writing** is the `artifact` kernel — `mental_model`
   kind has entries up to 2026-04-24T00:30:32Z, all from other CC sessions
   on other projects (big-mozzart-clean, vesna-6abb357b). Those go through
   the MCP `claudex_curated_context` tool (`src/mcp/recall-server.ts`), which
   runs in a long-lived server process whose DB handle was opened before
   V17 ran and never re-opened. The MCP server doesn't exercise the
   `initializeSchema` re-open path on every call, so it sidesteps the
   defect. Angel (long-lived process spawned pre-V17 and since respawned)
   similarly opens the DB once; its writes (e.g., reranker supervision,
   heartbeat) also continue.

6. **Isolated repro:** executing just the `migrateV15toV16` SQL against the
   live DB:

   ```
   node -e "const db = new Database('...'); db.exec('CREATE INDEX IF NOT EXISTS idx_pcc_project_status ON project_curated_context(project, status)')"
   // SqliteError: views may not be indexed
   ```

7. **Full hook path repro** (properly-escaped JSON payload to
   `session-end.cjs`): stdout `{}`, stderr
   `[claudex] SessionEnd error: views may not be indexed`, exit 0, no row
   inserted. `wrapHook`'s `catch (err)` in `infrastructure.ts:233` is
   exactly where the error surfaces.

8. **Bundled code matches source.** `dist/adapters/cc-hooks/session-end.cjs`
   line 3577 calls `migrateV15toV16(db);` without a surrounding try/catch —
   identical to the source shape in `src/core/migrations.ts:165`. The
   sibling `migrateV16toV17` call one line below IS wrapped in
   `try { ... } catch { }`, but V15→V16 is not.

---

## Scope

### Affected tables (stuck since 2026-04-20)

Every table written to by CC hooks (not an exhaustive list — these are the
ones I verified):

- `sessions`, `session_events`, `conversation_turns`
- `session_journal`, `session_signals`, `thread_state`, `session_messages`
- `retrieval_events`, `telemetry`, `action_transitions`
- `pressure_scores` (already stale since March, separate dead code path)
- `observations` (already stale since March, separate)
- Anything else written transitively via `ctx.db` inside a hook handler

### Affected processes

- **CC hooks** — completely broken across every project (26 hook bundles).
- **OpenClaw bridge** (`src/adapters/openclaw-bridge/plugin-entry.cjs`) —
  same shared lifecycle code path. If it opens the DB via `openDatabase`
  it is also broken. Evidence: plugin entry bundle exists and is compiled
  from the same sources; if it re-opens DB the same way, it hits the
  same throw.

### NOT affected

- **Angel** (`dist/angel/index.cjs`) — runs as a long-lived process; opened
  DB handle once pre-V17 (PID 15212 on current run). All its writes go
  through the artifact INSTEAD OF INSERT triggers or direct `artifact` inserts,
  not through `project_curated_context` indexing.
- **MCP server** (`dist/mcp/recall-server.cjs`) — long-lived; same reasoning.
- **CLI tools invoked manually** — each CLI invocation does re-open, so
  any CLI that writes to a hook-targeted table is also broken. But
  Angel / MCP / migration CLI all use their own paths and were unaffected
  in practice.

### Severity

**Critical, system-wide.** Phase 4 memory curation queue is
one symptom — the underlying failure is that the entire CC-hook
observability layer has been dark for 3.5 days. Cross-session threading,
conversation tracking, telemetry, signals, checkpoint tracking, critical-rule
TTL decay, Q-value updates, intent prediction accuracy, experience-flag
persistence — anything a hook writes is gone. The `memory_curation_pending`
enqueue in `session-end.ts:47` is a tiny tip of an iceberg.

---

## Proposed fix (plan 04-07 sketch)

### Minimum fix (ship today, < 1h effort, low risk)

Wrap `migrateV15toV16(db)` in a try/catch inside `initializeSchema`
(`src/core/migrations.ts:165`), symmetric to the existing V16→V17 wrap at
line 172. Rationale: V15→V16 is idempotent and the DDL only matters on
first application; once V17 has replaced the table with a view, re-running
the CREATE INDEX is guaranteed to fail and guaranteed to be harmless.

```ts
// current (broken):
migrateV14toV15(db);
migrateV15toV16(db);
try { migrateV16toV17(db); } catch { /* non-fatal */ }

// fix:
migrateV14toV15(db);
try { migrateV15toV16(db); } catch { /* post-V17: view blocks index, non-fatal */ }
try { migrateV16toV17(db); } catch { /* non-fatal: may fail on older sqlite-vec */ }
```

Also rebuild and confirm `dist/adapters/cc-hooks/session-end.cjs` emits
no stderr for the live-payload repro.

### Better fix (same plan, slightly more effort, same risk)

Make `initializeSchema` version-aware: if `PRAGMA user_version >= 17`,
skip V14–V16 re-application entirely. They were all gated by version
checks inside `runMigrations`; `initializeSchema` calls them
unconditionally as a "fresh-DB belt and braces" which is exactly what
trips this. The current design (`src/core/migrations.ts:148-202`) is
that `initializeSchema` handles both fresh DBs and post-migration
re-opens with the same codepath; that codepath is the bug.

### Bonus: post-fix data audit

Phase 4 curation queue is empty but other tables have missed 3.5 days
of data. Most of it is ephemeral (telemetry, signals, thread_state —
re-populate naturally from new activity). Things worth back-filling:

- **session_messages** — cross-session coordination; 0 in-flight
  messages probably lost. Low impact.
- **Nothing else is recoverable**; hooks are fire-and-forget on
  event streams that have moved on.

### Pre-commit guard

Add a test in `src/tests/adapters/cc-hooks/` that:
1. creates a temp DB
2. runs V17 migration on it (new file: `V17-migrated fixture`)
3. re-opens it via `openDatabase`
4. asserts no throw + writes via `recordEvent` succeed

This is the missing test (see Test Gap below).

**Effort:** 1-3h for minimum fix + new test; 3-6h including the audit
+ guard test + a brief integration test that runs every hook bundle
against a V17 fixture. **Risk:** very low — the fix is a try/catch
around idempotent DDL that already fails.

---

## Test gap

### Why the 2556-test suite didn't catch this

1. **Migration tests use fresh DBs.** Every test in
   `src/tests/core/migration/` constructs a fresh `:memory:` DB or temp
   file and runs migrations forward from user_version=0. No test opens
   an already-V17 DB via `openDatabase`. The bug manifests ONLY on a
   post-V17 re-open.
2. **Hook tests use fresh DBs.** Same pattern — each test invokes
   `openDatabase` on an empty file. `initializeSchema` hits the
   "run all migrations forward" path with no views in the way.
3. **V17 runner tests** (`v17-runner.test.ts`) exit after Phase B
   completes; they never re-open the DB through `openDatabase`
   afterwards. They verify the migration produces the right schema but
   not that the schema survives a re-open.
4. **No integration test runs a bundled hook binary.** We test handler
   functions in isolation with mocked `ctx.db`. The real hook path
   (`readStdin → bootstrapHook → openDatabase → initializeSchema → handler`)
   is exercised by CC in production and by nothing else.

### What would have caught it

A single test added to `src/tests/core/migration/v17-*.test.ts`:

```ts
test('initializeSchema is idempotent against a post-V17 DB', () => {
  const db = new Database(':memory:');
  // arrange: migrate a fresh DB through to V17 exactly as prod does
  initializeSchema(db);                       // V15→V16→(stub V17)
  runV17Migration({ dbPath: ':memory:', ... }); // the real runner
  db.close();

  // act + assert: re-opening must not throw
  const db2 = openDatabase(':memory:');
  expect(() => {
    db2.prepare('INSERT INTO session_events(...)').run(...);
  }).not.toThrow();
});
```

This belongs in the phase-04-07 plan and should be broadened into a
general "every released migration must survive a re-open" rule.

### Follow-up methodology item

The `catch {}` empty-catch pattern is pervasive across the hook path
(`recordEvent`, `recordEventDeduped`, `saveSessionSummary`,
`getLastSessionSummary`, almost every function in `session-events.ts`).
That pattern is defensible for non-throwing primitives at the call site,
but it means schema-level or open-time failures are invisible in
production. Recommend:

- Surface hook-bootstrap errors to **telemetry** (not just stderr), even
  when `ctx.db` is null — fall back to writing an error file under
  `~/.claudex/logs/hook-errors.log`.
- Add a smoke test to the release process: open the DB via `openDatabase`
  against a V17 fixture and run every hook bundle with a canned payload.
  Assert row counts increase.

Flagged here for the verification-methodology backlog, not for this fix.

---

## Other related bugs noticed (flagged, NOT chased)

1. **`db.pragma('user_version = 16')` at `src/core/migrations.ts:201`**.
   `initializeSchema` unconditionally resets user_version back to 16, even
   on a V17-migrated DB. The live DB's `user_version = 17` was set by the
   V17 runner and is currently correct only because `initializeSchema` is
   failing before reaching that line. Once the V15→V16 fix lands, every
   hook re-open will silently demote the pragma from 17 to 16. That will
   not break `runMigrations` (early-return gate is `>= 16`), but it is
   wrong and will confuse any future `>= 17` gate. Should be fixed in the
   same plan.
2. **`migrateV16toV17(db)` in `initializeSchema:172`** calls `applyV17DDL`
   which creates the V17 kernel DDL on every open. It's inside a try/catch,
   so a failure is hidden, but the DDL is fully idempotent (IF NOT EXISTS
   everywhere). Works, but is wasted work on every hook invocation.
3. **Empty catch `{}` in `recordEvent`** (`src/core/session-events.ts:44`) —
   this hid the view-indexing error (if it had ever reached `recordEvent`,
   which it did not in this case). Same concern applies across
   `session-events.ts`. Worth an observability audit but not blocking.

---

## Key file paths (absolute)

- `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\core\migrations.ts:165` — unguarded `migrateV15toV16` call
- `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\core\migration-steps.ts:1390` — throwing DDL
- `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\adapters\cc-hooks\infrastructure.ts:142-149` — bootstrapHook
- `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\adapters\cc-hooks\infrastructure.ts:233-248` — wrapHook catch (where the error silently exits)
- `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\dist\adapters\cc-hooks\session-end.cjs:3577` — bundled unguarded call
- `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\core\migration\v17-triggers.ts` — view generator
- `C:\Users\Grigorije\.claudex\db\claudex.db` — live DB, user_version=17

---
