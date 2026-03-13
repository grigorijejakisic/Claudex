# Phase 9: OpenClaw Bridge Adapter — Context

## Purpose

Wire all core subsystems (Phases 0-7) into OpenClaw via a persistent in-process globalThis Symbol bridge. Creates 3 adapter files: bridge types, bridge adapter (6 callbacks), and plugin entry point (activate function). This is the second of two adapters — the counterpart to Phase 8's CC Hook Adapter.

## Dependencies (all complete)

- Phase 0: Repository Setup (shared types, paths, config, constants)
- Phase 1: Storage Layer (SQLite, CRUD modules, telemetry)
- Phase 2: Extraction Pipeline (per-tool extractors, redaction, quality gates)
- Phase 3: Intelligence Core (decision capture, thread tracker, dedup, learnings)
- Phase 4: Intelligence v1.2 (embeddings, topic-shift, enrichment)
- Phase 5: Assembly Pipeline (priority-budgeted assembly, sections, boundary-only)
- Phase 6: Checkpoint System (ULID writer, 3-hop loader, inject renderer)
- Phase 7: Supporting Subsystems (token gauge, decay engine, GSD reader)

## Requirements

- **ADPT-04**: OpenClaw bridge adapter registers via `globalThis[Symbol.for('claudex.v3.bridge')]` and receives callbacks from OpenClaw gateway
- **ADPT-05**: OPENCLAW_CAPABILITIES declared correctly (already in `src/shared/constants.ts`)
- **ADPT-06**: Plugin `activate()` function works as standard OpenClaw plugin install

## Architecture References

- Section 3.1: Capability-aware event model, RuntimeEvent, OPENCLAW_CAPABILITIES (lines 108-264)
- Section 3.3: OpenClaw Bridge Adapter — event mapping table, globalThis registration, plugin-side code (lines 360-474)
- Section 12: File structure — `adapters/openclaw-bridge/` (lines 2026-2029)
- Section 14: Phase 9 implementation steps

## Confirmed Design Decisions

### 1. No createCore() orchestrator class

Consistent with Phase 8: call core functions directly rather than using a ClaudexCore class. The bridge callbacks ARE the orchestration layer. Each callback maps a Pi SDK event to the appropriate core pipeline functions.

### 2. Persistent DB lifecycle (unlike CC hooks)

CC hooks open/close DB per ephemeral process. The OpenClaw bridge opens DB once in `activate()` and keeps it open for the entire session. Module-level `db` reference with cleanup in session_end hook.

### 3. Pi SDK type stubs (not runtime dependency)

Define minimal stub interfaces for `PiExtension`, `OpenClawPluginApi`, and Pi SDK context objects in `bridge-types.ts`. Match what the architecture shows, nothing more. OpenClaw types are not a runtime dependency.

### 4. OPENCLAW_CAPABILITIES already exists

Defined in `src/shared/constants.ts` (lines 19-28). No need to redefine.

## Bridge Protocol

### globalThis Symbol registration

```typescript
const BRIDGE_KEY = Symbol.for('claudex.v3.bridge');

// Plugin registers bridge object on globalThis:
(globalThis as any)[BRIDGE_KEY] = {
  onInit(ctx) { ... },
  onContext(ctx) { ... },
  onToolResult(ctx) { ... },
  onTurnEnd(ctx) { ... },
  onCompact(ctx, prep, runtime) { ... },
};

// OpenClaw's extensions.ts discovers it:
const bridge = (globalThis as any)[BRIDGE_KEY];
if (!bridge?.onInit) { /* fallback */ }
```

### Pi SDK Event -> RuntimeEvent mapping

| Pi SDK Event | RuntimeEvent kind | Injection? | Notes |
|---|---|---|---|
| Bridge `onInit` | `session_init` | Yes (enqueueSystemEvent) | Full assembly for session restore |
| `context` event | `before_prompt` | Conditional | Full assembly if post-compaction; provides `messageHistory` + `tokenUsage` |
| `tool_result` event | `after_tool` | No | Tool output available directly from SDK |
| `message_end` event | `after_turn` | No | Thread tracking, decision capture from full turn |
| `session_before_compact` | `before_compact` | No | Checkpoint + enrichment (supportsAsyncEnrichment=true) |
| (session_end via api.registerHook) | `session_end` | No | Final checkpoint, decay, cleanup |

### Key differences from CC hooks

| Aspect | CC Hooks (Phase 8) | OpenClaw Bridge (Phase 9) |
|--------|-------------------|--------------------------|
| Lifecycle | Ephemeral process per hook | Persistent in-process (DB stays open) |
| Communication | stdin/stdout JSON | globalThis Symbol bridge with direct calls |
| DB lifecycle | Open/close per invocation | Open once at activate(), close on session_end |
| Capabilities | CC_CAPABILITIES (transcript, no history) | OPENCLAW_CAPABILITIES (history, native usage, no transcript) |
| Injection | Returns `{ additionalContext }` or `{ systemMessage }` via stdout | Calls `enqueueSystemEvent` or returns via context callback |
| Token usage | Transcript JSONL parsing | `ctx.getContextUsage()` natively |
| Message history | Not available | Full `ctx.messages` available |
| Enrichment | Ollama only (CC API = deadlock) | Ollama or native `completeSimple` |

## Callback Responsibilities

### onInit (session_init)
- Create session record (`createSession` with source: 'bridge_init')
- Run checkpoint recovery (`recoverFromDb`)
- Prune telemetry
- Full assembly (`assembleFullContext`)
- Return inject payload for enqueueSystemEvent

### onContext (before_prompt)
- Check post-compaction flag
- Map `ctx.getContextUsage()` to TokenUsage
- Detect topic shift (recent prompts from thread_state)
- Call `assembleRegularPrompt`
- Clear post-compact-pending if set
- Return inject payload or void

### onToolResult (after_tool)
- Run extraction pipeline (`processToolObservation`)
- Update pressure scores
- Thread tracking (`ThreadTracker.onAfterTool`)
- Check checkpoint thresholds
- No injection

### onTurnEnd (after_turn)
- Decision capture (`captureDecisions` with mode after_turn)
- Thread tracking (`ThreadTracker.onAfterTurn`)
- Check checkpoint threshold
- No injection

### onCompact (before_compact)
- Write checkpoint (compaction trigger) with enrichment
- Promote learnings
- Mark post-compact-pending
- No injection

### session_end (via api.registerHook)
- Write final checkpoint
- Run decay (prune observations, retention policy)
- Run pressure decay
- End session record
- Prune telemetry
- Close DB

## Plan Split

### 09-01: Bridge types + adapter + plugin entry + tests
- `src/adapters/openclaw-bridge/bridge-types.ts` — BRIDGE_KEY constant, callback interfaces, Pi SDK type stubs
- `src/adapters/openclaw-bridge/bridge-adapter.ts` — 6 callback functions mapping Pi SDK events to core pipeline calls
- `src/adapters/openclaw-bridge/plugin-entry.ts` — activate() function, globalThis registration, session_end cleanup
- Tests for bridge registration, callback mapping, core function calls

## Key Module Interfaces (for bridge integration)

Same as Phase 8 — the bridge calls the same core functions:

```
storage.ts:        openDatabase(path) -> Database, closeDatabase(db)
config.ts:         loadConfig() -> ClaudexConfig
scope-detector.ts: detectProjectScope(cwd) -> string | null
sessions.ts:       createSession(db, {...}), endSession(db, sessionId)
extractor.ts:      processToolObservation({db, sessionId, project, toolName, ...})
assembler.ts:      assembleFullContext({db, project, ...}), assembleRegularPrompt({...})
checkpoint/writer: writeCheckpoint({db, sessionId, ...}), shouldTriggerCheckpoint({...})
checkpoint/loader: recoverFromDb(db)
thread-tracker.ts: ThreadTracker class
topic-shift.ts:    TopicShiftDetector class
decision-capture:  captureDecisions({db, sessionId, text, ...})
learnings-promoter: promoteLearnings({db, project, sessionLearnings})
token-gauge.ts:    getTokenGauge({capabilities, nativeUsage, model})
decay-engine.ts:   pruneObservations(db, project, opts), applyRetentionPolicy(db, project)
pressure-decay.ts: decayPressureStratified(db)
pressure.ts:       updatePressureScore(db, filePath, project, increment)
telemetry.ts:      emitTelemetry(db, sessionId, kind, detail, latency), pruneTelemetry(db)
checkpoint-tracking: getCheckpointTracking(db, sid), markPostCompactPending(db, sid), clearPostCompactPending(db, sid)
constants.ts:      OPENCLAW_CAPABILITIES (already defined)
paths.ts:          getDbPath(), getConfigPath(), getClaudexHome(), getCheckpointsDir(projectDir)
embeddings:        EmbeddingProvider, initTemplates
enrichment.ts:     detectEnrichmentProvider
gsd/state-reader:  readGsdState(cwd)
```

## Build Output

Architecture Section 12 specifies `dist/openclaw-plugin.mjs` as the build artifact for this adapter. The `build.ts` entry points list needs `src/adapters/openclaw-bridge/plugin-entry.ts` added.

## Risks

- **globalThis pollution**: Symbol.for() is global — ensure cleanup on deactivate/session_end to avoid leaking between test runs or reloads.
- **DB connection lifetime**: Long-running OpenClaw sessions mean the DB stays open for hours. WAL mode handles this well, but must ensure no connection leaks.
- **Type stub drift**: Pi SDK type stubs may diverge from actual OpenClaw types. Keep stubs minimal and update when integrating with real OpenClaw in Phase 10/11.
