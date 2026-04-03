# Phase 6 Plan: Config & Environment Hooks

**Phase:** 6 of 12
**Items:** H8, H9, H10/H15, H16, H16b (WorktreeCreate/Remove)
**Status:** PLANNED

---

## Scope

**In scope:** 6 new hook files, 3 existing file modifications (session-events.ts, build.ts, setup.ts), 6 new EventTypes, 1 unit test file (CwdChanged).
**Out of scope:** Config change blocking (H8 exit code 2), InstructionsLoaded post-compact reliance (B3), CwdChanged session creation, Setup additionalContext injection. All hooks except CwdChanged are record-only event loggers.

## Files to Create

| File | Hook Event | Est. Lines |
|------|-----------|-----------|
| `src/adapters/cc-hooks/config-change.ts` | ConfigChange (H8) | ~25 |
| `src/adapters/cc-hooks/instructions-loaded.ts` | InstructionsLoaded (H9) | ~35 |
| `src/adapters/cc-hooks/cwd-changed.ts` | CwdChanged (H10/H15) | ~55 |
| `src/adapters/cc-hooks/setup.ts` | Setup (H16) | ~20 |
| `src/adapters/cc-hooks/worktree-create.ts` | WorktreeCreate (H16b) | ~20 |
| `src/adapters/cc-hooks/worktree-remove.ts` | WorktreeRemove (H16b) | ~20 |

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/session-events.ts` | Add 6 EventType values: `config_change`, `instructions_loaded`, `cwd_changed`, `setup`, `worktree_create`, `worktree_remove` |
| `build.ts` | Add 6 entries to `optionalEntryPoints`. Add 6 smoke payloads. Add 6 entries to `hookEntryPoints`. |
| `src/cli/setup.ts` | Add 6 entries to `HOOK_FILES`. Update summary count 17 -> 23. |

## Implementation Details

### 1. EventType Union (session-events.ts)

Add `'config_change' | 'instructions_loaded' | 'cwd_changed' | 'setup' | 'worktree_create' | 'worktree_remove'` to the EventType union at line 14. No schema migration needed -- `event_type` is plain TEXT in SQLite.

### 2. ConfigChange Hook (H8) -- Simplest, Start Here

**Payload:**
```typescript
{
  hook_event_name: 'ConfigChange'
  source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills'
  file_path?: string
  // + base fields (session_id, transcript_path, cwd, permission_mode)
}
```
**Output:** `{}` (allow change, no blocking)

Logic:
- Extract `source` and `file_path` from payload
- Record `config_change` event: entity=source, action=file_path or 'unknown', detail=undefined
- Return `{}`
- Register with `matcher: ""` (all config sources)

### 3. InstructionsLoaded Hook (H9)

**Payload:**
```typescript
{
  hook_event_name: 'InstructionsLoaded'
  file_path: string
  memory_type: 'User' | 'Project' | 'Local' | 'Managed'
  load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact'
  globs?: string[]
  trigger_file_path?: string
  parent_file_path?: string
  // + base fields
}
```
**Output:** `{}` (observability only)

**B3 awareness:** Does NOT fire after compaction (#30973). PostCompact hook handles that case. No reliance on this hook for post-compact detection.

Logic:
- Extract `file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path`, `parent_file_path`
- Record `instructions_loaded` event: entity=file_path, action=load_reason, detail=JSON with memory_type, globs, trigger_file_path, parent_file_path (omitting undefined fields)
- Return `{}`
- Register with `matcher: ""` (all load reasons)

### 4. Setup Hook (H16)

**Payload:**
```typescript
{
  hook_event_name: 'Setup'
  trigger: 'init' | 'maintenance'
  // + base fields
}
```
**Output:** `{}` (no additionalContext)

**Naming:** Hook file is `src/adapters/cc-hooks/setup.ts`. CLI is `src/cli/setup.ts`. Different directories, no conflict. Build outputs: `dist/adapters/cc-hooks/setup.cjs` vs `dist/cli/setup.cjs`.

Logic:
- Extract `trigger`
- Record `setup` event: entity=trigger, action='hook_fired'
- Return `{}`
- Register with `matcher: ""` (both init and maintenance)

### 5. WorktreeCreate Hook (H16b-a)

**Payload:**
```typescript
{
  hook_event_name: 'WorktreeCreate'
  name: string
  // + base fields
}
```
**Output:** `{}` (Claudex does not create worktrees)

Logic:
- Extract `name`
- Record `worktree_create` event: entity=name, action='created'
- Return `{}`
- Register with `matcher: ""`

### 6. WorktreeRemove Hook (H16b-b)

**Payload:**
```typescript
{
  hook_event_name: 'WorktreeRemove'
  worktree_path: string
  // + base fields
}
```
**Output:** `{}` (exit code 0 = success)

Logic:
- Extract `worktree_path`
- Record `worktree_remove` event: entity=worktree_path, action='removed'
- Return `{}`
- Register with `matcher: ""`

### 7. CwdChanged Hook (H10/H15) -- Most Complex

**Payload:**
```typescript
{
  hook_event_name: 'CwdChanged'
  old_cwd: string
  new_cwd: string
  // + base fields
  // CC also sets CLAUDE_ENV_FILE env var
}
```
**Output:**
```typescript
{
  hookSpecificOutput: {
    hookEventName: 'CwdChanged',
    watchPaths: string[]
  }
}
```

**Key constraint:** CwdChanged cannot return `additionalContext` per CC source -- only `watchPaths`.

Logic:
1. Extract `old_cwd` and `new_cwd` from payload
2. Call `writeClaudeEnvFile()` -- rewrites env flags for the new directory (CC passes CLAUDE_ENV_FILE in env)
3. Re-detect project scope: `detectProjectScope(new_cwd)` + `deriveProjectId(new_cwd)`
4. Record `cwd_changed` event: entity=new_cwd, action=old_cwd, detail=JSON with detected project/scope
5. Build `watchPaths` for the new project's ACTIVE.md and CLAUDE.md (same logic as session-start.ts lines 391-398):
   - Check `path.join(new_cwd, 'context', 'handoffs', 'ACTIVE.md')` -- add if exists
   - Check `path.join(new_cwd, 'CLAUDE.md')` -- add if exists
6. Return `{ hookSpecificOutput: { hookEventName: 'CwdChanged', watchPaths } }`

**Imports needed (beyond wrapHook/recordEvent):**
- `writeClaudeEnvFile` from `../../adapters/shared/env-file.js`
- `detectProjectScope`, `deriveProjectId` from `../../shared/scope-detector.js`
- `fs` (existsSync) and `path` (join) from Node.js

**Note:** `wrapHook` calls `bootstrapHook(input)` which already calls `detectProjectScope(input.cwd)` and `deriveProjectId(input.cwd)` on `input.cwd`. But `input.cwd` is the original session cwd, NOT `new_cwd`. CwdChanged must re-detect for `new_cwd` specifically. The ctx.project from bootstrapHook reflects the OLD project -- the event recording uses ctx for the session_id/old project, but the detail captures the NEW project detection.

### 8. Build & Setup Wiring

**build.ts -- optionalEntryPoints (6 new):**
```typescript
'src/adapters/cc-hooks/config-change.ts',
'src/adapters/cc-hooks/instructions-loaded.ts',
'src/adapters/cc-hooks/cwd-changed.ts',
'src/adapters/cc-hooks/setup.ts',
'src/adapters/cc-hooks/worktree-create.ts',
'src/adapters/cc-hooks/worktree-remove.ts',
```

**build.ts -- hookEntryPoints (6 new):**
```typescript
'dist/adapters/cc-hooks/config-change.cjs',
'dist/adapters/cc-hooks/instructions-loaded.cjs',
'dist/adapters/cc-hooks/cwd-changed.cjs',
'dist/adapters/cc-hooks/setup.cjs',
'dist/adapters/cc-hooks/worktree-create.cjs',
'dist/adapters/cc-hooks/worktree-remove.cjs',
```

**build.ts -- smoke payloads (6 new):**
```typescript
'config-change': { session_id: '__smoke__', source: 'project_settings', file_path: '/tmp/CLAUDE.md', cwd },
'instructions-loaded': { session_id: '__smoke__', file_path: '/tmp/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start', cwd },
'cwd-changed': { session_id: '__smoke__', old_cwd: cwd, new_cwd: cwd, cwd },
'setup': { session_id: '__smoke__', trigger: 'init', cwd },
'worktree-create': { session_id: '__smoke__', name: 'smoke-worktree', cwd },
'worktree-remove': { session_id: '__smoke__', worktree_path: '/tmp/smoke-worktree', cwd },
```

**setup.ts -- HOOK_FILES (6 new entries):**
```typescript
ConfigChange: path.join('adapters', 'cc-hooks', 'config-change.cjs'),
InstructionsLoaded: path.join('adapters', 'cc-hooks', 'instructions-loaded.cjs'),
CwdChanged: path.join('adapters', 'cc-hooks', 'cwd-changed.cjs'),
Setup: path.join('adapters', 'cc-hooks', 'setup.cjs'),
WorktreeCreate: path.join('adapters', 'cc-hooks', 'worktree-create.cjs'),
WorktreeRemove: path.join('adapters', 'cc-hooks', 'worktree-remove.cjs'),
```

**setup.ts -- summary count:** Change `Hooks: 17 registered` to `Hooks: 23 registered` (line 233).

### 9. CwdChanged Unit Test

Only CwdChanged has non-trivial logic worth unit testing. The other 5 hooks are pure event loggers that follow the exact same pattern as Phase 5 hooks.

**Test file:** `src/tests/adapters/cc-hooks/cwd-changed.test.ts`

Test cases:
1. **Calls writeClaudeEnvFile** -- verify env file write is invoked (mock CLAUDE_ENV_FILE env var, check file written)
2. **Re-detects project scope for new_cwd** -- verify detectProjectScope is called with new_cwd, not old_cwd
3. **Records cwd_changed event** -- verify recordEvent called with entity=new_cwd, action=old_cwd, detail containing new project
4. **Returns watchPaths for existing files** -- create temp CLAUDE.md and ACTIVE.md, verify they appear in watchPaths
5. **Returns empty watchPaths when files don't exist** -- verify watchPaths is empty array when neither file exists
6. **Returns hookSpecificOutput with correct hookEventName** -- verify output shape matches `{ hookSpecificOutput: { hookEventName: 'CwdChanged', watchPaths } }`

**Approach:** Test the handler logic directly rather than the full wrapHook flow. Extract the core logic into a testable function or test via the exported module pattern used in other hook tests.

## Implementation Order

1. EventType union changes (unblocks all hooks)
2. ConfigChange (H8) -- simplest, pure recording
3. InstructionsLoaded (H9) -- simple recording with metadata
4. Setup (H16) -- simple recording
5. WorktreeCreate (H16b-a) -- simple recording
6. WorktreeRemove (H16b-b) -- simple recording
7. CwdChanged (H10/H15) -- most complex: env rewrite + watchPaths + project re-detection
8. build.ts + setup.ts wiring (6 new hooks registered)
9. CwdChanged unit test
10. Build + test verification (`bun run build && bun run test`)

## Parallelization

Steps 2-6 are independent and can be implemented in parallel by separate agents. Step 7 depends on step 1. Steps 8-9 depend on steps 2-7.

**Recommended waves:**
- **Wave 1:** Step 1 (EventType) -- single file edit, unblocks everything
- **Wave 2:** Steps 2-7 (all 6 hook files) -- fully parallel, no dependencies between them
- **Wave 3:** Step 8 (build.ts + setup.ts wiring) -- depends on all hooks existing
- **Wave 4:** Step 9 (CwdChanged test) -- depends on CwdChanged implementation
- **Wave 5:** Step 10 (build + test verification)

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | ConfigChange: record-only, no blocking | No reason to block config changes. Observability only. |
| D2 | InstructionsLoaded: record-only, B3-aware | Observability hook. Known bug: doesn't fire post-compact. Don't rely on it. |
| D3 | CwdChanged: record + env rewrite + watchPaths, no new session | CC manages session lifecycle. Claudex records event and updates env/watch state. Cannot inject additionalContext. |
| D4 | Setup: record-only | Transient event. No context injection needed. |
| D5 | Worktree hooks: record-only | Claudex doesn't create/manage worktrees. Pure event logging. |
| D6 | All hooks: matcher "" | Full data collection for observability. |
| D7 | New hooks added to optional list in build.ts | Prevents build failures during development. |
| D8 | CwdChanged is the only hook with a unit test | Other hooks are trivial event loggers. CwdChanged has env rewrite + watchPaths + project re-detection. |

## Infrastructure Reuse

All hooks use established patterns -- no new shared functions needed:
- `wrapHook()` from `infrastructure.ts` -- stdin/stdout JSON protocol, DB bootstrap, error handling, telemetry
- `recordEvent()` from `session-events.ts` -- structured event logging
- `writeClaudeEnvFile()` from `env-file.ts` -- CLAUDE_ENV_FILE injection (CwdChanged only)
- `detectProjectScope()` + `deriveProjectId()` from `scope-detector.ts` -- project detection (CwdChanged only)

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| H8 ConfigChange | LOW -- record-only | Return `{}` always. No behavioral impact. |
| H9 InstructionsLoaded | LOW -- observability-only, B3 bug means no post-compact reliance | Pure logging. PostCompact hook handles that case. |
| H10/H15 CwdChanged | MEDIUM -- env file rewrite + project re-detection on every cwd change | `writeClaudeEnvFile()` is non-throwing. `detectProjectScope()` is a cheap JSON file read. watchPaths uses existsSync (non-throwing). |
| H16 Setup | LOW -- transient event logging | Return `{}` always. |
| H16b Worktree | LOW -- pure recording | Return `{}` always. |
| Build/setup | LOW -- optional entry points | Won't break builds. |

## Verification Criteria

- [ ] All 6 new hook files exist and follow wrapHook pattern
- [ ] EventType union includes 6 new types
- [ ] CwdChanged calls writeClaudeEnvFile(), re-detects project scope, returns watchPaths
- [ ] CwdChanged returns hookSpecificOutput with hookEventName: 'CwdChanged'
- [ ] build.ts compiles all 6 new hooks without errors
- [ ] setup.ts registers all 23 hooks in settings.json
- [ ] Smoke tests pass for all 6 new hooks
- [ ] CwdChanged unit test passes (env file + watchPaths + project re-detection)
- [ ] `bun run build` succeeds
- [ ] `bun run test` passes (all existing + new tests)
