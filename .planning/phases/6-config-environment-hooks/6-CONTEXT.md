# Phase 6 Context: Config & Environment Hooks

**Phase:** 6 of 12
**Items:** H8, H9, H10/H15, H16, H16b (WorktreeCreate/Remove)
**Status:** CONTEXT GATHERED
**Sources:** SYNTHESIS.md, 03-hook-system-deep-dive.md, existing hook implementations (Phases 4-5)
**Dependencies:** None (standalone new hook registration)

---

## Pre-existing State

**SessionStart** (`src/adapters/cc-hooks/session-start.ts`): Already calls `writeClaudeEnvFile()` and returns `watchPaths`. CwdChanged reuses both patterns.

**env-file.ts** (`src/adapters/shared/env-file.ts`): Contains `writeClaudeEnvFile()` utility. CwdChanged will import and call this directly.

**scope-detector.ts** (`src/shared/scope-detector.ts`): Contains `detectProjectScope()` and `deriveProjectId()`. CwdChanged uses these for project re-detection on directory change.

Phase 6 actual new work: **6 new hook files, 3 existing file modifications, 6 new EventTypes.**

---

## Item Analysis

### H8 -- ConfigChange Hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'ConfigChange'
  source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills'
  file_path?: string
  // + base fields (session_id, transcript_path, cwd, permission_mode)
}
```
Matcher field: `source`

**CC return schema:** No hookSpecificOutput defined for ConfigChange in CC source. Exit code 0 = allow, exit code 2 = block change from session.

**When it fires:** When settings.json, project CLAUDE.md, or skill files change during a session.

**Decision: Record-only.** Log which config source changed and the file path. No blocking. Claudex can detect when its own rules or settings are modified — useful for observability and debugging.

**Implementation:**
- Record `config_change` event (source as entity, file_path as action)
- Return `{}` (allow change)
- Register with `matcher: ""` (all config sources)

**EventType needed:** `config_change`

**Key files:**
- `src/adapters/cc-hooks/config-change.ts` (new)
- `src/core/session-events.ts` -- `recordEvent()`

---

### H9 -- InstructionsLoaded Hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'InstructionsLoaded'
  file_path: string
  memory_type: 'User' | 'Project' | 'Local' | 'Managed'
  load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact'
  globs?: string[]              // paths: frontmatter patterns that matched
  trigger_file_path?: string    // file Claude touched that caused the load
  parent_file_path?: string     // file that @-included this one
  // + base fields
}
```
Matcher field: `load_reason`

**CC return schema:** No hookSpecificOutput. Observability-only, no blocking support.

**When it fires:** When CLAUDE.md or rules files are loaded/reloaded.

**Known bug B3:** InstructionsLoaded does NOT fire after compaction (#30973). We already handle post-compact via PostCompact hook, so this is purely observability. Do not rely on this hook for post-compact detection.

**Decision: Record-only.** Log CLAUDE.md loads with metadata for observability. Useful for tracking conditional rule activation (`.claude/rules/` with `paths:` frontmatter).

**Implementation:**
- Record `instructions_loaded` event (file_path as entity, load_reason as action, JSON detail with memory_type/globs/trigger_file_path/parent_file_path)
- Return `{}` (observability only, no blocking)
- Register with `matcher: ""` (all load reasons)

**EventType needed:** `instructions_loaded`

**Key files:**
- `src/adapters/cc-hooks/instructions-loaded.ts` (new)
- `src/core/session-events.ts` -- `recordEvent()`

---

### H10/H15 -- CwdChanged Hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'CwdChanged'
  old_cwd: string
  new_cwd: string
  // + base fields
}
```
No matcher field. CC also sets `CLAUDE_ENV_FILE` env var for this hook.

**CC return schema:**
```typescript
hookSpecificOutput: {
  hookEventName: 'CwdChanged'
  watchPaths?: string[]        // dynamically update file watch list
}
```

**When it fires:** When the working directory changes during a session (user navigates to a different project).

**Decision: Record + env rewrite + watchPaths update. No new session creation.** The session continues under the original session_id. CC manages session lifecycle, not Claudex. CwdChanged cannot return `additionalContext` per CC source — only `watchPaths`.

**Implementation (most complex hook in this phase):**
1. Extract `old_cwd` and `new_cwd` from payload
2. Call `writeClaudeEnvFile()` to rewrite env flags for the new directory (CC passes CLAUDE_ENV_FILE)
3. Re-detect project scope: `detectProjectScope(new_cwd)` + `deriveProjectId(new_cwd)`
4. Record `cwd_changed` event (new_cwd as entity, old_cwd as action, JSON detail with detected project/scope)
5. Build `watchPaths` for the new project's ACTIVE.md and CLAUDE.md (same logic as session-start.ts lines 391-398)
6. Return `{ hookSpecificOutput: { hookEventName: 'CwdChanged', watchPaths } }`

**EventType needed:** `cwd_changed`

**Key files:**
- `src/adapters/cc-hooks/cwd-changed.ts` (new)
- `src/adapters/shared/env-file.ts` -- `writeClaudeEnvFile()` (reuse, no modification)
- `src/shared/scope-detector.ts` -- `detectProjectScope()`, `deriveProjectId()` (reuse, no modification)
- `src/core/session-events.ts` -- `recordEvent()`

---

### H16 -- Setup Hook

**CC payload schema:**
```typescript
{
  hook_event_name: 'Setup'
  trigger: 'init' | 'maintenance'
  // + base fields
}
```
Matcher field: `trigger`

**CC return schema:**
```typescript
hookSpecificOutput: {
  hookEventName: 'Setup'
  additionalContext?: string
}
```

**When it fires:** During `claudex setup` or CC's own setup/maintenance process.

**Decision: Record-only.** Log the trigger type. No additionalContext injection — the setup process is transient and doesn't need context injection.

**Naming:** The hook file is `src/adapters/cc-hooks/setup.ts`. The CLI is `src/cli/setup.ts`. Different directories, no conflict. Build outputs are `dist/adapters/cc-hooks/setup.cjs` vs `dist/cli/setup.cjs`.

**Implementation:**
- Record `setup` event (trigger as entity, 'hook_fired' as action)
- Return `{}`
- Register with `matcher: ""` (both init and maintenance)

**EventType needed:** `setup`

**Key files:**
- `src/adapters/cc-hooks/setup.ts` (new)
- `src/core/session-events.ts` -- `recordEvent()`

---

### H16b -- WorktreeCreate + WorktreeRemove Hooks

**WorktreeCreate payload:**
```typescript
{
  hook_event_name: 'WorktreeCreate'
  name: string                  // suggested worktree slug
  // + base fields
}
```
No matcher field.

**WorktreeCreate return:**
```typescript
hookSpecificOutput: {
  hookEventName: 'WorktreeCreate'
  worktreePath: string         // absolute path to created worktree
}
```
Note: Command hooks write path to stdout instead of returning JSON. Since we don't create worktrees, we return `{}`.

**WorktreeRemove payload:**
```typescript
{
  hook_event_name: 'WorktreeRemove'
  worktree_path: string         // absolute path to the worktree being removed
  // + base fields
}
```
No matcher field.

**WorktreeRemove return:** No specific output schema. Exit code 0 = success.

**When they fire:** WorktreeCreate fires when CC creates a git worktree (e.g., via `/worktree` or the EnterWorktree tool). WorktreeRemove fires when a worktree is removed.

**Decision: Record-only for both.** Log worktree events for multi-workspace session tracking. No worktree creation or path manipulation by Claudex.

**Implementation:**
- **WorktreeCreate:** Record `worktree_create` event (name as entity, 'created' as action). Return `{}`.
- **WorktreeRemove:** Record `worktree_remove` event (worktree_path as entity, 'removed' as action). Return `{}`.
- Register both with `matcher: ""`

**EventTypes needed:** `worktree_create`, `worktree_remove`

**Key files:**
- `src/adapters/cc-hooks/worktree-create.ts` (new)
- `src/adapters/cc-hooks/worktree-remove.ts` (new)
- `src/core/session-events.ts` -- `recordEvent()`

---

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | ConfigChange: record-only, no blocking | No reason to block config changes. Observability only. |
| D2 | InstructionsLoaded: record-only, B3-aware | Observability hook. Known bug: doesn't fire post-compact. Don't rely on it for post-compact detection. |
| D3 | CwdChanged: record + env rewrite + watchPaths, no new session | CC manages session lifecycle. Claudex records the event and updates env/watch state. Cannot inject additionalContext per CC source. |
| D4 | Setup: record-only | Transient event. No context injection needed. |
| D5 | Worktree hooks: record-only | Claudex doesn't create/manage worktrees. Pure event logging for analytics. |
| D6 | All hooks: matcher "" for full data collection | We want to see ALL config/env events to build observability. |
| D7 | New hooks added to optional list in build.ts | Prevents build failures during development. |
| D8 | CwdChanged unit test for env file + watchPaths logic | Only non-trivial hook in this phase. Other hooks are pure event loggers. |

---

## Files to Create

| File | Hook Event | Lines (est.) |
|------|-----------|-------------|
| `src/adapters/cc-hooks/config-change.ts` | ConfigChange | ~25 |
| `src/adapters/cc-hooks/instructions-loaded.ts` | InstructionsLoaded | ~35 |
| `src/adapters/cc-hooks/cwd-changed.ts` | CwdChanged | ~55 |
| `src/adapters/cc-hooks/setup.ts` | Setup | ~20 |
| `src/adapters/cc-hooks/worktree-create.ts` | WorktreeCreate | ~20 |
| `src/adapters/cc-hooks/worktree-remove.ts` | WorktreeRemove | ~20 |

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/session-events.ts` | Add 6 EventType values: `config_change`, `instructions_loaded`, `cwd_changed`, `setup`, `worktree_create`, `worktree_remove` |
| `build.ts` | Add 6 entries to `optionalEntryPoints`. Add to `hookEntryPoints` for smoke testing. |
| `src/cli/setup.ts` | Add 6 entries to `HOOK_FILES` map. Update summary count 17 -> 23. |

## Settings.json Registration

All new hooks use empty matcher (fire for all events of that type):

```json
{
  "ConfigChange": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...config-change.cjs'" }] }],
  "InstructionsLoaded": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...instructions-loaded.cjs'" }] }],
  "CwdChanged": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...cwd-changed.cjs'" }] }],
  "Setup": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...setup.cjs'" }] }],
  "WorktreeCreate": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...worktree-create.cjs'" }] }],
  "WorktreeRemove": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node '...worktree-remove.cjs'" }] }]
}
```

---

## Implementation Order

1. **EventType union** (6 new types -- unblocks all hooks)
2. **ConfigChange** (H8 -- simplest, pure recording)
3. **InstructionsLoaded** (H9 -- simple recording with metadata)
4. **Setup** (H16 -- simple recording)
5. **WorktreeCreate** (H16b-a -- simple recording)
6. **WorktreeRemove** (H16b-b -- simple recording)
7. **CwdChanged** (H10/H15 -- most complex: env rewrite + watchPaths + project re-detection)
8. **build.ts + setup.ts wiring** (6 new hooks registered)
9. **CwdChanged unit test** (env file + watchPaths logic)
10. **Build + test verification** (`bun run build && bun run test`)

---

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| H8 ConfigChange | LOW -- record-only. No behavioral impact. | Return `{}` always. |
| H9 InstructionsLoaded | LOW -- observability-only. B3 bug means no post-compact reliance. | Pure logging. PostCompact hook handles that case. |
| H10/H15 CwdChanged | MEDIUM -- env file rewrite + project re-detection on every cwd change. | `writeClaudeEnvFile()` is non-throwing. Project re-detection is a cheap JSON file read. watchPaths is safe (existence check + array return). |
| H16 Setup | LOW -- transient event logging. | Return `{}` always. |
| H16b Worktree | LOW -- pure recording. | Return `{}` always. |
| Build/setup | LOW -- optional entry points. | Won't break builds. |

---

## CC Source References

| File | Relevant Finding |
|------|-----------------|
| `03-hook-system-deep-dive.md` | ConfigChange payload: source (5 values) + file_path. Exit 2 = block change. |
| `03-hook-system-deep-dive.md` | InstructionsLoaded payload: file_path, memory_type, load_reason, globs, trigger/parent paths. Observability only. |
| `03-hook-system-deep-dive.md` | CwdChanged payload: old_cwd, new_cwd. Returns watchPaths (NOT additionalContext). Sets CLAUDE_ENV_FILE. |
| `03-hook-system-deep-dive.md` | Setup payload: trigger (init/maintenance). Returns additionalContext. |
| `03-hook-system-deep-dive.md` | WorktreeCreate: name. WorktreeRemove: worktree_path. |
| `05-github-issues.md` | B3: InstructionsLoaded doesn't fire after compaction (#30973). |

---

## Existing Infrastructure Reuse

All new hooks use established patterns -- no new shared functions needed:
- `wrapHook()` from `infrastructure.ts` -- stdin/stdout JSON protocol, DB bootstrap, error handling, telemetry
- `recordEvent()` from `session-events.ts` -- structured event logging
- `writeClaudeEnvFile()` from `env-file.ts` -- CLAUDE_ENV_FILE injection (CwdChanged only)
- `detectProjectScope()` + `deriveProjectId()` from `scope-detector.ts` -- project detection (CwdChanged only)

No new shared lifecycle functions needed. 5 of 6 hooks are simple event loggers. CwdChanged is the only hook with non-trivial logic, reusing existing utilities.
