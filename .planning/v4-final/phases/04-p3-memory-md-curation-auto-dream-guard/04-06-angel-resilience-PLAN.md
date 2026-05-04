---
plan_id: 04-06
phase: 4
wave: 4
depends_on:
  - 04-04
files_modified:
  - src/adapters/cc-hooks/session-start.ts
  - src/angel/heartbeat.ts
  - src/angel/angel-supervisor.ts
  - src/angel/index.ts
  - src/tests/angel/
autonomous: true
requirements:
  - CUR-01
  - CUR-04
---

# Plan 04-06: Angel Resilience Hardening

## Objective

Three-layer resilience fix for Angel, surfaced by a live soak-test discovery: Angel died silently at 2026-04-24T00:30:32Z during VRAM-contention with two concurrent benchmarks + Hearthstone, with zero diagnostic trace and no auto-recovery. This made the Phase 4 MEMORY.md curation pipeline appear to "work" under unit tests while being non-resilient in real use. Land three hardening fixes so Angel (and by extension the whole memory curation pipeline) survives the conditions a real user will put it under.

## Must-haves (goal-backward)

- **Fix 1 — stderr capture**: Angel's stdout+stderr pipe to a log file so future deaths are diagnosable. Rotation (size-based or daily) so log doesn't grow forever. `src/adapters/cc-hooks/session-start.ts` `stdio: 'ignore'` → `stdio: ['ignore', <logFd>, <logFd>]` (or a detached shell wrapper that tees to file).
- **Fix 2 — per-operation try/catch in heartbeat queue drain**: The memory_curation_pending queue consumer in `src/angel/heartbeat.ts` (landed as plan 04-04-03, search for `memory_curation_pending` inside the heartbeat loop) must wrap per-session and per-project operations in try/catch, emitting an error-telemetry event and continuing. One bad session/project must not kill Angel. Mirror the Phase 3 `bdca0a3` per-candidate hardening in `run-precision.ts`.
- **Fix 3 — AngelSupervisor**: New module `src/angel/angel-supervisor.ts` modeled on `src/angel/reranker-supervisor.ts` (existing pattern) and `src/angel/llama-server-supervisor.ts`. Bounded restart policy: e.g., max 3 restarts within 5 minutes, then give up with a critical telemetry event. Captures stdout/stderr to log file. Call from session-start instead of directly `spawn(...)`ing.
- Live-fire verification (post-implementation): simulate a failing Ollama call (or equivalent), confirm Angel logs the exception, supervisor restarts, next heartbeat tick succeeds.
- All existing tests pass (baseline 2556/2577, 21 pre-existing known failures in llama-server-supervisor/llama-client/e2e-flows — do NOT regress).

## Non-goals / out of scope

- `session_events` table write-path failure since 2026-04-20 V17 migration — that is a SEPARATE bug discovered alongside this investigation and is being tracked as a follow-up (NOT 04-06). Angel resilience is still worth doing even if the write-path bug means Angel currently has no queue rows to drain; the fix is defensive for when the write path is restored.
- Angel observability beyond stderr capture (e.g., structured logging, metrics dashboard) — follow-up P5 or P6 territory.
- Migrating away from `stdio: 'ignore'` pattern across other detached spawns — limit scope to Angel.

## Tasks

<task id="04-06-01">
  <subject>Capture Angel stdout/stderr to log file</subject>
  <description>
Change `src/adapters/cc-hooks/session-start.ts` `ensureAngelRunning()` spawn call (currently `stdio: 'ignore'`) to capture stdout+stderr to a log file. Minimum viable approach:

1. Log path: `~/.claudex/logs/angel.log` (create dir if missing)
2. Open log file for append with `fs.openSync(logPath, 'a')`, pass the fd as stdio[1] and stdio[2]. Keep stdin as 'ignore'.
3. Timestamp each line at write time if possible (via a prefix stream) or accept that the log has no timestamps (raw stderr from Node is acceptable MVP).
4. Rotation: if the log exceeds 10 MB at startup, rename to `angel.log.1` (dropping any previous `.1`) before opening. Simple one-generation rotation; no cron.
5. Session-start must NOT block on log-file open errors — if rotation/open fails, fall back to `stdio: 'ignore'` and emit one session_events row `log_open_failed`.
6. Update the comment on lines 68-70 of session-start.ts to document the new behavior.

Unit test: mock `spawn`, verify the stdio tuple is `['ignore', number, number]` when log file opens cleanly, and `'ignore'` when fs.openSync throws.
  </description>
</task>

<task id="04-06-02">
  <subject>Per-operation try/catch in heartbeat queue drain</subject>
  <description>
Open `src/angel/heartbeat.ts`. Locate the queue drain block around line 420 (the `WHERE se.event_type = 'memory_curation_pending'` query and the following loop). The loop currently:

- Reads pending rows (session_id, project)
- For each pending row: runs `chunkSessionTranscript` then `curateMemoryMd`
- Inserts a `memory_curation_done` marker

If any of the chunker/curator calls throw (e.g., Ollama embed call timeout under VRAM contention, disk-full during MEMORY.md atomic rename, sqlite WAL lock, etc.), the rejection propagates up and Angel's main loop fails, killing the whole process.

Requirements:

1. Wrap `chunkSessionTranscript(sessionId)` in its own try/catch. On throw, record a session_events row `memory_curation_failed` with detail including a short error message, skip the chunk, continue to curation (if the plan author deems chunk-then-curate a strict order, skip curation too and move to next pending row — document the choice in code comment).
2. Wrap `curateMemoryMd(project)` in its own try/catch. On throw, record `memory_curation_failed` for that project, continue.
3. Even on failure path, still insert `memory_curation_done` for the pending row (so it doesn't loop forever) OR increment a retry counter and only mark done after N failures. Design choice — document in code.
4. At heartbeat-iteration top level: one more try/catch wrapping the whole drain block so a DB connection error or similar doesn't kill Angel.
5. Telemetry: the `memory_curation_failed` event must carry enough detail to diagnose (error.message + error.name, NOT full stack — stacks go to the angel.log from Fix 1).

Unit tests covering:
- Chunker throws → curator still runs → pending marked done → next iteration continues
- Curator throws → pending marked done → next iteration continues
- DB connection error thrown from inside drain → caught at iteration level, next heartbeat tick still runs

Mirror the Phase 3 `bdca0a3` commit pattern (`src/benchmarks/directive-detector/run-precision.ts` per-candidate try/catch) for structural consistency.
  </description>
</task>

<task id="04-06-03">
  <subject>AngelSupervisor with bounded restart</subject>
  <description>
Create `src/angel/angel-supervisor.ts` modeled on `src/angel/reranker-supervisor.ts`. The supervisor:

1. Constructor options: `projectRoot`, `logPath` (default `~/.claudex/logs/angel.log`), `maxRestarts: 3`, `restartWindowMs: 5*60*1000`, `angelBinPath` (default resolved from `dist/angel/index.cjs`).
2. `start()`: spawn Angel as detached+unref with captured stdout/stderr streaming to `logPath`. Track (pid, startTime). On child exit, record (exitCode, exitTime). If last N exit times within restartWindow exceed maxRestarts, give up and emit a critical telemetry event (`angel_supervisor_gave_up`). Otherwise restart after a small backoff (1s, 3s, 10s for attempts 1/2/3).
3. `stop()`: send SIGTERM, wait up to 5s, SIGKILL if still alive.
4. `status()`: returns { alive: boolean, pid: number | null, restartCount: number, lastExitCode: number | null }.
5. Integrate with `src/adapters/cc-hooks/session-start.ts`: replace direct `spawn(angelDist, ...)` with `new AngelSupervisor(...).start()`. The PID written to `~/.claudex/angel.pid` should be the supervisor's currently-active child PID (updated on each restart) OR a supervisor PID — document choice, session-start liveness check must match.

Design consideration: unlike RerankerSupervisor (which runs inside Angel, same process lifetime), AngelSupervisor runs OUTSIDE Angel, in session-start's detached context. So the supervisor itself must be detached+unref from the CC hook process (which is ephemeral) AND survive across sessions. Concretely: session-start spawns a new `dist/angel-supervisor-launcher.cjs` wrapper (or reuses an existing) that itself spawns Angel and supervises it. On CC hook exit, the launcher persists. Subsequent hooks check for the launcher PID instead of the Angel PID directly.

Alternative if the detached-supervisor is too complex: step back to a SIMPLER pattern — have `user-prompt-submit` hook also call `ensureAngelRunning()` (not just session-start). That way each user turn verifies Angel is alive and restarts on death. Simpler, no separate supervisor process needed. Decision-tree:

- If detached-supervisor implementation is clean and fits the codebase's patterns: ship it.
- If it requires more than ~200 lines of infrastructure code: fall back to the hook-driven liveness check at every user-prompt-submit + session-start.

Document the chosen path in the SUMMARY.md.

Unit tests:
- Supervisor spawns Angel; Angel exits with code 0 → no restart (clean exit)
- Supervisor spawns Angel; Angel exits with code 1 → restart within backoff
- 4 exits in 4 min → 4th restart not attempted → emit `angel_supervisor_gave_up`
- `stop()` sends SIGTERM then SIGKILL after timeout
  </description>
</task>

<task id="04-06-04">
  <subject>Live-fire verification</subject>
  <description>
After tasks 01-03 all pass unit tests:

1. Kill any running Angel process (none currently — confirmed).
2. Delete stale `~/.claudex/angel.pid`.
3. Start a fresh Angel via whatever path session-start now uses (direct re-run of the hook OR a new CC session on a scratch project).
4. Verify `~/.claudex/logs/angel.log` is being written to.
5. Inject a controlled failure: e.g., temporarily set `OLLAMA_HOST` to an invalid port and trigger a heartbeat tick that would call Ollama. Confirm:
   - The exception goes into angel.log (Fix 1)
   - Angel does NOT die (Fix 2 caught it)
   - If Angel is configured to die on this class of error (unlikely for a simple timeout), the supervisor restarts it (Fix 3)
6. Restore `OLLAMA_HOST`.
7. Re-attempt the Phase 4 soak test (open CC session in `~/Desktop/Projects/soak-test-p4`, do 6+ turns, `/endsession`, close terminal, wait 60s, verify MEMORY.md appears at `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-soak-test-p4/memory/MEMORY.md`).

Note: soak-test-p4 step may fail due to the SEPARATE session_events-write regression — if MEMORY.md still doesn't appear even with Angel healthy, that's the queue-enqueue bug, not an Angel resilience issue. Document clearly in the summary.

Record results in a new `04-06-live-fire.md` in the phase dir.
  </description>
</task>

<task id="04-06-05">
  <subject>SUMMARY + commits</subject>
  <description>
Write `.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-06-angel-resilience-SUMMARY.md` matching the shape of 04-01..04-04 summaries. Cover:

- Bug discovery: silent Angel death at 2026-04-24T00:30:32Z during benchmark+game VRAM contention, with zero diagnostic trace due to `stdio: 'ignore'` in session-start spawn
- Three fixes landed (describe each + commit SHAs)
- Decision record for Task 04-06-03 (supervisor vs hook-driven liveness)
- Live-fire outcomes
- Separate-bug pointer: session_events writes frozen since 2026-04-20 V17 migration (cross-reference a new follow-up task OR issue ID)
- Test delta vs Phase 4 baseline

Commits (atomic per task per repo convention):
- feat(04-06-01): Angel stderr capture with rotation (session-start + unit test)
- feat(04-06-02): heartbeat queue drain per-op try/catch hardening (+ tests)
- feat(04-06-03): AngelSupervisor (OR: feat(04-06-03): hook-driven liveness check) (+ tests)
- test(04-06-04): live-fire verification report
- docs(04-06): SUMMARY for Angel resilience hardening
  </description>
</task>

## Verification

- `~/.claudex/logs/angel.log` appears and contains stderr lines from Angel
- Heartbeat queue drain survives a failing Ollama call (demonstrated via unit test + live fire)
- AngelSupervisor restarts Angel after SIGKILL (demonstrated via test)
- 2556+ tests pass (no regression from Phase 4 baseline; pre-existing 21 still pass/fail as before)
- All 5 tasks committed, SUMMARY.md written, all task IDs checked off
- Phase 4 soak test passes IF the separate session_events-write bug is also resolved in parallel; otherwise soak is blocked on that bug and this plan is a pre-requisite without being sufficient
