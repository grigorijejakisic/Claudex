# Phase 4 Plan: Core Lifecycle Hooks

**Phase:** 4 of 12
**Items:** H1, H2, H4, H13 (H3 + H17 already exist)
**Status:** PLANNED

---

## Scope

**In scope:** 5 new hook files for 4 new event types.
**Out of scope:** H3 (PreCompact) and H17 (SessionEnd) -- already implemented.

## Files to Create

| File | Hook Event | Est. Lines |
|------|-----------|-----------|
| `src/adapters/cc-hooks/post-compact.ts` | PostCompact (H4) | ~45 |
| `src/adapters/cc-hooks/subagent-start.ts` | SubagentStart (H1) | ~40 |
| `src/adapters/cc-hooks/subagent-stop.ts` | SubagentStop (H2) | ~50 |
| `src/adapters/cc-hooks/task-created.ts` | TaskCreated (H13a) | ~25 |
| `src/adapters/cc-hooks/task-completed.ts` | TaskCompleted (H13b) | ~25 |

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/session-events.ts` | Add 4 new EventType values: `subagent_start`, `subagent_stop`, `task_created`, `task_completed` |
| `build.ts` | Add 5 entries to `optionalEntryPoints`. Add smoke payloads. Post-compact excluded from smoke list (Ollama timeout). |
| `src/cli/setup.ts` | Add 5 entries to `HOOK_FILES`. Update summary count 6 -> 11. |
| `src/tests/adapters/cc-hooks/hooks.test.ts` | Test cases for all 5 new hooks. |
| `src/tests/cli/setup.test.ts` | Update expected hook count 6 -> 11. |

## Implementation Details

### 1. EventType Union (session-events.ts)

Add `'subagent_start' | 'subagent_stop' | 'task_created' | 'task_completed'` to the EventType union. No schema migration needed -- `event_type` is plain TEXT in SQLite with no CHECK constraint.

### 2. PostCompact Hook (H4) -- Highest Priority

**Payload:** `{ hook_event_name, trigger: 'manual'|'auto', compact_summary: string, ...base }`
**Output:** `{}` (exit 0)

Logic:
- Record `compaction` event (event_type already in union) with `trigger` and truncated `compact_summary`
- Call `clearPostCompactPending()` to clear the flag set by PreCompact
- Store `compact_summary` as journal entry (type `'summary'`) for cross-session recall
- Return `{}`

**Why highest priority:** Provides clean post-compact signal for T7 wiring. Pairs with existing PreCompact. CC fires `SessionStart('compact')` AFTER PostCompact -- so flag must be cleared synchronously here.

### 3. SubagentStart Hook (H1)

**Payload:** `{ hook_event_name, agent_id, agent_type, ...base }`
**Output:** `{ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext } }`

Logic:
- Record `subagent_start` event with `agent_id` as entity, `agent_type` as action
- Build minimal context (<200 tokens): project name + active signals from `getActiveSignals()`
- Return `additionalContext` via `hookSpecificOutput`
- Do NOT duplicate PreToolUse MCP hint (already handled by pre-tool-use.ts)

**Token budget:** Every byte of `additionalContext` accumulates in every subagent's context window. Hard cap at 200 tokens.

### 4. SubagentStop Hook (H2)

**Payload:** `{ hook_event_name, agent_id, agent_type, agent_transcript_path, last_assistant_message?, ...base }`
**Output:** `{}` (exit 0)

Logic:
- Compute duration by querying matching `subagent_start` event for same `agent_id`
- Record `subagent_stop` event with agent_id, agent_type, truncated last_assistant_message (500 chars), transcript_path, duration
- Graceful fallback: null duration if start event not found
- Do NOT parse transcript (Angel's job -- hook is ephemeral)

**Duration query:**
```sql
SELECT timestamp_epoch FROM session_events
WHERE session_id = ? AND event_type = 'subagent_start' AND entity = ?
ORDER BY timestamp_epoch DESC LIMIT 1
```

### 5. TaskCreated Hook (H13a)

**Payload:** `{ hook_event_name, task_id, task_subject, task_description?, teammate_name?, team_name?, ...base }`
**Output:** `{}` (exit 0)

Logic:
- Record `task_created` event: entity=task_id, action=task_subject (truncated 80 chars), detail=JSON metadata
- Pure analytics -- no blocking, no injection

### 6. TaskCompleted Hook (H13b)

**Payload:** `{ hook_event_name, task_id, task_subject, task_description?, teammate_name?, team_name?, ...base }`
**Output:** `{}` (exit 0)

Logic:
- Record `task_completed` event: entity=task_id, action=task_subject (truncated 80 chars), detail=JSON metadata
- Pure analytics -- no blocking, no injection

### 7. Build & Setup Wiring

**build.ts:**
- Add 5 paths to `optionalEntryPoints` (D7 -- prevents build failures)
- Add smoke payloads for subagent-start, subagent-stop, post-compact, task-created, task-completed
- Add subagent-start, subagent-stop, task-created, task-completed to `hookEntryPoints` for smoke testing
- Exclude post-compact from smoke list (same reason as pre-compact: Ollama timeout)

**setup.ts:**
- Add 5 entries to `HOOK_FILES` record
- Update summary message: `Hooks: 11 registered`

### 8. Tests

**hooks.test.ts:**
- PostCompact: records compaction event, clears post-compact-pending flag, stores journal entry
- SubagentStart: records subagent_start event with agent_id/agent_type
- SubagentStop: records subagent_stop event with computed duration
- TaskCreated: records task_created event with task metadata
- TaskCompleted: records task_completed event with task metadata

**setup.test.ts:**
- Update `getHookPaths` test: expect 11 hooks instead of 6
- Update idempotency tests: expect 11 hook entries

## Implementation Order

1. EventType union changes (unblocks all hooks)
2. PostCompact (H4) -- highest value
3. SubagentStart (H1) -- enables context injection
4. SubagentStop (H2) -- depends on SubagentStart events for duration
5. TaskCreated (H13a) + TaskCompleted (H13b) -- lightweight, parallel
6. build.ts + setup.ts wiring
7. Tests for all hooks
8. Build + test verification (`bun run build && bun run test`)

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Keep PreToolUse AND SubagentStart | Different capabilities (updatedInput vs additionalContext), different timing (coordinator vs agent start) |
| D2 | SubagentStart injection < 200 tokens | Every subagent gets this content; heavy injection bloats all subagents |
| D3 | SubagentStop skips transcript parsing | Hook is ephemeral (~2s budget); transcript analysis is Angel's job |
| D4 | PostCompact: flags + journal, no re-injection | CC fires SessionStart('compact') after PostCompact; that handles full assembly |
| D5 | Two separate files for task hooks | One-file-per-hook consistency; CC sends them as separate event types |
| D6 | Task hooks return exit 0, no blocking | No clear use case for blocking task creation/completion |
| D7 | All new hooks as optional in build.ts | Prevents build failures during development; promote after stabilization |

## Infrastructure Reuse

All hooks use established patterns -- no new shared functions needed:
- `wrapHook()` from `infrastructure.ts` -- stdin/stdout JSON protocol, DB bootstrap, error handling, telemetry
- `recordEvent()` from `session-events.ts` -- structured event logging
- `clearPostCompactPending()` from `checkpoint-tracking.ts` -- PostCompact flag management
- `addJournalEntry()` from `journal.ts` -- compact summary persistence
- `getActiveSignals()` from `session-signals.ts` -- SubagentStart context
- `cachedPrepare()` from `stmt-cache.ts` -- duration lookup in SubagentStop

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| H4 PostCompact | MEDIUM -- timing-sensitive flag clearing | Synchronous SQLite writes. CC source confirms PostCompact fires before SessionStart re-trigger. |
| H1 SubagentStart | LOW -- simple event + context injection | Hard 200-token cap. No dynamic assembly. |
| H2 SubagentStop | LOW -- event recording with duration lookup | Graceful null-duration fallback if start event missing. |
| H13 TaskCreated/Completed | LOW -- pure event logging | Non-blocking. If CC doesn't fire them, they're unused (no regression). |
| Build/setup | LOW -- optional entry points | Won't break builds. Promote after smoke tests pass. |

## Verification Criteria

- [ ] All 5 new hook files exist and follow wrapHook pattern
- [ ] EventType union includes 4 new types
- [ ] build.ts compiles all 5 hooks without errors
- [ ] setup.ts registers all 11 hooks in settings.json
- [ ] Smoke tests pass for new hooks (except post-compact)
- [ ] Unit tests pass for each hook's core behavior
- [ ] `bun run build` succeeds
- [ ] `bun run test` passes (all existing + new tests)
