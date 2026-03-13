---
phase: 08-cc-hook-adapter
plan: 01
status: complete
started: 2026-03-12
completed: 2026-03-12
duration: 4min
tasks_completed: 2
files_created:
  - src/adapters/cc-hooks/infrastructure.ts
  - src/adapters/cc-hooks/session-start.ts
  - src/adapters/cc-hooks/user-prompt-submit.ts
  - src/adapters/cc-hooks/post-tool-use.ts
  - src/adapters/cc-hooks/stop.ts
  - src/adapters/cc-hooks/pre-compact.ts
  - src/adapters/cc-hooks/session-end.ts
  - src/tests/adapters/cc-hooks/infrastructure.test.ts
  - src/tests/adapters/cc-hooks/hooks.test.ts
tests_added: 36
tests_passing: 36
---

## What was built

Hook infrastructure module (`infrastructure.ts`) with 6 CC hook entry points implementing the ephemeral process lifecycle per Architecture Section 3.2.

### infrastructure.ts
- `readStdin()` — reads stdin JSON, non-throwing with safe default
- `writeStdout()` — writes JSON to stdout, non-throwing
- `bootstrapHook()` — opens DB, loads config, detects project scope
- `detectAdapter()` — identifies CC vs OpenClaw from globalThis bridge symbol
- `getTranscriptPath()` — extracts transcript path from input (snake_case + camelCase)
- `wrapHook()` — HOF wrapping handlers with latency measurement, error catching, telemetry emission, DB close

### 6 Hook Entry Points
Each follows: `wrapHook('HookName', handler)` pattern with `main()` invocation.

| Hook | Event | Returns | Key operations |
|------|-------|---------|---------------|
| session-start.ts | session_init | `{ additionalContext }` | createSession, recoverFromDb, pruneTelemetry, assembleFullContext |
| user-prompt-submit.ts | before_prompt | `{ systemMessage }` | checkPostCompact, getTokenGauge, TopicShiftDetector, assembleRegularPrompt |
| post-tool-use.ts | after_tool | `{}` | processToolObservation, updatePressureScore, ThreadTracker.onAfterTool |
| stop.ts | after_turn | `{}` | captureDecisions (with optional embedding classifier), ThreadTracker.onAfterTurn |
| pre-compact.ts | before_compact | `{}` | writeCheckpoint(compaction), promoteLearnings, markPostCompactPending |
| session-end.ts | session_end | `{}` | writeCheckpoint, pruneObservations, decayPressureStratified, endSession |

### Key Decisions
- No `createCore()` orchestrator class — hooks call functions directly
- ThreadTracker load/save per ephemeral process via DB persistence
- `HookInvocationDetail` telemetry uses `result: 'inject' | 'skip'` based on output content
- `NonNullable<>` wrapper for classifier templates type to satisfy strict TS
