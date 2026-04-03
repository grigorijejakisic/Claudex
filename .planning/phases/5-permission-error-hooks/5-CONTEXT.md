# Phase 5 Context: Permission & Error Hooks

**Phase:** 5 of 12
**Items:** H5, H6, H7, H14, X8, B7
**Status:** CONTEXT GATHERED
**Sources:** SYNTHESIS.md, 03-hook-system-deep-dive.md, existing hook implementations (Phase 4)
**Dependencies:** None (standalone new hook registration + one existing hook modification)

---

## Pre-existing State

**PreToolUse** (`src/adapters/cc-hooks/pre-tool-use.ts`): Already exists. Currently handles Agent tool prompt injection only (injects Claudex MCP tool awareness via `updatedInput`). Registered with `matcher: "Agent"` in settings.json. X8 will extend this hook.

**Stop** (`src/adapters/cc-hooks/stop.ts`): Already exists. Uses `wrapHook()` (command-type). B7 constraint already satisfied.

**SessionEnd** (`src/adapters/cc-hooks/session-end.ts`): Already exists. Uses `wrapHook()` (command-type). B7 constraint already satisfied.

Phase 5 actual new work: **6 new hook files, 1 existing file modification, 6 new EventTypes.**

---

## Item Analysis

### H5 -- PermissionRequest Hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: unknown
  permission_suggestions?: PermissionUpdate[]
  // + base fields (session_id, transcript_path, cwd, permission_mode)
}
```
Matcher field: `tool_name`

**CC return schema:**
```typescript
hookSpecificOutput: {
  hookEventName: 'PermissionRequest'
  decision: (
    | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
    | { behavior: 'deny'; message?: string; interrupt?: boolean }
  )
}
```

**When it fires:** When CC is about to ask the user for tool permission. This is the most powerful hook in Phase 5 -- it can auto-allow or auto-deny tools, bypassing user prompts entirely.

**Decision: Record-only for Phase 5.** Auto-allow deferred until Angel has collected sufficient behavioral data from permission requests/denials. Shipping auto-allow without data = risk with no proven benefit.

**Implementation:**
- Record `permission_request` event to `session_events` (tool_name as entity, truncated tool_input summary as detail)
- Return `{}` (pass-through to normal CC permission flow)
- Register with `matcher: ""` (all tools) for comprehensive data collection

**EventType needed:** `permission_request`

**Key files:**
- `src/adapters/cc-hooks/permission-request.ts` (new)
- `src/core/session-events.ts` -- `recordEvent()`

---

### H6 -- PermissionDenied Hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'PermissionDenied'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  reason: string
  // + base fields
}
```
Matcher field: `tool_name`

**CC return schema:**
```typescript
hookSpecificOutput: {
  hookEventName: 'PermissionDenied'
  retry?: boolean
}
```

**When it fires:** When the user denies a tool permission request.

**Decision: Never set `retry: true` in Phase 5.** Too risky without understanding the denial context. Pure data collection.

**Implementation:**
- Record `permission_denied` event (tool_name as entity, reason as action, truncated tool_input as detail)
- Return `{}` (no retry)
- Register with `matcher: ""` for full data collection

**EventType needed:** `permission_denied`

**Key files:**
- `src/adapters/cc-hooks/permission-denied.ts` (new)
- `src/core/session-events.ts` -- `recordEvent()`

---

### H7 -- Elicitation + ElicitationResult Hooks

**Elicitation payload:**
```typescript
{
  hook_event_name: 'Elicitation'
  mcp_server_name: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
  // + base fields
}
```
Matcher field: `mcp_server_name`

**Elicitation return:**
```typescript
hookSpecificOutput: {
  hookEventName: 'Elicitation'
  action?: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}
```

**ElicitationResult payload:**
```typescript
{
  hook_event_name: 'ElicitationResult'
  mcp_server_name: string
  elicitation_id?: string
  mode?: 'form' | 'url'
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  // + base fields
}
```
Matcher field: `mcp_server_name`

**ElicitationResult return:**
```typescript
hookSpecificOutput: {
  hookEventName: 'ElicitationResult'
  action?: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}
```

**When they fire:** Elicitation fires when an MCP tool requests structured user input. ElicitationResult fires when the user responds.

**Decision: Record-only, no auto-response.** Claudex MCP tools don't currently use elicitation. Pure future-proofing.

**Implementation:**
- **Elicitation:** Record `elicitation` event (mcp_server_name as entity, message truncated as action, JSON detail with mode/elicitation_id)
- **ElicitationResult:** Record `elicitation_result` event (mcp_server_name as entity, action as action, JSON detail with elicitation_id/content)
- Both return `{}`
- Register both with `matcher: ""`

**EventTypes needed:** `elicitation`, `elicitation_result`

**Key files:**
- `src/adapters/cc-hooks/elicitation.ts` (new)
- `src/adapters/cc-hooks/elicitation-result.ts` (new)
- `src/core/session-events.ts` -- `recordEvent()`

---

### H14 -- PostToolUseFailure + StopFailure Hooks

**PostToolUseFailure payload:**
```typescript
{
  hook_event_name: 'PostToolUseFailure'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  error: string
  is_interrupt?: boolean
  // + base fields
}
```
Matcher field: `tool_name`

**PostToolUseFailure return:**
```typescript
hookSpecificOutput: {
  hookEventName: 'PostToolUseFailure'
  additionalContext?: string
}
```

**StopFailure payload:**
```typescript
{
  hook_event_name: 'StopFailure'
  error: 'rate_limit' | 'authentication_failed' | 'billing_error' | 'invalid_request' |
         'server_error' | 'max_output_tokens' | 'unknown'
  error_details?: string
  last_assistant_message?: string
  // + base fields
}
```
Matcher field: `error` (the error type string)

**CRITICAL:** StopFailure is fire-and-forget -- CC ignores ALL hook output and exit codes.

**Decision: Pure recording, no additionalContext injection for Phase 5.**

**Implementation:**
- **PostToolUseFailure:** Record `tool_error` event (tool_name as entity, error as action, JSON detail with tool_use_id/is_interrupt/truncated tool_input). Return `{}`.
- **StopFailure:** Record `stop_failure` event (error type as entity, error_details as action). Return `{}` for consistency via wrapHook even though CC ignores it.
- Register both with `matcher: ""`

**EventTypes needed:** `tool_error`, `stop_failure`

**Key files:**
- `src/adapters/cc-hooks/post-tool-use-failure.ts` (new)
- `src/adapters/cc-hooks/stop-failure.ts` (new)
- `src/core/session-events.ts` -- `recordEvent()`

---

### X8 -- permissionDecision in PreToolUse (MODIFY EXISTING)

**Extended return schema for PreToolUse:**
```typescript
hookSpecificOutput: {
  hookEventName: 'PreToolUse'
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>    // existing
  additionalContext?: string                 // existing
}
```

**Decision: Wire the infrastructure, default to pass-through (no rules).** The hook will check for permission rules but find none, returning undefined for permissionDecision. This means normal CC permission flow applies.

**Implementation:**
- Extend `pre-tool-use.ts` to handle all tools, not just Agent
- Current Agent matcher in settings.json must change to `matcher: ""` to fire for all tools
- For Agent tool: existing updatedInput logic (Claudex MCP hint injection)
- For all tools: permission decision lookup (currently always returns undefined)
- Future: Angel promotes auto-allow rules based on H5/H6 data

**Important settings.json change:** PreToolUse matcher changes from `"Agent"` to `""`. This means the hook fires for EVERY tool call instead of just Agent calls. Performance impact: the hook is fast (~10ms) but will fire much more often. Acceptable because the permission decision check is a simple DB/config lookup.

**Key files:**
- `src/adapters/cc-hooks/pre-tool-use.ts` (modify)

---

### B7 -- Command-Type Enforcement for Stop/End Hooks (VERIFICATION)

**Bug:** Agent-type hooks silently fail on SessionEnd/Stop events (CC #40010).

**Current state:** Both `stop.ts` and `session-end.ts` use `wrapHook()` which is a command-type hook. Settings.json registration uses `"type": "command"`. **B7 is already satisfied.**

**Deliverable:**
- Add B7 awareness comment in `stop.ts` and `session-end.ts`
- Add test assertion in `setup.test.ts` verifying stop/end hooks use command type

---

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | PermissionRequest: record-only, no auto-allow | Auto-allow without data = risk. Data collection first, Angel analysis second, auto-allow third. |
| D2 | PermissionDenied: never retry | Retry without understanding denial context could cause loops or safety violations. |
| D3 | Elicitation: record-only, no auto-response | Claudex MCP doesn't use elicitation yet. Pure future-proofing. |
| D4 | X8: infrastructure-only, pass-through default | Wire the return path now so future auto-allow rules don't require hook changes. |
| D5 | StopFailure: return {} via wrapHook | CC ignores output but consistency matters for our codebase. |
| D6 | All hooks: matcher "" for full data collection | We want to see ALL permission/error/elicitation events to learn patterns. |
| D7 | No additionalContext injection in Phase 5 | Pure recording. Context injection deferred to when we have pattern data. |
| D8 | PreToolUse matcher changes "" -> fires for all tools | Needed for X8 permission decisions to work on any tool. Performance acceptable (~10ms). |
| D9 | New hooks added to optional list in build.ts | Prevents build failures during development. Promote after stabilization. |

---

## Files to Create

| File | Hook Event | Lines (est.) |
|------|-----------|-------------|
| `src/adapters/cc-hooks/permission-request.ts` | PermissionRequest | ~30 |
| `src/adapters/cc-hooks/permission-denied.ts` | PermissionDenied | ~30 |
| `src/adapters/cc-hooks/elicitation.ts` | Elicitation | ~30 |
| `src/adapters/cc-hooks/elicitation-result.ts` | ElicitationResult | ~25 |
| `src/adapters/cc-hooks/post-tool-use-failure.ts` | PostToolUseFailure | ~30 |
| `src/adapters/cc-hooks/stop-failure.ts` | StopFailure | ~25 |

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/session-events.ts` | Add 6 EventType values: `permission_request`, `permission_denied`, `elicitation`, `elicitation_result`, `tool_error`, `stop_failure` |
| `src/adapters/cc-hooks/pre-tool-use.ts` | X8: extend with permissionDecision lookup, change from Agent-only to all-tools |
| `src/adapters/cc-hooks/stop.ts` | B7: add comment documenting command-type requirement |
| `src/adapters/cc-hooks/session-end.ts` | B7: add comment documenting command-type requirement |
| `build.ts` | Add 6 entries to `optionalEntryPoints`. Add smoke payloads. Add to `hookEntryPoints` (except stop-failure -- fire-and-forget). |
| `src/cli/setup.ts` | Add 6 entries to `HOOK_FILES`. Update summary count 11 -> 17. |
| `src/tests/adapters/cc-hooks/hooks.test.ts` | Add test cases for all 6 new hooks + X8 permission decision. |
| `src/tests/cli/setup.test.ts` | Update expected hook count 11 -> 17. |

## Settings.json Registration

All new hooks use empty matcher (fire for all events of that type):

```json
{
  "PermissionRequest": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...permission-request.cjs'" }] }],
  "PermissionDenied": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...permission-denied.cjs'" }] }],
  "Elicitation": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...elicitation.cjs'" }] }],
  "ElicitationResult": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...elicitation-result.cjs'" }] }],
  "PostToolUseFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...post-tool-use-failure.cjs'" }] }],
  "StopFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...stop-failure.cjs'" }] }]
}
```

**PreToolUse matcher change:** `"Agent"` -> `""` (fires for all tools, not just Agent).

---

## Implementation Order

1. **EventType union** (6 new types -- unblocks all hooks)
2. **PostToolUseFailure** (H14a -- simplest, pure recording)
3. **StopFailure** (H14b -- simplest, fire-and-forget recording)
4. **PermissionDenied** (H6 -- simple recording)
5. **Elicitation** (H7a -- simple recording)
6. **ElicitationResult** (H7b -- simple recording)
7. **PermissionRequest** (H5 -- most complex return schema, but record-only)
8. **PreToolUse X8 wiring** (modify existing, add permission decision path)
9. **B7 comments** (trivial additions to stop.ts and session-end.ts)
10. **build.ts + setup.ts wiring** (6 new hooks registered)
11. **Tests** (8 new describe blocks + setup count update)
12. **Build + test verification** (`bun run build && bun run test`)

---

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| H5 PermissionRequest | LOW -- record-only, no auto-allow. No behavioral impact. | Return `{}` always. |
| H6 PermissionDenied | LOW -- record-only, no retry. | Return `{}` always. |
| H7 Elicitation/Result | LOW -- record-only, no auto-response. | Return `{}` always. |
| H14 PostToolUseFailure | LOW -- record-only. | Return `{}`, no context injection. |
| H14 StopFailure | LOW -- fire-and-forget, CC ignores output. | Pure logging. |
| X8 PreToolUse | MEDIUM -- matcher change from "Agent" to "" means hook fires for ALL tools. | Hook is fast (~10ms). Permission lookup returns undefined (pass-through). No behavioral change until rules are created. |
| B7 | TRIVIAL -- already satisfied. | Comments + test only. |
| Build/setup | LOW -- optional entry points. | Won't break builds. |

---

## CC Source References

| File | Relevant Finding |
|------|-----------------|
| `03-hook-system-deep-dive.md` | All 27 hook event types, complete payload schemas, exit code semantics, return value schemas |
| `03-hook-system-deep-dive.md` | PermissionRequest decision schema (allow/deny with updatedInput/updatedPermissions) |
| `03-hook-system-deep-dive.md` | StopFailure is fire-and-forget (CC ignores all output) |
| `03-hook-system-deep-dive.md` | Elicitation/ElicitationResult payload with mcp_server_name matcher |
| `14-tools-pre-post-hooks.md` | PreToolUse permissionDecision field (allow/deny/ask) |
| `05-github-issues.md` | B7: Agent-type hooks fail on SessionEnd/Stop (#40010) |

---

## Existing Infrastructure Reuse

All new hooks use established patterns -- no new shared functions needed:
- `wrapHook()` from `infrastructure.ts` -- stdin/stdout JSON protocol, DB bootstrap, error handling, telemetry
- `recordEvent()` from `session-events.ts` -- structured event logging
- `emitErrorTelemetry()` from `error-telemetry.ts` -- isolated error capture (used in pre-tool-use.ts)

No new shared lifecycle functions needed. All hooks are simple enough to implement inline with existing utilities.
