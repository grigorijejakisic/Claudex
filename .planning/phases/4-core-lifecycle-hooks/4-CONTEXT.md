# Phase 4 Context: Core Lifecycle Hooks

**Phase:** 4 of 12
**Items:** H1, H2, H3, H4, H13, H17
**Status:** CONTEXT GATHERED
**Sources:** SYNTHESIS.md, 03-hook-system-deep-dive.md, existing hook implementations
**Dependencies:** None (standalone new hook registration)

---

## Pre-existing Items (already implemented)

**H3 — PreCompact** (`src/adapters/cc-hooks/pre-compact.ts`): Already exists. Runs compaction sequence via `runCompactionSequence()`, returns custom compaction instructions if configured. Registered in `build.ts` (required) and `setup.ts`.

**H17 — SessionEnd** (`src/adapters/cc-hooks/session-end.ts`): Already exists. Runs `runSessionEndCleanup()`, clears session signals, sweeps expired signals, updates Q-values. Registered in `build.ts` (required) and `setup.ts`.

Phase 4 actual new work: **4 new event types across 5 new hook files.**

---

## Item Analysis

### H1 — SubagentStart hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'SubagentStart'
  agent_id: string        // unique subagent identifier
  agent_type: string      // e.g. 'general-purpose', 'code-reviewer'
  // + base fields (session_id, transcript_path, cwd, permission_mode)
}
```
Matcher field: `agent_type`
Output: `{ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext?: string } }`

**When it fires:** Inside `runAgent.ts` after agent is configured, before first query turn. This is the actual agent start, not the coordinator's tool dispatch (which is PreToolUse on Agent tool).

**Relationship with PreToolUse:** PreToolUse on Agent fires at the coordinator level and can modify tool input via `updatedInput`. SubagentStart fires at the actual agent start and can inject `additionalContext` into the subagent's context. Different purposes:
- PreToolUse: modify the Agent tool prompt string (input modification)
- SubagentStart: inject context into the running subagent (context injection)

**Decision:** Keep both. PreToolUse handles prompt modification (Claudex MCP tool awareness). SubagentStart handles richer context injection (project state, worker context).

**Implementation:**
- Record `subagent_start` event to `session_events` with `agent_id` and `agent_type`
- Inject minimal Claudex context via `additionalContext` (< 200 tokens to avoid bloating every subagent)
- Context should include: project name, active signals relevant to subagent work
- Do NOT duplicate the PreToolUse MCP hint — that's already handled

**Token budget concern:** Every byte of `additionalContext` accumulates in every subagent's context window. Keep injection minimal. Full worker-context assembly is too heavy here.

**Key files:**
- `src/adapters/cc-hooks/subagent-start.ts` (new)
- `src/core/session-events.ts` — `recordEvent()`
- `src/core/session-signals.ts` — `getActiveSignals()` for relevant signals

---

### H2 — SubagentStop hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'SubagentStop'
  stop_hook_active: boolean
  agent_id: string
  agent_transcript_path: string   // path to subagent's JSONL transcript
  agent_type: string
  last_assistant_message?: string // final message from subagent
  // + base fields
}
```
Matcher field: `agent_type`
Output: No `hookSpecificOutput` defined. Exit code 2 = show to subagent and continue.

**When it fires:** When a subagent completes (success or failure).

**Implementation:**
- Record `subagent_stop` event to `session_events` with `agent_id`, `agent_type`, truncated `last_assistant_message` (first 500 chars)
- Compute duration by looking up the matching `subagent_start` event for this `agent_id`
- Store `agent_transcript_path` in event detail for Angel to process later
- Do NOT parse the transcript in the hook (too slow for ephemeral hook). Angel handles transcript analysis.

**Duration tracking pattern:**
```sql
SELECT timestamp_epoch FROM session_events
WHERE session_id = ? AND event_type = 'subagent_start' AND entity = ?
ORDER BY timestamp_epoch DESC LIMIT 1
```
Where `entity` = `agent_id`. Duration = `now - start_epoch`.

**Key files:**
- `src/adapters/cc-hooks/subagent-stop.ts` (new)
- `src/core/session-events.ts` — `recordEvent()`

---

### H4 — PostCompact hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'PostCompact'
  trigger: 'manual' | 'auto'
  compact_summary: string   // the summary produced by compaction
  // + base fields
}
```
Matcher field: `trigger`
Output: No `hookSpecificOutput` with `additionalContext`. Stdout shown to user on exit 0.

**When it fires:** After compaction completes. BEFORE `processSessionStartHooks('compact')` re-triggers SessionStart.

**Timing sequence:**
1. Compaction runs (LLM summarizes context)
2. **PostCompact fires** (Claudex records event, clears/sets flags)
3. `processSessionStartHooks('compact')` fires SessionStart with `source: 'compact'`
4. SessionStart does full `assembleFullContext()` re-injection
5. Next user prompt triggers UserPromptSubmit

**Implementation:**
- Record `compaction` event to `session_events` with `trigger` and truncated `compact_summary`
- Call `clearPostCompactPending()` to reset the pre-compact flag set by PreCompact
- Set a new post-compact-done flag so next UserPromptSubmit can reduce injection (T7 wiring)
- Store `compact_summary` as a journal entry for cross-session recall

**Relationship with PreCompact:** PreCompact sets `post_compact_pending` flag and writes checkpoint. PostCompact clears that flag and records the compaction result. Clean lifecycle pair.

**Key files:**
- `src/adapters/cc-hooks/post-compact.ts` (new)
- `src/core/checkpoint-tracking.ts` — `clearPostCompactPending()`, `markPostCompactPending()`
- `src/core/session-events.ts` — `recordEvent()`
- `src/core/journal.ts` — `addJournalEntry()` for compact_summary

---

### H13 — TaskCreated / TaskCompleted hooks

**CC payload schemas:**

TaskCreated:
```typescript
{
  hook_event_name: 'TaskCreated'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string    // present in team mode
  team_name?: string        // present in team mode
  // + base fields
}
```

TaskCompleted:
```typescript
{
  hook_event_name: 'TaskCompleted'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
  // + base fields
}
```
No matcher field. Exit code 0 = nothing, exit code 2 = show to model and prevent action.

**When they fire:** When CC's task system creates or completes tasks. This includes `TaskCreate` and `TaskUpdate` tool calls.

**Implementation (both hooks):**
- Record `task_created` / `task_completed` event to `session_events`
- Entity = `task_id`, action = task_subject (truncated), detail = JSON with full metadata
- Return `{}` with exit 0 (no blocking, no injection)
- Analytics value: task lifecycle tracking enables outcome correlation (which tasks succeed/fail, duration, team patterns)

**Decision:** Two separate files (`task-created.ts`, `task-completed.ts`) for consistency with one-file-per-hook pattern. Both are lightweight (~20 lines of hook logic each).

**Key files:**
- `src/adapters/cc-hooks/task-created.ts` (new)
- `src/adapters/cc-hooks/task-completed.ts` (new)
- `src/core/session-events.ts` — `recordEvent()`

---

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Keep PreToolUse AND SubagentStart (complementary) | PreToolUse modifies Agent tool input (`updatedInput`). SubagentStart injects context into running subagent (`additionalContext`). Different capabilities, different timing. |
| D2 | SubagentStart injection < 200 tokens | Every subagent gets this content. Heavy injection (worker-context assembly) would bloat all subagents. Minimal: project name + relevant signals. |
| D3 | SubagentStop skips transcript parsing | Hook is ephemeral (~2s budget). Transcript parsing is Angel's job (persistent, holistic). Hook records metadata only. |
| D4 | PostCompact records event + sets flag, no re-injection | CC fires SessionStart('compact') after PostCompact. SessionStart already does full assembly. PostCompact just manages flags and records the compaction summary. |
| D5 | TaskCreated/TaskCompleted as two separate files | One-file-per-hook consistency. CC sends them as separate event types requiring separate settings.json entries. |
| D6 | TaskCreated/TaskCompleted return exit 0, no blocking | No clear use case for blocking task creation/completion. Analytics-only for now. |
| D7 | New hooks added to optional list in build.ts | Prevents build failures during development. Promote to required after stabilization. |

---

## Files to Create

| File | Hook Event | Lines (est.) |
|------|-----------|-------------|
| `src/adapters/cc-hooks/subagent-start.ts` | SubagentStart | ~40 |
| `src/adapters/cc-hooks/subagent-stop.ts` | SubagentStop | ~50 |
| `src/adapters/cc-hooks/post-compact.ts` | PostCompact | ~45 |
| `src/adapters/cc-hooks/task-created.ts` | TaskCreated | ~25 |
| `src/adapters/cc-hooks/task-completed.ts` | TaskCompleted | ~25 |

## Files to Modify

| File | Changes |
|------|---------|
| `build.ts` | Add 5 entries to `optionalEntryPoints` array. Add smoke test payloads for all 5. |
| `src/cli/setup.ts` | Add 5 entries to `HOOK_FILES` record. Update hook count in summary message (6 -> 11). |
| `src/tests/adapters/cc-hooks/hooks.test.ts` | Add test cases for each new hook's core behavior. |
| `src/tests/cli/setup.test.ts` | Update expected hook paths to include new hooks. |

## Settings.json Registration

All new hooks use empty matcher (fire for all events of that type):

```json
{
  "SubagentStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...subagent-start.cjs'" }] }],
  "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...subagent-stop.cjs'" }] }],
  "PostCompact": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...post-compact.cjs'" }] }],
  "TaskCreated": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...task-created.cjs'" }] }],
  "TaskCompleted": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...task-completed.cjs'" }] }]
}
```

---

## Implementation Order

1. **PostCompact** (H4) — highest value. Provides clean post-compact signal for T7 wiring. Pairs with existing PreCompact.
2. **SubagentStart** (H1) — enables richer subagent context injection beyond current PreToolUse hack.
3. **SubagentStop** (H2) — completes subagent lifecycle tracking (needs SubagentStart events to compute duration).
4. **TaskCreated** (H13a) — lightweight event logger.
5. **TaskCompleted** (H13b) — lightweight event logger.
6. **Build/setup changes** — wire all 5 into build.ts and setup.ts.
7. **Tests** — integration tests for each hook's core behavior.

---

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| H1 SubagentStart | LOW — simple event recording + minimal context injection. Risk: injection bloats subagent context. | Hard cap at 200 tokens. No dynamic assembly in subagent injection. |
| H2 SubagentStop | LOW — simple event recording. Risk: agent_id lookup for duration fails if SubagentStart event wasn't recorded. | Graceful fallback: record duration as null if start event not found. |
| H4 PostCompact | MEDIUM — timing-sensitive. PostCompact must clear flags BEFORE SessionStart('compact') fires. | CC source confirms PostCompact fires before SessionStart re-trigger. Flag operations are synchronous SQLite writes. |
| H13 TaskCreated/Completed | LOW — pure event logging, no side effects. Risk: hooks may not fire in current CC version. | Non-blocking — if CC doesn't fire them, they're simply unused. No regression. |
| Build/setup | LOW — optional entry points won't break builds. | Add to optional list first. Promote after smoke tests pass. |

---

## CC Source References

| File | Relevant Finding |
|------|-----------------|
| `03-hook-system-deep-dive.md` | All 27 hook event types, complete payload schemas, exit code semantics, return value schemas |
| `10-coordinator-remote.md` | SubagentStart fires inside `runAgent.ts`, not at coordinator dispatch |
| `02-compaction-pipeline.md` | PostCompact → SessionStart('compact') firing order |
| `14-tools-pre-post-hooks.md` | PreToolUse `updatedInput` vs SubagentStart `additionalContext` — different capabilities |

---

## Existing Infrastructure Reuse

All new hooks use the established patterns from existing hooks:
- `wrapHook()` from `infrastructure.ts` — stdin/stdout JSON protocol, DB bootstrap, error handling, telemetry
- `recordEvent()` from `session-events.ts` — structured event logging
- `emitErrorTelemetry()` from `error-telemetry.ts` — isolated error capture
- `cachedPrepare()` from `stmt-cache.ts` — prepared statement caching
- `getTranscriptPath()` from `infrastructure.ts` — safe transcript path extraction

No new shared lifecycle functions needed. All hooks are simple enough to implement inline with existing utilities.
