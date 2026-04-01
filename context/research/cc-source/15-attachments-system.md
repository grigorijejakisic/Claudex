# CC Attachments System — Deep Research

**Date:** 2026-04-01  
**Source:** `claude-code-buildable/src/`  
**Purpose:** Token optimization for Claudex context injection via hooks

---

## 1. What Are Attachments?

Attachments are CC's internal mechanism for adding context to the conversation without it being "real" user content. Every attachment is wrapped in an `AttachmentMessage` record:

```typescript
// src/utils/attachments.ts:3201
export function createAttachmentMessage(attachment: Attachment): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
```

Attachments live in the `Message[]` array alongside user and assistant messages. They are separate from the message stream — they are **not** `UserMessage` or `AssistantMessage`. They get converted to API-ready messages only when `normalizeMessagesForAPI()` is called in `messages.ts`.

### Full Attachment Type Union

Defined in `src/utils/attachments.ts` starting ~line 440. All known types:

**File/content types:**
- `file` — @-mentioned file content (via FileReadTool tool_use/tool_result pair)
- `compact_file_reference` — file read before last compact, too large to re-include
- `pdf_reference` — PDF at-mention (page count + size)
- `already_read_file` — file already in context, re-attached
- `edited_text_file` — file edited during session, injects diff snippet
- `edited_image_file` — image file edited
- `directory` — directory listing (via BashTool ls)
- `selected_lines_in_ide` — IDE selection context
- `opened_file_in_ide` — IDE opened file notification
- `mcp_resource` — MCP resource content

**Reminder/mode types:**
- `todo_reminder` / `task_reminder` — todo/task list state
- `nested_memory` — CLAUDE.md from nested directory
- `relevant_memories` — memdir surfaced memories (up to 5 files × 4KB = 20KB/turn)
- `dynamic_skill` / `skill_listing` / `skill_discovery` — skill system
- `plan_mode` / `plan_mode_reentry` / `plan_mode_exit` — plan mode state
- `auto_mode` / `auto_mode_exit` — auto mode (TRANSCRIPT_CLASSIFIER feature)
- `verify_plan_reminder` — plan verification reminder
- `critical_system_reminder` — urgent injected system message
- `compaction_reminder` — auto-compact context warning (COMPACTION_REMINDERS feature flag)
- `context_efficiency` — history snip nudge (HISTORY_SNIP feature)
- `date_change` — date change notification
- `output_style` — output style preference

**Hook types** (`HookAttachment` union):
- `hook_success` — hook ran, non-empty content case
- `hook_additional_context` — **the primary Claudex injection type**
- `hook_blocking_error` — hook blocked execution
- `hook_non_blocking_error` — hook failed non-fatally
- `hook_error_during_execution` — exception during hook
- `hook_cancelled` — hook was aborted
- `hook_stopped_continuation` — hook requested stop
- `hook_system_message` — hook returned systemMessage field
- `hook_permission_decision` — hook returned allow/deny for tool

**Agent/team types:**
- `queued_command` — mid-turn user message or task notification
- `agent_mention` — @agent mention
- `task_status` — async agent task status update
- `async_hook_response` — async hook response delivered
- `teammate_mailbox` — team DM messages
- `team_context` — team coordination info
- `invoked_skills` — skills content used this session

**Telemetry/UI types (null rendering, no API cost):**
- `token_usage` / `budget_usd` / `output_token_usage` — usage tracking
- `structured_output` — SDK structured output
- `max_turns_reached` — turn limit hit
- `current_session_memory` — session memory file content
- `teammate_shutdown_batch` — batch teammate shutdown notice
- `ultrathink_effort` — thinking effort level
- `deferred_tools_delta` / `agent_listing_delta` / `mcp_instructions_delta` — tool/agent announcements
- `companion_intro` — buddy companion intro
- `bagel_console` — browser console errors
- `invoked_skills` — skill content tracker

---

## 2. How Hook `additionalContext` Becomes an Attachment

The pipeline from hook output to API message:

### Step 1: Hook output parsing (`src/utils/hooks.ts`)

Each hook's JSON output is parsed. If `hookSpecificOutput.additionalContext` is present, it's extracted to `result.additionalContext: string`:

```typescript
// hooks.ts ~line 621
result.additionalContext = json.hookSpecificOutput.additionalContext
```

This applies to: `PreToolUse`, `UserPromptSubmit`, `SessionStart`, `Setup`, `SubagentStart`, `PostToolUse`, `PostToolUseFailure`, `Notification`.

### Step 2: Per-hook result aggregation (`src/utils/hooks.ts:2782`)

As hooks are yielded from `executeHooks()`, each individual `additionalContext` is wrapped in an array and yielded as `AggregatedHookResult.additionalContexts`:

```typescript
// hooks.ts:2783
if (result.additionalContext) {
  yield { additionalContexts: [result.additionalContext] }
}
```

### Step 3: AttachmentMessage creation — different for each hook event

**SessionStart / Setup** (`src/utils/sessionStart.ts:163`):
```typescript
const contextMessage = createAttachmentMessage({
  type: 'hook_additional_context',
  content: additionalContexts,      // string[] — all hooks merged
  hookName: 'SessionStart',
  toolUseID: 'SessionStart',
  hookEvent: 'SessionStart',
})
hookMessages.push(contextMessage)
```
All SessionStart hook contexts are merged into ONE attachment message.

**UserPromptSubmit** (`src/utils/processUserInput/processUserInput.ts:231`):
```typescript
result.messages.push(
  createAttachmentMessage({
    type: 'hook_additional_context',
    content: hookResult.additionalContexts.map(applyTruncation),
    hookName: 'UserPromptSubmit',
    toolUseID: `hook-${randomUUID()}`,
    hookEvent: 'UserPromptSubmit',
  }),
)
```
Applied per hook result. Truncated at `MAX_HOOK_OUTPUT_LENGTH = 10000` chars.

**PostToolUse** (`src/services/tools/toolHooks.ts:133`):
```typescript
yield {
  message: createAttachmentMessage({
    type: 'hook_additional_context',
    content: result.additionalContexts,
    hookName: `PostToolUse:${tool.name}`,
    toolUseID: toolUseID,
    hookEvent: 'PostToolUse',
  }),
}
```

**PreToolUse** (`src/services/tools/toolHooks.ts:566`):
```typescript
yield {
  type: 'additionalContext',
  message: {
    message: createAttachmentMessage({
      type: 'hook_additional_context',
      content: result.additionalContexts,
      hookName: `PreToolUse:${tool.name}`,
      toolUseID,
      hookEvent: 'PreToolUse',
    }),
  },
}
```

**SubagentStart** (`src/tools/AgentTool/runAgent.ts:547`):
```typescript
const contextMessage = createAttachmentMessage({
  type: 'hook_additional_context',
  content: additionalContexts,
  hookName: 'SubagentStart',
  toolUseID: randomUUID(),
  hookEvent: 'SubagentStart',
})
initialMessages.push(contextMessage)   // pushed into agent's initial message list
```

### Step 4: Attachment data structure

```typescript
// Type from src/utils/attachments.ts:371
{
  type: 'hook_additional_context'
  content: string[]          // array of strings, one per hook output
  hookName: string           // e.g., 'SessionStart', 'PostToolUse:Bash'
  toolUseID: string          // links to the tool invocation
  hookEvent: HookEvent       // 'SessionStart'|'UserPromptSubmit'|etc.
}
```

---

## 3. How Attachments Appear in the API Conversation

### The Rendering Pipeline

`normalizeAttachmentForAPI()` in `src/utils/messages.ts:3453` converts each `Attachment` to `UserMessage[]`.

For `hook_additional_context` (messages.ts ~line 4117):
```typescript
case 'hook_additional_context': {
  if (attachment.content.length === 0) return []
  return [
    createUserMessage({
      content: wrapInSystemReminder(
        `${attachment.hookName} hook additional context: ${attachment.content.join('\n')}`,
      ),
      isMeta: true,
    }),
  ]
}
```

**`wrapInSystemReminder()`** (messages.ts:3097):
```typescript
export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}
```

So the API sees exactly:
```
<system-reminder>
SessionStart hook additional context: [Claudex context content here]
</system-reminder>
```

### isMeta flag

All attachment messages use `isMeta: true`. This marks them as metadata — they are injected for Claude's awareness but are not "real" user content. CC's UI rendering can suppress them for display.

### smooshSystemReminderSiblings

`messages.ts:1835` — a post-pass that folds `<system-reminder>`-prefixed text siblings into the last `tool_result` in the same user message. This affects PreToolUse `hook_additional_context` attachments in particular (they appear between assistant and tool_result and get smooshed in).

---

## 4. Do Attachments Survive Compaction?

### The verdict: `hook_additional_context` does NOT survive compaction automatically.

Compaction replaces the entire message history with a summary boundary marker. The pre-compact messages are gone. What survives post-compact is a specific set of re-injected attachments:

**What IS re-injected post-compact** (`src/services/compact/compact.ts:531`):
1. `createPostCompactFileAttachments()` — up to 5 recently-read files (compact_file_reference or re-read)
2. `createAsyncAgentAttachmentsIfNeeded()` — async agent state
3. `createPlanAttachmentIfNeeded()` — plan file reference
4. `createPlanModeAttachmentIfNeeded()` — plan mode instructions
5. `createSkillAttachmentIfNeeded()` — invoked skills content
6. `getDeferredToolsDeltaAttachment()` — tool schema deltas
7. `getAgentListingDeltaAttachment()` — agent listings
8. `getMcpInstructionsDeltaAttachment()` — MCP instructions
9. **`processSessionStartHooks('compact')`** — SessionStart hooks re-execute!

Point 9 is the critical one for Claudex: **SessionStart hooks run again after compaction** (`compact.ts:592`). This means Claudex's session-start hook will re-fire and inject fresh context post-compact. This is the mechanism that keeps Claudex's context alive across compaction.

**What is NOT re-injected**: UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart contexts. Those are one-time injections tied to specific turns that no longer exist.

### COMPACTION_REMINDERS feature flag

This is a feature gate controlling a `compaction_reminder` attachment type — it's an informational message to Claude that auto-compact is enabled. It is NOT related to preserving hook context post-compact. It's a user-awareness notification:

```typescript
// attachments.ts:922
...(feature('COMPACTION_REMINDERS')
  ? [
      maybe('compaction_reminder', () =>
        Promise.resolve(getCompactionReminderAttachment(messages ?? [], ...))
      ),
    ]
  : []),
```

The `getCompactionReminderAttachment` function only fires when context usage > 25% of effective window:
```typescript
// attachments.ts:3949
if (usedTokens < effectiveWindow * 0.25) return []
return [{ type: 'compaction_reminder' }]
```

Rendered as (messages.ts:4139):
```
Auto-compact is enabled. When the context window is nearly full, older messages 
will be automatically summarized so you can continue working seamlessly.
```

---

## 5. Do Attachments Survive Session Resume?

### Storage gating in `src/utils/sessionStorage.ts:4351`

```typescript
export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  // IMPORTANT: We deliberately filter out most attachments for non-ants because
  // they have sensitive info for training that we don't want exposed to the public.
  // When enabled, we allow hook_additional_context through since it contains
  // user-configured hook output that is useful for session context on resume.
  if (m.type === 'attachment' && getUserType() !== 'ant') {
    if (
      m.attachment.type === 'hook_additional_context' &&
      isEnvTruthy(process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT)
    ) {
      return true
    }
    return false
  }
  return true
}
```

**By default, for non-ANT users:**
- All attachment messages are filtered out of the JSONL transcript
- `hook_additional_context` is filtered out **unless** `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1` env var is set
- ANT users (Anthropic employees) get attachments logged to JSONL

**For Claudex users specifically:**
- On `--resume`, the hook_additional_context messages from the previous session are NOT loaded back from disk (they were never written, or written only if env var set)
- Instead, SessionStart hooks re-execute on resume (source = 'resume'), re-injecting fresh context
- This is the correct behavior: fresh context is better than stale context from hours ago

### Session resume flow

`processSessionStartHooks('resume', ...)` is called with source `'resume'`. The Claudex session-start hook runs again and returns fresh context. This is identical to the startup path.

---

## 6. Full Attachment Lifecycle

```
HOOK EXECUTION
  └── Hook returns { hookSpecificOutput: { additionalContext: "..." } }
      └── hooks.ts:~620 — parsed to result.additionalContext
          └── hooks.ts:2783 — yielded as { additionalContexts: ["..."] }
              └── Caller (sessionStart.ts / processUserInput.ts / toolHooks.ts)
                  └── createAttachmentMessage({ type: 'hook_additional_context', content: [...] })
                      └── Pushed to Message[] array

MESSAGE ARRAY
  └── AttachmentMessage sits alongside UserMessage, AssistantMessage
      └── NOT sent to API directly

PRE-API NORMALIZATION (messages.ts:normalizeMessagesForAPI)
  └── normalizeAttachmentForAPI('hook_additional_context')
      └── Returns [UserMessage { content: '<system-reminder>\nSessionStart hook additional context: ...\n</system-reminder>', isMeta: true }]
          └── smooshSystemReminderSiblings pass (if tengu_chair_sermon gate)
              └── SR-text folded into adjacent tool_result if present

API CALL
  └── Model sees: <system-reminder>\nHookName hook additional context: ...\n</system-reminder>

COMPACTION
  └── All pre-compact messages dropped
  └── processSessionStartHooks('compact') re-executes Claudex hook
  └── Fresh hook_additional_context attachment re-injected

SESSION END / RESUME
  └── isLoggableMessage() filters attachments from JSONL (unless CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1)
  └── On resume: processSessionStartHooks('resume') re-executes → fresh context
```

---

## 7. Token Overhead Per Turn

### Context analysis tracking (`src/utils/analyzeContext.ts:839`)

CC tracks attachment tokens by type for telemetry:
```typescript
function processAttachment(msg: AttachmentMessage, breakdown: MessageBreakdown): void {
  const contentStr = jsonStringify(msg.attachment)
  const tokens = roughTokenCountEstimation(contentStr)
  breakdown.attachmentTokens += tokens
  breakdown.attachmentsByType.set(attachType, ...)
}
```

The `attachmentTokens` field appears in SDK `messageBreakdown` telemetry.

### Overhead formula for `hook_additional_context`

The wrapping adds constant overhead:

```
"<system-reminder>\n" + hookName + " hook additional context: " + content + "\n</system-reminder>"
```

Example for Claudex SessionStart hook with 5KB context:
- Prefix: `<system-reminder>\nSessionStart hook additional context: ` = ~55 chars
- Suffix: `\n</system-reminder>` = ~20 chars
- **Total overhead: ~75 chars ≈ ~20 tokens** per injection
- Content itself: however large your additionalContext string is

### Per-hook-event overhead

| Hook Event | When Injected | Frequency |
|---|---|---|
| SessionStart | Session start, resume, post-compact | Once per session start boundary |
| UserPromptSubmit | Each user turn | Every turn (potentially) |
| PreToolUse | Before each tool call | Per tool call |
| PostToolUse | After each tool call | Per tool call |
| SubagentStart | When subagent spawns | Per subagent |

UserPromptSubmit is the most impactful for ongoing cost — it fires every turn.

### Truncation

Only `UserPromptSubmit` path applies truncation:
```typescript
// processUserInput.ts:272
const MAX_HOOK_OUTPUT_LENGTH = 10000
function applyTruncation(content: string): string {
  if (content.length > MAX_HOOK_OUTPUT_LENGTH) {
    return `${content.substring(0, MAX_HOOK_OUTPUT_LENGTH)}… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters]`
  }
  return content
}
```

SessionStart, PreToolUse, PostToolUse contexts have no truncation applied. The raw string is used.

---

## 8. Deduplication — Is There Any?

**No built-in deduplication exists for `hook_additional_context` content.**

Each hook execution produces a new attachment with a new UUID. There is no mechanism that:
- Compares content of new injection to previous injections
- Suppresses identical content already in context
- Merges multiple context strings across turns

The only implicit deduplication is structural:
1. **SessionStart only fires once per boundary** (startup, resume, compact)
2. **UserPromptSubmit fires per turn** — each one is a fresh injection, so if content is identical every turn, it repeats identically every turn

For Claudex's case: the system-reminder from the previous UserPromptSubmit turn is still in the context window when the next one fires. Both are sent to the API. Over N turns: N copies of the context exist in the window, each from a separate UserPromptSubmit hook execution.

**Practical implication**: Claudex's UserPromptSubmit hook injects context every turn. Over 50 turns with 2KB context, that's 100KB of repeated context in the conversation window. This is the primary optimization target.

### Hook success dedup

There is a soft dedup for `hook_success` (non-additional-context):
```typescript
// hooks.ts:725
// JSON-output hooks inject context via additionalContext → hook_additional_context,
// not this field. Empty content suppresses the trivial "X hook success: Success"
// system-reminder...
content: '',
```

When a hook returns JSON (like Claudex does), the `hook_success` attachment gets `content: ''`, and `normalizeAttachmentForAPI` skips it (line 4106: `if (attachment.content === '') return []`). So Claudex doesn't pay the cost of a success message on top of the additional context.

---

## 9. Bridge/Inbound Attachments (Different System)

`src/bridge/inboundAttachments.ts` handles a completely different type of "attachment" — files uploaded via the web composer. These are file UUIDs sent alongside a message from the bridge UI. They are:
- Fetched from `/api/oauth/files/{uuid}/content`
- Written to `~/.claude/uploads/{sessionId}/`
- Prepended as `@"path"` refs to the user message text

This is NOT the same as the `Attachment` type system. These become part of the user message text, not an `AttachmentMessage`.

---

## 10. NULL Rendering Attachments

Some attachment types render as nothing in the UI (but still consume API tokens):

```typescript
// src/components/messages/nullRenderingAttachments.ts
export const NULL_RENDERING_TYPES = [
  'token_usage', 'budget_usd', 'output_token_usage',
  'pen_mode_enter', 'pen_mode_exit',
  'verify_plan_reminder', 'current_session_memory',
  'compaction_reminder', 'date_change',
] as const
```

`hook_additional_context` is NOT in this list — it renders in the UI (presumably as a collapsible hook output card).

---

## Key Findings for Claudex Token Optimization

1. **SessionStart is efficient**: fires once per session boundary, context re-injected at compact/resume by CC's own mechanism (no Claudex work needed).

2. **UserPromptSubmit is expensive**: fires every turn, context accumulates unbounded in context window. 50-turn session × 2KB = 100KB of redundant context.

3. **No dedup exists**: CC has no mechanism to suppress identical context already in context. All injection is additive.

4. **Token overhead is minimal**: ~20 tokens per attachment wrap. The content itself is the cost.

5. **Truncation limit**: 10,000 chars for UserPromptSubmit content. No limit for SessionStart.

6. **Compaction auto-recovers**: SessionStart hooks re-execute post-compact. Claudex context survives compaction naturally via CC's design.

7. **Resume auto-recovers**: SessionStart hooks re-execute on resume. No need to save/restore context to JSONL (and it's filtered out anyway for non-ANT users).

8. **Optimization strategy options**:
   - Use **SessionStart** for bulk context (CLAUDE.md, checkpoints, patterns) — injected once, survives compact/resume
   - Use **UserPromptSubmit** only for turn-specific dynamic context (matched experience patterns, recent signals)
   - Keep UserPromptSubmit payload small (< 500 tokens) to bound per-turn overhead
   - Consider content hashing to skip UserPromptSubmit injection when previous turn's context was identical

---

## Files Referenced

| File | Purpose |
|---|---|
| `src/utils/attachments.ts` | Attachment type definitions, `getAttachments()`, `createAttachmentMessage()` |
| `src/utils/messages.ts` | `normalizeAttachmentForAPI()`, `wrapInSystemReminder()`, `isLoggableMessage()` |
| `src/utils/hooks.ts` | Hook parsing, `additionalContext` extraction, yielding |
| `src/utils/sessionStart.ts` | SessionStart/Setup hook processing → `hook_additional_context` creation |
| `src/utils/processUserInput/processUserInput.ts` | UserPromptSubmit → attachment (with truncation) |
| `src/services/tools/toolHooks.ts` | PreToolUse/PostToolUse → attachment |
| `src/tools/AgentTool/runAgent.ts` | SubagentStart → attachment |
| `src/services/compact/compact.ts` | Compaction — SessionStart hooks re-execute, file attachments re-injected |
| `src/services/compact/postCompactCleanup.ts` | Cache/state reset post-compact |
| `src/utils/sessionStorage.ts` | `isLoggableMessage()` — attachment filtering from JSONL |
| `src/types/hooks.ts` | `syncHookResponseSchema` — `additionalContext` zod schema per hook type |
| `src/bridge/inboundAttachments.ts` | Bridge file attachments (unrelated to hook system) |
| `src/utils/analyzeContext.ts` | Token counting by attachment type |
| `src/components/messages/nullRenderingAttachments.ts` | UI-only null rendering list |
