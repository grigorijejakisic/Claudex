# CC Source: Tool Interception — PreToolUse / PostToolUse Deep Dive

**Source files analyzed:**
- `src/services/tools/toolExecution.ts` — dispatcher and execution pipeline
- `src/services/tools/toolHooks.ts` — hook runner helpers for pre/post
- `src/utils/hooks.ts` — core hook execution engine (executeHooks, matching, parsing)
- `src/types/hooks.ts` — HookResult, AggregatedHookResult, schema validators
- `src/entrypoints/sdk/coreSchemas.ts` — HookInput Zod schemas (PreToolUse, PostToolUse)
- `src/Tool.ts` — Tool type definition, backfillObservableInput, checkPermissions

---

## 1. Tool Dispatch Flow: Model Output → Execution

```
runToolUse(toolUse: ToolUseBlock, ...)
  → findToolByName(toolUseContext.options.tools, toolName)
  → streamedCheckPermissionsAndCallTool(...)
      → checkPermissionsAndCallTool(...)
          1. tool.inputSchema.safeParse(input)        [Zod validation]
          2. tool.validateInput?(parsedInput, context) [tool-specific validation]
          3. tool.backfillObservableInput?(clone)      [add legacy/derived fields to observable copy]
          4. runPreToolUseHooks(...)                   [PreToolUse hooks]
          5. resolveHookPermissionDecision(...)        [permission decision from hook + settings rules]
          6. tool.call(callInput, ...)                 [actual execution]
          7. runPostToolUseHooks(...)                  [PostToolUse hooks]
          8. addToolResult(toolOutput)                 [serialize result into conversation]
```

Key: steps 4–5 happen BEFORE `tool.call()`. Step 7 happens AFTER. The model sees the final `tool_result` in its next turn.

---

## 2. PreToolUse: Full Interception Flow

**Entry:** `executePreToolHooks()` in `utils/hooks.ts`

```typescript
// Hook input constructed:
const hookInput: PreToolUseHookInput = {
  ...createBaseHookInput(permissionMode, undefined, toolUseContext),
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,       // the raw parsed input
  tool_use_id: toolUseID,
}
```

**Hook input schema** (`coreSchemas.ts:414`):
```typescript
PreToolUseHookInputSchema = BaseHookInputSchema.and({
  hook_event_name: 'PreToolUse',
  tool_name: string,
  tool_input: unknown,   // full tool input object
  tool_use_id: string,
})

BaseHookInputSchema = {
  session_id: string,
  transcript_path: string,
  cwd: string,
  permission_mode?: string,
  agent_id?: string,      // present for subagent hooks
  agent_type?: string,    // present for subagent or --agent main thread
}
```

**Execution:** All matching hooks run IN PARALLEL via `all(hookPromises)` in `executeHooks()`.

**Result aggregation precedence** (when multiple hooks conflict):
- `deny` always wins over `ask` and `allow`
- `ask` wins over `allow` but not `deny`
- `allow` only applies if nothing else set

---

## 3. What PreToolUse Can Return

### Via JSON output (command/HTTP hooks):
```json
{
  "decision": "approve" | "block",
  "reason": "string",
  "continue": false,
  "stopReason": "string",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "string",
    "updatedInput": { ...modified tool input... },
    "additionalContext": "string"
  }
}
```

### Possible behaviors:

| Return | Effect |
|--------|--------|
| `decision: "approve"` | Sets `permissionBehavior = 'allow'` |
| `decision: "block"` | Sets `permissionBehavior = 'deny'`, tool blocked |
| `hookSpecificOutput.permissionDecision: "allow"` | Allow, skips interactive prompt |
| `hookSpecificOutput.permissionDecision: "deny"` | Block with `permissionDecisionReason` |
| `hookSpecificOutput.permissionDecision: "ask"` | Force show permission dialog (despite hook running) |
| `hookSpecificOutput.updatedInput: {...}` | Modify tool input before execution |
| `continue: false` | Set `preventContinuation = true`, stop agent after tool |
| `hookSpecificOutput.additionalContext` | Inject context into conversation |
| exit code 2 | Blocking error — tool is denied |
| exit code != 0 and != 2 | Non-blocking error — shown to user, tool still runs |

### Important: `allow` does NOT bypass settings.json deny/ask rules

From `resolveHookPermissionDecision()` in `toolHooks.ts`:
- If hook returns `allow`, settings.json `deny` rules STILL override it
- If hook returns `allow` but there is a settings.json `ask` rule, the dialog still shows
- Only when neither deny nor ask rule matches does the hook `allow` skip the dialog

---

## 4. `updatedInput` — Exact Schema

`updatedInput` is typed as `Record<string, unknown>` throughout the codebase. There is no per-tool schema enforcement on the hook's returned `updatedInput` — it replaces the full processed input as-is.

**How it propagates:**

1. **With permission decision (allow or ask):**
   - `result.updatedInput` is included in the yielded `hookPermissionResult`
   - In `resolveHookPermissionDecision()`: `const hookInput = hookPermissionResult.updatedInput ?? input`
   - This `hookInput` becomes the `input` for both permission checks AND the final `processedInput`

2. **Without permission decision (passthrough):**
   - Hook returns `updatedInput` with no `permissionDecision`
   - Yields `type: 'hookUpdatedInput'` from `runPreToolUseHooks()`
   - In `checkPermissionsAndCallTool()`: `processedInput = result.updatedInput`
   - This flows through to permission checks AND `tool.call()`

3. **From permissions (not hook):**
   - After all permission resolution: `if (permissionDecision.updatedInput !== undefined) processedInput = permissionDecision.updatedInput`

**What fields can be set:** Any fields the tool's `inputSchema` accepts. The hook can set any subset of the tool's input schema fields. There is no re-validation via Zod after hook modification — the modified input goes directly to `tool.call()`.

**The backfill/callInput nuance:**
```
tool.backfillObservableInput → backfilledClone (observable-only, never sent to tool.call directly)
                                             ↓
                              processedInput (starts as backfilledClone, can be replaced by hooks/permissions)
                                             ↓
                              callInput (what tool.call() actually receives)
```
If a hook replaces `processedInput`, `callInput` converges to the hook's value. There is a special case: if the hook's replacement has a `file_path` that matches the backfill-expanded version, the original model-emitted `file_path` is restored (for VCR/transcript hash stability).

---

## 5. Can PreToolUse Modify Which Tool is Called?

**No.** `updatedInput` modifies the INPUT of the selected tool. The tool itself is already dispatched before hooks run (the dispatch uses `toolUse.name` from the model's output). There is no mechanism to redirect to a different tool.

The only way to effectively prevent a tool from running is to return `decision: "block"` or `permissionDecision: "deny"`.

---

## 6. PostToolUse: How It Works and What It Can Modify

**Entry:** `executePostToolHooks()` in `utils/hooks.ts`

**Hook input schema:**
```typescript
PostToolUseHookInputSchema = BaseHookInputSchema.and({
  hook_event_name: 'PostToolUse',
  tool_name: string,
  tool_input: unknown,    // the processed input that was sent to the tool
  tool_response: unknown, // the raw tool output
  tool_use_id: string,
})
```

**IMPORTANT — field name:** The tool output is `tool_response` (NOT `tool_output`, NOT `tool_result`). This matches the CLAUDE.md project truth table.

**What PostToolUse can return:**

| Return | Effect |
|--------|--------|
| `hookSpecificOutput.updatedMCPToolOutput` | Replaces the MCP tool's output before it reaches the model |
| `hookSpecificOutput.additionalContext` | Appends context into the conversation |
| `continue: false` | `preventContinuation = true` — stops agent after this tool |
| `decision: "block"` | `blockingError` — shows error to model |
| exit code 2 | Blocking error |

**The critical limitation — `updatedMCPToolOutput` is MCP-only:**

From `toolHooks.ts` line 146:
```typescript
if (result.updatedMCPToolOutput && isMcpTool(tool)) {
  toolOutput = result.updatedMCPToolOutput as Output
```

And in `toolExecution.ts` line 1494:
```typescript
if ('updatedMCPToolOutput' in hookResult) {
  if (isMcpTool(tool)) {
    toolOutput = hookResult.updatedMCPToolOutput
  }
}
```

**PostToolUse CANNOT modify the output of built-in tools** (Bash, FileRead, FileEdit, etc.). Only MCP tools support output modification via `updatedMCPToolOutput`. For built-in tools, the `mapToolResultToToolResultBlockParam()` is called BEFORE PostToolUse hooks run, and the result is already committed to `resultingMessages`.

The ordering in `toolExecution.ts`:
```
1. mappedToolResultBlock = tool.mapToolResultToToolResultBlockParam(result.data, toolUseID)
2. if (!isMcpTool(tool)) { await addToolResult(toolOutput, mappedToolResultBlock) }  // COMMITTED before hooks
3. for await (hookResult of runPostToolUseHooks(...)) { ... }
4. if (isMcpTool(tool)) { await addToolResult(toolOutput) }  // MCP: committed AFTER hooks
```

---

## 7. Tool Metadata Available to Hooks

**PreToolUse receives:**
```json
{
  "session_id": "...",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default|auto|bypassPermissions|...",
  "agent_id": "agent-uuid",      // only for subagents
  "agent_type": "general-purpose|...",  // for subagents or --agent main thread
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",           // canonical tool name
  "tool_input": { "command": "ls -la" },  // full input object
  "tool_use_id": "toolu_..."     // unique ID for this tool invocation
}
```

**PostToolUse receives:**
Same as PreToolUse plus:
```json
{
  "hook_event_name": "PostToolUse",
  "tool_response": { ... }  // full output of the tool
}
```

**PostToolUseFailure receives:**
```json
{
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "...",
  "tool_input": { ... },
  "tool_use_id": "...",
  "error": "error message string",
  "is_interrupt": true|false    // whether the tool was user-interrupted
}
```

---

## 8. Per-Tool-Type Hooks vs Generic

There are **no per-tool-type hooks** in the settings format. All hooks are registered for an event (PreToolUse, PostToolUse, etc.) with a **matcher** field that selects which tools they apply to.

The matcher operates at the `tool_name` level — it is NOT aware of tool categories/types.

---

## 9. The Matcher System

**How `matcher: "Bash"` works:**

The `matcher` field on a hook entry in settings.json is matched against the `tool_name` from the hook input.

From `matchesPattern()` in `hooks.ts:1346`:

```typescript
function matchesPattern(matchQuery: string, matcher: string): boolean {
  if (!matcher || matcher === '*') return true  // wildcard

  // Simple alphanumeric + pipe: exact match or pipe-separated list
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes('|')) {
      const patterns = matcher.split('|').map(p => normalizeLegacyToolName(p.trim()))
      return patterns.includes(matchQuery)  // e.g., "Bash|Edit"
    }
    return matchQuery === normalizeLegacyToolName(matcher)  // e.g., "Bash"
  }

  // Otherwise: regex matching
  const regex = new RegExp(matcher)
  return regex.test(matchQuery)  // e.g., "^Bash.*" or "^(Bash|Edit)$"
}
```

**Supported matcher patterns:**
- `"Bash"` — exact match for Bash tool only
- `"Bash|Edit"` — matches Bash OR Edit
- `"*"` or `""` — matches all tools
- `"^mcp__.*"` — regex matching all MCP tools
- Any valid regex string

**The `if` sub-condition (deeper matching):**

Beyond the top-level matcher, hooks can have an `if` field with `Bash(git *)` syntax — this is the tool-specific pattern system using `tool.preparePermissionMatcher()`.

```typescript
if (ifMatcher(ifCondition)) {
  // hook runs only if Bash command matches "git *"
}
```

This is what powers `{ "matcher": "Bash", "if": "Bash(git *)" }` — hooks that fire only for specific Bash commands. The `preparePermissionMatcher()` method on each Tool implements the matching logic (tree-sitter for Bash, path-based for file tools).

**What the matcher selects from (for tool events):**

For PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied:
- `matchQuery = hookInput.tool_name` (the raw tool name, e.g., "Bash")

---

## 10. Internal Tool Hooks

Yes, there are internal hooks that are not user-facing. From `types/hooks.ts`:

```typescript
export type HookCallback = {
  type: 'callback'
  callback: (input, toolUseID, abort, hookIndex?, context?) => Promise<HookJSONOutput>
  timeout?: number
  internal?: boolean   // <-- internal flag
}
```

Internal hooks (e.g., session file access analytics, attribution tracking) are registered as `type: 'callback'` with `internal: true`. They:
- Are excluded from `tengu_run_hook` analytics events
- Are not deduped by command string (each callback is unique)
- Can run for any hook event including PreToolUse/PostToolUse
- Appear via `getRegisteredHooks()` — the SDK/programmatic hook registry

These internal callbacks are registered programmatically (not via settings.json) and are invisible to users. Claudex hooks are registered through this same mechanism when `type: 'callback'` is used in the registered hooks system.

---

## 11. Does the Model See Modified Input After PreToolUse?

**For `updatedInput`:** The modified input goes to `tool.call()`, and the tool's result is what the model sees. However, the `tool_use` block the model already emitted contains the ORIGINAL input — CC never re-sends a modified `tool_use` to the model.

What the model actually sees next turn:
- The `tool_use` block (with original input — already in conversation)
- The `tool_result` block (from the actual execution using modified input)

So if PreToolUse changes `command: "ls -la"` to `command: "ls -la --color=never"`, the model's conversation contains:
```
[tool_use]: command="ls -la"          (original, unmodified)
[tool_result]: <output of ls -la --color=never>  (from modified input)
```

The model may be confused by the discrepancy, but this is the current behavior. The model does NOT see a modified `tool_use` block.

**For `additionalContext`:** This IS injected as a system message into the conversation, so the model sees it.

**For `updatedMCPToolOutput` (PostToolUse, MCP only):** The MCP tool output IS replaced before being serialized into the `tool_result`, so the model sees the hook's modified version.

---

## 12. Hook Types: Command, HTTP, Prompt, Agent, Callback, Function

CC supports multiple hook implementation types, all usable for PreToolUse/PostToolUse:

| Type | How | Use case |
|------|-----|----------|
| `command` | Shell subprocess, stdin=JSON payload, stdout=JSON response | External scripts |
| `http` | HTTP POST to URL | Remote webhook |
| `prompt` | Runs a mini-agent with a prompt template | LLM-based hook logic |
| `agent` | Runs a full agent | Complex hook logic |
| `callback` | JS function registered programmatically | SDK consumers, internal hooks |
| `function` | Session-scoped JS function (structured output enforcement) | Internal CC use |

Claudex hooks are registered as `callback` type hooks via `getRegisteredHooks()`.

---

## 13. Additional Hook Events Relevant to Claudex

| Event | Trigger | Can block tool? | Can modify? |
|-------|---------|-----------------|-------------|
| `PreToolUse` | Before tool.call() | Yes (deny/block) | Yes (updatedInput) |
| `PostToolUse` | After tool.call() | Yes (preventContinuation) | Yes (MCP only: updatedMCPToolOutput) |
| `PostToolUseFailure` | After tool.call() throws | No | No |
| `PermissionRequest` | When permission dialog would show | Yes | Yes (updatedInput, updatedPermissions) |
| `PermissionDenied` | When tool is denied (auto-mode classifier) | No | Yes (retry flag) |
| `Stop` | After model finishes its turn | Yes (exit code 2 blocks next turn) | No |
| `SubagentStart` | When subagent spawns | No | Yes (additionalContext) |

---

## Key Findings for Claudex

1. **PostToolUse cannot modify built-in tool output.** Only MCP tools support `updatedMCPToolOutput`. For Bash, FileRead, FileEdit, etc., the output is committed to messages BEFORE PostToolUse hooks run.

2. **PreToolUse can modify inputs of ANY tool** via `updatedInput`. The modified input reaches `tool.call()` but the model's `tool_use` block still shows original input.

3. **The field is `tool_response`** in PostToolUse payloads (not `tool_output`). CLAUDE.md project rules already document this correctly.

4. **Hooks run in parallel.** All matching hooks for an event fire simultaneously. Precedence rules resolve conflicts: deny > ask > allow.

5. **`allow` doesn't bypass settings.json deny rules.** This is a security invariant in `resolveHookPermissionDecision()`.

6. **Matcher system is tool-name + optional `if` sub-condition.** The `matcher` field matches the tool name (exact, pipe-separated, or regex). The `if` field uses `ToolName(pattern)` syntax for deeper matching.

7. **No tool-switching.** Cannot redirect execution to a different tool from PreToolUse. Only block or modify inputs.

8. **The model sees original tool_use + modified tool_result.** Discrepancies are possible but this is by design (prompt cache preservation).

9. **Internal callback hooks are invisible to users** but powerful — they can observe every tool call silently. This is how session file access analytics and attribution hooks work.

10. **`additionalContext` from PreToolUse** is injected as a `hook_additional_context` attachment message visible to the model. This is the primary way to inject guidance into the conversation via hooks.
