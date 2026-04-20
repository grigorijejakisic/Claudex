# Phase 5 Plan: Permission & Error Hooks

**Phase:** 5 of 12
**Items:** H5, H6, H7, H14, X8, B7
**Status:** PLANNED

---

## Scope

**In scope:** 6 new hook files, 1 existing file modification (PreToolUse), 6 new EventTypes, build/setup/test updates.
**Out of scope:** Auto-allow/deny logic (H5), retry logic (H6), auto-response (H7), additionalContext injection (H14). All hooks are record-only in Phase 5.

## Files to Create

| File | Hook Event | Est. Lines |
|------|-----------|-----------|
| `src/adapters/cc-hooks/permission-request.ts` | PermissionRequest (H5) | ~30 |
| `src/adapters/cc-hooks/permission-denied.ts` | PermissionDenied (H6) | ~30 |
| `src/adapters/cc-hooks/elicitation.ts` | Elicitation (H7a) | ~30 |
| `src/adapters/cc-hooks/elicitation-result.ts` | ElicitationResult (H7b) | ~25 |
| `src/adapters/cc-hooks/post-tool-use-failure.ts` | PostToolUseFailure (H14a) | ~30 |
| `src/adapters/cc-hooks/stop-failure.ts` | StopFailure (H14b) | ~25 |

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/session-events.ts` | Add 6 EventType values: `permission_request`, `permission_denied`, `elicitation`, `elicitation_result`, `tool_error`, `stop_failure` |
| `src/adapters/cc-hooks/pre-tool-use.ts` | X8: extend with permissionDecision infrastructure, refactor from Agent-only to all-tools |
| `src/adapters/cc-hooks/stop.ts` | B7: add comment documenting command-type requirement |
| `src/adapters/cc-hooks/session-end.ts` | B7: add comment documenting command-type requirement |
| `build.ts` | Add 6 entries to `optionalEntryPoints`. Add smoke payloads. Add to `hookEntryPoints` (except stop-failure -- fire-and-forget). |
| `src/cli/setup.ts` | Add 6 entries to `HOOK_FILES`. Update summary count 11 -> 17. |
| `src/tests/adapters/cc-hooks/hooks.test.ts` | Test cases for all 6 new hooks + X8 permission decision. |
| `src/tests/cli/setup.test.ts` | Update expected hook count 11 -> 17. |

## Implementation Details

### 1. EventType Union (session-events.ts)

Add `'permission_request' | 'permission_denied' | 'elicitation' | 'elicitation_result' | 'tool_error' | 'stop_failure'` to the EventType union. No schema migration needed -- `event_type` is plain TEXT in SQLite.

### 2. PostToolUseFailure Hook (H14a) -- Simplest, Start Here

**Payload:**
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
**Output:** `{}` (no additionalContext in Phase 5)

Logic:
- Record `tool_error` event: entity=tool_name, action=error (truncated 200 chars), detail=JSON with tool_use_id, is_interrupt, truncated tool_input summary (200 chars)
- Return `{}`
- Register with `matcher: ""` (all tools)

### 3. StopFailure Hook (H14b) -- Fire-and-Forget

**Payload:**
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
**Output:** `{}` (CC ignores ALL output and exit codes for StopFailure)

Logic:
- Record `stop_failure` event: entity=error (the error type string), action=error_details (truncated 200 chars)
- Return `{}` via wrapHook for codebase consistency even though CC ignores it
- Register with `matcher: ""` (all error types)

**Critical:** StopFailure is fire-and-forget. CC does not wait for this hook. The wrapHook infrastructure handles this transparently -- the hook runs to completion but CC doesn't read the output. No special handling needed.

### 4. PermissionDenied Hook (H6)

**Payload:**
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
**Output:** `{}` (never set retry: true in Phase 5)

Logic:
- Record `permission_denied` event: entity=tool_name, action=reason (truncated 200 chars), detail=JSON with tool_use_id, truncated tool_input summary (200 chars)
- Return `{}`
- Register with `matcher: ""` (all tools)

### 5. Elicitation Hook (H7a)

**Payload:**
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
**Output:** `{}` (no auto-response in Phase 5)

Logic:
- Record `elicitation` event: entity=mcp_server_name, action=message (truncated 200 chars), detail=JSON with mode, elicitation_id
- Return `{}`
- Register with `matcher: ""` (all MCP servers)

### 6. ElicitationResult Hook (H7b)

**Payload:**
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
**Output:** `{}` (no modification in Phase 5)

Logic:
- Record `elicitation_result` event: entity=mcp_server_name, action=the action value ('accept'/'decline'/'cancel'), detail=JSON with elicitation_id, mode
- Return `{}`
- Register with `matcher: ""` (all MCP servers)

### 7. PermissionRequest Hook (H5)

**Payload:**
```typescript
{
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: unknown
  permission_suggestions?: PermissionUpdate[]
  // + base fields
}
```
**Output:** `{}` (pass-through to normal CC permission flow)

Logic:
- Record `permission_request` event: entity=tool_name, action='requested', detail=truncated tool_input summary (200 chars)
- Return `{}` -- no decision, no auto-allow, no auto-deny
- Register with `matcher: ""` (all tools, for comprehensive data collection)

**Decision D1:** Auto-allow deferred. Data collection first, Angel analysis second, auto-allow third.

### 8. PreToolUse X8 Wiring (pre-tool-use.ts modification)

**Current state:** PreToolUse only fires for Agent tool (matcher: "Agent"), returns updatedInput with Claudex MCP hint.

**New state:** PreToolUse fires for ALL tools (matcher: ""), handles two responsibilities:
1. Agent tool: existing updatedInput logic (Claudex MCP hint injection) -- unchanged
2. All tools: permissionDecision lookup (currently always returns undefined = pass-through)

**Extended return schema:**
```typescript
hookSpecificOutput: {
  hookEventName: 'PreToolUse'
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>    // existing, Agent-only
  additionalContext?: string                 // existing field
}
```

Logic:
- Keep existing Agent tool prompt injection (no change to behavior)
- Add permission decision lookup function that returns undefined (no rules yet)
- When permission decision is undefined, omit `permissionDecision` from output (CC treats as pass-through)
- Future: Angel promotes auto-allow rules based on H5/H6 data, this function returns 'allow'/'deny'

**settings.json change:** PreToolUse matcher changes from `"Agent"` to `""`.

**Performance:** Hook is fast (~10ms). The permission decision check is a simple function call that currently returns undefined immediately. Acceptable for all tool calls.

### 9. B7 Comments (stop.ts + session-end.ts)

**Bug:** Agent-type hooks silently fail on SessionEnd/Stop events (CC #40010).

Both `stop.ts` and `session-end.ts` already use `wrapHook()` which is command-type. B7 is already satisfied.

Deliverable:
- Add B7 awareness comment to `stop.ts` header
- Add B7 awareness comment to `session-end.ts` header
- Add test assertion in `setup.test.ts` verifying stop/end hooks use command type

### 10. Build & Setup Wiring

**build.ts:**
- Add 6 paths to `optionalEntryPoints` (D9 -- prevents build failures during development)
- Add smoke payloads for all 6 new hooks
- Add 5 new hooks to `hookEntryPoints` for smoke testing (exclude stop-failure -- fire-and-forget, CC ignores output anyway)

Smoke payloads:
```typescript
'permission-request': { session_id: '__smoke__', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd },
'permission-denied': { session_id: '__smoke__', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 'smoke-id', reason: 'User denied', cwd },
'elicitation': { session_id: '__smoke__', mcp_server_name: 'test-server', message: 'Enter value', cwd },
'elicitation-result': { session_id: '__smoke__', mcp_server_name: 'test-server', action: 'accept', cwd },
'post-tool-use-failure': { session_id: '__smoke__', tool_name: 'Bash', tool_input: { command: 'fail' }, tool_use_id: 'smoke-id', error: 'command failed', cwd },
'stop-failure': { session_id: '__smoke__', error: 'rate_limit', error_details: 'Rate limited', cwd },
```

**setup.ts:**
- Add 6 entries to `HOOK_FILES` record:
  - PermissionRequest, PermissionDenied, Elicitation, ElicitationResult, PostToolUseFailure, StopFailure
- Update summary message: `Hooks: 17 registered`
- PreToolUse is already registered (Phase 4 / earlier). The matcher change from "Agent" to "" is handled by `patchSettingsJson` which overwrites the existing Claudex entry.

**Note on PreToolUse matcher:** The `patchSettingsJson` function in setup.ts always writes `matcher: ''` for all hooks. PreToolUse was originally registered with `matcher: "Agent"` manually. After `bun run setup`, it will be overwritten to `matcher: ""`. This is the desired behavior for X8.

However, `patchSettingsJson` currently writes `matcher: ''` for ALL hooks. PreToolUse was manually set to `"Agent"` outside of setup.ts. Since setup.ts already writes empty matcher, running `bun run setup` after Phase 5 will naturally apply the X8 matcher change. No code change needed in setup.ts for this.

### 11. Tests

**hooks.test.ts -- 7 new describe blocks:**

1. **PermissionRequest (H5):** Records `permission_request` event with tool_name as entity
2. **PermissionDenied (H6):** Records `permission_denied` event with tool_name and reason
3. **Elicitation (H7a):** Records `elicitation` event with mcp_server_name and message
4. **ElicitationResult (H7b):** Records `elicitation_result` event with mcp_server_name and action
5. **PostToolUseFailure (H14a):** Records `tool_error` event with tool_name and error string
6. **StopFailure (H14b):** Records `stop_failure` event with error type and details
7. **PreToolUse X8:** Returns undefined permissionDecision for non-Agent tools (pass-through), still returns updatedInput for Agent tool

**setup.test.ts:**
- Update `getHookPaths` test: expect 17 hooks instead of 11
- Verify PreToolUse is included in hook paths

## Implementation Order

1. EventType union changes (unblocks all hooks)
2. PostToolUseFailure (H14a) -- simplest, pure recording
3. StopFailure (H14b) -- simplest, fire-and-forget recording
4. PermissionDenied (H6) -- simple recording
5. Elicitation (H7a) -- simple recording
6. ElicitationResult (H7b) -- simple recording
7. PermissionRequest (H5) -- most complex return schema, but record-only
8. PreToolUse X8 wiring (modify existing, add permission decision path)
9. B7 comments (trivial additions to stop.ts and session-end.ts)
10. build.ts + setup.ts wiring (6 new hooks registered)
11. Tests (7 new describe blocks + setup count update)
12. Build + test verification (`bun run build && bun run test`)

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | PermissionRequest: record-only, no auto-allow | Auto-allow without data = risk. Data collection first, Angel analysis second, auto-allow third. |
| D2 | PermissionDenied: never retry | Retry without understanding denial context could cause loops or safety violations. |
| D3 | Elicitation: record-only, no auto-response | Claudex MCP doesn't use elicitation yet. Pure future-proofing. |
| D4 | X8: infrastructure-only, pass-through default | Wire the return path now so future auto-allow rules don't require hook changes. |
| D5 | StopFailure: return {} via wrapHook | CC ignores output but codebase consistency matters. |
| D6 | All hooks: matcher "" for full data collection | We want ALL permission/error/elicitation events to learn patterns. |
| D7 | No additionalContext injection in Phase 5 | Pure recording. Context injection deferred to when we have pattern data. |
| D8 | PreToolUse matcher changes to "" -- fires for all tools | Needed for X8 permission decisions to work on any tool. Performance acceptable (~10ms). |
| D9 | New hooks added to optional list in build.ts | Prevents build failures during development. Promote after stabilization. |

## Infrastructure Reuse

All hooks use established patterns -- no new shared functions needed:
- `wrapHook()` from `infrastructure.ts` -- stdin/stdout JSON protocol, DB bootstrap, error handling, telemetry
- `recordEvent()` from `session-events.ts` -- structured event logging

No new shared lifecycle functions needed. All hooks are simple enough to implement inline.

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| H5 PermissionRequest | LOW -- record-only, no auto-allow | Return `{}` always. No behavioral impact. |
| H6 PermissionDenied | LOW -- record-only, no retry | Return `{}` always. |
| H7 Elicitation/Result | LOW -- record-only, no auto-response | Return `{}` always. |
| H14 PostToolUseFailure | LOW -- record-only | Return `{}`, no context injection. |
| H14 StopFailure | LOW -- fire-and-forget, CC ignores output | Pure logging. |
| X8 PreToolUse | MEDIUM -- matcher change means hook fires for ALL tools | Hook is fast (~10ms). Permission lookup returns undefined (pass-through). No behavioral change until rules are created. |
| B7 | TRIVIAL -- already satisfied | Comments + test only. |
| Build/setup | LOW -- optional entry points | Won't break builds. |

## Verification Criteria

- [ ] All 6 new hook files exist and follow wrapHook pattern
- [ ] EventType union includes 6 new types
- [ ] PreToolUse handles all tools (not just Agent) with permissionDecision infrastructure
- [ ] PreToolUse still injects Claudex hint for Agent tool (regression check)
- [ ] stop.ts and session-end.ts have B7 awareness comments
- [ ] build.ts compiles all 6 new hooks without errors
- [ ] setup.ts registers all 17 hooks in settings.json
- [ ] Smoke tests pass for new hooks
- [ ] Unit tests pass for each hook's core behavior + X8
- [ ] `bun run build` succeeds
- [ ] `bun run test` passes (all existing + new tests)
