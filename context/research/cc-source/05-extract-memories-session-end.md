# CC Source: EXTRACT_MEMORIES & Session-End Housekeeping

**Date:** 2026-04-01
**Source repo:** `C:/Users/Grigorije/Desktop/Projects/claude-code-buildable/src/`
**Research scope:** EXTRACT_MEMORIES feature, backgroundHousekeeping, stopHooks, session-end lifecycle

---

## 1. What Is EXTRACT_MEMORIES?

`EXTRACT_MEMORIES` is a **compile-time feature flag** (`bun:bundle` `feature()`) that gates background memory extraction. When enabled, it runs a forked subagent at the end of every query loop to extract and persist durable memories from the conversation.

**Core purpose:** Automatically save user preferences, project context, feedback, and reference information to the auto-memory directory (`~/.claude/projects/<sanitized-cwd>/memory/`) so they persist across sessions.

**Feature flag key:** `EXTRACT_MEMORIES` (bundle-time, not runtime)
**Runtime kill switch:** GrowthBook flag `tengu_passport_quail` (default: `false` in production, must be enabled)

**Files:**
- `src/services/extractMemories/extractMemories.ts` — core extraction logic
- `src/services/extractMemories/prompts.ts` — agent prompt templates
- `src/utils/backgroundHousekeeping.ts` — initialization at session start
- `src/query/stopHooks.ts` — trigger point (end of each query loop)
- `src/memdir/paths.ts` — auto-memory path resolution and enable gates
- `src/memdir/memoryScan.ts` — memory directory scanning
- `src/memdir/memoryTypes.ts` — memory taxonomy and prompt sections
- `src/cli/print.ts` — drain before shutdown (headless mode)

---

## 2. When Does Extraction Trigger?

### Trigger point: `handleStopHooks` in `src/query/stopHooks.ts`

At the end of every query loop (when the model produces a final response with no further tool calls), `handleStopHooks` fires. Inside:

```typescript
// stopHooks.ts lines 141-153
if (
  feature('EXTRACT_MEMORIES') &&
  !toolUseContext.agentId &&         // main session only, not subagents
  isExtractModeActive()              // GrowthBook gate + interactive check
) {
  void extractMemoriesModule!.executeExtractMemories(
    stopHookContext,
    toolUseContext.appendSystemMessage,
  )
}
```

**Conditions for extraction to run:**
1. `feature('EXTRACT_MEMORIES')` — compile-time feature enabled
2. `!toolUseContext.agentId` — not a subagent (main session only)
3. `isExtractModeActive()` — runtime gate (see §7)
4. Not `isBareMode()` (bare / `--simple` / `-p` scripted calls skip everything)

The call is **fire-and-forget** (`void`). The extraction runs asynchronously while the user sees the response. For headless `-p` mode, `print.ts` drains the in-flight promise before `gracefulShutdownSync`.

### When `isExtractModeActive()` is true (paths.ts:69-77)

```typescript
export function isExtractModeActive(): boolean {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', false)) {
    return false
  }
  return (
    !getIsNonInteractiveSession() ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_thimble', false)
  )
}
```

- `tengu_passport_quail` must be `true` (master gate, default: off)
- Either interactive session, OR `tengu_slate_thimble` is true (enables non-interactive extraction)
- Both check `isAutoMemoryEnabled()` independently at entry

### Additional throttle: `tengu_bramble_lintel`

Inside `runExtraction` (extractMemories.ts:374-385), extraction only runs every N eligible turns:

```typescript
turnsSinceLastExtraction++
if (
  turnsSinceLastExtraction <
  (getFeatureValue_CACHED_MAY_BE_STALE('tengu_bramble_lintel', null) ?? 1)
) {
  return  // skip this turn, count the turn
}
turnsSinceLastExtraction = 0
```

Default: run every turn (value `1`). Can be raised via GrowthBook to throttle extraction frequency. Trailing extractions (from stashed contexts during overlap) bypass this check.

---

## 3. What Gets Extracted?

### Memory taxonomy — 4 types (memoryTypes.ts:14-19)

```typescript
export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const
```

**What each type captures:**

| Type | What | When to save |
|------|------|------|
| `user` | User's role, goals, expertise, knowledge, preferences | Any revealed detail about who the user is |
| `feedback` | Guidance — corrections AND confirmations of approach | User says "don't do X", "perfect, keep doing that", accepts unusual choice |
| `project` | Ongoing work, goals, initiatives, bugs, deadlines NOT in code/git | Who is doing what, why, by when |
| `reference` | Pointers to external systems (Linear, Grafana, Slack, etc.) | When external resource mentioned and its purpose |

**What NOT to extract (hard-coded exclusion):**
- Code patterns, architecture, file paths, project structure (derivable via grep)
- Git history, recent changes (git log/blame authoritative)
- Debugging solutions or fix recipes (fix is in the code)
- Anything already in CLAUDE.md files
- Ephemeral task details, in-progress work, temporary state
- Activity logs, PR lists, architecture snapshots (unless something was surprising/non-obvious)

These exclusions apply even when the user explicitly asks to save such content.

### Memory file format

Each memory is a Markdown file with frontmatter:

```markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{user, feedback, project, reference}}
---

{{memory content}}
```

For `feedback` and `project` types, structured as: rule/fact, then `**Why:**` and `**How to apply:**` lines.

---

## 4. Where Do Extracted Memories Go?

### Auto-memory directory resolution (paths.ts)

**Resolution order (first defined wins):**
1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var — full-path override (used by Cowork)
2. `autoMemoryDirectory` in `settings.json` — trusted sources only: policy/flag/local/user (NOT project settings — security)
3. `<memoryBase>/projects/<sanitized-git-root>/memory/`

Where `memoryBase` resolves as:
- `CLAUDE_CODE_REMOTE_MEMORY_DIR` env var (CCR), OR
- `getClaudeConfigHomeDir()` (default: `~/.claude`)

**Default path:** `~/.claude/projects/<sanitized-cwd>/memory/`

Git repo canonical root is used so all worktrees of the same repo share one memory directory (not diverge per worktree).

### MEMORY.md index (default mode, `skipIndex=false`)

Saving is a two-step process:
1. Write memory to its own file (e.g., `user_role.md`, `feedback_testing.md`)
2. Add a pointer to `MEMORY.md` — one line under ~150 chars: `- [Title](file.md) — one-line hook`

`MEMORY.md` is the index always loaded into the system prompt. Lines after 200 are truncated, so it must remain concise. Memory content never goes directly into `MEMORY.md`.

### `tengu_moth_copse` flag — skip index mode

When `tengu_moth_copse` is `true` (extractMemories.ts:367):
```typescript
const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)
```

The agent skips the two-step process and writes only the topic file. No `MEMORY.md` pointer required.

### Team memory (TEAMMEM feature)

When `feature('TEAMMEM')` and `isTeamMemoryEnabled()`, uses `buildExtractCombinedPrompt` instead of `buildExtractAutoOnlyPrompt`. Each memory type has a `<scope>` directive: `private`, `team`, or guidance to choose. Each directory (private and team) gets its own `MEMORY.md`.

---

## 5. How Does Extraction Work?

### Core mechanism: `runForkedAgent` (the "perfect fork" pattern)

```typescript
// extractMemories.ts:415-427
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams,                  // identical params from parent — shares prompt cache
  canUseTool,
  querySource: 'extract_memories',
  forkLabel: 'extract_memories',
  skipTranscript: true,             // no transcript recording (avoids race conditions)
  maxTurns: 5,                      // hard cap (2-4 turns expected: read → write)
})
```

The forked agent:
- Gets the **same system prompt** as the main conversation (including full memory-save instructions)
- Gets the **full conversation history** as context prefix
- Makes fresh API calls to Claude (same model as main session)
- Has a restricted tool set (read tools + memory-dir-only write tools)
- Does NOT record to transcript (`skipTranscript: true`)

### The extraction prompt (prompts.ts)

The user-turn injected into the fork:

```
You are now acting as the memory extraction subagent. Analyze the most recent ~{N} messages 
above and use them to update your persistent memory systems.

Available tools: Read, Grep, Glob, read-only Bash, and Edit/Write for paths inside the 
memory directory only.

You have a limited turn budget. The efficient strategy is: turn 1 — issue all Read calls 
in parallel for every file you might update; turn 2 — issue all Write/Edit calls in parallel.

You MUST only use content from the last ~{N} messages. Do not investigate or verify further 
— no grepping source files, no reading code, no git commands.
```

Plus the **existing memory manifest** (pre-injected so the agent doesn't spend a turn on `ls`):
- Scanned from `scanMemoryFiles()`: all .md files in memdir (except MEMORY.md), newest-first, capped at 200
- Formatted as: `- [type] filename (timestamp): description`

### Cursor-based incremental extraction (closure state)

State is closure-scoped inside `initExtractMemories()`:

```typescript
let lastMemoryMessageUuid: string | undefined  // cursor: last processed message
let inProgress = false                          // overlap guard
let turnsSinceLastExtraction = 0               // throttle counter
let pendingContext: {...} | undefined           // stash for overlapping calls
```

`countModelVisibleMessagesSince(messages, lastMemoryMessageUuid)` counts only user+assistant messages since the last extraction, so the agent only sees new content. If the cursor UUID isn't found (context compaction), falls back to counting all messages.

### Mutual exclusion with main agent

`hasMemoryWritesSince()` (extractMemories.ts:121-148) checks if any assistant message since the cursor contains a Write/Edit tool_use targeting an auto-memory path:

```typescript
// If main agent already wrote to memory files this turn, skip extraction
if (hasMemoryWritesSince(messages, lastMemoryMessageUuid)) {
  // advance cursor, skip forked agent, log event
  return
}
```

This prevents the background agent and main agent from writing simultaneously. The main agent's system prompt always has full save instructions; the background agent is the fallback.

### Overlap coalescing

If `executeExtractMemories` is called while an extraction is in progress (e.g., two rapid query loops), the new context is stashed in `pendingContext`. After the current run finishes, a trailing extraction runs with the latest stashed context. Only one trailing run queues at a time (newer overwrites older).

---

## 6. Token Cost of Extraction

### Cache hit pattern

The fork shares the parent's prompt cache because it uses `createCacheSafeParams(context)` — same system prompt, same conversation history prefix. The user-prompt appended for extraction is the only cache-busting addition.

In the debug log (extractMemories.ts:451-453):
```typescript
logForDebugging(
  `[extractMemories] finished — ${writtenPaths.length} files written, cache: ` +
  `read=${result.totalUsage.cache_read_input_tokens} ` +
  `create=${result.totalUsage.cache_creation_input_tokens} ` +
  `input=${result.totalUsage.input_tokens} (${hitPct}% hit)`
)
```

### Analytics event (logged to Growthbook/analytics)

`tengu_extract_memories_extraction` event includes:
- `input_tokens` — uncached input tokens
- `output_tokens` — output tokens
- `cache_read_input_tokens` — cache hits (cheap: ~0.1x cost)
- `cache_creation_input_tokens` — cache writes (1.25x cost)
- `message_count` — new messages processed
- `turn_count` — turns the extraction agent used (expected 2-4)
- `files_written` — total files touched (including MEMORY.md)
- `memories_saved` — topic memory files saved (excludes MEMORY.md index)
- `team_memories_saved` — team-scoped memories (TEAMMEM mode)
- `duration_ms` — wall clock time

**Effective cost:** Very low in practice. The entire conversation history is in cache from the parent (cache_read, not cache_creation). The only non-cached tokens are the short extraction prompt appended as a new user turn, plus whatever the agent outputs.

**Turn budget:** Hard capped at `maxTurns: 5`. Expected 2-4 turns (turn 1: parallel reads, turn 2: parallel writes). The comment: "A hard cap prevents verification rabbit-holes from burning turns."

---

## 7. Disabling EXTRACT_MEMORIES

### Layer 1: Feature flag (compile-time)
`feature('EXTRACT_MEMORIES')` — must be enabled at build time. Not configurable at runtime.

### Layer 2: GrowthBook gates (runtime)
- `tengu_passport_quail` — master gate (default `false`). Extraction does nothing without this.
- `tengu_slate_thimble` — enables non-interactive (headless `-p`) extraction. Off by default.
- `tengu_bramble_lintel` — throttle N (default 1 = every turn). Raise to reduce frequency.

### Layer 3: `isAutoMemoryEnabled()` (paths.ts:30-55)
Full priority chain:
1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` → disabled
2. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` → enabled (overrides settings)
3. `CLAUDE_CODE_SIMPLE=1` (bare mode) → disabled
4. `CLAUDE_CODE_REMOTE=1` with no `CLAUDE_CODE_REMOTE_MEMORY_DIR` → disabled
5. `settings.json` key `autoMemoryEnabled: false` → disabled
6. Default: enabled

### Layer 4: `isBareMode()` in stopHooks.ts
```typescript
if (!isBareMode()) {
  // prompt suggestion, extractMemories, autoDream — ALL skipped in bare mode
}
```

`--bare` / `CLAUDE_CODE_SIMPLE` skips extraction entirely, regardless of all other flags.

### Layer 5: `settings.json` (via ConfigTool)
```typescript
// types.ts
autoMemoryEnabled: z.boolean()
```
Can be set project-level in local/user settings. Project settings (`.claude/settings.json`) intentionally excluded — a malicious repo could redirect memory to `~/.ssh`.

---

## 8. What `backgroundHousekeeping` Does

`src/utils/backgroundHousekeeping.ts` — called on first user submit (interactive) or session start (headless).

```typescript
export function startBackgroundHousekeeping(): void {
  void initMagicDocs()           // MagicDocs initialization
  void initSkillImprovement()    // skill improvement system
  if (feature('EXTRACT_MEMORIES')) {
    extractMemoriesModule!.initExtractMemories()  // fresh closure for extraction state
  }
  initAutoDream()                // background memory consolidation
  void autoUpdateMarketplacesAndPluginsInBackground()
  if (feature('LODESTONE') && getIsInteractive()) {
    void registerProtocolModule!.ensureDeepLinkProtocolRegistered()
  }

  // Very slow operations: run 10 min after start, only when user is idle
  setTimeout(runVerySlowOps, 10 * 60 * 1000).unref()

  // For Ant users: recurring 24h cleanup
  if (process.env.USER_TYPE === 'ant') {
    setInterval(() => {
      void cleanupNpmCacheForAnthropicPackages()
      void cleanupOldVersionsThrottled()
    }, 24 * 60 * 60 * 1000).unref()
  }
}
```

**`runVerySlowOps` (after 10 minutes idle):**
- `cleanupOldMessageFilesInBackground()` — runs once per session
- `cleanupOldVersions()` — native installer version cleanup
- Both deferred further if user was active in the last minute

### `cleanupOldMessageFilesInBackground` (cleanup.ts:575-602)

Runs sequentially:
1. `cleanupOldMessageFiles()` — error logs, MCP logs (default 30-day retention)
2. `cleanupOldSessionFiles()` — session .jsonl/.cast files + tool-results dirs
3. `cleanupOldPlanFiles()` — `~/.claude/plans/*.md`
4. `cleanupOldFileHistoryBackups()` — `~/.claude/file-history/`
5. `cleanupOldSessionEnvDirs()` — `~/.claude/session-env/`
6. `cleanupOldDebugLogs()` — `~/.claude/debug/*.txt` (preserves `latest` symlink)
7. `cleanupOldImageCaches()` — image store
8. `cleanupOldPastes(cutoff)` — paste store
9. `cleanupStaleAgentWorktrees(cutoff)` — git worktrees from old agent sessions
10. `cleanupNpmCacheForAnthropicPackages()` — Ant users only

Cutoff date: `cleanupPeriodDays` from settings (default 30 days). Skips if settings have validation errors and `cleanupPeriodDays` was explicitly set (safety guard).

---

## 9. All Stop Hooks and What They Do

`handleStopHooks` in `src/query/stopHooks.ts` is an async generator yielding stream events. It runs these in order:

### Phase 1: Job classification (TEMPLATES feature, line 109-132)
When running as a dispatched job (`CLAUDE_JOB_DIR` set), classifies state after each turn and writes `state.json`. Awaited (not fire-and-forget) so `claude list` sees current state.

### Phase 2: Background bookkeeping (non-bare mode, lines 136-157)
Fire-and-forget, all in parallel:

| Task | Condition | What it does |
|------|-----------|------|
| `executePromptSuggestion` | `!CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` falsy | Generates next-prompt suggestions |
| `executeExtractMemories` | `EXTRACT_MEMORIES` feature + not subagent + `isExtractModeActive()` | Runs memory extraction fork |
| `executeAutoDream` | Not subagent | Time/session-gated memory consolidation |

### Phase 3: Computer use cleanup (CHICAGO_MCP feature, lines 164-173)
Auto-unhides computer use and releases lock. Main thread only.

### Phase 4: User-configured Stop hooks (lines 175-295)
Executes hooks from `.claude/settings.json` `hooks.Stop` array. These are user shell scripts, run in parallel. Results:
- `hook_success` — output collected
- `hook_non_blocking_error` — logged, shown in transcript (ctrl+o), non-fatal
- `hook_error_during_execution` — logged
- Blocking errors → fed back into model as user messages
- `preventContinuation` → stops the query loop

Summary message with hook count, durations, errors shown to user.

### Phase 5: Teammate hooks (isTeammate() only, lines 335-453)
For agent-mode teammates:
- `executeTaskCompletedHooks` — for each in-progress task owned by this teammate
- `executeTeammateIdleHooks` — after all task hooks

Both support `blockingError` and `preventContinuation`.

### Return values
```typescript
type StopHookResult = {
  blockingErrors: Message[]     // fed back to model for correction
  preventContinuation: boolean  // true stops query loop
}
```

---

## 10. Tool Permissions for the Extraction Agent

`createAutoMemCanUseTool(memoryDir)` (extractMemories.ts:171-222) — shared by both extractMemories and autoDream.

| Tool | Permission |
|------|-----------|
| `REPL` | Always allowed (inner primitive tools still gated) |
| `Read` (FileRead) | Unrestricted — inherently read-only |
| `Grep` | Unrestricted |
| `Glob` | Unrestricted |
| `Bash` | Only if `tool.isReadOnly(input)` passes (ls, find, grep, cat, stat, wc, head, tail, similar) |
| `Edit` / `Write` | Only if `file_path` is within `memoryDir` (checked via `isAutoMemPath()`) |
| All other tools | Denied (MCP, Agent, write-capable Bash, etc.) |

Denied tools get `logEvent('tengu_auto_mem_tool_denied', { tool_name })` and a `{ behavior: 'deny' }` response.

The REPL passthrough is needed because when REPL mode is enabled (ant-default), primitive tools are hidden and the fork must call REPL instead — but REPL's inner calls still pass through `createAutoMemCanUseTool` for actual gating.

---

## 11. AutoDream — The Other Session-End Memory Operation

`src/services/autoDream/autoDream.ts` — also called fire-and-forget from `handleStopHooks`.

**What it is:** Periodic memory consolidation. Runs the `/dream` prompt as a forked subagent when enough time and sessions have accumulated. Not per-turn — time/session gated.

**Gates (cheapest first):**
1. Not KAIROS mode (KAIROS uses disk-skill dream instead)
2. Not remote mode
3. `isAutoMemoryEnabled()` true
4. `isAutoDreamEnabled()` (separate GrowthBook flag `tengu_onyx_plover`)
5. Time gate: `>= minHours` (default 24h) since last consolidation
6. Scan throttle: 10 min between session scans
7. Session gate: `>= minSessions` (default 5) sessions since last consolidation
8. Lock: no other process mid-consolidation (file lock)

**Purpose:** Distill accumulated session transcripts into topic files and update MEMORY.md. Produces fewer, higher-quality memories than per-turn extraction.

---

## 12. Drain Before Shutdown (Headless Mode)

`src/cli/print.ts` line 962-968:

```typescript
// Drain any in-flight memory extraction before shutdown.
// Response already flushed, so this adds no user-visible latency.
// Delays process exit so gracefulShutdownSync's 5s failsafe doesn't kill
// the forked agent mid-flight.
if (feature('EXTRACT_MEMORIES') && isExtractModeActive()) {
  await extractMemoriesModule!.drainPendingExtraction()
}
gracefulShutdownSync(...)
```

`drainPendingExtraction(timeoutMs = 60_000)`:
```typescript
drainer = async (timeoutMs = 60_000) => {
  if (inFlightExtractions.size === 0) return
  await Promise.race([
    Promise.all(inFlightExtractions).catch(() => {}),
    new Promise<void>(r => setTimeout(r, timeoutMs).unref()),  // soft 60s timeout
  ])
}
```

Races the in-flight set against a 60-second timeout. The `.unref()` prevents the timer from holding the process alive if everything else exits. For interactive sessions, shutdown drains naturally via the event loop.

---

## 13. Claudex Comparison

CC's `EXTRACT_MEMORIES` system is architecturally similar to Claudex's session-end hooks but with key differences:

| Aspect | CC EXTRACT_MEMORIES | Claudex Stop Hook |
|--------|---------------------|-------------------|
| Storage | Markdown files in `~/.claude/projects/*/memory/` | SQLite (`observations`, `artifacts`, `experience_patterns`) + Qdrant |
| Mechanism | Forked LLM subagent (full API call) | Ephemeral Node.js script, DB-only |
| Memory types | 4 types: user/feedback/project/reference | Typed observations + pattern learning |
| Index | `MEMORY.md` loaded into system prompt | Hybrid retrieval (5-channel RRF) injected as context |
| Consolidation | `autoDream` (separate, time/session gated) | Angel pattern extractor (continuous background process) |
| LLM in hook | Yes — forked Claude call | No — deadlock risk, Claudex uses Ollama for embeddings only |
| Per-turn | Yes (optionally throttled by `tengu_bramble_lintel`) | Yes (every stop hook fires) |
| Disable | 5-layer gate: feature + GrowthBook + env + settings + bare mode | `hooks` config in settings.json |
| Cache sharing | Yes — parent prompt cache shared via `createCacheSafeParams` | N/A (no LLM call in hook) |

The main architectural divergence: CC runs a full Claude API call per turn-end (highly capable but expensive). Claudex deliberately avoids this to prevent deadlock and cost. CC's approach produces semantic, editorially curated memories; Claudex's approach produces structured DB records.

CC's `tengu_passport_quail` flag (default off) suggests this feature is currently not broadly deployed — likely still in A/B testing or rollout.

---

## 14. Key Files and Line References

| File | Lines | Content |
|------|-------|---------|
| `src/services/extractMemories/extractMemories.ts` | 1-615 | Core extraction logic, closure state, `runForkedAgent` call |
| `src/services/extractMemories/prompts.ts` | 1-154 | Agent prompt templates (auto-only + combined TEAMMEM) |
| `src/utils/backgroundHousekeeping.ts` | 31-94 | `startBackgroundHousekeeping` — init sequence |
| `src/query/stopHooks.ts` | 65-473 | `handleStopHooks` — full stop hook pipeline |
| `src/memdir/paths.ts` | 30-77 | `isAutoMemoryEnabled()`, `isExtractModeActive()`, path resolution |
| `src/memdir/memoryScan.ts` | 35-77 | `scanMemoryFiles()` — pre-extraction directory scan |
| `src/memdir/memoryTypes.ts` | 14-195 | Memory taxonomy, prompt sections, frontmatter format |
| `src/cli/print.ts` | 962-973 | `drainPendingExtraction` before shutdown |
| `src/utils/cleanup.ts` | 575-602 | `cleanupOldMessageFilesInBackground` |
| `src/services/autoDream/autoDream.ts` | 1-250 | AutoDream consolidation system |
