# Environmental Event Audit — Phase 1 Plan 03

**Purpose:** Catalogue every site in the codebase where an environmental event could plausibly write into `episodic_events` with `provenance='environmental'`, plus the explicit instrument/defer/never decision for each. Phase 6 (Crash-resilient episode boundary) will revisit deferred sites when fsnotify + heartbeat + idle-sweep land.

**Audit date:** 2026-05-04
**Auditor:** Plan 01-03 execution (autonomous)

---

## Sites instrumented in this plan (3)

| Site | File | Type | Source | Content shape | Why |
|------|------|------|--------|----------------|-----|
| session-start hook fires | `src/adapters/cc-hooks/session-start.ts` (right after `createSession`) | `session_boundary` | `cc-hooks/session-start` | `"Session opened: <session_id>"` | Substrate needs a "this session began" marker so future readers (Phase 3 retrieval, Phase 6 episode-boundary) can scope episode windows. |
| session-end hook fires | `src/adapters/cc-hooks/session-end.ts` (right after `runSessionEndCleanup`) | `session_boundary` | `cc-hooks/session-end` | `"Session closed: <session_id>"` | Pair with session-start; Phase 6 reads start+end pairs to compute session bounds. |
| Angel heartbeat tick | `src/angel/heartbeat.ts` (top of `heartbeatTick`) | `environmental_event` | `angel/heartbeat` | `"Heartbeat tick"` | Required for Phase 6's idle-timeout sweep — fsnotify needs heartbeat rows to distinguish "active" from "dormant" sessions/processes. metadata_json includes tick duration when known. |

Each site uses `writeEnvironmentalEvent(...)` from `src/core/episodic-events.ts`. Hooks await; Angel may fire-and-forget per `.claude/rules/hooks-safety.md`. The write is single-row, single-transaction; on rollback one telemetry row lands with `event_kind='episodic_write_failure'`.

---

## Sites deliberately NOT instrumented in Phase 1 (deferred to later phases)

| Site | File | Why deferred |
|------|------|--------------|
| post-compact hook fires | `src/adapters/cc-hooks/post-compact.ts` | Compaction is a real episode-relevant event but interpreting it (was the compaction successful? what was lost?) requires the Phase 6 episode-boundary semantics. Defer. |
| pre-compact hook fires | `src/adapters/cc-hooks/pre-compact.ts` | Mirror of post-compact; defer with the same justification. |
| subagent-start / subagent-stop | `src/adapters/cc-hooks/subagent-start.ts`, `subagent-stop.ts` (via the wrapHook generic; not under cc-hooks/ as standalone files in V25 — see `src/adapters/cc-hooks/infrastructure.ts`) | Subagent lifecycle is part of teammate coordination, not the Phase 1 substrate. Phase 4/6 will revisit when teammate trace-stitching becomes load-bearing. |
| task-created / task-completed | `src/adapters/cc-hooks/task-*` (via wrapHook) | TaskCreate/TaskUpdate are app-layer, not episode-substrate. The events already feed the existing `task_*` tables; Phase 1 has no need to mirror them. |
| permission-request / permission-denied | `src/adapters/cc-hooks/permission-*.ts` | User-interaction events; orthogonal to Phase 1's "what did the agent see" axis. Defer to a later phase if behavioral-signal analysis ever wants them. |
| elicitation / elicitation-result | `src/adapters/cc-hooks/elicitation*.ts` | Same reasoning as permission events. |
| post-tool-use-failure | `src/adapters/cc-hooks/post-tool-use-failure.ts` | The failure already routes through `error-telemetry`. Tool *result* writes (Plan 03 Task 1) cover the success case. A failed tool with no output does not produce an episodic row in Phase 1. Phase 2/4 may revisit when error-fingerprint indexes land. |
| stop-failure | `src/adapters/cc-hooks/stop-failure.ts` (via wrapHook) | Stop hook failure — already telemetry-tracked; Phase 1 does not need a mirror. |
| config-change | `src/adapters/cc-hooks/config-change.ts` | Not session-bound; cross-cutting environment metadata. Defer. |
| instructions-loaded | `src/adapters/cc-hooks/instructions-loaded.ts` | Loaded once at session start; the session_boundary marker covers its semantic (session began). |
| cwd-changed | `src/adapters/cc-hooks/cwd-changed.ts` | Cross-cutting environment metadata. Defer. |
| worktree-create / worktree-remove | `src/adapters/cc-hooks/worktree-*.ts` | Git infrastructure events; not episode substrate. Defer. |
| Angel idle-warning send | `src/angel/heartbeat.ts` (`sendIdleWarning` call site) | Idle warnings already record session_event rows + telemetry; mirroring into episodic_events would duplicate. Phase 6 will revisit when idle-sweep semantics tighten. |
| Angel auto-close orphans | `src/angel/heartbeat.ts` (escalated idle session close path) | Same reasoning as idle-warning. |
| Angel pattern-extractor invocation | `src/angel/pattern-extractor.ts` | Pattern extraction is itself a Phase 4 reduction target — instrumenting its lifecycle into episodic_events while we're planning to delete it would be wasted work. |
| Angel reranker-supervisor lifecycle | `src/angel/reranker-supervisor.ts` | Supervisor health is in `telemetry` (`event_kind='reranker_fallback'`); episodic mirror would duplicate. Phase 6 may want a process-liveness marker; defer. |
| OpenClaw bridge plugin entry | `src/adapters/openclaw-bridge/plugin-entry.ts` | The bridge is a separate adapter with its own session lifecycle; instrumenting it requires deciding the (sessionId, project) tuple semantics for bridge-driven sessions. Phase 6 boundary work covers this. |
| post-compact embeddings refresh | `src/embeddings/*` | Internal index maintenance; not episode-relevant from a recall standpoint. |

Total deferred: **17 categories of sites.** The audit is intentionally exhaustive on the cc-hooks side because Phase 6's `fsnotify + heartbeat + idle-sweep + PID-liveness` work needs the complete map.

---

## Sites NOT instrumented (out of scope forever)

| Site | Why never |
|------|-----------|
| `src/observability/telemetry.ts` `emitTelemetry()` | The telemetry table IS the structured environmental signal surface for "the system did X." Mirroring every telemetry row into episodic_events would duplicate without adding any modality (Phase 2 indexes will read from telemetry directly when relevant). |
| `src/observability/error-telemetry.ts` `emitErrorTelemetry()` | Same: errors live in `telemetry` (`event_kind='error'`). Mirroring would inflate episodic_events with operational noise that the substrate's "what did the agent see" axis does not need. |
| Any DB transaction commit / rollback | Internal infrastructure; not user-observable. |
| sqlite-vec extension load | Internal infrastructure. |
| `db.pragma()` calls during migration | Internal. |
| stmt-cache LRU evictions | Internal. |

---

## How to extend this list (for Phase 6 / future phases)

1. Identify the new site by greping for the trigger (e.g., `fsnotify`, `setInterval`, `process.on('exit')`).
2. Decide instrument/defer/never using the heuristic: **does a future LLM-facing reader need this row to disambiguate "what happened to the agent's environment"?** If yes → instrument. If maybe → defer. If only ops cares → never (use telemetry instead).
3. Append to the appropriate table here. The audit document is the substrate-completeness contract — it should remain the single source of truth for the environmental surface.

---

*Phase: 01-episode-substrate*
*Plan: 03*
*Audit committed: 2026-05-04*
