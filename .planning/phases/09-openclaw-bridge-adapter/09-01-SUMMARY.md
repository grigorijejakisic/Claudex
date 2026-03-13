---
phase: 09-openclaw-bridge-adapter
plan: 01
status: complete
duration: 4min
tasks_completed: 2
files_created:
  - src/adapters/openclaw-bridge/bridge-types.ts
  - src/adapters/openclaw-bridge/bridge-adapter.ts
  - src/adapters/openclaw-bridge/plugin-entry.ts
  - src/tests/adapters/openclaw-bridge/bridge-adapter.test.ts
  - src/tests/adapters/openclaw-bridge/plugin-entry.test.ts
tests: 27 passed, 0 failed
---

## What Was Done

### Task 1: Bridge types and adapter callbacks
- **bridge-types.ts**: Exports `BRIDGE_KEY` as `Symbol.for('claudex.v3.bridge')`, `ClaudexBridge` interface with 5 callbacks, Pi SDK type stubs (`PiContext`, `PiToolResultContext`, `PiMessageEndContext`, `PiCompactContext`, `PiCompactPrep`, `PiRuntime`, `PiExtension`, `OpenClawPluginApi`, `BridgeInitContext`)
- **bridge-adapter.ts**: Exports `createBridgeCallbacks(bctx)` returning `ClaudexBridge` with 5 callbacks mapping Pi SDK events to core pipeline calls. Exports `mapTokenUsage()` for SDK-to-TokenUsage conversion. All callbacks defensive non-throwing with `'error'` telemetry on failure.
- 20 tests covering all 5 callbacks, mapTokenUsage, and error handling

### Task 2: Plugin entry point
- **plugin-entry.ts**: Exports `activate(api)` that opens DB once, creates bridge callbacks, registers on `globalThis[BRIDGE_KEY]`, and registers `session_end` cleanup (write checkpoint, decay, end session, prune telemetry, clear globalThis, close DB)
- 7 tests covering registration, lifecycle, graceful degradation, and full integration

## Key Decisions
- Error telemetry uses `'error'` EventKind with `subsystem: 'bridge:<callback>'` (not a custom `'bridge_error'` kind)
- `import type Database from 'better-sqlite3'` (default import) for namespace access to `Database.Database`
- Compact tests use `provider: 'native'` config to skip Ollama network calls (avoids 3s timeout per test)
- DB lifecycle: opened once in `activate()`, closed in `session_end` hook (persistent, not ephemeral)

## Verification
- `npx tsc --noEmit`: clean compilation
- 27/27 tests pass (bridge-adapter: 20, plugin-entry: 7)
- `bun run build` produces `dist/adapters/openclaw-bridge/plugin-entry.js` (204KB)
- ADPT-04: Bridge registers via `globalThis[Symbol.for('claudex.v3.bridge')]`
- ADPT-05: `OPENCLAW_CAPABILITIES` imported from `shared/constants.ts`
- ADPT-06: `activate()` works as standard OpenClaw plugin install
