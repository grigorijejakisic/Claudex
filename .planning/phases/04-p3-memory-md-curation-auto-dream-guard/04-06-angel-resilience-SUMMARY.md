---
phase: 04-p3-memory-md-curation-auto-dream-guard
plan: 04-06
subsystem: angel + cc-hooks
tags: [angel, resilience, stderr-capture, log-rotation, supervisor, hook-driven-liveness, heartbeat, curation-queue, error-telemetry]

requires:
  - plan: 04-04
    provides: Phase 5b `memory_curation_pending` queue drain — hardened here against per-op throws
provides:
  - `~/.claudex/logs/angel.log` — captured stdout/stderr with 10 MB rotation (one-generation)
  - `src/adapters/cc-hooks/angel-log.ts` — `openAngelLogForAppend` helper
  - `src/adapters/cc-hooks/angel-launcher.ts` — `ensureAngelRunning` extracted for hook-driven liveness
  - `memory_curation_failed` session_events rows with stage + error name/message detail
  - `angel_log_open_failed` session_events rows for observability of log-capture fallback
  - `angel_respawn` session_events rows tagged `hook_driven_liveness`
  - Per-op try/catch hardening in heartbeat Phase 5b queue drain (chunker + curator + iteration-level)
  - Hook-driven Angel liveness check at every `user-prompt-submit`
affects: [Phase 4 gate (04-06 is the prerequisite for full soak); separate session_events write-path bug still blocks soak]

tech-stack:
  added: []
  patterns:
    - One-generation size-based log rotation (rename-and-reopen) rather than time-based (daily cron)
    - Module extraction to avoid accidental hook re-fire on import (lesson: top-level `main()` calls in hook bundles execute on import)
    - Hook-driven liveness as an alternative to a dedicated detached supervisor process (simpler, line-count-favored, symmetric with existing `ensureRunning` periodic recovery)
    - Structured failure-event emission with error.name + error.message (NOT full stack — stacks go to log file)

key-files:
  created:
    - src/adapters/cc-hooks/angel-log.ts
    - src/adapters/cc-hooks/angel-launcher.ts
    - src/tests/adapters/cc-hooks/angel-log.test.ts
    - src/tests/adapters/cc-hooks/ensure-angel-running.test.ts
    - src/tests/adapters/cc-hooks/user-prompt-submit-angel-liveness.test.ts
    - .planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-06-live-fire.md
  modified:
    - src/adapters/cc-hooks/session-start.ts — imports ensureAngelRunning from angel-launcher; removed the inline definition
    - src/adapters/cc-hooks/user-prompt-submit.ts — calls ensureAngelRunning on every user turn after CC_INTERNAL early-exit
    - src/angel/heartbeat.ts — per-op try/catch in Phase 5b drain + recordCurationFailure helper + iteration-level catch
    - src/core/session-events.ts — EventType += 'memory_curation_failed' | 'angel_log_open_failed' | 'angel_respawn'
    - src/tests/angel/heartbeat.test.ts — 3 new cases: chunker throw, curator throw, DB-error at iteration level

key-decisions:
  - "Fix 1 (stderr capture) uses size-based one-generation rotation
    (angel.log → angel.log.1) rather than time-based (daily cron). Simpler:
    no timer infrastructure, no stale log if the process never runs on a
    given day, bounded at ~20MB on disk. Rotation triggers on *next open*
    (not mid-write) so there's no locking complexity."
  - "Fix 2 (per-op try/catch) still marks each pending row `memory_curation_done`
    even on failure. Alternative (retry counter / N-attempts-then-drop)
    would pin a deterministically-broken session in the queue forever.
    Drop-after-one + `memory_curation_failed` event gives the queue a
    clean start each tick AND keeps the failure observable. Full stack
    goes to angel.log; only name + message in the session_events row."
  - "Fix 3 chose hook-driven liveness (Option B) over detached supervisor
    launcher (Option A). See 04-06-live-fire.md for the four-point
    rationale — summary: (1) fits existing pattern, (2) better coverage
    because user-prompt-submit fires every turn, (3) ~5 lines vs ~250,
    (4) symmetric with existing reranker/llama-server ensureRunning
    periodic recovery."
  - "`ensureAngelRunning` was extracted to `angel-launcher.ts` instead of
    being imported from `session-start.ts`. The hook bundles call `main()`
    at module top level — importing `session-start.js` re-ran that main
    in the user-prompt-submit process, double-firing SessionStart assembly
    every turn and shipping concatenated JSON to CC. Caught by the build
    smoke test. The module extraction is the minimum refactor that
    decouples the reusable helper from the entry-point."

patterns-established:
  - "`recordCurationFailure(db, sessionId, project, stage, err)` helper in
    heartbeat.ts — precedent for future queue-drain phases that need
    structured failure telemetry without leaking stacks into the DB."
  - "Hook-driven ensure-running liveness call at user-prompt-submit — reusable
    for any future long-lived helper process that needs mid-session recovery
    and already has an `ensureX()` function. Could migrate
    `ensureCollections()` or `writeClaudeEnvFile()` to the same cadence if a
    future session turns up a case where those silently fail."
  - "stdio fd-share pattern for spawn — open log fd in parent, pass as
    `stdio[1]` and `stdio[2]`, close parent's fd after spawn since the child
    owns it via dup2. Used here for Angel; extensible to any future hook-
    spawned helper."

requirements-completed:
  - CUR-01 (curator resilience against per-op throws — hardens the Phase 5b delivery path)
  - CUR-04 (idempotency-on-retry — preserved: failed curation still marks done, so reruns don't double-curate)

duration: ~1 session
completed: 2026-04-24
---

# Plan 04-06: Angel Resilience Hardening — Summary

**Angel is now resilient against the three structural gaps exposed by the 2026-04-24T00:30:32Z silent death during Phase 4 soak testing. Stdout/stderr are captured to `~/.claudex/logs/angel.log` with 10 MB one-generation rotation so future deaths are diagnosable. The heartbeat Phase 5b queue drain wraps chunker + curator in independent try/catch blocks that emit `memory_curation_failed` session events and still mark pending rows done so one poisoned session cannot kill the loop. `ensureAngelRunning` now fires on every `user-prompt-submit` too, not just session-start, so an Angel that dies mid-session is revived within one user turn — no dedicated supervisor process needed.**

## Bug Discovery

Mid-soak-test on 2026-04-24T00:30:32Z, Angel (PID 16507 family) died silently during VRAM-contention with two concurrent benchmarks (LongMemEval + LoCoMo) and Hearthstone running. Zero diagnostic trace: no log file, no `session_events` failure row, no heartbeat telemetry past the crash. The stale `~/.claudex/angel.pid` remained on disk, `kill -0 <pid>` failed silently, and the next `ensureAngelRunning` at session-start would have restarted it — except no new session was triggered during the soak window.

Root-cause investigation surfaced three orthogonal structural gaps:

1. **No stderr capture.** `src/adapters/cc-hooks/session-start.ts:70` spawned Angel with `stdio: 'ignore'`. Anything Angel wrote to stderr before crashing (the `uncaughtException` handler in `src/angel/index.ts:316` WOULD have logged something to stderr, but stderr was /dev/null).
2. **Heartbeat queue drain had only one outer try/catch.** A throw from `chunkSessionTranscript` or `curateMemoryMd` would propagate to the heartbeat's top-level catch, but not before the pending row was left unprocessed. Under VRAM contention, Ollama embed calls time out, chunker throws, Angel main loop dies.
3. **No auto-recovery.** No supervisor process. Once Angel died, it stayed dead until the user explicitly started a new CC session.

## Performance

- **Completed:** 2026-04-24
- **Tasks:** 5 atomic commits (one per task id in PLAN §Tasks)
- **Files created:** 6 (2 source modules + 3 test files + 1 live-fire report)
- **Files modified:** 5 (session-start, user-prompt-submit, heartbeat, session-events EventType, heartbeat.test)
- **New tests:** 13 (5 angel-log rotation + 3 ensureAngelRunning stdio + 3 heartbeat failure isolation + 2 user-prompt-submit wiring)
- **Test delta vs baseline:** 2556 → 2568 passing; 21 → 20 pre-existing failures (one llama-server test teardown race cleared up in the run — not a behavioural fix).

## Task Commits

1. **04-06-01** — `051564b feat(04-06-01): Angel stderr capture with size-based rotation`
2. **04-06-02** — `a75fcb4 feat(04-06-02): heartbeat queue drain per-op try/catch hardening`
3. **04-06-03** — `750c82a feat(04-06-03): hook-driven Angel liveness check`
4. **04-06-04** — `d6c8f88 test(04-06-04): live-fire verification report`
5. **04-06-05** — this SUMMARY

## Accomplishments

### Fix 1 — stderr capture (04-06-01)

- New module `src/adapters/cc-hooks/angel-log.ts` with `openAngelLogForAppend()` — creates `~/.claudex/logs/` if missing, rotates `angel.log` → `angel.log.1` at 10 MB (clobbering any prior `.1`), opens for append, returns `{fd, reason}`. Non-throwing — any failure returns `{fd: null, reason}` so the caller falls back safely.
- `session-start.ts::ensureAngelRunning` now uses that helper and passes the fd as `stdio[1]` + `stdio[2]`. On open failure, falls back to `['ignore','ignore','ignore']` and records a `angel_log_open_failed` session_events row so the failure is observable.
- fd close: parent closes its copy after spawn — child owns it via dup2. CC hooks are ephemeral and exit within ms; leaving the fd open briefly pins the handle but not correctness.
- `EventType` union gains `memory_curation_failed`, `angel_log_open_failed`, `angel_respawn`.

### Fix 2 — per-operation try/catch in heartbeat queue drain (04-06-02)

- `heartbeat.ts` Phase 5b (lines 417-477) rewritten with three nested levels:
  - **Iteration-level catch** around the whole drain block. DB connection errors, SELECT throws, anything that bypasses the per-op guards lands here, records a rollup `memory_curation_failed` action='drain_iteration', and continues.
  - **Per-session chunker try/catch** emitting `memory_curation_failed` action='chunker' with error.name + error.message. Curator still runs (independent: the curator reads older chunks).
  - **Per-project curator try/catch** emitting `memory_curation_failed` action='curator'. Project still added to `curatedProjects` dedup Set so batched pending rows for the same project don't retry the throw.
- `recordCurationFailure(db, sessionId, project, stage, err)` helper factored to keep the drain body legible. Non-throwing.
- Failed pending rows are STILL marked `memory_curation_done` (design choice: alternative of retry-counter-then-drop would pin deterministically-broken sessions in the queue forever; drop-after-one plus a failure event is observable AND self-limiting).
- Three new heartbeat tests: chunker throw case, curator throw case, DB-error-at-iteration case followed by a happy tick that proves the loop survived.

### Fix 3 — hook-driven Angel liveness (04-06-03)

- `ensureAngelRunning` extracted to new `src/adapters/cc-hooks/angel-launcher.ts` module so it can be imported by user-prompt-submit WITHOUT importing `session-start.ts` (whose top-level `main()` would double-fire SessionStart assembly on every user turn — caught by the build smoke test during this task).
- `user-prompt-submit.ts` calls `await ensureAngelRunning(ctx.db, input.session_id, ctx.project, /* isUserTurn */ true)` right after the CC_INTERNAL early-exit and before the intent classifier. Non-throwing (Angel is optional). The `isUserTurn=true` flag drives an `angel_respawn` session event tagged `hook_driven_liveness` when a respawn actually happens, so recovery cadence is observable.
- Wiring test in `user-prompt-submit-angel-liveness.test.ts` enforces:
  - Import from `./angel-launcher.js` (not `./session-start.js`)
  - Call appears between CC_INTERNAL check and `classifyIntent` usage
  - Call passes `isUserTurn=true`

### Decision record — detached supervisor vs hook-driven liveness

The plan's 04-06-03 gave a decision tree: Option A (new detached launcher process that spawns+supervises Angel) or Option B (hook-driven ensureAngelRunning at every user-prompt-submit). Chose **B**. Full rationale is in `04-06-live-fire.md`; summary:

1. Pattern fit — B reuses the existing best-effort-helper-on-hook pattern (Angel@session-start, writeClaudeEnvFile, ingestFileArtifacts). A would have been the first detached launcher process in the codebase.
2. Recovery coverage — B revives Angel every user turn (seconds) not every new session (minutes-to-hours).
3. Line-count — A's budget estimate ~250 lines (launcher + PID refactor + Windows detach edge cases); B's actual cost ~5 lines hook call + one-module refactor. Plan's explicit "≤200 lines" threshold firmly in B territory.
4. Symmetry — heartbeat already calls `rerankerSupervisor.ensureRunning()` + `llamaServerSupervisor.ensureRunning()` every tick. Angel's own liveness was the one layer without a periodic re-check. Hook-driven liveness closes the gap — every user turn IS a periodic re-check.

## Live-fire Outcomes

See `.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-06-live-fire.md` for full detail. Abbreviated:

- Fix 1 — verified. Currently-running Angel (PID 15212, spawned 03:16:32 local via the new code path) is writing to `~/.claudex/logs/angel.log`. 826 bytes of expected `[angel/info]` structured output.
- Fix 2 — unit-tested. Not deliberately starved Ollama during live-fire: (a) `exec-04-05b` is mid-benchmark and (b) the separate `session_events` write-path bug means no `memory_curation_pending` rows to drain anyway. The fix is defensive for when that upstream bug lands.
- Fix 3 — unit-tested via wiring assertions + validated by the build smoke test's JSON-validity check on user-prompt-submit output. Deliberate mid-session Angel kill skipped to avoid disturbing the in-flight benchmark.
- **Full Phase 4 soak re-test skipped** per team-lead guidance — blocked on the separate `session_events` write-path regression.

## Test Results

- Targeted: `bun run test src/tests/adapters/cc-hooks/angel-log.test.ts` — **5/5 pass** (~43ms)
- Targeted: `bun run test src/tests/adapters/cc-hooks/ensure-angel-running.test.ts` — **3/3 pass** (~29ms)
- Targeted: `bun run test src/tests/adapters/cc-hooks/user-prompt-submit-angel-liveness.test.ts` — **2/2 pass** (~2ms)
- Targeted: `bun run test src/tests/angel/heartbeat.test.ts` — **7/7 pass** (~280ms) — 4 prior + 3 new
- Full suite: `bun run test` — **2568 pass / 20 fail** (pre-existing failures in `llama-server-supervisor.test.ts` (18) and `llama-client.test.ts` (2); no new regressions; −1 from baseline is coincidental teardown timing, not a behavioural fix).
- Build: `bun run build` succeeds (~70ms; all 24 hook entry-points pass smoke JSON-validity check).

## Separate Bug — session_events write-path

The Phase 4 soak-test cannot complete via this plan alone because `session_events` table writes have been silently dropping since the V17 migration on 2026-04-20T10:38Z. `recordEvent(...)` calls appear to succeed (no exception from `.run()`) but the row does not materialize in a subsequent SELECT. This means the `/endsession` → `memory_curation_pending` enqueue produces no row for Angel's Phase 5b to drain, so no MEMORY.md ever appears under `~/.claude/projects/.../memory/`.

**Plan 04-06 is a prerequisite, not a sufficient fix.** When the write-path is restored, the three resilience guarantees land here will keep Angel alive under real-world conditions. Team-lead is tracking the write-path bug separately; it was explicitly called out as out-of-scope for 04-06.
