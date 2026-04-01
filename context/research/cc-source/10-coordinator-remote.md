# CC Source Research: Coordinator Mode and Remote Mode

**Date:** 2026-04-01
**Source:** `claude-code-buildable/src/`

---

## 1. What Is Coordinator Mode?

Coordinator mode is a **feature-gated execution mode** where Claude Code operates as an orchestrator ("coordinator") that delegates all actual work to spawned subagents ("workers") rather than directly executing tools itself.

### Activation

```typescript
// src/coordinator/coordinatorMode.ts:36-41
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

**Activation mechanism:** `CLAUDE_CODE_COORDINATOR_MODE=1` environment variable, gated on a compile-time bundle feature flag `COORDINATOR_MODE`. This flag controls dead-code elimination — the entire coordinator module is stripped from builds where it is disabled.

**Mode persistence:** When a session is saved, the coordinator/normal mode is stored. On resume, `matchSessionMode()` (line 49-78) flips the env var to restore the correct mode, emitting a `tengu_coordinator_mode_switched` analytics event.

---

## 2. Topology: Hub-Spoke, Not Mesh

CC's coordination is a **strict hub-spoke topology**:

```
[User]  ←→  [Coordinator (main thread)]
                    ↓           ↓
             [Worker A]    [Worker B]
```

- Workers **cannot spawn other workers** (via `ALL_AGENT_DISALLOWED_TOOLS` which blocks `AgentTool` for non-ant users; `src/constants/tools.ts:36-46`).
- Workers **cannot message each other directly** — they can only report back to the coordinator via `<task-notification>` XML.
- The coordinator is the **only agent with access to coordinator tools** (`Agent`, `SendMessage`, `TaskStop`, `SyntheticOutput`).
- There is no peer-to-peer mesh between workers in coordinator mode.

**Exception:** Agent Swarms (a separate, unrelated feature behind `ENABLE_AGENT_SWARMS`) does support a flat team topology with file-based mailboxes. This is distinct from coordinator mode.

---

## 3. Coordinator Tool Set vs. Worker Tool Set

### Coordinator tools (restricted)

```typescript
// src/constants/tools.ts:107-112
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,       // = 'Agent' — spawn workers
  TASK_STOP_TOOL_NAME,   // kill a running worker
  SEND_MESSAGE_TOOL_NAME, // continue an existing worker
  SYNTHETIC_OUTPUT_TOOL_NAME, // structured output
])
```

Additionally, PR activity subscription MCP tools (`subscribe_pr_activity`, `unsubscribe_pr_activity`) are always passed through since they are orchestration primitives (`src/utils/toolPool.ts:11-18`).

The coordinator's tool pool is filtered at two points:
- **REPL path:** `mergeAndFilterTools()` in `src/utils/toolPool.ts:55-79`
- **Headless path:** `applyCoordinatorToolFilter()` called in `src/main.tsx:1885-1890`

### Worker tools (async agents)

```typescript
// src/constants/tools.ts:55-71
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])
```

The `CLAUDE_CODE_SIMPLE=1` env var narrows this to just `[Bash, Read, Edit]`.

Worker tool sets are communicated to the coordinator via a `workerToolsContext` user context key injected by `getCoordinatorUserContext()`:

```typescript
// src/coordinator/coordinatorMode.ts:97-98
let content = `Workers spawned via the ${AGENT_TOOL_NAME} tool have access to these tools: ${workerTools}`
```

---

## 4. Coordinator System Prompt

`getCoordinatorSystemPrompt()` (`src/coordinator/coordinatorMode.ts:111-368`) injects a detailed orchestration prompt. Key content:

- **Identity:** "You are a coordinator. Your job is to direct workers, synthesize results, communicate with the user."
- **Tool descriptions:** Explains `Agent`, `SendMessage`, `TaskStop`, and optional PR subscription tools.
- **Task notification format:** Documents the `<task-notification>` XML format workers report back through.
- **Concurrency rules:** Read-only tasks parallelize freely; write-heavy tasks run one at a time per file set.
- **Worker prompt writing rules:** "Workers can't see your conversation. Every prompt must be self-contained."
- **Continue vs. spawn decision matrix:** Based on context overlap between the worker's prior run and the next task.
- **Synthesis requirement:** Coordinator must read findings and synthesize specific file paths and line numbers into follow-up prompts, never write "based on your findings."

---

## 5. How Agents Are Spawned

Spawning goes through `AgentTool.tsx` calling `runAgent.ts`. The coordinator triggers the **async path** for all spawns:

```typescript
// src/tools/AgentTool/AgentTool.tsx:567
const shouldRunAsync = (run_in_background === true || selectedAgent.background === true
  || isCoordinator || forceAsync || assistantForceAsync || ...) && !isBackgroundTasksDisabled
```

`isCoordinator` forces every `Agent` call async in coordinator mode, regardless of the `run_in_background` parameter.

### Spawn flow

1. **AgentTool.tsx** resolves the agent definition, validates MCP requirements, determines isolation mode.
2. **Worktree isolation** (optional): `createAgentWorktree()` creates a temporary git worktree. The worker gets its own isolated copy of the repo.
3. **Remote isolation** (ant-internal only, `isolation: "remote"`): `teleportToRemote()` bundles the repo as a git bundle and creates a CCR (Cloud Compute Resource) session. Returns immediately as `remote_launched`.
4. **runAgent.ts**: Assembles the agent's system prompt, tool pool, abort controller (new, unlinked for async), and executes via `query()`.
5. **SubagentStart hooks** fire before the agent's first query turn (`runAgent.ts:530-553`).
6. **Task registration**: The agent is registered as a `LocalAgentTask` with a unique `agentId` in AppState.

### Agent ID and addressing

```typescript
// src/tools/AgentTool/AgentTool.tsx: createAgentId() call
// Workers are identified by agentId (UUID-based format)
// Names are optional: Agent({ name: "my-worker", ... })
// Named workers are stored in appState.agentNameRegistry
```

The `agentId` returned from `Agent()` is used as the `to` parameter in `SendMessage()` to continue the worker.

---

## 6. How Workers Report Back: task-notification XML

Workers do **not** call any coordinator API. They simply finish execution. The `enqueueAgentNotification()` function formats and enqueues the result as a user-role message delivered to the coordinator's next turn:

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx:252-257
const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>${resultSection}${usageSection}${worktreeSection}
</${TASK_NOTIFICATION_TAG}>`;
enqueuePendingNotification({ value: message, mode: 'task-notification' });
```

Full format:
```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <tool-use-id>{toolUseId}</tool-use-id>
  <output-file>/path/to/output</output-file>
  <status>completed|failed|killed</status>
  <summary>Agent "description" completed</summary>
  <result>{agent's final text response}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
  <worktree>
    <worktree-path>/path/to/worktree</worktree-path>
    <worktree-branch>branch-name</worktree-branch>
  </worktree>
</task-notification>
```

These arrive as **user-role messages** in the coordinator's conversation. The coordinator system prompt explains they are not real user messages.

---

## 7. SendMessage: Continuing Workers

`SendMessageTool` (`src/tools/SendMessageTool/SendMessageTool.ts`) allows the coordinator to send follow-up messages to a worker.

Routing logic (line 800-873):
1. Look up `input.to` in `appState.agentNameRegistry` (by name) or try to parse as raw `agentId`.
2. If the task is **running**: call `queuePendingMessage()` — message is delivered at the worker's next tool round.
3. If the task is **stopped**: call `resumeAgentBackground()` — worker resumes from transcript with the new prompt.
4. If the task is **evicted from state**: call `resumeAgentBackground()` from disk transcript.

This means `SendMessage` is the **continuation mechanism** for both live and stopped workers. There is no separate "wake up" API.

---

## 8. Task Tracking and Shared State

All agent tasks live in **AppState.tasks**, a dictionary keyed by `taskId`:

```typescript
// src/tasks/types.ts
export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState    // coordinator workers, background agents
  | RemoteAgentTaskState   // CCR-hosted agents
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
```

`LocalAgentTaskState` fields relevant to coordinator mode:
- `status`: `'running' | 'stopped' | 'killed' | 'completed' | 'failed' | 'pending'`
- `abortController`: used by `TaskStop` to cancel the agent
- `pendingMessages`: queue of follow-up messages from `SendMessage`
- `progress`: live progress from assistant messages
- `notified`: deduplication flag to prevent double-notification
- `retain`: if true, don't evict from AppState after completion

Workers share **no state** with each other directly. State is only shared via:
1. The filesystem (same git repo, worktree isolation optional)
2. The coordinator's synthesized prompts (the coordinator reads worker output and injects facts into next prompts)
3. The scratchpad directory (when `tengu_scratch` gate enabled): a per-session temp dir at `/tmp/claude-{uid}/{sanitized-cwd}/{sessionId}/scratchpad/` that workers can read/write without permission prompts

---

## 9. TaskStop Tool

```typescript
// src/constants/tools.ts: TASK_STOP_TOOL_NAME available to coordinator
```

Calls `killAsyncAgent()` which:
1. Calls `task.abortController?.abort()` — signals the worker's query loop to stop
2. Calls `task.unregisterCleanup?.()` — releases cleanup registrations
3. Sets status to `'killed'`
4. Schedules `evictTaskOutput` to clean up disk output after a grace period

Workers stopped via `TaskStop` can be continued with `SendMessage` (which calls `resumeAgentBackground()`).

### killAllRunningAgentTasks

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx:309-315
export function killAllRunningAgentTasks(tasks, setAppState): void {
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.type === 'local_agent' && task.status === 'running') {
      killAsyncAgent(taskId, setAppState)
    }
  }
}
```

Used by ESC cancellation in coordinator mode to stop all running subagents at once (comment explicitly says "Used by ESC cancellation in coordinator mode").

---

## 10. Hooks in Coordinator Mode

### SubagentStart hook

Fires on every agent spawn (worker or otherwise) via `executeSubagentStartHooks()` in `runAgent.ts:530-553`:

```typescript
// src/entrypoints/sdk/coreSchemas.ts:540-547
export const SubagentStartHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(z.object({
    hook_event_name: z.literal('SubagentStart'),
    agent_id: z.string(),
    agent_type: z.string(),
  })),
)
```

Output: `{ hookEventName: 'SubagentStart', additionalContext?: string }`

If `additionalContext` is returned, it is injected as a user message in the worker's initial message list, **before the first turn**. This is the injection point Claudex already uses (`src/adapters/cc-hooks/` — the `PreToolUse` hook for Agent calls). The `SubagentStart` hook fires with `agent_id` and `agent_type` for each spawned worker.

### SubagentStop hook

Fires just before a subagent concludes. Input includes `agent_transcript_path`, `agent_type`, `last_assistant_message`. Exit code 2 tells the model to continue running.

### Permission handling in coordinator workers

Workers that are async but have `bubble` permission mode (e.g., in-process teammates) can still show permission prompts. For coordinator workers, `awaitAutomatedChecksBeforeDialog = true` is set, meaning hooks and the classifier run **before** the dialog is shown:

```typescript
// src/hooks/toolPermission/handlers/coordinatorHandler.ts:33-57
// 1. Try permission hooks first (fast, local)
const hookResult = await ctx.runHooks(permissionMode, suggestions, updatedInput)
if (hookResult) return hookResult
// 2. Try classifier (slow, inference — bash only)
const classifierResult = await ctx.tryClassifier?.(...)
if (classifierResult) return classifierResult
// 3. Fall through to dialog
```

This means external permission hooks (like Claudex's) run before the user sees any prompt for coordinator workers.

---

## 11. Remote Mode (CCR)

Remote mode is an entirely different concept from coordinator mode. It refers to CC's ability to **connect a local CLI to a session running in Anthropic's cloud infrastructure (CCR = Cloud Compute Resource)**.

### Two distinct remote patterns

**A. Remote Session (view/control of CCR):** The local CLI connects to a pre-existing CCR session via WebSocket. The model runs in the cloud; the local CLI is a UI terminal.

**B. Remote Isolation for Agents (ant-internal):** When `isolation: "remote"` is passed to `Agent()`, the coordinator calls `teleportToRemote()` which creates a new CCR session for the worker to run in. The worker runs in Anthropic's cloud, not locally.

### RemoteSessionManager (`src/remote/RemoteSessionManager.ts`)

Manages connection to a remote CCR session:

```typescript
export type RemoteSessionConfig = {
  sessionId: string
  getAccessToken: () => string
  orgUuid: string
  hasInitialPrompt?: boolean
  viewerOnly?: boolean  // 'claude assistant' mode — no interrupts, no title updates
}
```

**Channels:**
- **WebSocket** (`SessionsWebSocket`): Receives `SDKMessage` stream from CCR (streaming assistant output, tool progress, status, compact boundaries)
- **HTTP POST** (`sendEventToRemoteSession`): Sends user messages to CCR
- **Control channel** (over same WebSocket): `control_request` / `control_response` / `control_cancel_request` for permission prompts

```
[Local CLI] --WS subscribe--> [CCR session]
                <-- SDKMessage stream --
[Local CLI] --HTTP POST--> [CCR session]  (user messages)
[Local CLI] <-- control_request -- [CCR] (permission prompts)
[Local CLI] -- control_response --> [CCR]
```

### SessionsWebSocket (`src/remote/SessionsWebSocket.ts`)

WebSocket endpoint: `wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...`

Auth: Bearer token in `Authorization` header (OAuth).

Reconnect behavior:
- `MAX_RECONNECT_ATTEMPTS = 5` with `RECONNECT_DELAY_MS = 2000`
- Close code `4001` (session not found) gets `MAX_SESSION_NOT_FOUND_RETRIES = 3` retries — transient during compaction
- Close code `4003` (unauthorized) = permanent, no retry
- Ping interval: 30s (`PING_INTERVAL_MS`)

### Permission bridge in remote mode (`src/remote/remotePermissionBridge.ts`)

When CCR sends a `control_request` with `subtype: 'can_use_tool'`, the local CLI must display a permission dialog and respond:

```typescript
// Creates a synthetic AssistantMessage that ToolUseConfirm expects
export function createSyntheticAssistantMessage(request, requestId): AssistantMessage
// Creates a minimal Tool stub for tools the local CLI doesn't know about
export function createToolStub(toolName: string): Tool
```

Permission response sent back via `sendControlResponse()`:
```typescript
{ behavior: 'allow', updatedInput: {...} }
// or
{ behavior: 'deny', message: '...' }
```

### sdkMessageAdapter (`src/remote/sdkMessageAdapter.ts`)

Converts CCR's `SDKMessage` stream format into the REPL's internal `Message` types for rendering. Handles:
- `assistant` → `AssistantMessage`
- `stream_event` → streaming delta
- `result` → session end signal (only shows error results)
- `system.init` → initialization info
- `system.status` → compaction status
- `system.compact_boundary` → compact metadata
- `tool_progress` → progress indicator
- Unknown types → logged and ignored (forward compat)

### Remote agent task (`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`)

When `isolation: "remote"` is used via `Agent()`, a `RemoteAgentTask` is created:

```typescript
export type RemoteAgentTaskState = TaskStateBase & {
  type: 'remote_agent'
  remoteTaskType: RemoteTaskType  // 'remote-agent' | 'ultraplan' | 'ultrareview' | ...
  sessionId: string
  command: string
  title: string
  todoList: TodoList
  log: SDKMessage[]
  isLongRunning?: boolean
  pollStartedAt: number
}
```

Task completion is detected by polling CCR for result events. Notification format is identical to `LocalAgentTask` notifications (`<task-notification>` XML), so the coordinator handles them the same way.

Completion checkers can be registered per `remoteTaskType`:
```typescript
export function registerCompletionChecker(remoteTaskType, checker): void
```
This is an **extension point** — external code can register type-specific completion logic.

---

## 12. Agent Swarms vs. Coordinator Mode

These are two different multi-agent systems in CC, **not the same thing**:

| Feature | Coordinator Mode | Agent Swarms |
|---------|-----------------|--------------|
| Gate | `COORDINATOR_MODE` bundle feature | `ENABLE_AGENT_SWARMS` (plan-based) |
| Topology | Hub-spoke | Flat team (lead + peers) |
| Communication | `<task-notification>` XML user messages | File-based mailboxes (`~/.claude/teams/{team}/inboxes/{name}.json`) |
| Worker discovery | `appState.agentNameRegistry` | Team file (`~/.claude/teams/{team}/team.json`) |
| Spawn mechanism | `Agent()` with `worker` subagent_type | `Agent()` with `name` + `team_name` |
| Worker tools | `SendMessage` routes to async queue | `SendMessage` routes to mailbox |
| Coordinator prompt | `getCoordinatorSystemPrompt()` | N/A (lead has normal prompt) |

In swarm mode, `SendMessageTool` routes to `writeToMailbox()`, which writes JSON to `~/.claude/teams/{team}/inboxes/{name}.json`. Workers poll their inbox at each tool turn. Locking is done with a retry-based lockfile to handle concurrent CC processes.

---

## 13. Scratchpad: The Only True Shared State for Workers

When the `tengu_scratch` GrowthBook gate is enabled, workers get a shared scratchpad directory:

```typescript
// src/coordinator/coordinatorMode.ts:104-107
if (scratchpadDir && isScratchpadGateEnabled()) {
  content += `\n\nScratchpad directory: ${scratchpadDir}\n` +
    `Workers can read and write here without permission prompts. ` +
    `Use this for durable cross-worker knowledge — structure files however fits the work.`
}
```

Path: `/tmp/claude-{uid}/{sanitized-cwd}/{sessionId}/scratchpad/` (from `src/utils/permissions/filesystem.ts:385`).

This is the **only cross-worker shared state mechanism** in coordinator mode. Workers can coordinate via files here without needing the coordinator to relay information.

---

## 14. Extension Points

### SubagentStart hook (used by Claudex)

Already used by Claudex's `PreToolUse` hook to inject awareness into subagents. The correct hook is actually `SubagentStart` (fires on agent spawn, not PreToolUse on the Agent tool call):

- Input: `{ hook_event_name: 'SubagentStart', agent_id, agent_type, session_id, ... }`
- Output: `{ hookEventName: 'SubagentStart', additionalContext?: string }`
- Additional context is injected as a user message at the start of the worker's conversation

### Permission hooks for coordinator workers

CC explicitly runs permission hooks before showing the dialog for coordinator workers (`src/hooks/toolPermission/handlers/coordinatorHandler.ts`). This means Claudex's permission hooks can influence coordinator worker behavior the same as regular sessions.

### Remote task completion checkers

`registerCompletionChecker(remoteTaskType, checker)` allows registering custom completion detection for remote task types. Currently internal to CC.

### No coordinator-specific hook event

There is no dedicated "coordinator spawn" or "coordinator turn" hook event. The coordinator is just a regular session with a different tool set and system prompt. All existing hooks (SessionStart, UserPromptSubmit, PostToolUse, PreToolUse, Stop) fire normally on the coordinator.

---

## 15. Conflict Analysis with Claudex

### Claudex's PreToolUse hook on Agent calls

Claudex injects Claudex awareness into subagents via a `PreToolUse` hook that fires when the `Agent` tool is called. This works by reading the tool input and injecting context into the prompt.

**CC's actual mechanism:** The correct injection point is the `SubagentStart` hook, which runs inside `runAgent.ts` after the agent is fully configured but before its first query turn. The `SubagentStart` hook output (`additionalContext`) is injected as a user message.

The `PreToolUse` on `Agent` fires on the coordinator side (before `runAgent.ts` is called), while `SubagentStart` fires on the worker side (inside `runAgent.ts`). Both are valid injection points but with different timing and context.

### Claudex's cross-session coordination vs. CC's task-notification system

**CC coordinator communication:** Entirely in-process. `<task-notification>` messages are enqueued via `enqueuePendingNotification()` which injects them into the coordinator's conversation as user messages. There is no cross-process IPC, no file system polling — everything is in-memory within one CC process.

**Claudex's cross-session system:** Uses a SQLite DB (`~/.claudex/db/claudex.db`) and `session_messages` table. Different sessions are different processes.

**No conflict:** Claudex's coordination is at the process/session level. CC's coordinator mode is within a single process. They operate at different layers and don't interfere.

### Claudex session signals and CC's agent name registry

CC's coordinator tracks workers via `appState.agentNameRegistry` (in-memory, per-process). Claudex's stigmergic signals are in the SQLite DB (cross-process). These are independent systems.

### The `workerToolsContext` user context key

CC's `getCoordinatorUserContext()` injects a `workerToolsContext` key into the coordinator's user context. If Claudex also injects user context keys, there's no collision risk since keys are different. CC reads `workerToolsContext` in the coordinator prompt assembly; Claudex reads its own keys.

---

## 16. File Reference Index

| File | Purpose |
|------|---------|
| `src/coordinator/coordinatorMode.ts` | Mode detection, session persistence, coordinator system prompt, worker tool listing |
| `src/coordinator/workerAgent.ts` | Empty — placeholder (no worker-side coordinator logic here) |
| `src/remote/RemoteSessionManager.ts` | WebSocket + HTTP hybrid client for CCR sessions |
| `src/remote/SessionsWebSocket.ts` | WebSocket protocol, reconnect, ping, control channel |
| `src/remote/remotePermissionBridge.ts` | Synthetic assistant message + tool stub for remote permission prompts |
| `src/remote/sdkMessageAdapter.ts` | SDKMessage → REPL Message conversion |
| `src/tools/AgentTool/AgentTool.tsx` | Agent spawning, isolation routing, async/sync decision, remote agent launch |
| `src/tools/AgentTool/runAgent.ts` | Core agent execution loop, SubagentStart hooks, MCP init, tool assembly |
| `src/tools/AgentTool/constants.ts` | `AGENT_TOOL_NAME`, `LEGACY_AGENT_TOOL_NAME`, `ONE_SHOT_BUILTIN_AGENT_TYPES` |
| `src/tools/AgentTool/agentToolUtils.ts` | Tool filtering for agents, progress tracking, notification enqueue |
| `src/tools/SendMessageTool/SendMessageTool.ts` | Message routing to running/stopped/evicted workers, mailbox broadcast, shutdown/plan protocols |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | LocalAgentTask state machine, notification format, kill/complete/fail, killAll |
| `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` | CCR-hosted agent tracking, completion checkers, poll-based monitoring |
| `src/tasks/types.ts` | TaskState union type |
| `src/constants/tools.ts` | `ALL_AGENT_DISALLOWED_TOOLS`, `ASYNC_AGENT_ALLOWED_TOOLS`, `COORDINATOR_MODE_ALLOWED_TOOLS`, `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` |
| `src/utils/toolPool.ts` | `applyCoordinatorToolFilter()`, `mergeAndFilterTools()` |
| `src/utils/teammateMailbox.ts` | File-based mailbox for Agent Swarms (distinct from coordinator mode) |
| `src/hooks/toolPermission/handlers/coordinatorHandler.ts` | Coordinator worker permission flow (hooks before dialog) |
| `src/entrypoints/sdk/coreSchemas.ts` | `SubagentStartHookInputSchema`, `SubagentStopHookInputSchema` |
| `src/utils/hooks/hooksConfigManager.ts` | Hook descriptions including SubagentStart (`agent_id`, `agent_type`) |
| `src/QueryEngine.ts` | `getCoordinatorUserContext()` injection into user context |
| `src/main.tsx` | CLI entry, coordinator mode detection, tool filtering, mode persistence |
| `src/utils/teleport/api.ts` | CCR API client (create sessions, send events, poll) |
