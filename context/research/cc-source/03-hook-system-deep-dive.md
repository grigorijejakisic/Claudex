# Claude Code Hook System — Deep Dive

**Source:** `claude-code-buildable/src/`
**Analyzed:** 2026-04-01
**Files covered:**
- `src/utils/hooks.ts` — main dispatch engine (~3200 lines)
- `src/utils/hooks/hookEvents.ts` — event emission system
- `src/utils/hooks/hooksSettings.ts` — hook config helpers
- `src/utils/hooks/hooksConfigManager.ts` — UI metadata + grouping
- `src/utils/hooks/sessionHooks.ts` — in-memory session-scoped hooks
- `src/utils/hooks/hookHelpers.ts` — shared helpers (structured output, arguments)
- `src/utils/hooks/execAgentHook.ts` — agent hook executor
- `src/utils/hooks/execHttpHook.ts` — HTTP hook executor
- `src/utils/hooks/execPromptHook.ts` — prompt hook executor
- `src/utils/hooks/AsyncHookRegistry.ts` — async hook tracking
- `src/utils/hooks/fileChangedWatcher.ts` — file watcher for FileChanged/CwdChanged
- `src/utils/hooks/postSamplingHooks.ts` — internal post-sampling hooks
- `src/utils/hooks/registerFrontmatterHooks.ts` — agent/skill hook registration
- `src/utils/hooks/registerSkillHooks.ts` — skill hook registration
- `src/schemas/hooks.ts` — hook command schemas
- `src/types/hooks.ts` — callback hook types
- `src/entrypoints/sdk/coreSchemas.ts` — all hook input/output Zod schemas
- `src/entrypoints/sdk/coreTypes.ts` — HOOK_EVENTS const array

---

## 1. All Hook Event Types

There are **27 distinct hook event types** as of the current source. Const array in `src/entrypoints/sdk/coreTypes.ts`:

```typescript
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const
```

The documentation typically mentions 6-7 hook types. The real count is 27.

---

## 2. Complete Payload Schemas For Every Hook Type

All input schemas are in `src/entrypoints/sdk/coreSchemas.ts`.

### Base Fields (present on EVERY hook payload)

```typescript
BaseHookInput = {
  session_id: string
  transcript_path: string       // path to the JSONL transcript
  cwd: string                   // current working directory
  permission_mode?: string      // e.g. 'default', 'bypassPermissions', etc.
  agent_id?: string             // present only when firing from a subagent
  agent_type?: string           // e.g. 'general-purpose', 'code-reviewer'
                                // present in subagent calls (with agent_id)
                                // OR on main-thread of --agent sessions (without agent_id)
}
```

**Key distinction:** `agent_id` is ONLY present from subagent context. On main thread of `--agent` sessions, only `agent_type` is present. Use `agent_id` presence (not `agent_type`) to distinguish subagent from main-thread calls.

### PreToolUse

```typescript
{
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: unknown           // the raw tool input object
  tool_use_id: string
  // + all base fields
}
```

Matcher field: `tool_name`

### PostToolUse

```typescript
{
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: unknown
  tool_response: unknown        // CORRECT field name (NOT tool_output)
  tool_use_id: string
  // + all base fields
}
```

**CRITICAL:** Field is `tool_response`, NOT `tool_output`. The CLAUDE.md already documents this.
Matcher field: `tool_name`

### PostToolUseFailure

```typescript
{
  hook_event_name: 'PostToolUseFailure'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  error: string
  is_interrupt?: boolean
  // + all base fields
}
```

Matcher field: `tool_name`

### PermissionRequest

```typescript
{
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: unknown
  permission_suggestions?: PermissionUpdate[]   // suggested permission rules
  // NOTE: no tool_use_id in the schema
  // + all base fields
}
```

Matcher field: `tool_name`

### PermissionDenied

```typescript
{
  hook_event_name: 'PermissionDenied'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  reason: string
  // + all base fields
}
```

Matcher field: `tool_name`

### Notification

```typescript
{
  hook_event_name: 'Notification'
  message: string
  title?: string
  notification_type: string     // 'permission_prompt' | 'idle_prompt' | 'auth_success' |
                                // 'elicitation_dialog' | 'elicitation_complete' | 'elicitation_response'
  // + all base fields
}
```

Matcher field: `notification_type`

### UserPromptSubmit

```typescript
{
  hook_event_name: 'UserPromptSubmit'
  prompt: string                // CORRECT field name (NOT user_prompt)
  // + all base fields
}
```

**CRITICAL:** Field is `prompt`, NOT `user_prompt`. The CLAUDE.md already documents this.
No matcher field — matches all.

### SessionStart

```typescript
{
  hook_event_name: 'SessionStart'
  source: 'startup' | 'resume' | 'clear' | 'compact'
  agent_type?: string           // redundant with base, but explicitly listed
  model?: string                // which model was started with
  // + all base fields
}
```

Matcher field: `source`

### SessionEnd

```typescript
{
  hook_event_name: 'SessionEnd'
  reason: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | 'bypass_permissions_disabled'
  // + all base fields
}
```

Matcher field: `reason`

### Stop

```typescript
{
  hook_event_name: 'Stop'
  stop_hook_active: boolean     // whether a Stop hook is already running (prevents recursion)
  last_assistant_message?: string  // text of last assistant message — avoids transcript parsing
  // + all base fields
}
```

**CRITICAL:** Field is `last_assistant_message`, NOT `stop_assistant_turn`. The CLAUDE.md already documents this.
No matcher field — matches all.

### StopFailure

```typescript
{
  hook_event_name: 'StopFailure'
  error: 'rate_limit' | 'authentication_failed' | 'billing_error' | 'invalid_request' |
         'server_error' | 'max_output_tokens' | 'unknown'
  error_details?: string
  last_assistant_message?: string
  // + all base fields
}
```

Matcher field: `error` (the error type string)
**Important:** This is fire-and-forget — CC ignores all hook output and exit codes.

### SubagentStart

```typescript
{
  hook_event_name: 'SubagentStart'
  agent_id: string
  agent_type: string
  // + all base fields
}
```

Matcher field: `agent_type`

### SubagentStop

```typescript
{
  hook_event_name: 'SubagentStop'
  stop_hook_active: boolean
  agent_id: string
  agent_transcript_path: string
  agent_type: string
  last_assistant_message?: string
  // + all base fields
}
```

Matcher field: `agent_type`

### PreCompact

```typescript
{
  hook_event_name: 'PreCompact'
  trigger: 'manual' | 'auto'
  custom_instructions: string | null   // existing compact instructions if any
  // + all base fields
}
```

Matcher field: `trigger`

### PostCompact

```typescript
{
  hook_event_name: 'PostCompact'
  trigger: 'manual' | 'auto'
  compact_summary: string       // the summary produced by compaction
  // + all base fields
}
```

Matcher field: `trigger`

### Setup

```typescript
{
  hook_event_name: 'Setup'
  trigger: 'init' | 'maintenance'
  // + all base fields
}
```

Matcher field: `trigger`

### TeammateIdle

```typescript
{
  hook_event_name: 'TeammateIdle'
  teammate_name: string
  team_name: string
  // + all base fields
}
```

No matcher field — matches all.

### TaskCreated

```typescript
{
  hook_event_name: 'TaskCreated'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
  // + all base fields
}
```

No matcher field — matches all.

### TaskCompleted

```typescript
{
  hook_event_name: 'TaskCompleted'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
  // + all base fields
}
```

No matcher field — matches all.

### Elicitation

```typescript
{
  hook_event_name: 'Elicitation'
  mcp_server_name: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
  // + all base fields
}
```

Matcher field: `mcp_server_name`

### ElicitationResult

```typescript
{
  hook_event_name: 'ElicitationResult'
  mcp_server_name: string
  elicitation_id?: string
  mode?: 'form' | 'url'
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  // + all base fields
}
```

Matcher field: `mcp_server_name`

### ConfigChange

```typescript
{
  hook_event_name: 'ConfigChange'
  source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills'
  file_path?: string
  // + all base fields
}
```

Matcher field: `source`

### InstructionsLoaded

```typescript
{
  hook_event_name: 'InstructionsLoaded'
  file_path: string
  memory_type: 'User' | 'Project' | 'Local' | 'Managed'
  load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact'
  globs?: string[]              // paths: frontmatter patterns that matched
  trigger_file_path?: string    // file Claude touched that caused the load
  parent_file_path?: string     // file that @-included this one
  // + all base fields
}
```

Matcher field: `load_reason`
**Note:** Observability-only, no blocking support.

### WorktreeCreate

```typescript
{
  hook_event_name: 'WorktreeCreate'
  name: string                  // suggested worktree slug
  // + all base fields
}
```

No matcher field.

### WorktreeRemove

```typescript
{
  hook_event_name: 'WorktreeRemove'
  worktree_path: string         // absolute path to the worktree being removed
  // + all base fields
}
```

No matcher field.

### CwdChanged

```typescript
{
  hook_event_name: 'CwdChanged'
  old_cwd: string
  new_cwd: string
  // + all base fields
}
```

No matcher field. Also sets `CLAUDE_ENV_FILE` env var.

### FileChanged

```typescript
{
  hook_event_name: 'FileChanged'
  file_path: string
  event: 'change' | 'add' | 'unlink'
  // + all base fields
}
```

Matcher field: filename (basename of `file_path`), pipe-separated list (e.g. `.envrc|.env`).
Also sets `CLAUDE_ENV_FILE` env var.

---

## 3. Return Value Schema (Full)

The hook output schema is a discriminated union of two types.

### Sync Response (most hooks)

```typescript
SyncHookJSONOutput = {
  // Global fields
  continue?: boolean          // false = preventContinuation (stop conversation)
  suppressOutput?: boolean    // hide stdout from transcript view
  stopReason?: string         // message shown when continue=false
  decision?: 'approve' | 'block'   // legacy permission decision
  reason?: string             // explanation for decision/block
  systemMessage?: string      // warning message shown to user
  
  // Per-event specific output
  hookSpecificOutput?: (one of the schemas below)
}
```

### Async Response (fire-and-forget background execution)

```typescript
AsyncHookJSONOutput = {
  async: true
  asyncTimeout?: number       // milliseconds before async hook is killed
}
```

When a hook outputs `{"async": true}` as its FIRST LINE of stdout, it is backgrounded immediately and CC continues without waiting. CC monitors for the hook's completion and re-injects its output when it finishes (via `AsyncHookRegistry`).

### hookSpecificOutput Per Event

**PreToolUse:**
```typescript
{
  hookEventName: 'PreToolUse'
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>   // MODIFY TOOL INPUT
  additionalContext?: string               // inject context to Claude
}
```

**UserPromptSubmit:**
```typescript
{
  hookEventName: 'UserPromptSubmit'
  additionalContext?: string   // inject context to Claude
}
```

**SessionStart:**
```typescript
{
  hookEventName: 'SessionStart'
  additionalContext?: string   // inject context to Claude
  initialUserMessage?: string  // inject a first user message
  watchPaths?: string[]        // register paths with FileChanged watcher
}
```

**Setup:**
```typescript
{
  hookEventName: 'Setup'
  additionalContext?: string
}
```

**SubagentStart:**
```typescript
{
  hookEventName: 'SubagentStart'
  additionalContext?: string   // inject context to the subagent
}
```

**PostToolUse:**
```typescript
{
  hookEventName: 'PostToolUse'
  additionalContext?: string
  updatedMCPToolOutput?: unknown   // REPLACE MCP tool output entirely
}
```

**PostToolUseFailure:**
```typescript
{
  hookEventName: 'PostToolUseFailure'
  additionalContext?: string
}
```

**PermissionDenied:**
```typescript
{
  hookEventName: 'PermissionDenied'
  retry?: boolean              // tell Claude it may retry the denied tool call
}
```

**Notification:**
```typescript
{
  hookEventName: 'Notification'
  additionalContext?: string
}
```

**PermissionRequest:**
```typescript
{
  hookEventName: 'PermissionRequest'
  decision: (
    | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
    | { behavior: 'deny'; message?: string; interrupt?: boolean }
  )
}
```

**Elicitation:**
```typescript
{
  hookEventName: 'Elicitation'
  action?: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}
```

**ElicitationResult:**
```typescript
{
  hookEventName: 'ElicitationResult'
  action?: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}
```

**CwdChanged:**
```typescript
{
  hookEventName: 'CwdChanged'
  watchPaths?: string[]        // dynamically update file watch list
}
```

**FileChanged:**
```typescript
{
  hookEventName: 'FileChanged'
  watchPaths?: string[]        // dynamically update file watch list
}
```

**WorktreeCreate:**
```typescript
{
  hookEventName: 'WorktreeCreate'
  worktreePath: string         // absolute path to created worktree
}
```
Note: Command hooks write path to stdout instead of returning JSON.

---

## 4. Exit Code Semantics Per Event

Exit codes determine what happens with stderr/stdout after the hook completes.

| Exit Code | PreToolUse | PostToolUse | UserPromptSubmit | Stop | SessionStart | StopFailure |
|-----------|-----------|-------------|-----------------|------|--------------|-------------|
| 0 | stdout/stderr not shown | stdout shown in transcript (ctrl+O) | stdout shown to Claude | stdout/stderr not shown | stdout shown to Claude | ignored |
| 2 | show stderr to Claude, block tool | show stderr to Claude immediately | block processing, erase prompt, show stderr to user | show stderr to Claude, continue conversation | ignored | ignored |
| other | show stderr to user only | show stderr to user only | show stderr to user only | show stderr to user only | show stderr to user only | ignored |

Additional exit code behaviors by event type:

- **PostToolUseFailure**: exit 0 = transcript only, exit 2 = show to Claude, other = user only
- **PermissionDenied**: exit 0 = transcript only, other = user only
- **Notification**: exit 0 = nothing shown, other = user only  
- **SubagentStop**: exit 0 = nothing shown, exit 2 = show to subagent and continue, other = user only
- **PreCompact**: exit 0 = stdout appended as custom compact instructions, exit 2 = block compaction, other = user only
- **PostCompact**: exit 0 = stdout shown to user, other = user only
- **SessionEnd**: exit 0 = success, other = user only
- **PermissionRequest**: exit 0 = use hook decision if provided, other = user only
- **Setup**: exit 0 = stdout shown to Claude, other = user only
- **TeammateIdle**: exit 0 = nothing, exit 2 = show to teammate and prevent idle, other = user only
- **TaskCreated/TaskCompleted**: exit 0 = nothing, exit 2 = show to model and prevent action, other = user only
- **Elicitation**: exit 0 = use response, exit 2 = deny elicitation, other = user only
- **ElicitationResult**: exit 0 = use response, exit 2 = block (action becomes decline), other = user only
- **ConfigChange**: exit 0 = allow, exit 2 = block change from session, other = user only
- **InstructionsLoaded**: exit 0 = success, other = user only (observability only, no blocking)
- **WorktreeCreate**: exit 0 = success, other = failure
- **WorktreeRemove**: exit 0 = success, other = user only
- **CwdChanged/FileChanged**: exit 0 = success, other = user only

---

## 5. PreToolUse — Full Power

PreToolUse is the most powerful hook. It can:

### Block Tool Execution

Exit code 2 → stderr goes to Claude as a system message, Claude can retry or abandon.

JSON output method:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Security policy violation: cannot write to /etc"
  }
}
```

Or legacy decision field:
```json
{ "decision": "block", "reason": "Not allowed" }
```

### Modify Tool Input (updatedInput)

This is a major undocumented capability. The hook can return a modified version of the tool's input:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "updatedInput": {
      "command": "git status",   // modified command
      "timeout": 30
    }
  }
}
```

The `updatedInput` is applied: CC uses the hook's version of the input instead of Claude's original. Source:
```typescript
// src/utils/hooks.ts line 618-621
if (json.hookSpecificOutput.updatedInput) {
  result.updatedInput = json.hookSpecificOutput.updatedInput
}
```

### Control Permission Dialog

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"  // skip dialog, auto-approve
  }
}
```
OR `"ask"` to force the dialog even for normally auto-approved tools.

### Inject Context

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "This file is under active development by another engineer."
  }
}
```

### if-Condition Filtering

Hooks can avoid spawning for non-matching calls using permission rule syntax:
```json
{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "command": "check-git-safety.sh",
    "if": "Bash(git push*)"
  }]
}
```
The `if` field uses the same syntax as permission rules. Only fires for `git push` commands.

---

## 6. PostToolUse — Full Power

### Inject Context to Claude

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Note: this file is read-only in production"
  }
}
```

### Replace MCP Tool Output

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedMCPToolOutput": { "result": "sanitized output" }
  }
}
```

Only works for MCP tools (not built-in tools). Replaces what Claude sees as the tool result.

### Block with Feedback

Exit code 2 → stderr injected as system message to Claude immediately (mid-conversation, not waiting for next Stop).

---

## 7. SessionStart — Full Power

The most powerful initialization hook. Returns via `hookSpecificOutput`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "You are working in a regulated environment.",
    "initialUserMessage": "Please start by reading CLAUDE.md and the current git status.",
    "watchPaths": [
      "/absolute/path/to/.env",
      "/absolute/path/to/config.json"
    ]
  }
}
```

- **`additionalContext`**: Injected into Claude's context at session start. This is the primary mechanism Claudex uses.
- **`initialUserMessage`**: Automatically submits a first user message to Claude. Powerful — triggers a full response cycle.
- **`watchPaths`**: Registers absolute paths with the FileChanged watcher. Any changes to these files will trigger FileChanged hooks.

Blocking is ignored for SessionStart — exit code 2 is treated same as 0.

HTTP hooks are NOT supported for SessionStart or Setup (deadlock risk in sandbox mode).

Matcher: `source` value ('startup' | 'resume' | 'clear' | 'compact').

---

## 8. Stop Hook — Full Power

Fires right before Claude concludes its response. Can prevent the response from ending.

### Continue Conversation (exit code 2)

Stderr is shown to Claude as: `"Stop hook feedback:\n<stderr>"`. Claude then continues the conversation. This is the "continue" mechanism for agent-loop enforcement.

### preventContinuation (via JSON)

```json
{ "continue": false, "stopReason": "Verification failed: tests did not pass" }
```

Stops the conversation with a custom message shown to the user.

### stop_hook_active Field

The input includes `stop_hook_active: boolean` — indicates whether a Stop hook is already running for this session. Prevents recursion if Stop hook itself triggers another Stop.

### last_assistant_message

Convenience field: the text content of the last assistant message. Avoids needing to parse the transcript file to know what Claude just said.

---

## 9. SubagentStop — Full Power

Fires right before a subagent (Agent tool call) concludes. Same semantics as Stop but for subagents.

Extra fields:
- `agent_id`: the specific subagent ID
- `agent_transcript_path`: path to the subagent's transcript file
- `agent_type`: agent type name

Important note in `registerFrontmatterHooks.ts`: When hooks are defined in agent frontmatter with `Stop` event, they are automatically converted to `SubagentStop` at registration time (since subagents trigger SubagentStop, not Stop).

---

## 10. How Hooks Are Dispatched

### Parallel Execution

All matching hooks for an event run **in parallel** (`Promise.all`-style via async generator `all()`). Source: `hooks.ts` line 2142-2144:
```typescript
const hookPromises = matchingHooks.map(async function* (...) {...})
// ...
for await (const result of all(hookPromises)) {
```

Results are aggregated as they arrive. Blocking errors from any hook immediately block the operation.

### Deduplication

Hooks are deduplicated before execution. Same command + shell + if-condition in multiple settings files collapses to one. Dedup is namespaced by pluginRoot/skillRoot so the same command template in two different plugins remains distinct.

### Hook Sources (priority order)

1. **Snapshot hooks** — from settings files at session start (user/project/local)
2. **Registered hooks** — SDK callbacks and plugin native hooks (via `registerHooks`)
3. **Session function hooks** — in-memory callbacks, scoped to current session/agent

### Matcher Matching

The matcher field supports:
- Empty string / `*` = match all
- Simple string `Write` = exact match
- Pipe-separated `Write|Edit` = multiple exact matches
- Regex patterns `^Write.*` = full regex

For FileChanged, the matcher is filenames (basenames), pipe-separated.

### if-Condition Filtering

Hooks with `if` fields are filtered before execution using permission rule syntax. The filter evaluates against `tool_name` + `tool_input` for PreToolUse, PostToolUse, PostToolUseFailure, and PermissionRequest events only. The `if` field is ignored for non-tool events.

### Trust Requirement

ALL hooks require workspace trust in interactive mode. This check happens at `executeHooks()` entry. Without trust, all hooks are silently skipped. In non-interactive (SDK) mode, trust is implicit.

### CLAUDE_CODE_SIMPLE Environment

If `process.env.CLAUDE_CODE_SIMPLE` is truthy, ALL hooks are skipped.

---

## 11. Timeouts

```typescript
const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000   // 10 minutes (default for most hooks)
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500         // 1.5 seconds (tight budget for shutdown)
```

SessionEnd timeout is overridable via `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` env var.

Per-hook timeout overridable via `timeout` field in settings (in seconds):
```json
{ "type": "command", "command": "long-script.sh", "timeout": 300 }
```

Agent hooks: default 60 seconds.
Prompt hooks: default 30 seconds.
HTTP hooks: default 10 minutes.

---

## 12. Async Hook Protocol

Hooks can signal they want to run in the background by outputting `{"async": true}` as the FIRST LINE of stdout. CC immediately backgrounds the process and continues.

Configuration-based async (set in settings):
```json
{ "type": "command", "command": "background-script.sh", "async": true }
```

Runtime-detection async (hook outputs it):
```json
{"async": true, "asyncTimeout": 15000}
```

`asyncTimeout` defaults to 15 seconds.

There's also `asyncRewake`: if set to true on a hook, it runs in the background and if it exits with code 2, it wakes the model via a queued notification (task-notification mode). Useful for monitoring hooks.

---

## 13. Hook Types — 6 Distinct Execution Mechanisms

### 1. command (shell)
Spawns a shell process. Input JSON on stdin. Shell: bash (default) or powershell.

```json
{
  "type": "command",
  "command": "my-script.sh",
  "shell": "bash",
  "timeout": 60,
  "if": "Bash(git *)",
  "async": false,
  "asyncRewake": false,
  "statusMessage": "Checking git safety...",
  "once": false
}
```

### 2. prompt (LLM evaluation)
Calls the model with a prompt. Returns `{"ok": true/false}`. Used for condition checks.

```json
{
  "type": "prompt",
  "prompt": "Verify that $ARGUMENTS contains only safe git commands.",
  "timeout": 30,
  "model": "claude-haiku-4-5",
  "if": "Bash(git *)",
  "statusMessage": "Verifying...",
  "once": false
}
```

`$ARGUMENTS` is replaced with the JSON input. Also supports indexed args: `$ARGUMENTS[0]`, `$0`, `$1`.

### 3. agent (multi-turn LLM agent)
Spawns a sub-agent that can use tools to verify conditions. Returns `{"ok": true/false, "reason": "..."}` via SyntheticOutputTool.

```json
{
  "type": "agent",
  "prompt": "Verify that unit tests pass. Run the tests if needed.",
  "timeout": 60,
  "model": "claude-sonnet-4-6",
  "statusMessage": "Running verification agent...",
  "once": false
}
```

Agent hooks run a full multi-turn query with access to all session tools (except agent-disallowed tools). Max 50 turns. Must call SyntheticOutputTool to return result.

### 4. http
POSTs JSON to a URL. Must return valid JSON response.

```json
{
  "type": "http",
  "url": "https://my-server.example.com/hook",
  "headers": { "Authorization": "Bearer $MY_TOKEN" },
  "allowedEnvVars": ["MY_TOKEN"],
  "timeout": 60,
  "statusMessage": "Notifying server...",
  "once": false
}
```

Header values support env var interpolation (`$VAR` or `${VAR}`), but only for vars explicitly listed in `allowedEnvVars`.

HTTP hooks are NOT supported for SessionStart or Setup (sandbox deadlock risk).

SSRF guard: resolves IPs and blocks private/link-local ranges (allows loopback). Skipped when proxy is active.

URL allowlist: `settings.allowedHttpHookUrls` (admin policy). Undefined = no restriction, `[]` = block all.

### 5. callback (internal SDK)
TypeScript function registered programmatically. Not configurable via settings.json. Returns `HookJSONOutput`.

```typescript
type HookCallback = {
  type: 'callback'
  callback: (input: HookInput, toolUseID: string | null, abort: AbortSignal | undefined,
             hookIndex?: number, context?: HookCallbackContext) => Promise<HookJSONOutput>
  timeout?: number
  internal?: boolean    // excludes from analytics metrics
}
```

### 6. function (in-memory session)
TypeScript callback registered per-session. Used internally for structured output enforcement.

```typescript
type FunctionHook = {
  type: 'function'
  id?: string
  timeout?: number
  callback: (messages: Message[], signal?: AbortSignal) => boolean | Promise<boolean>
  errorMessage: string
  statusMessage?: string
}
```

Returns true (pass) or false (block). If false, `errorMessage` is shown to Claude.

---

## 14. Internal Hooks Not Exposed to Users

### postSamplingHooks
In `src/utils/hooks/postSamplingHooks.ts` — an entirely separate internal hook registry that fires after model sampling. NOT configurable via settings.json, only registered programmatically via `registerPostSamplingHook()`. Receives full message history and system prompt. Used internally for things like attribution tracking.

### callback hooks
`HookCallback` type — registered via `registerHooks()` (SDK API / internal). These include:
- `sessionFileAccessHooks` — tracks file access for attribution
- `attributionHooks` — commit attribution tracking

These have `internal: true` set and are excluded from analytics metrics.

### Structured Output Enforcement Hook
`registerStructuredOutputEnforcement()` in `hookHelpers.ts` — registers a function hook on `Stop` event for agent/verification sub-sessions. Forces the agent to call `SyntheticOutputTool` before stopping. This is how agent hooks and `ask.tsx` enforce structured output.

---

## 15. Environment Variables Available to Hook Commands

All hook commands receive these env vars:

```bash
# Always present
CLAUDE_PROJECT_DIR=/absolute/path/to/project/root  # NOT worktree path, always the real root

# Present for plugins and skills
CLAUDE_PLUGIN_ROOT=/path/to/plugin-or-skill/root
CLAUDE_PLUGIN_DATA=/path/to/plugin/data-dir  # for plugins with pluginId

# Present for SessionStart, Setup, CwdChanged, FileChanged hooks (bash only, not PowerShell)
CLAUDE_ENV_FILE=/path/to/env-file.sh  # write bash exports here to set env for BashTool

# Plugin options (from plugin manifest userConfig)
CLAUDE_PLUGIN_OPTION_FOO=value
CLAUDE_PLUGIN_OPTION_BAR=value

# Plus all standard process.env vars via subprocessEnv()
```

Writing to `CLAUDE_ENV_FILE`: the hook writes bash export statements (e.g., `export FOO=bar`). CC reads these and applies them to subsequent BashTool commands in the session. This is how hooks can inject environment variables that persist across tool calls.

---

## 16. Hook Configuration Schema (settings.json)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "check-file-safety.sh",
            "timeout": 30,
            "if": "Write(/etc/*)",
            "shell": "bash",
            "statusMessage": "Checking file safety...",
            "async": false,
            "asyncRewake": false,
            "once": false
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "agent",
            "prompt": "Verify $ARGUMENTS meets quality standards",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

Settings locations:
- `~/.claude/settings.json` — user settings
- `.claude/settings.json` — project settings  
- `.claude/settings.local.json` — local settings (gitignored)
- Policy settings (managed/enterprise)

Hook sources in priority order: policy > user > project > local > plugin > session.

### Policy Controls

```json
{
  "allowManagedHooksOnly": true   // blocks user/project/local hooks, only policy/managed run
  "disableAllHooks": true         // disables ALL hooks including managed
  "allowedHttpHookUrls": ["https://*.example.com/*"]  // URL allowlist for http hooks
  "httpHookAllowedEnvVars": ["MY_TOKEN"]  // global allowlist for env var interpolation
}
```

---

## 17. The Matcher Field — Complete Semantics

The `matcher` field in hook configuration is matched against an event-specific field:

| Event | Matched Against | Match Semantics |
|-------|----------------|-----------------|
| PreToolUse | `tool_name` | tool name (normalized) |
| PostToolUse | `tool_name` | tool name |
| PostToolUseFailure | `tool_name` | tool name |
| PermissionRequest | `tool_name` | tool name |
| PermissionDenied | `tool_name` | tool name |
| Notification | `notification_type` | notification type string |
| SessionStart | `source` | 'startup'/'resume'/'clear'/'compact' |
| Setup | `trigger` | 'init'/'maintenance' |
| PreCompact | `trigger` | 'manual'/'auto' |
| PostCompact | `trigger` | 'manual'/'auto' |
| SessionEnd | `reason` | exit reason |
| StopFailure | `error` | error type |
| SubagentStart | `agent_type` | agent type name |
| SubagentStop | `agent_type` | agent type name |
| Elicitation | `mcp_server_name` | MCP server name |
| ElicitationResult | `mcp_server_name` | MCP server name |
| ConfigChange | `source` | settings source |
| InstructionsLoaded | `load_reason` | load reason |
| FileChanged | `basename(file_path)` | filename only |
| Stop | N/A | no matcher (always fires) |
| UserPromptSubmit | N/A | no matcher |
| TeammateIdle | N/A | no matcher |
| TaskCreated | N/A | no matcher |
| TaskCompleted | N/A | no matcher |
| CwdChanged | N/A | no matcher |
| WorktreeCreate | N/A | no matcher |
| WorktreeRemove | N/A | no matcher |

Matcher patterns:
- Empty/omitted = match all
- `*` = match all
- `Write` = exact match (alphanumeric/underscore)
- `Write|Edit|Bash` = pipe-separated OR
- Anything else = regex pattern (full JS regex)

---

## 18. Hook Prompt System — $ARGUMENTS Substitution

For `prompt` and `agent` type hooks, the hook input JSON is substituted into the prompt:

- `$ARGUMENTS` — replaced with full JSON input
- `$ARGUMENTS[0]`, `$ARGUMENTS[1]` — indexed access into array inputs
- `$0`, `$1`, `$2` — shorthand for `$ARGUMENTS[0]`, etc.

Source: `src/utils/hooks/hookHelpers.ts:addArgumentsToPrompt()` which calls `substituteArguments()`.

---

## 19. The Interactive Prompt Protocol (Undocumented)

Command hooks can request interactive input from the user during execution. The hook writes a JSON line to stdout:

```json
{"prompt": "request-id-123", "message": "Which environment?", "options": [
  {"key": "prod", "label": "Production"},
  {"key": "staging", "label": "Staging"}
]}
```

CC displays this as a dialog to the user. The user's selection is written back to the hook's stdin as:
```json
{"prompt_response": "request-id-123", "selected": "prod"}
```

This allows hooks to interactively query users mid-execution. The hook's stdin stays open for the duration. Prompt request lines are stripped from the final stdout so they don't appear in hook output processing.

Source: `hooks.ts` lines 1062-1105.

---

## 20. Error Handling

### Hook Failure (crash/timeout)

- Command hooks that crash: non-blocking error, stderr shown to user
- Timeout: hook killed, non-blocking error
- Aborted (user cancel): `hook_cancelled` attachment, no error shown

### StopFailure

Fire-and-forget. Output and exit codes completely ignored. Useful for notifications when API errors occur.

### JSON Validation Failure

If hook outputs JSON that starts with `{` but fails Zod validation, CC logs the error with full schema hint and treats it as non-blocking (shows the validation error to the user or Claude depending on exit code).

### Plugin Directory Missing

Pre-checks whether plugin directory exists before spawning. If missing, throws immediately (avoids exit code 2 from `python3 <missing.py>` being misinterpreted as intentional block).

---

## 21. Claudex-Specific Findings

### What Claudex Already Uses Correctly

The current Claudex hook implementation uses:
- `SessionStart` with `hookSpecificOutput.additionalContext` — correct
- `hookSpecificOutput.watchPaths` for CLAUDE.md change detection — correct
- `PreToolUse` for subagent context injection — correct

### High-Value Capabilities Not Yet Used

1. **`initialUserMessage` on SessionStart**: Can inject an automatic first prompt to Claude. For Claudex: could auto-trigger "load your memory and continue from where you left off."

2. **`updatedInput` on PreToolUse**: Can modify any tool input before execution. Potential: intercept Bash tool, add safety wrappers, log commands to DB.

3. **`updatedMCPToolOutput` on PostToolUse**: Can replace MCP tool output. Not relevant since Claudex IS the MCP server, but could be used to filter/transform outputs from other MCP servers.

4. **`PermissionRequest` hook**: Can auto-approve or auto-deny permissions programmatically. No user dialog needed. Claudex could register rules that auto-allow known-safe operations.

5. **`asyncRewake` hooks**: Background monitoring hooks that can wake Claude via notifications. Could be used for async observation tasks.

6. **`InstructionsLoaded` hook**: Fires whenever CLAUDE.md loads. Could log which context files are being used.

7. **`ConfigChange` hook**: Fires when settings files change. Could detect when hooks are reconfigured.

8. **`SubagentStart` with `additionalContext`**: Injects context into subagents. The PreToolUse hook Claudex already has achieves this at tool-call time, but SubagentStart fires earlier (before the first prompt).

9. **`CLAUDE_ENV_FILE`**: Session env injection. Hooks can set env vars that persist to BashTool calls. Claudex could inject env vars from DB.

10. **Interactive Prompt Protocol**: Hooks can query the user mid-execution. Could be used for confirmation dialogs in Claudex workflows.

### Field Name Truth Table (vs. what was assumed)

| Hook | Correct Field | Wrong Assumption |
|------|--------------|-----------------|
| PostToolUse | `tool_response` | `tool_output` |
| UserPromptSubmit | `prompt` | `user_prompt` |
| Stop | `last_assistant_message` | `stop_assistant_turn` |

These are documented in CLAUDE.md already.

---

## 22. The `once` Flag (Undocumented)

All hook command types (command, prompt, agent, http) support `once: true`. When a hook with `once: true` succeeds, it is automatically removed from the session hook registry. This is a per-session mechanism for one-shot initialization hooks.

Source: `src/utils/hooks/registerSkillHooks.ts` — skill hooks use `onHookSuccess` callback to call `removeSessionHook()` when `once: true`.

---

## 23. FileChanged Watcher Integration

The `FileChanged` hook uses `chokidar` (persistent file watcher). Configuration:
- Static paths: from `FileChanged` matcher fields (pipe-separated filenames resolved relative to cwd)
- Dynamic paths: returned by `hookSpecificOutput.watchPaths` from `CwdChanged` or `FileChanged` hooks
- Wait-for-write: 500ms stability threshold, 200ms poll interval

When cwd changes, the watcher is restarted and re-resolves all matcher paths relative to the new cwd. Env files are cleared. `CwdChanged` hook fires, and its `watchPaths` output updates the dynamic watch list.

---

## 24. Session-Scoped Hooks (Runtime Registration)

Hooks can be registered at runtime (in-memory, not settings.json) scoped to a session or agent:

```typescript
addSessionHook(setAppState, sessionId, event, matcher, hookCommand, onHookSuccess, skillRoot)
addFunctionHook(setAppState, sessionId, event, matcher, callback, errorMessage, options)
removeFunctionHook(setAppState, sessionId, event, hookId)
removeSessionHook(setAppState, sessionId, event, hook)
clearSessionHooks(setAppState, sessionId)  // called when session/agent ends
```

Session hooks are stored in a `Map<string, SessionStore>` (not reactive — mutations don't trigger store listeners). Function hooks are separate from regular hooks because they can't be serialized.

These are used by:
- Skills (frontmatter hooks): `registerSkillHooks()`
- Agents (frontmatter hooks): `registerFrontmatterHooks()`
- Verification agents: `registerStructuredOutputEnforcement()`

---

## 25. Summary of What Hooks Can Modify

| Hook | Can Block | Can Modify | Can Inject Context |
|------|-----------|-----------|-------------------|
| PreToolUse | YES (exit 2 or deny) | Tool input (`updatedInput`) | Yes (`additionalContext`) |
| PostToolUse | YES (exit 2) | MCP tool output (`updatedMCPToolOutput`) | Yes (`additionalContext`) |
| UserPromptSubmit | YES (exit 2, erases prompt) | — | Yes (`additionalContext`) |
| Stop | YES (exit 2 = continue conversation) | — | — |
| SessionStart | NO (blocking ignored) | — | Yes (`additionalContext`, `initialUserMessage`) |
| SubagentStop | YES (exit 2 = continue subagent) | — | — |
| PermissionRequest | YES (deny) | Tool input (`updatedInput` on allow) | — |
| PermissionDenied | NO | — | Yes (via `retry` flag) |
| PreCompact | YES (exit 2) | Compact instructions (stdout appended) | — |
| Elicitation | YES (decline) | Elicitation response | — |
| ElicitationResult | YES (action becomes decline) | Elicitation result | — |
| ConfigChange | YES (exit 2) | — | — |
| TeammateIdle | YES (exit 2 = prevent idle) | — | — |
| TaskCreated | YES (exit 2) | — | — |
| TaskCompleted | YES (exit 2) | — | — |
| StopFailure | NO (fire-and-forget) | — | — |
| InstructionsLoaded | NO | — | — |
| CwdChanged | NO | Watch paths | — |
| FileChanged | NO | Watch paths | — |
| WorktreeCreate | YES (failure) | Worktree path | — |
