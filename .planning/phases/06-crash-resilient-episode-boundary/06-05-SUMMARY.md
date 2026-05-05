---
phase: 06-crash-resilient-episode-boundary
plan: 05
subsystem: angel
tags: [angel, integration, watcher, boundary-tick, vesna, phase-6, ship]

requires:
  - phase: 06-01
    provides: V29 schema (cursor table + sessions liveness columns)
  - phase: 06-02
    provides: chokidar watcher + thresholds + pid-liveness leaves
  - phase: 06-03
    provides: hook-driven heartbeat ts feeding the classifier; clean_endsession close marker
  - phase: 06-04
    provides: composition rule + cursor + boundary detector sweep loop
provides:
  - Angel.heartbeatTick now runs runBoundaryTick after retention sweep on every cadence
  - Angel boot starts startJsonlWatcher; graceful shutdown closes it cleanly
  - TickResult extended with 5 boundary_* fields for observability surfaces
  - 2 new integration tests (integration + cursor-replay) locking the SHALL atomicity invariant
  - V28-trigger.test.ts updated to expect V29
affects: [phase-7-coexistence-migration-ship]

tech-stack:
  added: []
  patterns:
    - "Dynamic-import inside the hot loop. heartbeatTick uses `await import('./boundary/...')` rather than top-of-file imports. Why: heartbeat.ts already has 1100+ lines and 47 top-level imports; one more pair pollutes the module's import surface. Dynamic import inside the per-tick try/catch keeps the dependency localized to the new code path. Trade-off: ~5ms first-tick cost, then cached by Node's module loader. Acceptable given heartbeat cadence is 2 minutes."
    - "Async shutdown for clean watcher close. Existing shutdown() handler was synchronous. Promoted to async + awaiting jsonlWatcher.close() so chokidar releases its file handles before db.close() and process.exit(0). Signal handlers use `() => shutdown(...)` thunk so process.on() doesn't see an unhandled-promise emission."
    - "Degraded-mode watcher boot. startJsonlWatcher is wrapped in try/catch at the call site (in addition to the watcher's internal error recovery). If chokidar bind fails at boot (ENOENT on ~/.claude/projects, permission error), Angel logs a warning and continues. The boundary detector falls back to PID + heartbeat-only signals — close markers still fire via pid_dead/idle_timeout paths."

key-files:
  created:
    - src/tests/angel/boundary/integration.test.ts
    - src/tests/angel/boundary/cursor-replay.test.ts
  modified:
    - src/angel/heartbeat.ts
    - src/angel/index.ts
    - src/tests/core/migration/v28-trigger.test.ts
  deleted: []

key-decisions:
  - "Dynamic import for boundary modules inside heartbeatTick. heartbeat.ts is already a 1144-line module with 47 imports; threading 2 more (runBoundaryTick + loadThresholds) into the top-of-file imports adds noise to a hot file. Dynamic import scopes the dependency to the per-tick block, keeps the import surface stable, and adds negligible cost (5ms first-tick, cached after)."
  - "Vesna VAL-04 probe DEFERRED to Phase 7. CONTEXT: Vesna's probe schema is behavioral — prompt + assertion patterns over agent_text — with 4 setup_step kinds (artifact, handoff, critical_rule, narration_directive). Phase 6's substrate is currently invisible to assembly/retrieval; the episode_closed env event is written but no consumer reads it back into agent_text. A Vesna probe today would have nothing to assert behaviorally. Phase 7 wires the close marker into the consumer surface — that's where SC-V5-4 belongs as a Vesna gate. SC-V5-4 is currently regression-locked by the 53 vitest tests in src/tests/angel/boundary/, including end-to-end integration and cursor-replay-after-fault. Decision communicated to team-lead via SendMessage; recommended option 2 (defer)."
  - "TickResult fields are optional (`?:`) preserving backward compatibility. Existing observability consumers (CLI dashboard, telemetry-counters tests) expect the legacy field set; new boundary_* fields are additive and never required. Phase 7 may make them required after the substrate is consumed."

requirements-completed: [EBD-01, EBD-02, EBD-03, EBD-04, EBD-06]

duration: 8 min
completed: 2026-05-05
---

# Phase 6 Plan 05: Angel integration + ship gates Summary

**Phase 6 substrate is now live in Angel's running process. Heartbeat tick runs runBoundaryTick after retention sweep on every ~2-minute cadence. JSONL watcher boots at Angel startup and shuts down gracefully. End-to-end integration test + cursor-replay-after-fault test prove the atomicity invariant. Vesna VAL-04 probe deferred to Phase 7 (no consumer surface for behavioral assertion until then). Phase 6 ships.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-05T21:07Z
- **Completed:** 2026-05-05T21:15Z
- **Tasks:** 3 (Task 3 deferred — Vesna probe)
- **Files created:** 2
- **Files modified:** 3

## Accomplishments

### src/angel/heartbeat.ts
- `TickResult` extended with 5 optional boundary_* fields (closes_emitted, closes_aborted, reopens_emitted, reopens_anomalous, cursor_replays).
- New per-tick block after retention sweep: dynamic-imports `runBoundaryTick` + `loadThresholds`, calls runBoundaryTick(ctx.db, t), surfaces stats on result.
- Outer try/catch records `episodic_write_failure` telemetry on boundary-tick error; heartbeat loop continues unaffected.

### src/angel/index.ts
- Imports `startJsonlWatcher` + `JsonlWatcherController`.
- Watcher boot at Angel startup wrapped in try/catch — degraded mode (PID + heartbeat-only) if chokidar bind fails.
- Logs `[angel] JSONL watcher started` on success, `[angel] JSONL watcher boot failed (continuing in degraded mode)` on failure.
- Shutdown handler upgraded to async to await `jsonlWatcher.close()` before db.close() + process.exit(0).

### src/tests/angel/boundary/integration.test.ts (1 test, 88 lines)
- Seeds 4 sessions: fresh, idle, pid-dead, clean_endsession.
- Tick 1: 2 closes (idle_timeout + jsonl_silent), clean session skipped.
- Tick 2: 0 closes (cursor short-circuit).
- JSONL bump on idle session → Tick 3: 1 reopen, sessions.status='active', cursor.last_close_event_id=NULL, clean session's prior close_event_id untouched.

### src/tests/angel/boundary/cursor-replay.test.ts (1 test, 86 lines)
- 3 sessions (s1, s2, s3) all idle_timeout candidates.
- Tick 1 with PID resolver throwing on s2: s1+s3 close, s2 logs episodic_write_failure, sweep continues.
- Tick 2 (no fault): s2 closes, s1 + s3 short-circuited (counts.s1 == counts.s2 == counts.s3 == 1).
- Proves cursor + close-marker atomicity invariant: no duplicate close on s1, s2 not lost.

### src/tests/core/migration/v28-trigger.test.ts
- 2 user_version assertions updated 28 → 29 (V29 raised by Phase 6).
- All other V28 trigger semantics tests still pass — V28 marker migration unchanged.

## Task Commits

1. `c42b9d6` — feat(06-05): integrate runBoundaryTick into Angel heartbeat + boot watcher
2. `[hash]` — test(06-05): integration + cursor-replay + V29 user_version update

## Verification Results

- `bun run build`: clean.
- `bun run test src/tests/angel/boundary/`: 55/55 pass (53 from Plan 04 + 2 new from Plan 05; 1.8s).
- `bun run test src/tests/angel/heartbeat-regression.test.ts src/tests/angel/heartbeat.test.ts`: 19/19 pass (Phase 4 baseline preserved).
- `bun run test`: 3448 passed / 27 failed / 8 skipped (3483 total). The 27 failures match the Phase 4 pre-existing baseline (`llama-server-supervisor.test.ts`, `llama-client.test.ts`, `phase-5-full-gate.test.ts`). Phase 6 introduces zero net new failing tests.
- `bun run vesna`: 18/18 PASS at 100% (entry-recall, constraint-recall, handoff-pickup, cross-project, lesson-application, self-instrumented).

## Deviations from Plan

**[Rule 4 - Architectural] Vesna VAL-04 probe DEFERRED to Phase 7**
- Found during: Task 3 probe schema research
- Issue: Vesna's harness schema is behavioral — `setup_steps` support 4 kinds (artifact, handoff, critical_rule, narration_directive); assertions run over agent_text from the assembled prompt. Phase 6's episode_closed env event row is currently invisible to assembly/retrieval (Phase 7 wires the consumer). A Vesna probe today would have no behavioral surface to assert on.
- Communicated: SendMessage to team-lead with the two options (extend Vesna with run_boundary_tick + SQL assertions, or defer). Recommended defer.
- Mitigation: SC-V5-4 is regression-locked by 55 vitest tests in src/tests/angel/boundary/ — composition rule truth table, heartbeat-compare race, cursor + replay atomicity, reopen + anomaly branches, end-to-end integration. The behavioral lock comes from these tests; only the Vesna count goes from 18 → 18 instead of 18 → 19.
- Phase 7 carries the responsibility to add the Vesna probe once a consumer surface exists.

**Total deviations:** 1 (Rule 4 architectural, communicated and approved scope). **Impact:** SC-V5-4 ship gate has the same regression coverage via vitest; only the Vesna pass count number is unchanged (18/18 instead of 19/19).

## Issues Encountered

None blocking. The Vesna probe deferral is captured under Deviations.

## Next Phase Readiness — Phase 7 Unblock Checklist

Phase 7 (v4 coexistence / migration / ship) inherits these consumers from Phase 6:
- `episodic_events` rows with `provenance='environmental'`, `source='angel-boundary'`, `metadata_json LIKE '%episode_closed%'` — query surface for Phase 7's per-table retention decisions (which tables retire / re-derive / preserve based on the close marker).
- `episode_boundary_cursor` table — cursor state for crash-replay across Angel restarts; Phase 7 may use it for migration progress tracking.
- 5 new TickResult fields — Phase 7 dashboards / `claudex doctor` can surface them.
- Vesna VAL-04 probe — Phase 7 adds this once the consumer surface exists.

Phase 6 ships. Ready for **Phase 7** (per ROADMAP.md): per-table decisions, Vesna probe suite update (existing 18 + new VAL-01/02/04 + KILL-regression VAL-03'), ship gate validation, **v5.0.0 tag**.

## Phase 6 Total LOC Delta

- New files (production): 8 (`src/angel/boundary/{thresholds,pid-liveness,jsonl-watcher,composition-rule,cursor,boundary-detector}.ts` + `src/adapters/cc-hooks/session-end-close-marker.ts` + 5 test directories worth of files).
- New files (tests): 11 (V29 migration, 3 boundary leaves, composition-rule, cursor, heartbeat-compare, boundary-detector, reopen, integration, cursor-replay, heartbeat-column-writes).
- Modified production files: 7 (`src/core/{migrations,migration-steps,schema}.ts`, `src/adapters/cc-hooks/{user-prompt-submit,pre-tool-use,post-tool-use,stop,session-end}.ts`, `src/angel/{heartbeat,index}.ts`).
- Approximate: ~1500 lines added, ~10 lines deleted (mostly small refactor of session-end.ts).

Net: a focused additive surface — Phase 6 doesn't delete code (Phase 4's job was the deletions). Schema is forward-only (V28 → V29). Existing tests preserved (27 baseline failures unchanged).
