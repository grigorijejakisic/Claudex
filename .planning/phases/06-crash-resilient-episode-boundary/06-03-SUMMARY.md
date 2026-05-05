---
phase: 06-crash-resilient-episode-boundary
plan: 03
subsystem: cc-hooks
tags: [hooks, heartbeat, episodic-events, session-end, phase-6]

requires:
  - phase: 06-01
    provides: V29 sessions.last_heartbeat_ts column + episode_boundary_cursor table
  - phase: 06-02
    provides: chokidar JSONL watcher (heartbeat is the second corroborator alongside JSONL freshness)
provides:
  - last_heartbeat_ts UPDATE in 4 non-terminal hooks (UserPromptSubmit / PreToolUse / PostToolUse / Stop)
  - emitCleanEndsessionClose helper (atomic transaction; heartbeat + status='completed' + episode_closed env event + cursor advance)
  - SessionEnd integration calling the helper after existing session_boundary write
  - 6-assertion regression test (heartbeat-column-writes.test.ts)
affects: [phase-6-plan-04, phase-6-plan-05]

tech-stack:
  added: []
  patterns:
    - "Helper module extraction for testability. session-end.ts calls main() unconditionally (reads stdin). Extracted emitCleanEndsessionClose to a separate module so tests import the function without firing the script entry point."
    - "Telemetry-outside-transaction for forward-compat with CHECK enum extension. The episodic_close_emitted event_kind isn't in the V20 CHECK enum yet; if it were inside the close-marker transaction, a CHECK violation would roll back the close itself. Outside the tx + swallow keeps the close durable while telemetry waits for the enum extension."
    - "5-hook heartbeat tick pattern. Every CC hook handler updates sessions.last_heartbeat_ts on entry, wrapped in try/catch so a DB lock or schema mismatch never fails the hook (per .claude/rules/hooks-safety.md)."
    - "Idempotent cursor UPSERT preserving last_processed_jsonl_offset. ON CONFLICT(project, session_id) DO UPDATE only touches last_processed_event_ts_epoch + last_close_event_id; the offset is preserved via COALESCE-from-existing-row sub-select on INSERT."

key-files:
  created:
    - src/adapters/cc-hooks/session-end-close-marker.ts
    - src/tests/adapters/cc-hooks/heartbeat-column-writes.test.ts
  modified:
    - src/adapters/cc-hooks/user-prompt-submit.ts
    - src/adapters/cc-hooks/pre-tool-use.ts
    - src/adapters/cc-hooks/post-tool-use.ts
    - src/adapters/cc-hooks/stop.ts
    - src/adapters/cc-hooks/session-end.ts
  deleted: []

key-decisions:
  - "Extract emitCleanEndsessionClose into a separate module rather than exporting from session-end.ts. session-end.ts has unconditional main() at file end which reads stdin via readStdin() — importing the module from a test would hang. The new file (session-end-close-marker.ts) carries only the helper, can be unit-tested directly, and session-end.ts becomes a thin caller."
  - "Telemetry write OUTSIDE the close-marker transaction. The telemetry CHECK enum (last extended in V20) doesn't admit episode_close_emitted; a CHECK violation inside the transaction would roll back the close itself. Telemetry is best-effort observability — the close is the load-bearing artifact. Same pattern as Plan 02's jsonl_watcher_unreachable swallow."
  - "PreToolUse hook's _ctx parameter renamed to ctx now that the heartbeat write reads ctx.db. Previously the hook didn't touch the DB; the heartbeat tick is its first DB write. wrapHook's signature already provides db on every hook so no infrastructure change needed."

requirements-completed: [EBD-02]

duration: 7 min
completed: 2026-05-05
---

# Phase 6 Plan 03: heartbeat hook writes + clean_endsession close marker

**5 hooks now feed sessions.last_heartbeat_ts on every fire, giving Plan 04's composition rule fresh per-session liveness data. SessionEnd is the only path that emits the clean_endsession close marker — atomically with the cursor advance — so Plan 04's boundary detector short-circuits already-closed sessions and avoids the duplicate-close race (Pitfall 2). 6-test regression suite proves the SQL surface + atomicity guarantee.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-05-05T20:50Z
- **Completed:** 2026-05-05T20:57Z
- **Tasks:** 3
- **Files modified:** 5
- **Files created:** 2

## Accomplishments

- 4 non-terminal hooks (`user-prompt-submit.ts`, `pre-tool-use.ts`, `post-tool-use.ts`, `stop.ts`) each carry a single try/catch-wrapped `UPDATE sessions SET last_heartbeat_ts = ? WHERE session_id = ?` near the top of the handler.
- `pre-tool-use.ts`: previously had `_ctx` (db unused); renamed to `ctx`; first DB write in this hook.
- `user-prompt-submit.ts`: added explicit `cachedPrepare` import (was used implicitly elsewhere in the file via line-374 / 384 / 436 callers).
- `src/adapters/cc-hooks/session-end-close-marker.ts` (new, 110 lines):
  - `emitCleanEndsessionClose(db, sessionId, project)` — atomic 3-statement tx: UPDATE sessions + INSERT episodic_events + UPSERT episode_boundary_cursor.
  - Telemetry write (`episode_close_emitted`) outside the tx so a CHECK violation does not roll back the close.
  - durationSeconds computed from sessions.created_at_epoch (best-effort, defaults 0 if null).
  - SHA-256 content_hash matches Phase 1's `episodic-events.ts:sha256()` shape.
  - Outer try/catch records `episodic_write_failure` telemetry on transaction failure; NEVER throws.
- `session-end.ts`: imports the helper, calls it after the existing `writeEnvironmentalEvent('session_boundary', ...)` block.
- `src/tests/adapters/cc-hooks/heartbeat-column-writes.test.ts` (new, 145 lines, 6 tests):
  - 4 hook-style heartbeat assertions.
  - SessionEnd happy path: status='completed' + ended_at_epoch set + last_heartbeat_ts > 0 + 1 episodic_events row with metadata containing 'clean_endsession' + 1 cursor row with last_close_event_id matching the env event id.
  - Atomicity: DROP TABLE episodic_events mid-flight → helper does NOT throw, status remains 'active', last_heartbeat_ts NULL, cursor row absent.

## Task Commits

1. `68bcbc3` — feat(06-03): add last_heartbeat_ts UPDATE to 4 non-terminal CC hooks
2. `04f4c0f` — feat(06-03): SessionEnd emits clean_endsession close marker atomically
3. `906bafc` — test(06-03): regression test for heartbeat column writes + clean_endsession atomicity

## Verification Results

- `bun run build`: clean.
- `bun run test src/tests/adapters/cc-hooks/`: 157/157 pass (no regressions on Phase 1 / Phase 4 tests).
- `bun run test src/tests/adapters/cc-hooks/heartbeat-column-writes.test.ts`: 6/6 pass (56ms).
- `bun run vesna`: 18/18 PASS at 100% (entry-recall, constraint-recall, handoff-pickup, cross-project, lesson-application, self-instrumented).

## Deviations from Plan

**[Rule 4 - Architectural] Extract emitCleanEndsessionClose to a separate module file**
- Found during: Task 3 test design
- Issue: Plan specified exporting `emitCleanEndsessionClose` from `session-end.ts`. But that file has unconditional `main()` at the bottom which calls `readStdin()`; importing the module from the test would hang waiting for stdin.
- Fix: Created `src/adapters/cc-hooks/session-end-close-marker.ts` carrying only the helper. session-end.ts becomes a thin caller. No semantic change to the hook's behavior.
- Decision rationale: a structural change (new file) but it's a pure refactor of the close-marker emission path; the helper has the same contract the plan required. Communicated as Rule 4 because the plan named a specific file for the export.
- Files: `src/adapters/cc-hooks/session-end-close-marker.ts` (new), `src/adapters/cc-hooks/session-end.ts` (changed import).

**[Rule 1 - Bug] Telemetry INSERT inside tx would roll back the close marker**
- Found during: Task 3 atomicity analysis
- Issue: Initial implementation put `INSERT INTO telemetry (..., 'episode_close_emitted', ...)` inside the close-marker transaction. The telemetry CHECK enum doesn't admit `episode_close_emitted` yet (last extended in V20 / V21); a CHECK violation would roll back the close itself.
- Fix: Moved telemetry write OUTSIDE the transaction with its own swallow try/catch. Same pattern as `jsonl_watcher_unreachable` in Plan 02 and `telemetry-counters.ts`.
- Files: `src/adapters/cc-hooks/session-end-close-marker.ts`.
- Verification: Test "atomicity — transaction failure leaves NO partial state" still passes; close marker now durable independent of telemetry success.

**Total deviations:** 2 auto-fixed (1 architectural with helper-extract reasoning; 1 bug fix). **Impact:** durability of the close marker is improved; telemetry remains best-effort.

## Issues Encountered

None.

## Next Phase Readiness

- Plan 04 unblocked: composition rule + boundary detector reads `sessions.last_heartbeat_ts` (now bumped on every hook), `sessions.last_jsonl_write_ts` (Plan 02 watcher), and `episode_boundary_cursor.last_close_event_id` (Plan 03 SessionEnd UPSERT). Short-circuit logic for already-closed sessions is now possible.
- Plan 05 unblocked: Angel integration can rely on the SessionEnd close-marker being persistent + cursor advance happening atomically with status flip.

Ready for **06-04-PLAN.md** (composition rule + cursor + boundary detector with heartbeat-compare-before-cleanup guard).
