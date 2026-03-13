# Phase 8: CC Hook Adapter — Context

## Purpose

Wire all core subsystems (Phases 0-7) into Claude Code's lifecycle hook system. Creates 6 hook entry points (each an ephemeral Node.js process), shared infrastructure (stdin/stdout protocol, bootstrap), and a `claudex setup` CLI for fresh installs.

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

- **ADPT-01**: CC hook adapter maps 6 hooks to RuntimeEvent
- **ADPT-02**: CC_CAPABILITIES declared correctly (already in `src/shared/constants.ts`)
- **ADPT-03**: Ephemeral process lifecycle: stdin JSON -> SQLite -> stdout JSON -> exit
- **ADPT-07**: `claudex setup` CLI creates DB, patches `~/.claude/settings.json`, offers optional v2 migration
- **ADPT-08**: Adapter auto-detection from environment

## Architecture References

- Section 3.1: Capability-aware event model, RuntimeEvent, CC_CAPABILITIES
- Section 3.2: CC Hook Adapter — hook mapping table, ephemeral process lifecycle, latency budget
- Section 4.3: Database initialization (fresh install + optional v2 migration)
- Section 5: Observation extraction pipeline flow
- Section 10c: Telemetry event schemas (hook_invocation, injection, etc.)
- Section 11.1: Config file schema
- Section 12: File structure (adapters/cc-hooks/, cli/)
- Section 14: Phase 8 implementation steps

## Confirmed Design Decisions

### 1. No createCore() orchestrator class

The Architecture pseudocode shows a `createCore(CC_CAPABILITIES)` factory, but the implemented codebase uses plain functions with `db: Database` as first param. Each hook entry point calls the relevant functions directly (processToolObservation, assembleFullContext, etc.) rather than going through a class. The hooks ARE the orchestration layer. The `ClaudexCore` interface in types.ts remains unused for now.

### 2. Thread tracker statefulness in ephemeral hooks

The ThreadTracker class holds in-memory state between after_tool calls. Since CC hooks are ephemeral processes, each PostToolUse is a separate process. Approach:
- Load thread state from DB (`getThreadState`) at hook start
- Accumulate exchanges in the loaded state during PostToolUse
- Save back to DB (`upsertThreadState`) at hook end
- Stop hook flushes the final thread snapshot
- The `key_exchanges` JSON column already holds the 8-entry window — straightforward.

### 3. Topic-shift detector statefulness

TopicShiftDetector holds a sliding window of recent prompt embeddings in memory. Approach:
- Store last 3 prompt texts in `thread_state` JSON data (not embeddings — they're cheap to recompute at ~5ms each via Ollama)
- At UserPromptSubmit: load recent prompts from thread_state, compute embeddings fresh, check similarity
- If Ollama unavailable, Jaccard fallback works without any stored state
- Keep it simple — no embedding persistence needed.

### 4. Build output already configured

`build.ts` already lists all 6 hook entry points (`src/adapters/cc-hooks/*.ts`) + `src/cli/setup.ts`. Produces CJS bundles in `dist/`. No changes needed.

### 5. Settings.json merge, not overwrite

The setup CLI must merge hook entries into existing `~/.claude/settings.json`, preserving other hooks and settings. Never overwrite the whole file.

## CC Hook Protocol

### Settings.json format

```json
{
  "hooks": {
    "SessionStart": [{"matcher": "", "hooks": [{"type": "command", "command": "node /path/to/dist/session-start.mjs"}]}],
    "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "node /path/to/dist/user-prompt-submit.mjs"}]}],
    "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "node /path/to/dist/post-tool-use.mjs"}]}],
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "node /path/to/dist/stop.mjs"}]}],
    "PreCompact": [{"matcher": "", "hooks": [{"type": "command", "command": "node /path/to/dist/pre-compact.mjs"}]}],
    "SessionEnd": [{"matcher": "", "hooks": [{"type": "command", "command": "node /path/to/dist/session-end.mjs"}]}]
  }
}
```

### Hook-to-event mapping

| CC Hook | RuntimeEvent kind | Returns injection? | Latency target |
|---------|------------------|--------------------|----------------|
| SessionStart | session_init | Yes (additionalContext) | <500ms |
| UserPromptSubmit | before_prompt | Conditional (systemMessage) | <100ms (most), <500ms (injection) |
| PostToolUse | after_tool | No | <100ms |
| Stop | after_turn | No | <150ms |
| PreCompact | before_compact | No | <3000ms |
| SessionEnd | session_end | No | <500ms |

### Ephemeral process lifecycle

```
CC fires hook
  -> Node.js process starts
  -> reads stdin JSON
  -> opens SQLite (WAL mode, fast)
  -> loads config from disk (cached by mtime in future)
  -> detects project scope
  -> calls appropriate core pipeline functions
  -> emits telemetry (hook_invocation)
  -> writes stdout JSON (injection payload or empty {})
  -> closes DB
  -> process exits
```

## Hook Responsibilities

### SessionStart (session_init)
- Create session record (`createSession`)
- Run checkpoint recovery (`recoverFromDb` — re-mirror committed rows)
- Prune telemetry (retention policy)
- Full assembly (`assembleFullContext`)
- Return `{ additionalContext: content }` or empty

### UserPromptSubmit (before_prompt)
- Check post-compaction flag (`getCheckpointTracking`)
- Read token gauge (`getTokenGauge` via transcript JSONL)
- Detect topic shift (load recent prompts from thread_state, run TopicShiftDetector)
- Call `assembleRegularPrompt` (post-compaction -> topic-shift -> gauge -> zero)
- Clear post-compact-pending if was set
- Return `{ systemMessage: content }` or empty

### PostToolUse (after_tool)
- Run extraction pipeline (`processToolObservation`)
- Update pressure scores (from extracted files_modified)
- Load thread state, add tool action gist, save back
- Increment observation count in checkpoint_tracking
- Check checkpoint thresholds (token gauge based)
- No stdout injection

### Stop (after_turn)
- Run decision capture on turn text (`captureDecisions`)
- Load thread state, flush final snapshot (user/agent exchange), save back
- Check checkpoint threshold
- No stdout injection

### PreCompact (before_compact)
- Write checkpoint (compaction trigger) (`writeCheckpoint`)
- Promote session learnings (`promoteLearnings`)
- Mark post-compact-pending flag (`markPostCompactPending`)
- No stdout injection

### SessionEnd (session_end)
- Write final checkpoint (session_end trigger)
- Run decay engine (`pruneObservations`, `applyRetentionPolicy`)
- Run stratified pressure decay (`decayPressureStratified`)
- End session record (`endSession`)
- Prune telemetry
- No stdout injection

## Plan Split

### 08-01: Hook infrastructure + 6 entry points
- `src/adapters/cc-hooks/infrastructure.ts` — readStdin, writeStdout, bootstrapHook (open DB, load config, detect scope), wrapHook (latency tracking, error handling, telemetry)
- 6 entry point files in `src/adapters/cc-hooks/`
- Tests for infrastructure and each hook

### 08-02: Setup CLI
- `src/cli/setup.ts` — claudex setup command
- Directory creation, DB init, config write, settings.json merge
- v2 detection and optional migration
- Auto-detection logic
- Tests for setup CLI

## Key Module Interfaces (for hook integration)

```
storage.ts:        openDatabase(path) -> Database, closeDatabase(db)
migrations.ts:     initializeSchema(db), migrateFromV2(db, v2Path)
config.ts:         loadConfig() -> ClaudexConfig
scope-detector.ts: detectScope(cwd) -> { project, scope }
sessions.ts:       createSession(db, {...}), endSession(db, sessionId)
observations.ts:   insertObservation(db, {...}), getObservationsByProject(db, ...)
extractor.ts:      processToolObservation({db, sessionId, project, toolName, ...})
assembler.ts:      assembleFullContext({db, project, ...}), assembleRegularPrompt({...})
checkpoint/writer: writeCheckpoint({db, sessionId, ...})
checkpoint/loader: loadCheckpoint(db, projectDir), recoverFromDb(db)
thread-tracker.ts: ThreadTracker class (load/save via getThreadState/upsertThreadState)
topic-shift.ts:    TopicShiftDetector class (construct with EmbeddingProvider or null)
decision-capture:  captureDecisions({db, sessionId, text, ...})
learnings-promoter: promoteLearnings({db, project, sessionLearnings})
token-gauge.ts:    getTokenGauge({capabilities, transcriptPath, model})
decay-engine.ts:   pruneObservations(db, project, opts), applyRetentionPolicy(db, project)
pressure-decay.ts: decayPressureStratified(db)
telemetry.ts:      emitTelemetry(db, sessionId, kind, detail, latency), pruneTelemetry(db)
checkpoint-tracking: getCheckpointTracking(db, sid), markPostCompactPending(db, sid), clearPostCompactPending(db, sid)
pressure.ts:       updatePressureScore(db, filePath, project, increment), getHotFiles(db, project, limit)
constants.ts:      CC_CAPABILITIES (already defined)
paths.ts:          getDbPath(), getConfigPath(), getClaudexHome(), getCheckpointsDir(projectDir)
```

## Risks

- **Latency SLAs**: PostToolUse must stay <100ms including SQLite open/close. WAL mode is fast but ephemeral process overhead adds ~20-30ms. Monitor via telemetry.
- **Thread tracker load/save overhead**: Each PostToolUse loads and saves thread state. Should be <5ms per operation (single row upsert).
- **Topic-shift recomputing embeddings**: ~5ms per embed * 3 recent prompts = ~15ms. Acceptable within 500ms injection budget.
