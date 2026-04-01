# CC Compaction Pipeline — Source Analysis

**Date:** 2026-04-01
**Source:** `claude-code-buildable/src/`
**Purpose:** Understand CC's built-in compaction to avoid duplication with Claudex re-injection and save tokens.

---

## 1. File Map

All compaction logic lives in a dedicated directory:

```
src/services/compact/
  autoCompact.ts          — threshold math, isAutoCompactEnabled, autoCompactIfNeeded
  compact.ts              — compactConversation, partialCompactConversation, post-compact attachment builders
  microCompact.ts         — microcompactMessages, cachedMicrocompactPath, time-based trigger
  apiMicrocompact.ts      — server-side context_management (clear_tool_uses_20250919)
  sessionMemoryCompact.ts — SM-compact experiment (trySessionMemoryCompaction)
  prompt.ts               — BASE_COMPACT_PROMPT, PARTIAL_COMPACT_PROMPT, formatCompactSummary
  postCompactCleanup.ts   — runPostCompactCleanup (cache/state resets after any compaction)
  grouping.ts             — groupMessagesByApiRound (used for PTL retry truncation)
  compactWarningState.ts  — React-free store for warning suppression flag
  compactWarningHook.ts   — useCompactWarningSuppression React hook
  timeBasedMCConfig.ts    — GrowthBook config for time-based microcompact
```

---

## 2. Compaction Strategies (Three Distinct Systems)

CC has **three independent context-reduction systems**, run in order from cheapest to most disruptive:

### 2a. Microcompact (tool result clearing)
**File:** `src/services/compact/microCompact.ts`

Runs **before every API call** (upstream of `callModel`). Two sub-paths:

**Path 1: Time-based microcompact** (checked first)
- Trigger: gap between now and last assistant message timestamp exceeds `gapThresholdMinutes` (default: 60 min, off by default)
- Controlled by GrowthBook flag `tengu_slate_heron`
- Action: content-clear all but the most recent `keepRecent` (default: 5) compactable tool results
- Mutates message content directly (cold cache, no prompt cache to preserve)
- Cleared text replaced with `'[Old tool result content cleared]'`
- Resets `cachedMCState` afterward since cache is already invalidated

**Path 2: Cached microcompact** (main path when enabled)
- Feature flag: `feature('CACHED_MICROCOMPACT')` (ant-only)
- GrowthBook: `isCachedMicrocompactEnabled()`, model support check
- Main thread only (`querySource.startsWith('repl_main_thread')`)
- Does NOT mutate message content
- Registers tool_result blocks and queues `cache_edits` blocks for the API layer
- Uses Anthropic's cache editing API to delete old tool results without invalidating the cached prefix
- Configured by `getCachedMCConfig()` (trigger/keep thresholds from GrowthBook)
- Only runs for compactable tools: `Read, Bash, Grep, Glob, WebSearch, WebFetch, Edit, Write`

**Path 3: Legacy microcompact** — removed. Comment says "Legacy microcompact path removed — tengu_cache_plum_violet is always true." External builds and non-main-thread subagents get no compaction from this layer.

### 2b. Autocompact (full conversation summarization)
**File:** `src/services/compact/autoCompact.ts`

Runs in the main query loop after microcompact. Uses Claude to summarize the entire conversation history.

### 2c. Partial compact
**File:** `src/services/compact/compact.ts` — `partialCompactConversation()`

Manual only (`/compact [message-selector]`). Summarizes either messages before or after a selected message, preserving the other half verbatim.

---

## 3. What Triggers Compaction

### Autocompact trigger
**File:** `src/services/compact/autoCompact.ts` lines 72–239

```typescript
// Effective context window = model context window - MAX_OUTPUT_TOKENS_FOR_SUMMARY (20,000)
// CLAUDE_CODE_AUTO_COMPACT_WINDOW env var can cap the effective window
getEffectiveContextWindowSize(model) = contextWindow - min(maxOutputTokens, 20_000)

// Autocompact threshold
getAutoCompactThreshold(model) = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS (13,000)

// Override: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<0-100> sets threshold as percentage of effectiveWindow
```

**Warning/error/blocking thresholds:**
```typescript
AUTOCOMPACT_BUFFER_TOKENS = 13_000   // fires autocompact
WARNING_THRESHOLD_BUFFER_TOKENS = 20_000  // shows yellow warning
ERROR_THRESHOLD_BUFFER_TOKENS = 20_000    // same as warning (same const)
MANUAL_COMPACT_BUFFER_TOKENS = 3_000     // blocks further input if autocompact is off
```

**Turn-based:** No. Compaction is token-count only. `tokenCountWithEstimation(messages)` is called against the threshold before every API call.

**Circuit breaker:** After 3 consecutive autocompact failures (`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`), the circuit breaker trips and no more autocompact attempts are made in that session.

**Recursion guards:** `shouldAutoCompact()` returns `false` if `querySource === 'session_memory'` or `'compact'` to prevent deadlock. Also blocked for `'marble_origami'` (context-collapse agent) when `CONTEXT_COLLAPSE` feature is on.

### Autocompact disabled conditions
- `DISABLE_COMPACT=1` (disables all compaction, including manual `/compact`)
- `DISABLE_AUTO_COMPACT=1` (disables only auto, keeps manual `/compact`)
- `userConfig.autoCompactEnabled === false` (per-user config setting)
- `REACTIVE_COMPACT` feature + GrowthBook flag `tengu_cobalt_raccoon` (reactive-only mode, suppresses proactive autocompact)
- `CONTEXT_COLLAPSE` feature + `isContextCollapseEnabled()` (context-collapse owns headroom)

---

## 4. The Autocompact Flow (Step-by-Step)

**File:** `src/services/compact/autoCompact.ts` — `autoCompactIfNeeded()`

1. `DISABLE_COMPACT` env check → bail if set
2. Circuit breaker check → bail if `consecutiveFailures >= 3`
3. `shouldAutoCompact()` → token threshold check
4. **EXPERIMENT: try `trySessionMemoryCompaction()` first** (SM-compact path)
   - If SM has content and the result fits under threshold → use SM summary, skip Claude summarization call
   - Returns `CompactionResult` with preserved recent messages
5. If SM-compact returns null → fall through to `compactConversation()` (legacy path)

### SM-compact path (experiment, flag-gated)
**File:** `src/services/compact/sessionMemoryCompact.ts`

- Gate: `tengu_session_memory && tengu_sm_compact` GrowthBook flags (or `ENABLE_CLAUDE_CODE_SM_COMPACT=1`)
- Uses continuously-maintained session memory file instead of a summarization API call
- Calculates which messages to keep: `calculateMessagesToKeepIndex()` with `minTokens=10_000`, `minTextBlockMessages=5`, `maxTokens=40_000` (remote-configurable via `tengu_sm_compact_config`)
- Adjusts start index to not split tool_use/tool_result pairs or thinking blocks
- Runs SessionStart hooks to restore CLAUDE.md context
- Returns a `CompactionResult` without making any Claude API call

---

## 5. The `compactConversation()` Function

**File:** `src/services/compact/compact.ts` lines 387–762

Core steps:

1. Count tokens pre-compact
2. Execute **PreCompact hooks** (`trigger: 'auto' | 'manual'`) — hooks can inject `newCustomInstructions`
3. Strip images from messages before sending for summarization (`stripImagesFromMessages`)
4. Strip re-injected attachments (`stripReinjectedAttachments`) — removes `skill_discovery` and `skill_listing` attachment messages (they're re-surfaced post-compact)
5. Call `streamCompactSummary()` — the summarization API call
   - Default: **forked agent** reusing main conversation's prompt cache (`tengu_compact_cache_prefix` GrowthBook, default `true`)
   - Fallback: direct streaming with `maxOutputTokensOverride: COMPACT_MAX_OUTPUT_TOKENS`
   - PTL retry: if summarization hits prompt-too-long, truncates oldest groups and retries up to 3 times
6. Format summary via `formatCompactSummary()` — strips `<analysis>` scratchpad, extracts `<summary>` content
7. Clear `readFileState` cache and `loadedNestedMemoryPaths`
8. Build post-compact attachments (see Section 6)
9. Create `CompactBoundaryMessage` with metadata (`compactMetadata.preCompactDiscoveredTools`)
10. Wrap summary in `getCompactUserSummaryMessage()` — adds preamble: `"This session is being continued from a previous conversation that ran out of context."`
11. Execute **SessionStart hooks** with `source: 'compact'` — this is where CLAUDE.md gets re-injected
12. Execute **PostCompact hooks** (`trigger: 'auto' | 'manual'`, passes `compactSummary`)
13. Fire `markPostCompaction()` — flags next API call for cache miss tracking
14. Re-append session metadata (title, tag) to transcript tail window
15. Optionally write session transcript segment (KAIROS feature)

**Return type:**
```typescript
interface CompactionResult {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]        // contains the formatted summary
  attachments: AttachmentMessage[]       // files, plans, skills, deferred tools, MCP
  hookResults: HookResultMessage[]       // from SessionStart hooks (= CLAUDE.md etc.)
  messagesToKeep?: Message[]             // for partial compact / SM-compact only
  userDisplayMessage?: string
  preCompactTokenCount?: number
  postCompactTokenCount?: number         // actually the compact API call's total usage
  truePostCompactTokenCount?: number     // rough estimate of resulting context size
  compactionUsage?: TokenUsage
}
```

**Post-compact message order:**
```
boundaryMarker → summaryMessages → messagesToKeep (if any) → attachments → hookResults
```

---

## 6. What Gets Preserved vs. Discarded

### Discarded
- All conversation messages (replaced by the summary)
- Tool results from Read, Bash, Grep, Glob, etc.
- All attachment messages (CLAUDE.md injections, skill listings, etc.) — these are RE-INJECTED
- Image and document blocks (stripped before summarization, not restored)
- `skill_discovery` and `skill_listing` attachment messages (stripped before summarization)

### Preserved in summary (via `getCompactPrompt`)
The summarization prompt explicitly asks for (9 sections):
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (with full code snippets)
4. Errors and fixes
5. Problem Solving
6. All user messages (verbatim)
7. Pending Tasks
8. Current Work (most recent)
9. Optional Next Step (direct quotes from most recent)

The `<analysis>` drafting scratchpad is stripped from the final output before injection.

### Re-injected post-compact (attachments)
**File:** `src/services/compact/compact.ts` lines 530–594

1. **Recently-read files** — `createPostCompactFileAttachments()`:
   - Up to 5 files (`POST_COMPACT_MAX_FILES_TO_RESTORE = 5`)
   - Sorted by most-recent access timestamp
   - Token budget: 50,000 total (`POST_COMPACT_TOKEN_BUDGET`), 5,000 per file
   - Files already visible in `messagesToKeep` (preserved tail) are skipped
   - Re-reads from disk using FileReadTool (fresh content)

2. **Async agent status** — `createAsyncAgentAttachmentsIfNeeded()`: running/finished background agents

3. **Plan file** — `createPlanAttachmentIfNeeded()`: if a plan file exists for the session

4. **Plan mode instructions** — `createPlanModeAttachmentIfNeeded()`: if currently in plan mode

5. **Invoked skills** — `createSkillAttachmentIfNeeded()`:
   - Only if skills were invoked this session
   - Up to 25,000 token budget (`POST_COMPACT_SKILLS_TOKEN_BUDGET`), 5,000 per skill
   - Sorted most-recent-first
   - NOTE: `sentSkillNames` is intentionally NOT reset — avoids re-injecting the full skill_listing (~4K tokens)

6. **Deferred tool schemas** — `getDeferredToolsDeltaAttachment()`: re-announces tools that were discovered pre-compact

7. **Agent listing delta** — `getAgentListingDeltaAttachment()`: agent context

8. **MCP instructions delta** — `getMcpInstructionsDeltaAttachment()`: MCP client instructions

9. **SessionStart hook results** — CLAUDE.md, memory files, Claudex injections — via `processSessionStartHooks('compact')`

### Specifically NOT reset
- `sentSkillNames` — intentional, avoids redundant skill_listing re-injection
- `invokedSkills` — skills must survive multiple compactions (see comment at `postCompactCleanup.ts:18`)

### Reset by `runPostCompactCleanup()`
**File:** `src/services/compact/postCompactCleanup.ts`

```
resetMicrocompactState()           — clears cachedMCState, pendingCacheEdits
resetContextCollapse()             — if CONTEXT_COLLAPSE feature, main thread only
getUserContext.cache.clear()       — memo cache for CLAUDE.md loading, main thread only
resetGetMemoryFilesCache('compact')
clearSystemPromptSections()
clearClassifierApprovals()
clearSpeculativeChecks()
clearBetaTracingState()
sweepFileContentCache()            — if COMMIT_ATTRIBUTION feature
clearSessionMessagesCache()
```

---

## 7. The Compaction Summary Prompt

**File:** `src/services/compact/prompt.ts`

### Key structural features

```typescript
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.`
```

This preamble is placed **FIRST** because Sonnet 4.6+ adaptive-thinking models sometimes attempt tool calls despite instructions; the rejection wastes `maxTurns: 1`.

### Three prompt variants
1. `getCompactPrompt()` — full summarization (autocompact and manual `/compact`)
2. `getPartialCompactPrompt('from')` — summarizes the tail after a pivot point
3. `getPartialCompactPrompt('up_to')` — summarizes the head before a pivot point; includes "Context for Continuing Work" section instead of "Optional Next Step"

### Custom instructions
CLAUDE.md can contain `## Compact Instructions` or `# Summary instructions` sections. These are passed as `customInstructions` and appended to the prompt: `\n\nAdditional Instructions:\n${customInstructions}`. PreCompact hooks can also inject instructions.

### Post-formatting
`formatCompactSummary()` strips the `<analysis>` block and reformats `<summary>` tags into readable section headers.

### Summary message wrapper
`getCompactUserSummaryMessage()` wraps the formatted summary with:
```
"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation."
```
And optionally:
- Transcript path reference (`If you need specific details from before compaction...`)
- `"Recent messages are preserved verbatim."` (for SM-compact with preserved tail)
- Continuation instruction for autocompact: `"Continue the conversation from where it left off without asking the user any further questions."`
- Proactive mode continuation note (PROACTIVE/KAIROS feature)

---

## 8. COMPACTION_REMINDERS Feature

**File:** `src/utils/attachments.ts` lines 3931–3955

```typescript
export function getCompactionReminderAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_marble_fox', false)) {
    return []
  }
  if (!isAutoCompactEnabled()) {
    return []
  }
  const contextWindow = getContextWindowForModel(model, getSdkBetas())
  if (contextWindow < 1_000_000) {
    return []  // only for 1M+ context models
  }
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountWithEstimation(messages)
  if (usedTokens < effectiveWindow * 0.25) {
    return []  // only injects when >25% of effective window is used
  }
  return [{ type: 'compaction_reminder' }]
}
```

**Where it's called:** `src/utils/attachments.ts` line 922, inside `getAttachmentMessages()` — the standard pre-turn attachment pipeline. It's gated behind `feature('COMPACTION_REMINDERS')`.

**What it does:** Injects a `compaction_reminder` attachment type into the context. The actual rendered content of this attachment type is not visible in the source search (likely in a UI renderer), but the injection is controlled by:
- Feature flag `COMPACTION_REMINDERS` (bun bundle dead-code elimination gate, ant-only)
- GrowthBook experiment `tengu_marble_fox` (default: `false`)
- Auto-compact must be enabled
- Model must have ≥ 1M context window
- Current usage must be ≥ 25% of effective window

**Implication for Claudex:** This is an experiment-gated reminder about upcoming compaction, injected on regular turns (not as part of the compaction flow itself). Claudex injections happen via SessionStart hooks, which fire as part of the compaction flow — these are completely separate pipelines.

---

## 9. cachedMicrocompact — How It Works

**File:** `src/services/compact/microCompact.ts` lines 52–399

This is the main microcompact path for ant users with supported models.

### Architecture
- Module-level state: `cachedMCModule`, `cachedMCState`, `pendingCacheEdits`
- `cachedMCState` is lazy-initialized via `getCachedMCModule()` → `import('./cachedMicrocompact.js')`
- The actual `cachedMicrocompact.ts` in `src/` is a stub: `export default {}` — the real implementation is an ant-only build artifact not present in the buildable source

### What it does (from the calling code)
1. Walks messages collecting tool_result blocks for compactable tools (Read, Bash, Grep, Glob, WebSearch, WebFetch, Edit, Write)
2. Registers tool results grouped by user message via `registerToolResult()` / `registerToolMessage()`
3. Calls `getToolResultsToDelete()` — returns IDs of tool results that exceed the trigger threshold (exceeds `keepRecent` count)
4. Creates a `cache_edits` block via `createCacheEditsBlock()` and queues it in `pendingCacheEdits`
5. Does NOT modify the local messages array — the `cache_edits` block is applied at the API layer
6. Logs `tengu_cached_microcompact` analytics event
7. Returns `messages` unchanged + `compactionInfo.pendingCacheEdits` for the API layer to consume

### State lifecycle
- `consumePendingCacheEdits()` — called by API layer before each request; clears after retrieval (caller must pin)
- `pinCacheEdits(userMessageIndex, block)` — pins edits to a message position so they're re-sent for cache hits
- `getPinnedCacheEdits()` — returns all previously-pinned edits
- `markToolsSentToAPIState()` — called after successful API response
- `resetMicrocompactState()` — called by `runPostCompactCleanup()` after any full compaction

### Main thread restriction
`isMainThreadSource()` (prefix-match on `'repl_main_thread'`) ensures cached MC only runs for the main conversation thread, not for subagent forks like `session_memory`, `compact`, `prompt_suggestion`, etc.

---

## 10. Partial Compact

**File:** `src/services/compact/compact.ts` — `partialCompactConversation()` lines 772–1106

### Two directions
- `'from'` (default): Summarizes messages **after** pivot index, keeps earlier messages intact. Cache for kept messages is preserved.
- `'up_to'`: Summarizes messages **before** pivot index, keeps later messages. Cache invalidated since summary precedes kept messages.

### Key behaviors
- `'up_to'` strips old compact boundaries and summaries from the kept tail to avoid re-triggering prune logic
- Skips `progress` message type in both directions
- Re-announces only tools/MCP instructions that were in the summarized portion (diff against `messagesToKeep`)
- `annotateBoundaryWithPreservedSegment()` patches the boundary marker with head/anchor/tail UUIDs for the disk loader to relink the preserved segment

---

## 11. API-level Context Management

**File:** `src/services/compact/apiMicrocompact.ts`

A separate mechanism using Anthropic's server-side `context_management` API parameter. Different from client-side microcompact.

```typescript
// Strategy types:
type ContextEditStrategy =
  | { type: 'clear_tool_uses_20250919', trigger, keep, clear_tool_inputs, exclude_tools, clear_at_least }
  | { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: number } | 'all' }
```

**Thinking clearing:**
- Active when `hasThinking && !isRedactThinkingActive`
- Default: `keep: 'all'` (preserve all thinking)
- `clearAllThinking` path (>1h idle): `keep: { type: 'thinking_turns', value: 1 }` — the API requires `value >= 1`
- `thinkingClearLatched` state flag (in `bootstrap/state.ts`) ensures once triggered, stays triggered to avoid cache busting

**Tool result clearing:**
- Ant-only (`process.env.USER_TYPE !== 'ant'`)
- `USE_API_CLEAR_TOOL_RESULTS=1`: triggers `clear_tool_uses_20250919` for Read/Bash/Grep/etc.
- `USE_API_CLEAR_TOOL_USES=1`: triggers for Edit/Write/NotebookEdit
- `API_MAX_INPUT_TOKENS` env: trigger threshold (default: 180,000)
- `API_TARGET_INPUT_TOKENS` env: keep target (default: 40,000)

---

## 12. Environment Variables Summary

| Variable | Effect |
|----------|--------|
| `DISABLE_COMPACT=1` | Disables all compaction (manual and auto) |
| `DISABLE_AUTO_COMPACT=1` | Disables only auto-compact; manual `/compact` still works |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<n>` | Caps effective context window for autocompact calculation |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<0-100>` | Sets autocompact threshold as % of effective window (for testing) |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=<n>` | Override token count that blocks further input |
| `ENABLE_CLAUDE_CODE_SM_COMPACT=1` | Force-enable session memory compaction experiment |
| `DISABLE_CLAUDE_CODE_SM_COMPACT=1` | Force-disable session memory compaction |
| `USE_API_CLEAR_TOOL_RESULTS=1` | Enable server-side tool result clearing (ant-only) |
| `USE_API_CLEAR_TOOL_USES=1` | Enable server-side tool use clearing (ant-only) |
| `API_MAX_INPUT_TOKENS=<n>` | Trigger threshold for server-side tool clearing |
| `API_TARGET_INPUT_TOKENS=<n>` | Keep-until target for server-side tool clearing |

---

## 13. GrowthBook Feature Flags

| Flag | Effect |
|------|--------|
| `tengu_slate_heron` | Time-based microcompact config (enabled, gapThresholdMinutes, keepRecent) |
| `tengu_marble_fox` | COMPACTION_REMINDERS experiment (default: false) |
| `tengu_cobalt_raccoon` | Reactive-only compact mode (suppresses proactive autocompact) |
| `tengu_session_memory` | Session memory feature |
| `tengu_sm_compact` | Session memory compaction experiment |
| `tengu_sm_compact_config` | Remote config for SM-compact thresholds |
| `tengu_compact_cache_prefix` | Use forked agent for compaction (default: true) |
| `isCachedMicrocompactEnabled()` | Controls CACHED_MICROCOMPACT path |
| `isModelSupportedForCacheEditing(model)` | Model support check for cache editing |

---

## 14. Implications for Claudex

### What CC re-injects after compaction (that Claudex also injects)

CC's compaction runs `processSessionStartHooks('compact')` which fires CC's own SessionStart hooks. **Claudex's SessionStart hook is one of these** — so Claudex context IS re-injected by CC's compaction flow automatically via the hook pipeline.

The post-compact message structure after CC's flow:
```
SystemCompactBoundaryMessage
UserMessage (summary)
[optional: preserved messages from SM-compact]
[attachments: files, plans, skills, deferred tools, MCP]
[hook results: from SessionStart hooks INCLUDING Claudex hook]
```

### Key facts for deduplication

1. **CC always fires SessionStart hooks post-compact.** Claudex's hook will run and inject Claudex context into `hookResults`. This happens for ALL compaction types (auto, manual, SM-compact, partial).

2. **CC does NOT summarize Claudex-injected content specifically** — it summarizes the entire conversation. The summary will contain references to what Claudex injected if the model used that information, but not the raw injection blocks.

3. **Claudex's `system-reminder` tags** survive in the raw conversation history before compaction. The summarizer sees them as part of user messages and may or may not capture their content in the summary depending on how they were used.

4. **COMPACTION_REMINDERS** (`feature('COMPACTION_REMINDERS')`, `tengu_marble_fox`) is an experiment-gated reminder injected on regular turns for 1M+ context models when >25% used. This is separate from Claudex's context injection. Claudex should not worry about this — it doesn't conflict.

5. **The SM-compact path** (when `tengu_session_memory && tengu_sm_compact`) avoids a Claude API summarization call entirely. It still runs SessionStart hooks, so Claudex re-injection happens. But the "summary" is the session memory file content directly — Claudex should be aware that session memory compaction produces a different quality/format of summary than the LLM-based summarization.

6. **Token budget for post-compact attachments:**
   - 5 files max, 50K total token budget for file re-injection
   - 25K token budget for skill content
   - These limits are fixed constants, not configurable
   - Claudex injections (via hook) come AFTER all these fixed-budget items, in `hookResults`

7. **`cachedMicrocompact.ts` stub** — the file at `src/cachedMicrocompact.ts` is just `export default {}`. The real cached microcompact implementation is ant-only and not in this source tree. The calling code in `microCompact.ts` dynamically imports it; on external builds, `isCachedMicrocompactEnabled()` returns false.

### What Claudex can safely skip re-injecting

Since CC always fires SessionStart hooks post-compact (and Claudex's hook is in that pipeline), Claudex does not need to separately detect "a compaction just happened" to re-inject — the re-injection happens automatically.

The risk is **duplication on the turn immediately after compaction**: both the hook result (in `hookResults`) and the next turn's system-reminder injection could inject the same Claudex context. This is inherent to Claudex's design (hooks + turn-level injection) and CC's design (hooks fire into hookResults which appear in the message array, then the next turn's system-reminder fires again). Minimizing per-turn system-reminder payload size reduces this waste.

### What the `PostCompactBoundary` marker means for Claudex

`SystemCompactBoundaryMessage` with `compactMetadata` carries:
- `preCompactDiscoveredTools`: deferred tool names loaded before compaction
- `preservedSegment`: head/anchor/tail UUID linkage for the loader

Claudex's checkpoint system can use the boundary marker's UUID (or the `lastPreCompactUuid` timestamp) to identify which messages survived compaction. The 3-hop loader in Claudex should already handle this since session storage uses the boundary to prune old messages.
