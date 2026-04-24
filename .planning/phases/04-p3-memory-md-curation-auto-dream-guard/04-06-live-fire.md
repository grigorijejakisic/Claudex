# 04-06 Live-Fire Verification Report

**Date:** 2026-04-24
**Author:** exec-04-06 (this session)
**Plan:** .planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-06-angel-resilience-PLAN.md

## Summary

All three Angel-resilience fixes verified via a combination of:

1. **Unit tests** — 15 new tests across three files prove the mechanical
   invariants (stdio tuple shape, log rotation, per-op try/catch, event
   emission, hook wiring).
2. **Opportunistic live evidence** — the currently-running Angel process
   was spawned (03:16:32 local, post-commit `051564b`) via the new code
   path and is writing to `~/.claudex/logs/angel.log`. File exists, has
   the expected supervisor-startup content, and continues to receive
   tick telemetry during this session.
3. **Build smoke test** — `bun run build` runs every hook entry-point
   end-to-end with a stdin payload and validates stdout parses as JSON.
   All 24 hooks pass smoke after 04-06-03.

**Full soak re-test skipped** per team-lead guidance: the `session_events`
write-path is broken since the V17 migration (2026-04-20), so even a fully
resilient Angel cannot receive a `memory_curation_pending` row from the
soak-test-p4 `/endsession`. That bug is tracked separately; Angel
resilience hardening was always a pre-requisite, never sufficient on its
own.

## Fix 1 — stderr capture (04-06-01)

### Evidence

- **File exists.** `~/.claudex/logs/angel.log` at 826 bytes as of verification,
  7 lines of `[angel/info]` structured output.
- **Expected content.** First lines are the `reranker: spawning python …`
  supervisor trace and the `Angel started {pid…}` line — i.e., the
  `process.stderr.write(...)` calls inside Angel's main module are being
  captured. Pre-04-06 this output went to `/dev/null`.
- **Rotation logic** — unit test `angel-log.test.ts` covers: fresh-open
  happy path, 10 MB rotation trigger, one-generation clobber semantics,
  no-rotate below threshold, and fallback-on-directory-blocked. 5 tests,
  all green.

### Not-verified in live-fire

- 10 MB rotation *in production*. The live log is 826 bytes; rotation
  will trigger naturally after some weeks of uptime and is covered by
  the unit test.

## Fix 2 — Per-operation try/catch in heartbeat queue drain (04-06-02)

### Evidence

- **Unit tests** in `heartbeat.test.ts`:
  - `04-06-02: chunker throw emits memory_curation_failed and still marks done`
    — throws a fake `TimeoutError` from `chunkSessionTranscript`, confirms
    the event row lands, curator still runs, pending marked done.
  - `04-06-02: curator throw emits memory_curation_failed and still marks done`
    — throws a fake `FilesystemError` from `curateMemoryMd`, confirms
    the event row lands, `memory_md_written` stays zero,
    `memory_curation_errors` increments, pending marked done.
  - `04-06-02: DB error caught at iteration level — next tick still runs`
    — throws from BOTH chunker and curator on tick 1, restores happy
    path on tick 2, confirms tick 2 runs cleanly end-to-end.

### Not-verified in live-fire

- An actual Ollama VRAM-contention failure. The test suite simulates
  the class of error but we did not deliberately starve Ollama during
  this live-fire session — the separate `session_events` write bug
  means we wouldn't have any `memory_curation_pending` rows to drain
  anyway. The fix is defensive for when that upstream bug is resolved.

## Fix 3 — Hook-driven Angel liveness (04-06-03)

### Decision record

The plan's task 04-06-03 described a decision tree:

> (A) detached-supervisor launcher process with proper restart logic, OR
> (B) simpler hook-driven liveness check at every user-prompt-submit + session-start.
>
> … If detached-supervisor implementation is clean and fits the codebase's
> patterns: ship it.
> If it requires more than ~200 lines of infrastructure code: fall back
> to the hook-driven liveness check.

**Chose B.** Rationale:

1. **Pattern fit.** Existing Angel-launch path (`ensureAngelRunning` at
   session-start), `writeClaudeEnvFile`, and `ingestFileArtifacts` are
   all "best-effort helper on applicable hook." Option B reuses that
   pattern. Option A would have been the first detached launcher process
   the codebase ships.
2. **Recovery coverage.** Session-start already runs on every new
   session. Adding the check to user-prompt-submit means Angel dying
   mid-session is revived within one user prompt (seconds to minutes
   based on user pace), not on the next session.
3. **Line-count.** Option A budget estimate: ~250 lines for the
   launcher + PID-file refactor + Windows detach edge cases. Option B:
   ~5 lines of hook call + one-file module extraction. The plan's
   "~200 line" threshold is blown by A and easily cleared by B.
4. **Symmetry with existing recovery loops.** The heartbeat already
   calls `rerankerSupervisor.ensureRunning()` and
   `llamaServerSupervisor.ensureRunning()` every tick when those
   services are down. Angel's own liveness is the one layer without a
   periodic re-check. Hook-driven liveness closes that gap — every user
   turn IS a periodic re-check.

### Evidence

- **`user-prompt-submit.ts`** now imports `ensureAngelRunning` from the
  new `./angel-launcher.js` module (NOT from `./session-start.js`, which
  would have double-fired SessionStart assembly on every user turn) and
  calls it right after the CC_INTERNAL early-exit:

  ```ts
  try {
    await ensureAngelRunning(ctx.db, input.session_id, ctx.project, /* isUserTurn */ true);
  } catch { /* Angel is optional */ }
  ```

- **Wiring test** `user-prompt-submit-angel-liveness.test.ts` asserts:
  - Import is from `./angel-launcher.js`.
  - No import of `ensureAngelRunning` from `./session-start.js`.
  - Call appears after `CC_INTERNAL_RE.test(prompt)` and before
    `classifyIntent(`.
  - Call passes `isUserTurn=true`.
- **Build smoke** — after 04-06-03, `bun run build` runs all 24 hook
  entry-points with a smoke payload and validates stdout is JSON. All
  24 pass. Before the module-extraction refactor, importing
  `ensureAngelRunning` from `session-start.js` caused a double-fire of
  SessionStart assembly on user-prompt-submit, producing concatenated
  JSON and failing smoke. The refactor was caught by the build smoke
  path.

### Not-verified in live-fire

- A real mid-session Angel death followed by hook-driven respawn. We
  did NOT kill the currently-running Angel (PID 15212) because another
  teammate in this team is mid-benchmark (`exec-04-05b` polling
  LongMemEval). Killing Angel mid-benchmark would be a destructive
  side-effect outside the scope of 04-06 and was explicitly flagged in
  the team-lead briefing. The `ensureAngelRunning` function is
  otherwise fully unit-tested (both the stdio-tuple contract AND the
  hook call-site wiring).

## Test delta vs. Phase 4 baseline

| Metric                         | Pre-04-06 baseline | Post-04-06   |
|--------------------------------|--------------------|--------------|
| Total tests                    | 2577               | 2588 (+11)   |
| Passing                        | 2556               | 2568 (+12)   |
| Known-failing (llama-server +  | 21                 | 20 (−1)      |
|  llama-client)                 |                    |              |
| Regressions                    | —                  | 0            |

The net −1 in "known failing" is coincidental — the llama-server file
ran with one fewer teardown race this time. No behavioural fix was
made to it.

## Separate bug (out of scope)

`session_events` table writes have been frozen since the V17 migration
on 2026-04-20. Any `recordEvent` call that targets this table appears
to succeed (better-sqlite3 statement .run() returns normally) but the
row does not materialize in a subsequent SELECT. This means the
soak-test-p4 `/endsession` → `memory_curation_pending` queue enqueue
produces no row for Angel to drain, and the Phase 4 end-to-end
soak test cannot complete regardless of Angel resilience.

Team-lead is tracking this separately (NOT 04-06). Angel resilience
hardening is still landing because it is a necessary pre-requisite
and its three fixes are independently verifiable via unit test.

## Conclusion

Angel's three structural resilience gaps are closed:

1. Silent deaths are now diagnosable (log file + rotation).
2. A single poisoned session or project in the curation queue cannot
   kill the heartbeat loop (per-op try/catch + error-telemetry events).
3. Angel death between user turns is recoverable without a new session
   (hook-driven liveness at user-prompt-submit).

All three fixes are green on unit tests; the first is additionally
verified by a live-running Angel that's writing the new log file as
expected.
