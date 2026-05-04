---
phase: 01-episode-substrate
plan: 03
subsystem: database
tags: [episode-substrate, tool-result, environmental, provenance, audit]

requires:
  - phase: 01-02
    provides: episodic-events.ts module + dualWrite helpers + telemetry-on-rollback pattern
provides:
  - writeToolResult — single-row tool_result writer (no legacy mirror; tool boundary is the natural split)
  - writeEnvironmentalEvent — single-row environmental writer for session boundaries + heartbeat
  - PostToolUse hook instrumented to call writeToolResult after each tool firing
  - cc-hooks/session-start, cc-hooks/session-end, angel/heartbeat each write at least one environmental row
  - Environmental audit document mapping 3 instrumented + 17 deferred + 6 never-instrumented sites
affects: [01-04, phase-3, phase-4, phase-6]

tech-stack:
  added: []
  patterns:
    - "Tool boundary is the natural split — tool_result rows are NOT decomposed into sub-rows. Phase 4's reduced extractor treats tool_result as non-extraction-eligible by default."
    - "Heartbeat-as-substrate-marker: every Angel heartbeat tick lands one environmental_event row in the GLOBAL_PROJECT_SCOPE so Phase 6's fsnotify + idle-sweep can distinguish active from dormant processes."

key-files:
  created:
    - src/tests/adapters/episodic-events/dual-write-tool-result.test.ts
    - src/tests/adapters/episodic-events/environmental-events.test.ts
    - .planning/phases/01-episode-substrate/01-03-environmental-audit.md
  modified:
    - src/core/episodic-events.ts
    - src/adapters/cc-hooks/post-tool-use.ts
    - src/adapters/cc-hooks/session-start.ts
    - src/adapters/cc-hooks/session-end.ts
    - src/angel/heartbeat.ts

key-decisions:
  - "Heartbeat uses sessionId='angel-heartbeat' and project=GLOBAL_PROJECT_SCOPE since the tick is process-level, not session-bound. Phase 6 may revise this when episode-boundary semantics land."
  - "PostToolUse compute turn_number from MAX(conversation_turns.turn_number) at write time, not by passing it down from the user-prompt-submit context — the existing hook already lacks that context and adding it would touch processToolAndPressure's signature."
  - "Audit document catalogues 17 deferred sites exhaustively to give Phase 6 a complete substrate map; the audit IS the substrate-completeness contract."
  - "Tool result text is JSON.stringify(toolOutput) when toolOutput is an object; raw string is content. No truncation in Phase 1."

patterns-established:
  - "writeToolResult signature: { db, sessionId, project, toolName, toolInput, toolResult, turnNumber?, parentEventId? } -> { episodicId | null }"
  - "writeEnvironmentalEvent signature: { db, sessionId, project, type, source, content, metadata? } -> { episodicId | null }"
  - "Both helpers wrap their single-row INSERT in db.transaction(closure)() and on throw call recordEpisodicWriteFailure with a hook + kind discriminator before re-throwing."

requirements-completed: [EPI-03, EPI-05]

duration: 5 min
completed: 2026-05-04
---

# Phase 1 Plan 03: Tool-result + environmental write paths

**writeToolResult and writeEnvironmentalEvent complete the four-provenance substrate; PostToolUse, session-start, session-end, and Angel's heartbeat each emit the exact rows Phase 6 will consume.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-04T21:11:45Z
- **Completed:** 2026-05-04T21:16:28Z
- **Tasks:** 2
- **Files modified:** 8 (3 created, 5 modified)

## Accomplishments

- **`writeToolResult`** appended to `src/core/episodic-events.ts`. Per CONTEXT.md, tool results are NOT decomposed — single row per call with `provenance='tool_result'`, `source=<toolName>`, `metadata_json={tool_input}`, `parent_event_id=NULL`.
- **`writeEnvironmentalEvent`** appended to the same module. Single row with `provenance='environmental'`, `turn_number=NULL`, `parent_event_id=NULL`. Locked type set: `session_boundary | environmental_event`.
- **PostToolUse instrumented** at the bottom of the hook (after observation processing, behavioral signals, trigger engine, etc.). Failures route to `error-telemetry`; the new write never breaks the existing PostToolUse flow.
- **session-start instrumented** right after `createSession` — writes one `session_boundary` row with `content="Session opened: <id>"`. Phase 6 reads start+end pairs to compute episode windows.
- **session-end instrumented** after the cleanup phase — writes the paired close marker.
- **Angel heartbeat instrumented** at the top of `heartbeatTick` — writes one `environmental_event` row per tick with `metadata.tick_started_epoch_ms`. Project is `GLOBAL_PROJECT_SCOPE` since the tick is project-agnostic.
- **Environmental audit document** at `.planning/phases/01-episode-substrate/01-03-environmental-audit.md` catalogues all 3 instrumented sites + 17 deferred sites + 6 never-instrumented sites with explicit instrument/defer/never decisions and rationale per row. The audit is the substrate-completeness contract Phase 6 will read first.
- **15 new tests** (8 tool-result + 7 environmental) covering shape, hash, atomicity, multi-tool sequences, large/empty payloads, opaque-tool-result invariant, no-mirror-into-conversation_turns, start+end pair visibility under turn-bound filters.

## Task Commits

1. **Task 1: Tool-result writer + PostToolUse instrumentation** — `b9f6b73` (feat)
2. **Task 2: Environmental writer + 3 instrumented sites + audit doc** — `b4113ea` (feat)

## Files Created/Modified

- `src/core/episodic-events.ts` *(modified)* — append `writeToolResult` (single-row tool_result writer) and `writeEnvironmentalEvent` (single-row environmental writer). Both wrap `db.transaction()` + telemetry-on-rollback. Plan 02's `dualWriteUserPrompt`/`dualWriteAssistantMessage` and the helper functions (`sha256`, `insertEpisodicRow`, `recordEpisodicWriteFailure`, `captureError`) are unchanged.
- `src/adapters/cc-hooks/post-tool-use.ts` *(modified)* — final `try {...}` block before `return {}` calls `writeToolResult` with the current turn number from `MAX(conversation_turns.turn_number)`.
- `src/adapters/cc-hooks/session-start.ts` *(modified)* — `try {...}` block right after `createSession` writes the `session_boundary` row.
- `src/adapters/cc-hooks/session-end.ts` *(modified)* — `try {...}` block before `return {}` writes the paired close row.
- `src/angel/heartbeat.ts` *(modified)* — top of `heartbeatTick` writes one `environmental_event` row.
- `src/tests/adapters/episodic-events/dual-write-tool-result.test.ts` *(created)* — 8 tests including the no-decomposition invariant.
- `src/tests/adapters/episodic-events/environmental-events.test.ts` *(created)* — 7 tests including the start+end pairing test.
- `.planning/phases/01-episode-substrate/01-03-environmental-audit.md` *(created)* — full environmental site catalogue.

## Helper API (for Plan 04 reference)

```ts
writeToolResult({
  db, sessionId, project,
  toolName,                    // becomes source
  toolInput,                   // serialized into metadata_json under tool_input
  toolResult,                  // becomes content (string)
  turnNumber?,                 // current turn or undefined
  parentEventId?,              // NULL in Phase 1
}): { episodicId: number | null }

writeEnvironmentalEvent({
  db, sessionId, project,
  type,                        // 'session_boundary' | 'environmental_event'
  source,                      // e.g. 'cc-hooks/session-start'
  content,                     // human-readable description
  metadata?,                   // serialized into metadata_json
}): { episodicId: number | null }
```

Both throw on DB failure. Both record one telemetry row with `event_kind='episodic_write_failure'` (hook + kind discriminator + error_message + optional tool/type) on rollback before re-throwing.

## Audit pointer

`.planning/phases/01-episode-substrate/01-03-environmental-audit.md` is the canonical environmental-surface map. Phase 6 must read it before adding fsnotify-driven sites; future plans should append to its tables (instrument / defer / never) rather than creating parallel docs.

Deferred sites Phase 6 should revisit:
- `post-compact` / `pre-compact` (compaction event semantics)
- subagent-start / subagent-stop (teammate trace stitching)
- Angel idle-warning + auto-close orphan paths (avoid double-emit)
- OpenClaw bridge plugin entry (separate adapter session lifecycle)
- Reranker/llama-server supervisor lifecycle (process-liveness markers)

## Decisions Made

- **Heartbeat is process-level, not session-level.** Used `sessionId='angel-heartbeat'` + `project=GLOBAL_PROJECT_SCOPE` so the markers don't accidentally count as belonging to any user-driven session. Phase 6 may revise when fsnotify-driven boundaries land.
- **PostToolUse computes turn_number at write time** by querying `MAX(conversation_turns.turn_number)`. Adding a turn_number argument to `processToolAndPressure` would touch the lifecycle helper signature unnecessarily; the inline query is bounded by the existing index `idx_convturns_session`.
- **Tool result content is `JSON.stringify(toolOutput)`** when toolOutput is an object, empty string when undefined. No truncation in Phase 1; Phase 2 may add compression at index time.
- **Audit document is exhaustive on the cc-hooks side** because Phase 6's `fsnotify + heartbeat + idle-sweep + PID-liveness` work needs the complete map. Brevity of audit ≠ correctness of substrate.

## Deviations from Plan

None — Plan 01-03 executed exactly as written. The plan's `files_modified` whitelist is honored verbatim (5 modified + 3 created). The architectural deviation that landed in Plan 02 (extending the V25 telemetry CHECK enum to admit `episodic_write_failure`) was already in place when this plan executed, so the rollback telemetry surface used by `writeToolResult` and `writeEnvironmentalEvent` works without further migration changes.

## Issues Encountered

None directly tied to Plan 01-03. The 27 pre-existing full-suite failures (`llama-client.test.ts`, `llama-server-supervisor.test.ts`, `phase-5-full-gate.test.ts`) remain unchanged; Plan 01-03 added 15 new passing tests with zero regressions.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **Plan 01-04** (integration tests + impossibility proof + substrate README) can start immediately. The full four-provenance write surface is in place: `dualWriteUserPrompt` (organic + injected), `dualWriteAssistantMessage` (organic), `writeToolResult` (tool_result), `writeEnvironmentalEvent` (environmental). Plan 04 should:
  - Exercise the entire turn cycle end-to-end (UserPromptSubmit → PostToolUse → Stop → environmental boundaries) and assert the substrate's row pattern.
  - Author the EPI-07 stub-extractor proof at the integration level (separate from Plan 02's helper-level proof).
  - Author the operator-facing substrate README — the contract document Phase 2-7 read first when they touch the substrate.

---
*Phase: 01-episode-substrate*
*Plan: 03*
*Completed: 2026-05-04*
