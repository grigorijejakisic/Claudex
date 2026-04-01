# CC Source: QueryEngine & Context Assembly Pipeline

**Research date:** 2026-04-01  
**Source repo:** `C:/Users/Grigorije/Desktop/Projects/claude-code-buildable/src/`  
**Primary files analyzed:**
- `QueryEngine.ts` (1295 lines)
- `context.ts` (189 lines)
- `query.ts` (1729 lines)
- `utils/queryContext.ts` (179 lines)
- `constants/prompts.ts` (914 lines)
- `constants/systemPromptSections.ts` (68 lines)
- `utils/api.ts` (719 lines)
- `utils/hooks.ts` (3800+ lines)
- `utils/attachments.ts` (1700+ lines)
- `utils/messages.ts` (5000+ lines)
- `services/compact/autoCompact.ts`
- `utils/context.ts` (222 lines)
- `query/tokenBudget.ts`, `query/config.ts`

---

## 1. System Prompt Assembly — Complete Order

### Entry Point

`QueryEngine.submitMessage()` calls `fetchSystemPromptParts()` at line 292, which calls `getSystemPrompt()`.

**`utils/queryContext.ts:44-73` — `fetchSystemPromptParts()`:**
```typescript
const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
  customSystemPrompt !== undefined
    ? Promise.resolve([])
    : getSystemPrompt(tools, mainLoopModel, additionalWorkingDirectories, mcpClients),
  getUserContext(),
  customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
])
```

- If `customSystemPrompt` is set, `defaultSystemPrompt` is `[]` and `systemContext` is `{}`.
- Both `getUserContext()` and `getSystemContext()` are **memoized** — computed once per session, cached until `/clear` or `/compact`.

### `getSystemPrompt()` — The Full Static+Dynamic Array

**`constants/prompts.ts:444-576`** builds and returns a `string[]` array. The order is:

**Static sections (before boundary, globally cacheable):**
1. `getSimpleIntroSection(outputStyleConfig)` — "You are Claude Code..." + CYBER_RISK_INSTRUCTION
2. `getSimpleSystemSection()` — `# System` bullet list (markdown, tools, hooks, `<system-reminder>` tags, summarization)
3. `getSimpleDoingTasksSection()` — `# Doing tasks` (only if outputStyle is null OR keepCodingInstructions=true)
4. `getActionsSection()` — `# Executing actions with care`
5. `getUsingYourToolsSection(enabledTools)` — `# Using your tools`
6. `getSimpleToneAndStyleSection()` — `# Tone and style` (includes "do not use a colon before tool calls")
7. `getOutputEfficiencySection()` — `# Output efficiency` / `# Communicating with the user`

**Boundary marker (global cache split):**
```typescript
...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
// SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

**Dynamic sections (after boundary, session-specific, registry-managed):**
These are resolved via `resolveSystemPromptSections()` which caches each section once until `/clear`/`/compact`:

8. `session_guidance` → `getSessionSpecificGuidanceSection()` — agent tool, ask-user, skills, verification agent
9. `memory` → `loadMemoryPrompt()` — reads `~/.claude/CLAUDE.md` and nested memory files
10. `ant_model_override` — internal ant-only config suffix (returns null for external)
11. `env_info_simple` → `computeSimpleEnvInfo()` — `# Environment` section with CWD, git status, OS, model name, knowledge cutoff
12. `language` → `getLanguageSection()` — only if language preference is set
13. `output_style` → `getOutputStyleSection()` — only if output style config exists
14. `mcp_instructions` → `getMcpInstructionsSection()` — **DANGEROUS_uncached** (recomputes every turn) — MCP server instructions from connected servers
15. `scratchpad` → `getScratchpadInstructions()` — only if scratchpad is enabled
16. `frc` → `getFunctionResultClearingSection()` — only if CACHED_MICROCOMPACT feature flag
17. `summarize_tool_results` → constant string: "When working with tool results, write down..."
18. `numeric_length_anchors` — ant-only: "≤25 words between tool calls, ≤100 words final"
19. `token_budget` — only if TOKEN_BUDGET feature flag: instructions for "+500k" budget mode
20. `brief` — only if KAIROS/KAIROS_BRIEF feature flags

**After dynamic sections, QueryEngine appends (lines 321-325):**
```typescript
const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

- `memoryMechanicsPrompt` is injected when `customSystemPrompt` is set AND `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var is set (SDK subagents with memory).
- `appendSystemPrompt` — caller-supplied extra text appended at the very end of the system prompt.

### systemContext Appended at API Call Time

In `query.ts:449-451`, immediately before calling the model:
```typescript
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

**`utils/api.ts:437-447` — `appendSystemContext()`:**
```typescript
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

`systemContext` (from `context.ts:getSystemContext()`) contains:
- `gitStatus` — the git status block (branch, status, recent commits). Format: `"gitStatus: <full text>"`. This becomes a plain `key: value` entry appended to the system prompt string.
- `cacheBreaker` — only if `BREAK_CACHE_COMMAND` feature flag (ant-only debugging)

**Critical:** `systemContext` is appended to the system prompt (not the message array). It appears as the last element of the systemPrompt array, as a raw `"key: value\nkey: value"` string with no headers.

---

## 2. userContext — Where `additionalContext` from Hooks Lands

### The `userContext` Object

`getUserContext()` (`context.ts:155-189`) returns:
```typescript
{
  claudeMd: string,       // concatenated CLAUDE.md files (project + ~/.claude/CLAUDE.md)
  currentDate: string,    // "Today's date is YYYY-MM-DD."
}
```

- `claudeMd` is assembled by `getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))`.
- **Disabled by** `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` or `--bare` mode with no `--add-dir`.

### How userContext Is Injected Into the Message Array

**`utils/api.ts:449-474` — `prependUserContext()`:**
```typescript
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (Object.entries(context).length === 0) return messages

  return [
    createUserMessage({
      content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${Object.entries(context)
        .map(([key, value]) => `# ${key}\n${value}`)
        .join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

This is called at `query.ts:659`:
```typescript
messages: prependUserContext(messagesForQuery, userContext),
```

**Result:** `claudeMd` and `currentDate` become the **first message** in the conversation as a `<system-reminder>` block at the start of the user-role message array. Each key becomes a `# key` heading followed by its value.

### The Full userContext Injection Template

```
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
[full CLAUDE.md content]
# currentDate
Today's date is YYYY-MM-DD.

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
```

This is sent as a **user-role message** prepended before all other messages on every API call. It is **not cached** — it is re-prepended from `userContext` each turn (but `userContext` itself is memoized so the content is stable).

---

## 3. Hook `additionalContext` — Where It Lands

Hooks can return `additionalContext` in their JSON output for multiple events. This gets converted to `hook_additional_context` attachments, which become **user-role messages** wrapped in `<system-reminder>` tags.

### Hooks That Support `additionalContext`

From `utils/hooks.ts:593-652`:
- `PreToolUse` — `additionalContext` (optional)
- `UserPromptSubmit` — `additionalContext` (required in schema)
- `SessionStart` — `additionalContext` (optional)
- `Setup` — `additionalContext` (optional)
- `SubagentStart` — `additionalContext` (optional)
- `PostToolUse` — `additionalContext` (optional)
- `PostToolUseFailure` — `additionalContext` (optional)

### Rendering to Message

**`utils/messages.ts:4117-4128`** — `case 'hook_additional_context'`:
```typescript
return [
  createUserMessage({
    content: wrapInSystemReminder(
      `${attachment.hookName} hook additional context: ${attachment.content.join('\n')}`,
    ),
    isMeta: true,
  }),
]
```

`wrapInSystemReminder()` (`utils/messages.ts:3097-3099`):
```typescript
return `<system-reminder>\n${content}\n</system-reminder>`
```

**Full rendered format:**
```
<system-reminder>
UserPromptSubmit hook additional context: [content]
</system-reminder>
```

or for PreToolUse:
```
<system-reminder>
PreToolUse:ToolName hook additional context: [content]
</system-reminder>
```

### When Each Hook Fires

| Hook | When Injected | Position in Turn |
|------|--------------|-----------------|
| `SessionStart` | At session start (`processSessionStartHooks`) | Before first user message |
| `Setup` | On init/maintenance | Before first user message |
| `UserPromptSubmit` | After user types, before API call | After user message, before API call |
| `PreToolUse` | Before tool runs | Inside tool execution, before tool result |
| `PostToolUse` | After tool completes | After tool result, part of next user message batch |
| `PostToolUseFailure` | After tool error | After tool result |
| `SubagentStart` | When spawning a subagent | Prepended to subagent's first messages |

### Truncation

Hook output is truncated at 10,000 characters (`processUserInput.ts:272-278`):
```typescript
const MAX_HOOK_OUTPUT_LENGTH = 10000
function applyTruncation(content: string): string {
  if (content.length > MAX_HOOK_OUTPUT_LENGTH) {
    return `${content.substring(0, MAX_HOOK_OUTPUT_LENGTH)}… [output truncated...]`
  }
  return content
}
```

### SubagentStart Hook — How Claudex PreToolUse Hook Works

The `SubagentStart` hook runs in `runAgent.ts:530-554`. It collects `additionalContexts` and injects them as `hook_additional_context` attachment into the subagent's messages. This is how Claudex's `PreToolUse` hook (intercepting `mcp__claudex__*` tool calls) injects Claudex awareness into Agent subagent prompts.

---

## 4. Message Construction — What Gets Prepended/Appended

### Full Turn Message Array Structure

On each `query()` call, the `messagesForQuery` array is built as:

```
1. prependUserContext(messagesForQuery, userContext)
   → [<system-reminder>#claudeMd\n#currentDate</system-reminder>, ...messages]

2. Then the actual messages in order:
   [user_msg_1, asst_1, user_msg_2 (tool_results), asst_2, ...]
```

Each "user_msg" in the conversation can contain:
- Actual user text
- Tool results (`tool_result` blocks)
- `<system-reminder>` blocks from hooks
- `isMeta: true` messages (not shown to user but sent to API)

### normalizeMessagesForAPI

Before API dispatch, `normalizeMessagesForAPI()` in `utils/messages.ts:1989` consolidates:
- Merges consecutive user messages
- `<system-reminder>`-prefixed text blocks are merged into adjacent `tool_result` blocks
- Attachment messages are expanded into their API representation

### Attachment → API Message Conversion

**`utils/messages.ts:1791-1849`** — The "smoosh" logic:
`<system-reminder>` blocks get merged into adjacent tool_result messages, keeping them as text blocks. The structure is: if a user message starts with `<system-reminder>`, it merges with the previous user message's tool_result content.

---

## 5. Context Window Budget — Token Limits and Truncation

### Context Window Sizes

**`utils/context.ts`:**
```typescript
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Sonnet 4.6, Opus 4.6 support 1M context
export function modelSupports1M(model: string): boolean {
  const canonical = getCanonicalName(model)
  return canonical.includes('claude-sonnet-4') || canonical.includes('opus-4-6')
}
```

Context window override: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (ant-only, caps effective window for autocompact decisions).

### Token Warning Thresholds

**`services/compact/autoCompact.ts:62-144`:**
```typescript
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

function getAutoCompactThreshold(model): number {
  // effectiveContextWindow = contextWindow - reservedForSummary (up to 20k)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
}
```

States (checked each turn before API call):
- **Warning**: `tokenUsage >= threshold - 20_000`
- **Error**: `tokenUsage >= threshold - 20_000`
- **AutoCompact triggers**: `tokenUsage >= threshold - 13_000` (when autocompact enabled)
- **Blocking limit**: `tokenUsage >= effectiveContextWindow - 3_000` (hard block when autocompact OFF)

### Max Output Tokens

**`utils/context.ts:149-210`:**

| Model | Default | Upper Limit |
|-------|---------|-------------|
| Opus 4.6 | 64,000 | 128,000 |
| Sonnet 4.6 | 32,000 | 128,000 |
| Sonnet 4.x / Haiku 4.x | 32,000 | 64,000 |
| Claude 3 Opus | 4,096 | 4,096 |

With `CAPPED_DEFAULT_MAX_TOKENS = 8,000` optimization: slots are reserved at 8k and escalated to 64k on `max_output_tokens` errors.

### Autocompact Env Vars

- `DISABLE_COMPACT=1` — disables all compaction
- `DISABLE_AUTO_COMPACT=1` — disables auto-compact only
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=N` — caps effective context window to N tokens
- `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=N` — overrides blocking limit for testing
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=N` — sets autocompact threshold as % of effective window
- `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` — forces 200k context even on 1M-capable models

---

## 6. Streaming / Tool Dispatch Loop

### The `query()` Function Flow

**`query.ts:219-238`** is the outer entry. The actual loop is `queryLoop()` at line 241.

**Per-iteration sequence in `queryLoop()`:**

```
while (true):
  1. Start memory/skill prefetch (non-blocking)
  2. yield { type: 'stream_request_start' }
  3. getMessagesAfterCompactBoundary(messages)  // strip pre-compact messages
  4. applyToolResultBudget()                     // truncate oversized tool results
  5. snipCompactIfNeeded()                       // HISTORY_SNIP feature
  6. microcompact()                              // CACHED_MICROCOMPACT feature
  7. contextCollapse.applyCollapsesIfNeeded()    // CONTEXT_COLLAPSE feature
  8. appendSystemContext(systemPrompt, systemContext)  // append gitStatus etc.
  9. autoCompact check + maybe compact
  10. Check blocking limit (hard stop if over)
  11. callModel({
        messages: prependUserContext(messagesForQuery, userContext),  // inject claudeMd first
        systemPrompt: fullSystemPrompt,
        ...
      })
  12. For each streamed event:
      - assistant messages → yield, push to assistantMessages
      - tool_use blocks → push to toolUseBlocks, set needsFollowUp=true
  13. executePostSamplingHooks (async, fire-and-forget)
  14. if needsFollowUp:
      - runTools() or streamingToolExecutor
      - yield tool results
      - TOKEN_BUDGET check → maybe inject nudge message and continue
      - STOP_HOOK → maybe inject and continue
      - state = { messages: [..., new tool results], ... }
      - continue
  15. else:
      - Token budget check (TOKEN_BUDGET feature)
      - return { reason: 'completed' }
```

### Tool Dispatch

Two modes (controlled by `tengu_streaming_tool_execution2` Statsig gate):
- **Streaming mode**: `StreamingToolExecutor` — starts executing tools as they stream in
- **Sequential mode**: `runTools()` — executes after stream ends

Both modes produce `AttachmentMessage` and `UserMessage` (tool_results) that are yielded and pushed into `state.messages` for the next iteration.

---

## 7. Undocumented Injection Points and Extension Surfaces

### A. `systemContext` — Post-Turn, Pre-API Injection

`systemContext` from `getSystemContext()` is appended to the system prompt at `query.ts:449-451` on **every API call**. Currently only contains `gitStatus` and possibly `cacheBreaker`. This runs **after** the memoized system prompt but **before** the API call.

The `getSystemContext()` and `getUserContext()` caches can be cleared by calling `setSystemPromptInjection()` (`context.ts:29-34`), which also clears the caches:
```typescript
export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}
```

### B. `userContext` as First Message — Always Prepended

Every API call prepends `userContext` as the **first user message**. This is the prime injection point for context that should appear at the beginning of the conversation. The format is `<system-reminder>` with `# key` headings.

**Claudex advantage:** The `claudeMd` key is one of the two fields in `userContext`. This means CLAUDE.md content (all of it, from all directories) is injected as `# claudeMd` in this first-message `<system-reminder>` block. Claudex's context injection via hooks appears **after** the user's actual message (in tool result messages), while CLAUDE.md content appears **before** all messages.

### C. `appendSystemPrompt` — End of System Prompt

`appendSystemPrompt` is a string passed by the SDK caller that gets appended after everything else:
```typescript
const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```
This is a documented SDK parameter. No hook can set it — it must come from the QueryEngine config.

### D. The `<system-reminder>` Convention

The CC system itself uses `<system-reminder>` for all injected context that is not from the user. From `constants/prompts.ts:131-134`:
```typescript
function getSystemRemindersSection(): string {
  return `- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear.`
}
```

This is in `getSimpleSystemSection()` — the model is explicitly told that `<system-reminder>` tags are system-injected and may appear anywhere. This is the legitimate injection surface for hooks.

### E. `hook_additional_context` Attachment — Direct API Position

`hook_additional_context` attachments become **user-role messages** with `isMeta: true`. In `normalizeMessagesForAPI`, they are "smooshed" into adjacent messages.

For `UserPromptSubmit`, the attachment is pushed **after** the user's message but **before** the API call (`processUserInput.ts:231-240`). It appears immediately after the user message in the conversation.

For `PostToolUse`, it appears **after** the tool result in the next batch of user messages.

For `SessionStart`/`Setup`, it appears in the initial messages before the first real user message.

### F. Dynamic System Prompt Sections Registry

**`constants/systemPromptSections.ts`** — Two types:
1. `systemPromptSection()` — cached until `/clear`/`/compact`; stable across turns
2. `DANGEROUS_uncachedSystemPromptSection()` — recomputes every turn (busts cache)

The registry is populated in `getSystemPrompt()`. External code cannot add sections to this registry directly — it requires modifying `prompts.ts`.

### G. MCP Server Instructions — Dynamic System Prompt

MCP server instructions (from connected servers' `instructions` field) are injected as a `DANGEROUS_uncachedSystemPromptSection` named `mcp_instructions`. This means every turn, the system prompt is regenerated with the current MCP server instructions. Claudex's MCP server could inject instructions this way.

Format (`constants/prompts.ts:579-604`):
```
# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

## serverName
[instructions text]
```

### H. `relevant_memories` Attachment — Auto-Surfaced Memory Files

`getAttachmentMessages()` in `utils/attachments.ts` includes a `relevant_memories` path that auto-surfaces memory files via similarity search. From `attachments.ts:269-289`:
- Max 5 files per turn, 4KB per file (200 lines), 60KB cumulative session cap
- Files appear as `<system-reminder>` messages

This is the auto-memory system (separate from CLAUDE.md). It reads from `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` or the default mem dir.

---

## 8. Environment Variables Affecting Context Assembly

### CLAUDE.md and Memory

| Variable | Effect |
|----------|--------|
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | Hard disables all CLAUDE.md injection |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE=<path>` | Overrides auto-memory base path |

### System Prompt Path

| Variable | Effect |
|----------|--------|
| `CLAUDE_CODE_SIMPLE=1` | Minimal system prompt: just "You are Claude Code, CWD: X, Date: Y" |
| `CLAUDE_CODE_REMOTE=1` | Skips git status in systemContext |
| `--bare` / `isBareMode()` | Skips CLAUDE.md auto-discovery, skips plugin hooks |

### Context Window / Tokens

| Variable | Effect |
|----------|--------|
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS=N` | Caps effective context window (ant-only) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW=N` | Caps effective context window for autocompact |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=N` | Overrides blocking limit threshold |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=N` | Sets autocompact threshold as % |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | Forces 200k even on 1M models |
| `DISABLE_COMPACT=1` | Disables all compaction |
| `DISABLE_AUTO_COMPACT=1` | Disables auto-compact, keeps manual |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS=N` | Overrides max output tokens |

### Output Tokens / Capping

| Variable | Effect |
|----------|--------|
| `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES=1` | Emits tool use summary messages |
| `CLAUDE_CODE_EAGER_FLUSH=1` | Awaits storage flush after each turn |
| `CLAUDE_CODE_IS_COWORK=1` | Enables eager flush (remote cowork mode) |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | Strips `defer_loading`, `strict` from tool schemas |
| `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` | Force-enables per-tool streaming field |

---

## 9. Cache Architecture — What Gets Cached Where

### System Prompt Caching

The system prompt blocks are split for cache control via `splitSysPromptPrefix()` (`utils/api.ts:321-435`):

**Mode 1: Global cache (1P only, boundary marker present)**
- Attribution header → `cacheScope: null`
- System prompt prefix → `cacheScope: null`
- Static content before `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` → `cacheScope: 'global'` (cross-org cached, 1+ hour TTL)
- Dynamic content after boundary → `cacheScope: null`

**Mode 2: Org-level cache (3P providers or MCP tools present)**
- Attribution header → `cacheScope: null`
- System prompt prefix → `cacheScope: 'org'`
- Everything else joined → `cacheScope: 'org'`

### Tool Schema Caching

Tool schemas are cached per-session via `getToolSchemaCache()`. The cache key is `tool.name` (or `tool.name:schema` for StructuredOutput). This prevents mid-session feature flag flips from invalidating the schema — intentional for stability.

### Section-Level Caching

`systemPromptSections.ts` caches section values in `bootstrap/state.js`'s `systemPromptSectionCache`. All sections cached on first compute; `DANGEROUS_uncachedSystemPromptSection` sections recompute every turn. Cache cleared on `/clear` and `/compact`.

---

## 10. Key Architectural Findings for Claudex

### Where Claudex Context Currently Lands

Claudex context (via hooks) lands as `hook_additional_context` → `<system-reminder>` user messages. These appear **after** the user's actual message in the conversation. The model sees them as:

```
User: [user's actual question]
User (isMeta): <system-reminder>
UserPromptSubmit hook additional context: [Claudex injected context]
</system-reminder>
```

This is **not** at the top of the conversation — it's mid-conversation, after the user's message.

### vs. CLAUDE.md Injection (Better Position)

CLAUDE.md content is in `userContext.claudeMd`, which gets prepended as the **very first message** in the API call:
```
User (isMeta): <system-reminder>
# claudeMd
[all CLAUDE.md content]
# currentDate
Today's date is ...
</system-reminder>
User: [first real user message]
```

This is the prime position — before all conversation history, before tool results, before the user's actual question.

### Implications for Claudex Optimization

1. **Current Claudex position** (via `UserPromptSubmit` hook → `hook_additional_context`): After user message, as a `<system-reminder>` user turn. Position degrades across long conversations as it gets pushed deeper into history.

2. **CLAUDE.md position** (via `userContext.claudeMd`): First message in every API call. Most prominent. Cached across turns (memoized). Will not degrade with conversation length.

3. **`systemContext` position** (via `getSystemContext()`): Appended to system prompt as raw `key: value` string. No headers, just plain text. Runs every API call from the same memoized value.

4. **`appendSystemPrompt`** position: End of system prompt. Requires QueryEngine config change — not hook-accessible.

5. **MCP server `instructions`** position: In the dynamic system prompt section (`mcp_instructions`). Recomputed every turn. Appears after `session_guidance` and `memory` (CLAUDE.md) in the system prompt. This is the best Claudex-accessible **system prompt** position.

### Hook `additionalContext` Across All Hook Events

Different hook events place the context at different turn positions:

| Hook | Position in turn | Best for |
|------|-----------------|----------|
| `SessionStart` | Before any user message | Session-level context |
| `UserPromptSubmit` | After user message, before API | Per-prompt context injection |
| `PreToolUse` | After tool invocation seen, before tool runs | Tool-specific guidance |
| `PostToolUse` | After tool result, in next user batch | Follow-up context |
| `SubagentStart` | Injected into subagent's initial messages | Subagent awareness |

### The `system-reminder` Tag Is the Official Injection Channel

The model is explicitly told in `getSimpleSystemSection()` that `<system-reminder>` tags:
1. "contain useful information and reminders"
2. "are automatically added by the system"
3. "bear no direct relation to the specific tool results or user messages in which they appear"

This legitimizes Claudex's use of `<system-reminder>` tags. The model is trained to treat these as authoritative system context regardless of where in the conversation they appear.

### Token Budget Implications for Claudex

With 200k default context (or 1M for Sonnet 4.6):
- Auto-compact fires at `effectiveWindow - 13_000` tokens used
- Effective window = `contextWindow - min(maxOutputTokens, 20_000)`
- For Sonnet 4.6 at 200k: effective = ~168k, autocompact at ~155k

Claudex injections should be **concise** — hook `additionalContext` that exceeds 10,000 chars is truncated. Per-turn injections accumulate: if Claudex injects 5k tokens/turn across 30 turns, that's 150k tokens just from context injection, triggering autocompact.

The `relevant_memories` system has a 60KB session cap specifically to prevent this runaway accumulation problem. Claudex should consider similar budgeting.
