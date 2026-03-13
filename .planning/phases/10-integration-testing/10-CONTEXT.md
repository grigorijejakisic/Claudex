# Phase 10: Integration Testing — Context

## Purpose

Validate the complete system end-to-end on both adapters, verify performance SLAs, and confirm observability data is queryable. This is validation-only — no production code changes expected. All 11 integration scenarios from Architecture Section 14 are covered across 2 plans.

## Dependencies (all complete)

- Phase 0: Repository Setup (shared types, paths, config, constants)
- Phase 1: Storage Layer (SQLite, CRUD modules, telemetry)
- Phase 2: Extraction Pipeline (per-tool extractors, redaction, quality gates)
- Phase 3: Intelligence Core (decision capture, thread tracker, dedup, learnings)
- Phase 4: Intelligence v1.2 (embeddings, topic-shift, enrichment)
- Phase 5: Assembly Pipeline (priority-budgeted assembly, sections, boundary-only)
- Phase 6: Checkpoint System (ULID writer, 3-hop loader, inject renderer)
- Phase 7: Supporting Subsystems (token gauge, decay engine, GSD reader)
- Phase 8: CC Hook Adapter (6 hooks, infrastructure, setup CLI)
- Phase 9: OpenClaw Bridge Adapter (bridge types, callbacks, plugin entry)

## Requirements

- **OBSV-03**: Telemetry queryable via standard SQL (session latency, decision precision, checkpoint lifecycle)
- **PERF-01**: UserPromptSubmit < 100ms on non-injection turns, < 500ms on injection turns
- **PERF-02**: PostToolUse < 100ms per tool call
- **PERF-03**: Stop hook < 150ms
- **PERF-04**: Aggregate per-turn overhead < 600ms common case
- **QUAL-06**: Full vitest test suite covering all modules

## Architecture References

- Section 3.2: CC Hook Adapter — 6 hooks, stdin/stdout, ephemeral lifecycle (lines 265-359)
- Section 3.3: OpenClaw Bridge Adapter — globalThis, persistent DB, 5 callbacks (lines 360-474)
- Section 10c: Observability — telemetry table, event schemas, 4 SQL queries (lines 1715-1840)
- Section 14: Phase 10 — 11 integration scenarios (lines 2152-2163)
- Section 17: Success criteria (lines 2187-2207)

## Existing Test Coverage

**Current state**: 43 test files, 700 tests, all passing (5.58s).

**Existing adapter tests** (unit-level, individual function calls):
- `src/tests/adapters/cc-hooks/hooks.test.ts` (366 lines) — tests each hook's orchestration in isolation
- `src/tests/adapters/cc-hooks/infrastructure.test.ts` — wrapHook, readStdin, writeStdout, bootstrapHook
- `src/tests/adapters/openclaw-bridge/bridge-adapter.test.ts` (456 lines) — tests 5 callbacks individually
- `src/tests/adapters/openclaw-bridge/plugin-entry.test.ts` (140 lines) — activate(), cleanup, degradation

**Gaps addressed by Phase 10**:
1. No sequenced end-to-end flow tests (all hooks in order against one DB)
2. No performance SLA assertions
3. No telemetry queryability validation (the 4 SQL queries from Section 10c)
4. No cross-session scenarios (learnings persistence, checkpoint recovery across sessions)

## Confirmed Design Decisions

### 1. All integration tests use in-memory SQLite

Same pattern as existing adapter tests (`new Database(':memory:')`). No filesystem I/O for DB. Checkpoint file writes use temp directories cleaned up in afterEach.

### 2. No Ollama dependency in CI

Topic-shift and enrichment tests use the Jaccard/heuristic fallback path. Ollama-dependent scenarios tested with mock EmbeddingProvider (established pattern in `src/tests/embeddings/embedding-provider.test.ts`).

### 3. Date.now() wall-clock for performance SLAs

Smoke tests, not micro-benchmarks. Assert < threshold. SLAs are generous enough (600ms common, 1000ms injection) that even in CI they should pass.

### 4. Test file location: `src/tests/integration/`

New directory separating integration tests from unit tests. Two files: `e2e-flows.test.ts` and `cross-cutting.test.ts`.

### 5. Telemetry query tests use Architecture 10c SQL queries verbatim

Execute the exact 4 SQL queries from Section 10c against a DB populated by a full flow. Validates OBSV-03 directly.

## 11 Integration Scenarios (Architecture Section 14)

| # | Scenario | Plan | Key Verification |
|---|----------|------|-----------------|
| 1 | E2E CC hook flow | 10-01 | SessionStart -> PostToolUse x N -> Stop -> PreCompact -> UserPromptSubmit (post-compaction) -> SessionEnd |
| 2 | E2E OpenClaw bridge flow | 10-01 | onInit -> onContext -> onToolResult x N -> onTurnEnd -> onCompact -> onContext (post-compaction) |
| 3 | Fresh install flow | 10-01 | `claudex setup` creates DB with all tables, writes config |
| 4 | Cross-session learnings | 10-02 | Session 1 captures learnings -> Session 2 sees promoted learnings in assembly |
| 5 | Checkpoint recovery | 10-02 | Write checkpoint -> simulate restart -> recover via DB + file fallback |
| 6 | Topic-shift micro-injection | 10-02 | Jaccard fallback path produces <= 800 token pivot block |
| 7 | Enrichment fallback | 10-02 | Ollama unavailable -> heuristic-only checkpoint preserved |
| 8 | FTS5 search quality | 10-02 | Store observations -> search -> verify BM25 with temporal re-ranking |
| 9 | Telemetry queryable | 10-02 | Run flow -> execute 4 SQL queries from Section 10c -> verify results |
| 10 | Pressure scoring + HOT files | 10-02 | Touch files -> verify HOT classification -> verify surfacing in assembly |
| 11 | Decay engine pruning | 10-02 | Create old observations -> run decay -> verify pruned/retained correctly |

## Plan Split

### 10-01: End-to-End Flow Tests + Performance SLAs

**File**: `src/tests/integration/e2e-flows.test.ts`

**Scenarios**: 1, 2, 3 + performance SLA assertions

- Full CC hook sequence against single DB, verifying accumulated state at each step (session created, observations stored, decisions captured, checkpoint written, telemetry emitted, session ended)
- Full OpenClaw bridge sequence against single DB, same verifications
- Fresh install flow (initializeSchema creates all tables/indexes/FTS5)
- Performance: measure wall-clock time of each hook, assert PERF-01 through PERF-04

### 10-02: Cross-Cutting Integration Scenarios + Observability

**File**: `src/tests/integration/cross-cutting.test.ts`

**Scenarios**: 4-11

- Cross-session learnings persistence and promotion
- Checkpoint write -> recovery (DB path + file fallback path)
- Topic-shift detection producing micro-injection via Jaccard fallback
- Enrichment graceful fallback (mock unavailable Ollama)
- FTS5 BM25 search with temporal re-ranking
- Telemetry SQL queries from Architecture 10c
- Pressure scoring, HOT classification, assembly surfacing
- Decay engine pruning with retention policy

## Key Module Interfaces (for integration tests)

Tests call the same core functions as the adapters:

```
storage.ts:          openDatabase(path), closeDatabase(db)
migrations.ts:       initializeSchema(db)
config.ts:           loadConfig() -> ClaudexConfig
sessions.ts:         createSession(db, {...}), endSession(db, sessionId), getSession(db, sessionId)
extractor.ts:        processToolObservation({db, sessionId, project, toolName, ...})
assembler.ts:        assembleFullContext({...}), assembleRegularPrompt({...})
checkpoint/writer:   writeCheckpoint({...}), shouldTriggerCheckpoint({...})
checkpoint/loader:   recoverFromDb(db), loadFromFile(path), followHopChain(...)
thread-tracker.ts:   ThreadTracker class (onAfterTool, onAfterTurn, persist)
topic-shift.ts:      TopicShiftDetector class (detectTopicShift)
decision-capture.ts: captureDecisions({db, sessionId, text, mode, ...})
learnings-promoter:  promoteLearnings({db, project, sessionLearnings})
token-gauge.ts:      getTokenGauge({capabilities, transcriptPath, nativeUsage})
decay-engine.ts:     pruneObservations(db, project, opts), applyRetentionPolicy(db, project, days)
pressure-decay.ts:   decayPressureStratified(db)
pressure.ts:         updatePressureScore(db, filePath, project, increment), getHotFiles(db, project, limit)
telemetry.ts:        emitTelemetry(db, sessionId, kind, detail, latency), pruneTelemetry(db, opts)
checkpoint-tracking: getCheckpointTracking, markPostCompactPending, clearPostCompactPending
observations.ts:     insertObservation(db, {...}), searchObservations(db, query, project)
learnings.ts:        insertLearning(db, {...}), getLearnings(db, project)
constants.ts:        CC_CAPABILITIES, OPENCLAW_CAPABILITIES, DEFAULT_CONFIG
paths.ts:            getIdentityDir()
embeddings:          EmbeddingProvider (mocked for unavailable Ollama)
gsd/state-reader:    readGsdState(cwd)
```

## Estimated Scope

- 2 new test files (~400-500 lines each)
- 0 production code changes
- All 11 architecture scenarios covered
- Requirements: OBSV-03, PERF-01, PERF-02, PERF-03, PERF-04, QUAL-06

## Risks

- **Performance flakiness**: Wall-clock assertions can be flaky in slow CI environments. Mitigation: generous thresholds (architecture SLAs are already generous), and these are in-memory SQLite (no disk I/O bottleneck).
- **Checkpoint file writes in tests**: Integration tests that verify checkpoint file mirroring need temp directories. Mitigation: use `os.tmpdir()` + unique subdirectory, clean up in afterEach.
- **Cross-session test isolation**: Must ensure Session 1 and Session 2 in learnings test use the same DB but different session IDs. Standard pattern.
