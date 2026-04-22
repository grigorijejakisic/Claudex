---
phase: 04-p3-memory-md-curation-auto-dream-guard
plan: 04
subsystem: angel + cc-hooks
tags: [heartbeat, memory-md, chunker, curation-queue, session-events, sentinel-guard]

requires:
  - plan: 04-01
    provides: `src/angel/memory-md-writer.ts::curateMemoryMd` — consumed by Phase 5b
  - plan: 04-02
    provides: `src/angel/transcript-chunker.ts::chunkSessionTranscript` — consumed by Phase 5b
  - plan: 04-03
    provides: env-file flag + session-start verifier (orthogonal; not touched here)
provides:
  - `memory_curation_pending` event type emitted at session close (hook + auto-close)
  - `memory_curation_done` event type marking consumed queue rows for audit
  - Heartbeat Phase 5b — drains the queue: chunks per session, curates per project
  - `chunks_created` / `memory_md_written` / `memory_curation_errors` counters on `TickResult`
  - Guard in `memory-monitor.ts` that skips Angel-managed (sentinel-present) MEMORY.md files
affects: [04-05 phase gate; Phase 5 (P4) formatter can read both new event types]

tech-stack:
  added: []
  patterns:
    - Event-based work queue (session_events pending/done pair) vs watermark column
    - Dynamic imports inside the heartbeat for per-tick mockability
    - Dedup-per-tick via `Set<string>` for per-project curator invocation
    - Sentinel-line regex guard to keep two writers from stepping on each other

key-files:
  created:
    - src/tests/angel/heartbeat.test.ts
    - src/tests/angel/memory-monitor.test.ts
  modified:
    - src/adapters/cc-hooks/session-end.ts — enqueue after cleanup, before signal clear
    - src/angel/heartbeat.ts — Phase 5b consumer + 3 TickResult counters + auto-close emit
    - src/angel/memory-monitor.ts — sentinel-guard pre-check in monitorMemoryFiles
    - src/core/session-events.ts — EventType += 'memory_curation_pending' | 'memory_curation_done'
    - src/tests/adapters/cc-hooks/hooks.test.ts — row-shape wiring test

key-decisions:
  - "Queue mechanism is `session_events` rows (pending + done pair) rather than a
    watermark column on `sessions` or `projects`. RESEARCH §5 recommendation.
    Append-only audit trail, cheap filter via `NOT EXISTS` anti-join, no schema
    migration, idempotent under double-tick (done-guard re-checks on every tick)."
  - "Emit from session-end hook (SessionEnd fires on terminal close) AND from
    Angel's Phase 1b auto-close — both are valid 'session completed' triggers.
    Two emit sites, one consumer. /endsession skill does NOT directly emit — it
    runs `git commit` and the actual terminal close is what triggers SessionEnd,
    matching PLAN note about CC lifecycle."
  - "Phase 5b order: after Phase 2 (pattern extraction) + Phase 5 (memory_monitor
    prune) + BEFORE Phase 6b (embedding backfill). Recent-Threads reads the
    chunks inserted this tick; backfill picks up their null embedding_ref."
  - "Per-project curator dedup inside a single tick (Set of seen project_ids)
    prevents rewriting the same MEMORY.md on batch-session scenarios. Chunker
    runs per-session because it MUST — chunks are session-scoped artifacts."
  - "Failure isolation via three independent try/catch blocks: chunker throw
    bumps the error counter but doesn't skip the curator; curator throw doesn't
    skip the done-marker write; done-marker throw doesn't break the loop
    (worst case: duplicate processing next tick, both sides are idempotent)."
  - "memory-monitor guard uses a first-line regex match against the sentinel
    shape (`<!-- CLAUDEX-MANAGED: ... hash=<hex> -->`). Any-length hex to be
    permissive — the sentinel producer is the writer (64-char); a non-canonical
    hash still means 'Angel owns this file, hands off'. Confirmed with two
    regression tests covering legacy prune path + sentinel-skip path."

patterns-established:
  - "Heartbeat dynamic imports: `await import('./transcript-chunker.js')`
    inside Phase 5b so unit tests can swap the module via `vi.mock` without
    polluting the top of the file. Same technique already used for
    `embed-pipeline` and `rl-trainer`."
  - "Event-based queue in heartbeat: pending event + done anti-join. Precedent
    for future phases that want a 'do this once per completed session'
    trigger without session-state mutation."
  - "Fail-loud isolation across the pipeline: chunker/curator/done-mark each
    contribute to one global error counter but never short-circuit each other.
    Telemetry is the contract, not exception safety."

requirements-completed:
  - CUR-01 (curator fires from Angel at session-completed boundary — mechanical half already landed in 04-01)
  - CUR-03 (sentinel-present guard in memory-monitor is the 'second line of defense' against auto-dream; env flag already landed in 04-03)
  - STOR-06 (chunker fires from Angel at session-completed boundary — chunker module already landed in 04-02)

duration: ~1 session
completed: 2026-04-22
---

# Plan 04-04: Drive Chunker and Curator from Session-Completed Signal — Summary

**Angel's heartbeat now drains a `memory_curation_pending` queue — one row emitted by the session-end hook and one by Phase 1b auto-close, consumed by a new Phase 5b that runs the transcript chunker per session and the MEMORY.md curator per project, deduped within the tick, isolated against individual failures, and audited via `memory_curation_done` anti-join. The memory-monitor's legacy prune pass now skips any MEMORY.md that carries the CLAUDEX-MANAGED sentinel on line 1 so the two writers don't race.**

## Performance

- **Completed:** 2026-04-22
- **Tasks:** 6 atomic commits (one per task id in PLAN §Tasks)
- **Files created:** 2 (`heartbeat.test.ts`, `memory-monitor.test.ts`)
- **Files modified:** 5 (`session-end.ts`, `heartbeat.ts`, `memory-monitor.ts`, `session-events.ts`, `hooks.test.ts`)
- **New tests:** 7 (4 heartbeat Phase 5b + 2 memory-monitor + 1 session-end enqueue)
- **Test delta vs baseline:** 2550 → 2557 passing; 20 pre-existing failures unchanged.

## Task Commits

1. **04-04-01** — `c182900 feat(04-04-01): enqueue memory_curation_pending from session-end hook`
2. **04-04-02** — `914a5af feat(04-04-02): enqueue memory_curation_pending from Angel auto-close`
3. **04-04-03** — `2f286e5 feat(04-04-03): Phase 5b — consume memory_curation_pending queue`
4. **04-04-04** — `a3d7a06 feat(04-04-04): memory_monitor skips Angel-managed MEMORY.md files`
5. **04-04-05** — `491a6f0 test(04-04-05): heartbeat Phase 5b integration — stop→heartbeat→file`
6. **04-04-06** — `51da688 test(04-04-06): session-end enqueue row shape assertion`

## Accomplishments

- `src/adapters/cc-hooks/session-end.ts` calls `recordEvent(..., 'memory_curation_pending', 'angel', 'enqueue', JSON.stringify({project, session_id}))` after `runSessionEndCleanup` and before `clearSessionSignals`. Non-throwing so a telemetry write failure never blocks session close.
- `src/angel/heartbeat.ts` Phase 1b auto-close path emits the same event type right after `angel_auto_close`, inside the existing per-session try/catch. Sessions that time out get the same curation treatment as user-ended sessions.
- New **Phase 5b** in `heartbeatTick`: SELECT up to 20 oldest pending rows (anti-joined against `memory_curation_done`), invoke `chunkSessionTranscript` per session, `curateMemoryMd` per unique project (Set-dedup), insert `memory_curation_done` marker per consumed row. Each step inside an independent try/catch → three independent error counters feeding one global `memory_curation_errors` field.
- `TickResult` extended with `chunks_created`, `memory_md_written`, `memory_curation_errors` — all optional, only set when non-zero. No changes to existing counters or interval computation.
- `src/core/session-events.ts` `EventType` union += `'memory_curation_pending' | 'memory_curation_done'` so `recordEvent` type-checks and consumers can filter without stringly-typed predicates.
- `src/angel/memory-monitor.ts` now reads the first line of each MEMORY.md before the legacy prune path; if it matches the CLAUDEX-MANAGED sentinel regex, the monitor `continue`s to the next project. Angel-owned files are preserved byte-for-byte.
- Integration suite (`heartbeat.test.ts`, 4 cases): two-session end-to-end (chunker + curator both fire, sentinel + all 5 headers present), no-op second tick, input-change re-render (only changed project rewrites), failure isolation (chunker throw doesn't block curator). Chunker wrapped via `vi.fn` + `vi.importActual` so per-test throw behavior is one-line.
- Memory-monitor guard suite (`memory-monitor.test.ts`, 2 cases): legacy prune path still migrates 10-entry non-sentinel files; sentinel-guarded file byte-identical after a full monitor pass (read + mtime both unchanged).
- Session-end wiring test in `hooks.test.ts` confirms the row shape (`event_type`, `entity='angel'`, `action='enqueue'`, `detail` JSON with `project` + `session_id`) — mirrors Phase 5b's SELECT predicate.

## Test Results

- Targeted: `bun run test src/tests/angel/heartbeat.test.ts` — **4/4 pass** (~265ms).
- Targeted: `bun run test src/tests/angel/memory-monitor.test.ts` — **2/2 pass** (~51ms).
- Targeted: `bun run test src/tests/adapters/cc-hooks/hooks.test.ts` — **71/71 pass** (prior 70 + 1 new enqueue case).
- Full suite: `bun run test` — **2557 pass / 20 fail**. All 20 failures are in `src/tests/angel/llama-server-supervisor.test.ts` (18) and `src/tests/angel/llama-client.test.ts` (2), pre-existing and documented in every prior Phase 4 SUMMARY. No new regressions. Delta vs baseline 2550/2570: +7 passing tests (matches my 7 new test cases), same 20 failing tests.
- Build: `bun run build` succeeds (~70ms, 26/26 hooks compile).

## Decisions Made

- **Queue mechanism: session_events pairs.** PLAN §Tasks 04-04-03 and RESEARCH §5 both recommended `session_events` rows over a watermark column. Chose `memory_curation_done` marker (rather than deleting the pending row) because `session_events` is append-only in the rest of the codebase and this preserves an audit trail. The SELECT's `NOT EXISTS` anti-join against done-rows costs one index scan per tick — cheap, and the row count is bounded by the LIMIT 20.
- **Two emit sites, one consumer.** PLAN §Must-haves called out the CC lifecycle asymmetry: `/endsession` runs a git commit but the actual terminal close is what fires `SessionEnd`. So `session-end.ts` is the primary emit site for user-driven ends; Angel's Phase 1b auto-close is the parallel path for idle-timeout ends. One Phase 5b consumer drains both into the same work.
- **Phase 5b ordering: AFTER Phase 5 / BEFORE Phase 6b.** Phase 5 (memory_monitor) prunes CC-managed files — running it first means our curator writes don't get stomped within the same tick. Phase 6b (embedding backfill) must run AFTER chunker because the chunker inserts `embedding_ref=NULL` and the backfill is what populates it. PLAN §Tasks/04-04-03 documents both invariants in code comments.
- **Per-project curator dedup via Set.** Multiple pending rows from the same project trigger a single curator run per tick. Chunker still runs per-session because transcript_chunk is session-scoped. This keeps the per-tick cost bounded on batch sessions (e.g., if 5 sessions from one project close between ticks).
- **Failure isolation scope.** Three independent try/catch: chunker, curator, done-mark. If the done-mark throws, the pending row is re-processed next tick — but both chunker (idempotency guard: skip if any `transcript_chunk` rows exist for the session) and curator (idempotency fast-path: bytes equal → no write) are idempotent, so double-processing is safe. Not a bug, not a hack — a property of the upstream modules.
- **Memory-monitor guard uses any-length hex.** Following the pattern in plan 04-03's verifier: producers write 64-char hashes but the guard accepts `hash=[0-9a-f]+` so a non-canonical sentinel still flags 'Angel owns this'. Safer than a strict `{64}` match for guard semantics.

## Deviations from Plan

- **Memory-monitor test file uses dynamic `await import`.** PLAN §Tasks/04-04-04 specified 'add tests to memory-monitor test file if one exists, otherwise create'. The file didn't exist, so I created it. Required dynamic imports of `memory-monitor.js` per test because the module resolves `CC_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')` at import-evaluation time. Vitest would otherwise capture the developer's real HOME before `beforeEach` can override. `vi.resetModules()` + `await import(...)` per test fixes it cleanly. Same pattern as RESEARCH §1 in plan 04-03's SUMMARY for path-capturing modules.
- **Heartbeat integration test chunker wrapper.** PLAN §Tasks/04-04-05 described the integration test in prose. My implementation wraps the chunker through a `vi.fn()` that forwards to the real `chunkSessionTranscript` by default (resolved once per suite via `vi.importActual`), with one test overriding the implementation for failure-isolation. Cleaner than a `vi.spyOn` on the imported namespace, which doesn't compose with `await import()` dynamic imports from inside heartbeat.ts.
- **Did NOT remove `vi.restoreAllMocks()` via `afterEach` globally**. Initial version had it; turned out it clears the wrapper's `mockImplementation` between tests, which breaks the pass-through. Removed it — each test sets the implementation fresh in `beforeEach` via `mockChunker.mockImplementation(...)`.
- **Integration test assertion count.** PLAN §Tasks/04-04-05 lists 5 assertion groups (end-to-end, no-op second tick, re-render after input change, failure isolation). I packaged them as 4 `it()` blocks because the 'two completed sessions → 2 chunks + 2 writes' and 'sentinel present + section headers' assertions are one end-to-end scenario. Semantically equivalent; fewer DB fixtures to assemble.

## Issues Encountered

- Initial `vi.spyOn(chunkerModule, 'chunkSessionTranscript')` approach in the integration test didn't intercept calls because the heartbeat uses dynamic `await import()` which may return a separate module record under some resolver paths. Switched to `vi.mock(...)` with a `vi.fn()` wrapper that forwards to `vi.importActual(...)`'s real implementation — the wrapper's override is respected by the dynamic import because both resolve to the same mocked module.
- The 'third tick re-curates p1 only' test initially failed with ENOENT on `MEMORY.md` because `vi.restoreAllMocks()` in afterEach was clearing the chunker wrapper's implementation between tests, causing subsequent tests to call an undefined function. Removing the restore call fixed it — each `beforeEach` installs the default forwarder fresh.

## Next Phase Readiness

- **Plan 04-05 (phase gate)** can proceed. The full P3 pipeline is now wired end-to-end: `/endsession` → hook enqueue → Angel tick → chunker + curator. BENCH gate test can exercise a real session close and assert the file-on-disk shape + event pair.
- **Phase 5 (P4, assembly/injection-section deletion)** can read both `memory_curation_pending` and `memory_curation_done` events to build a 'last successful curation' signal or a 'how many sessions since last curation' metric — the data contract is there.
- **No injection path changed.** Dual-injection remains intact. Assembly continues to read the existing sections; the MEMORY.md file produced by Phase 5b is the durable artifact but is not yet read into any assembled prompt.

---
*Phase: 04-p3-memory-md-curation-auto-dream-guard*
*Completed: 2026-04-22*
