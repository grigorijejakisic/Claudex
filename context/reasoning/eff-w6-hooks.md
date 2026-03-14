# W6: Hook Overhead Scout Report

## Summary

Every CC hook invocation spawns a **fresh Node.js process** — no in-memory state survives between calls. This makes per-invocation overhead the dominant cost factor. The bootstrap sequence (`bootstrapHook`) runs identically on all 6 hooks and carries several redundancies. PostToolUse multiplies all overhead by the tool-call count per turn. Four of six hooks always return `{}` (no injection), making their full bootstrap cost pure overhead. Key redundancies: double `projects.json` read per invocation, full `config.json` read+merge cycle per invocation, telemetry DB write on every invocation, and `checkpointIfThresholdMet` called independently by both PostToolUse and Stop within a single turn.

---

## Infrastructure Overhead

### `bootstrapHook` — runs on every hook (infrastructure.ts:98-105)

```
openDatabase(getDbPath())    → new DB connection + 5 PRAGMA statements
loadConfig()                 → disk read of config.json + JSON.parse + deepMerge + validateConfig + deepClone
detectProjectScope(input.cwd) → disk read of projects.json + path comparison loop
getProjectId(input.cwd)      → calls detectProjectScope() again internally (line 67 of scope-detector.ts) → second disk read of projects.json
```

**Double file read**: `detectProjectScope` (line 101) and `getProjectId` (line 102) are called sequentially. `getProjectId` calls `detectProjectScope` internally (scope-detector.ts:67). This reads `projects.json` **twice per invocation** for no reason.

**config.json overhead**: `loadConfig` (config.ts:86-97) does:
1. `readJsonFile(getConfigPath())` — disk read
2. `deepMerge(defaults, loaded)` — recursive object merge
3. `validateConfig(merged)` — iterates all 9 section keys
4. `deepClone` via `JSON.parse(JSON.stringify(...))` — called inside `getDefaultConfig()` which is called twice (once for defaults, once inside validateConfig)

### `wrapHook` overhead (infrastructure.ts:140-180)

On every successful invocation: `emitTelemetry(ctx.db, session_id, 'hook_invocation', ...)` — a DB write (INSERT) fires unconditionally regardless of what the hook did or whether anything was injected. This is a DB write for every hook call, including PostToolUse which fires per tool.

On every error: another `emitTelemetry` attempt.

`closeDatabase(ctx.db)` always fires in finally — proper but contributes to per-invocation cost.

### DB open cost (storage.ts:16-26)

```ts
db.pragma('journal_mode = WAL');    // 5 PRAGMAs on every open
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = 10000');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
```

SQLite may already be in WAL mode from a prior session. The PRAGMAs still re-execute on every connection open. With WAL already set, `journal_mode = WAL` is a no-op but still round-trips to SQLite.

### Migrations — NOT run on every hook (GOOD)

`initializeSchema` is only called from:
- `src/cli/setup.ts:210`
- `src/cli/migrate.ts:188`
- Tests

**It is NOT called inside `openDatabase` or `bootstrapHook`.** Hooks do not re-run schema migrations. This is correct.

---

## Hook-by-Hook Analysis

### SessionStart (session-start.ts)

**Fired**: Once per session start.

**Operations**:
1. `createSession` — DB insert into `sessions`
2. `recoverFromDb` — DB read, possibly writes checkpoint files
3. `pruneTelemetry` — conditional; DB delete on `telemetry` table
4. `assembleFullContext` — reads multiple DB tables (observations, decisions, learnings, pressure_scores), reads identity files from disk, assembles injection payload

**Returns**: Non-empty `{ additionalContext: payload.content }` when payload has content. This is the primary context injection point — the overhead is justified for this hook.

**Verdict**: Appropriate cost. Runs once per session.

---

### UserPromptSubmit (user-prompt-submit.ts)

**Fired**: Every user message.

**Operations**:
1. `getCheckpointTracking(ctx.db, session_id)` — DB read
2. `getTokenGauge(...)` — reads transcript file from disk if `transcriptPath` provided
3. **Embedding path** (conditional, if not post-compaction and prompt exists):
   - `new EmbeddingProvider(...)` — instantiated fresh
   - `embedProvider.isAvailable()` — HTTP request to Ollama
   - `new TopicShiftDetector(provider)` — instantiated fresh
   - `detector.detectTopicShift(...)` — DB reads (prior prompts) + possibly HTTP embedding requests
4. `assembleRegularPrompt` — DB reads (observations, decisions, learnings), identity files from disk
5. `clearPostCompactPending` — conditional DB write

**Returns**: Non-empty `{ systemMessage: payload.content }` when payload has content. Injection fires here.

**Notable**: EmbeddingProvider availability check is an HTTP request on **every user prompt** if embeddings enabled. No caching between invocations (process exits after each call). If Ollama is slow or unavailable, this adds latency to every prompt submission.

**Verdict**: Cost is largely justified (injection hook), but Ollama HTTP check is expensive with no cross-invocation cache.

---

### PostToolUse (post-tool-use.ts)

**Fired**: After EVERY tool call. 10 tools in a turn = 10 invocations.

**Operations** (per invocation):
1. Full bootstrap: DB open + 5 PRAGMAs + config.json read (2x deepClone) + projects.json read × 2
2. `processToolAndPressure` → `processToolObservation` (DB read for dedup + conditional DB insert) + `updatePressureScore` (DB upsert)
3. `trackAfterTool` → `new ThreadTracker(db, sessionId)` (instantiated fresh, reads thread_state from DB) → `tracker.onAfterTool()` (in-memory accumulation) → `tracker.persist()` (DB write/upsert to thread_state)
4. `getTokenGauge(...)` — transcript file disk read
5. `checkpointIfThresholdMet` → `getCheckpointTracking` (DB read) → if threshold met: `readGsdState` (filesystem read) + `writeCheckpoint` (DB write + filesystem write)
6. `emitTelemetry` — unconditional DB INSERT
7. DB close

**Returns**: Always `{}` — no injection possible from PostToolUse.

**PostToolUse Multiplication**:
- 10 tools = 10 full bootstrap cycles (50-200ms each just for I/O)
- 10x config.json reads
- 20x projects.json reads
- 10x transcript file reads
- 10x telemetry DB writes
- 10x ThreadTracker DB reads + writes
- 10x checkpoint_tracking DB reads

**Comment in code** (post-tool-use.ts:33-40) explicitly documents that ThreadTracker accumulation is lost between invocations in CC hooks mode — so `trackAfterTool` + `tracker.persist()` in PostToolUse only persists the single-tool delta; the pending exchange count resets each time.

**Verdict**: Highest-overhead hook by multiplier effect. Returns `{}` unconditionally. Every operation here is pure side-effect cost.

---

### PreCompact (pre-compact.ts)

**Fired**: Once per compaction event.

**Operations**:
1. `getTokenGauge` — transcript file disk read
2. `readGsdState(input.cwd)` — filesystem read of GSD state files
3. `runCompactionSequence` → `writeCheckpoint` (DB write + filesystem) + `promoteLearnings` (DB read/write) + `markPostCompactPending` (DB write)

**Returns**: Always `{}`.

**Verdict**: Appropriate cost for compaction event. Runs infrequently.

---

### Stop (stop.ts)

**Fired**: After every assistant turn (after all tools complete, when Claude stops).

**Operations**:
1. `captureDecisionsWithClassifier` — if embeddings enabled:
   - `buildDecisionClassifier` → `new EmbeddingProvider(...)` (fresh instantiation) → `ep.isAvailable()` (HTTP request to Ollama) → `initTemplates(ep)` (more HTTP requests for template embeddings) → returns classifier
   - `captureDecisions` — regex + embedding classifier against assistant text, DB reads + writes
2. `trackAfterTurn` → `new ThreadTracker(db, sessionId)` (fresh, DB read) → `tracker.onAfterTurn()` → **no `tracker.persist()` call** (lifecycle.ts:152-160) — in-memory state lost immediately since process exits
3. `getTokenGauge` — transcript file disk read
4. `checkpointIfThresholdMet` → `getCheckpointTracking` (DB read) → conditional checkpoint write

**Returns**: Always `{}`.

**Notable issues**:
- `trackAfterTurn` does not call `tracker.persist()` (lifecycle.ts:158-160) — the after-turn state update is never persisted to DB. This is a silent data loss for thread state on every turn end.
- `buildDecisionClassifier` rebuilds from scratch every Stop: new EmbeddingProvider + HTTP availability check + template embedding fetch. No caching.

**Overlap with PostToolUse**: Both Stop and PostToolUse call `checkpointIfThresholdMet`. Within a turn:
- PostToolUse may trigger checkpoint at tool N
- Stop also checks and may trigger again

Both read `checkpoint_tracking`. The debounce logic prevents double-write, but the reads are redundant.

**Verdict**: EmbeddingProvider rebuild + Ollama HTTP call on every turn end is the highest single-invocation cost item. `trackAfterTurn` without persist is likely a bug.

---

### SessionEnd (session-end.ts)

**Fired**: Once per session end.

**Operations** (via `runSessionEndCleanup`, lifecycle.ts:276-305):
1. `getTokenGauge` — transcript file disk read
2. `readGsdState(input.cwd)` — filesystem read
3. `writeCheckpoint` with `trigger: 'session_end'` — DB write + filesystem
4. `pruneObservations` — DB delete
5. `applyRetentionPolicy` — DB delete
6. `decayPressureStratified` — DB read + updates
7. `endSession` — DB UPDATE on sessions
8. `pruneTelemetry` — DB DELETE on telemetry

**Returns**: Always `{}`.

**Overlap with SessionStart**: `pruneTelemetry` is called in both SessionStart (session-start.ts:25-29) and SessionEnd (lifecycle.ts:301-304). In a single session this fires once at start and once at end — limited redundancy but worth noting.

**Verdict**: Appropriate cost for session cleanup. Runs once.

---

## PostToolUse Multiplication

With N tool calls per turn, PostToolUse multiplies:

| Operation | Per tool | N=5 | N=10 |
|-----------|---------|-----|------|
| Node.js process spawn | 1 | 5 | 10 |
| DB open + 5 PRAGMAs | 1 | 5 | 10 |
| config.json read+merge | 1 | 5 | 10 |
| projects.json reads | 2 | 10 | 20 |
| processToolObservation (DB r/w) | 1 | 5 | 10 |
| ThreadTracker DB read+write | 1 | 5 | 10 |
| getTokenGauge (transcript read) | 1 | 5 | 10 |
| checkpointTracking DB read | 1 | 5 | 10 |
| emitTelemetry DB INSERT | 1 | 5 | 10 |
| DB close | 1 | 5 | 10 |

All returning `{}`. No injection, just overhead.

---

## Cross-Hook Redundancies

### 1. Double projects.json read per invocation
- `detectProjectScope(cwd)` reads projects.json (scope-detector.ts:22)
- `getProjectId(cwd)` calls `detectProjectScope(cwd)` internally (scope-detector.ts:67) — reads projects.json again
- Both called sequentially in `bootstrapHook` (infrastructure.ts:101-102)
- **Fix**: Pass result of `detectProjectScope` into `getProjectId` to avoid second read

### 2. config.json read + deepClone on every invocation
- `loadConfig()` called per hook
- `getDefaultConfig()` uses `deepClone` (JSON parse/stringify) — called twice during merge+validate cycle
- No caching possible across invocations (separate processes)
- **Impact**: Minor per-call cost, but multiplied by PostToolUse count

### 3. checkpointIfThresholdMet in both PostToolUse AND Stop
- PostToolUse (post-tool-use.ts:55-63): reads `checkpoint_tracking`, checks threshold
- Stop (stop.ts:41-49): reads `checkpoint_tracking` again, checks threshold
- Within a turn with N tool calls: N+1 reads of `checkpoint_tracking`, N+1 threshold evaluations
- Debounce prevents double-write but not double-read
- **Fix**: Stop-only threshold check may suffice (PostToolUse check is the "eager" path for long-running turns)

### 4. pruneTelemetry in both SessionStart and SessionEnd
- SessionStart prunes at turn start
- SessionEnd prunes at turn end
- Same session, twice — minor but unnecessary

### 5. EmbeddingProvider rebuild without caching
- UserPromptSubmit: builds EmbeddingProvider + Ollama HTTP check per prompt
- Stop: `buildDecisionClassifier` builds EmbeddingProvider + Ollama HTTP check per turn-end
- No persistent cache possible (process exits)
- **Impact**: HTTP round-trip latency on every prompt and every turn-end if embeddings enabled

### 6. trackAfterTurn missing persist() call
- Stop calls `trackAfterTurn` (lifecycle.ts:152-160)
- `trackAfterTurn` creates ThreadTracker, calls `onAfterTurn()`, but **does not call `tracker.persist()`**
- Thread state from after-turn is never written to DB
- Contrast with `trackAfterTool` which does call `tracker.persist()` (lifecycle.ts:144-146)
- This appears to be a bug: the after-turn summary/topic is computed but lost

---

## Process Model Impact

CC hooks are invoked as separate Node.js child processes. Each invocation pays:

1. **Node.js startup**: ~20-50ms (V8 init, module loading)
2. **better-sqlite3 native module load**: ~5-15ms
3. **DB open**: file open + WAL check + 5 PRAGMA round-trips ~5-20ms
4. **File I/O**: config.json + projects.json (×2) reads ~1-5ms
5. **Actual hook work**: variable
6. **Telemetry write**: ~1-2ms
7. **DB close**: ~1ms

Estimated **fixed overhead per invocation**: 30-90ms before any hook logic runs.

For a session with 10 user prompts × 8 tools each = 80 PostToolUse invocations + 10 UserPromptSubmit + 10 Stop + 1 SessionStart + 1 SessionEnd = **102 process launches**.

---

## Findings

| # | Finding | Severity | Hooks Affected |
|---|---------|----------|----------------|
| F1 | Double projects.json read per invocation (detectProjectScope + getProjectId) | Medium | All 6 |
| F2 | Telemetry DB INSERT unconditional on every invocation including PostToolUse | Medium | All 6 |
| F3 | PostToolUse fires per-tool with full bootstrap cost, always returns `{}` | High | PostToolUse |
| F4 | EmbeddingProvider + Ollama HTTP check rebuilt fresh every UserPromptSubmit and Stop | High | UserPromptSubmit, Stop |
| F5 | checkpointIfThresholdMet called independently by PostToolUse AND Stop (N+1 DB reads per turn) | Medium | PostToolUse, Stop |
| F6 | trackAfterTurn does not call tracker.persist() — after-turn thread state is never saved | High (bug) | Stop |
| F7 | pruneTelemetry runs at both SessionStart and SessionEnd | Low | SessionStart, SessionEnd |
| F8 | config.json deep merge + 2× deepClone (JSON roundtrip) on every invocation | Low | All 6 |
| F9 | 5 PRAGMA statements on every DB open regardless of WAL already being set | Low | All 6 |
| F10 | ThreadTracker comment acknowledges persistent CC hooks limitation — pending exchange state lost | Known/Documented | PostToolUse, Stop |

---

## Recommendations

1. **[F1] Fix double projects.json read**: In `bootstrapHook`, call `detectProjectScope` once, pass result to a modified `getProjectId(cwd, detectedScope?)` that skips the internal detect call. One disk read instead of two.

2. **[F6] Fix missing tracker.persist() in trackAfterTurn**: Add `tracker.persist()` at lifecycle.ts:160. After-turn thread state (topic, summary update) is currently silently dropped.

3. **[F3] PostToolUse overhead reduction**: Consider batching: only run `processToolAndPressure` and `emitTelemetry` in PostToolUse; defer `checkpointIfThresholdMet` to Stop only. This halves the number of checkpoint_tracking reads per turn without losing threshold semantics (Stop already checks). PostToolUse checkpoint check is "eager" insurance — Stop covers the same threshold.

4. **[F4] Ollama check caching**: Persist Ollama availability result to DB (TTL ~60s) to avoid HTTP round-trip on every UserPromptSubmit and Stop. A simple `ollama_available` row in a settings/cache table with `checked_at_epoch` would eliminate most HTTP calls.

5. **[F2] Conditional telemetry**: Only emit `hook_invocation` telemetry if the hook actually did meaningful work (observation captured, injection produced, checkpoint written). PostToolUse that processed no observation produces a telemetry row for nothing.

6. **[F5] Single checkpointIfThresholdMet**: Move the threshold check from PostToolUse to Stop-only. Stop fires after every turn and will catch all threshold crossings. PostToolUse threshold check adds N reads per turn with the same outcome (debounce prevents double-write anyway).

7. **[F7] Remove pruneTelemetry from SessionStart**: It already runs in SessionEnd. A session that was just started does not need immediate pruning of the prior session's telemetry.
