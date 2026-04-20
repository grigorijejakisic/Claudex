# Phase 1 Plan: Environment Flags & CLAUDE_ENV_FILE

**Phase:** 1 of 12
**Items:** X3, T1, T2, T8, C1, C2, B6
**Status:** PLANNED

---

## Wave 1 — Core env file write (X3 + T1 + T2 + T8 + B6)

**File:** `src/adapters/cc-hooks/session-start.ts`

### What to do

Add a `writeClaudeEnvFile()` block after the three `ensure*Running()` calls and before `createSession()`. This block:

1. Reads `process.env.CLAUDE_ENV_FILE`
2. If present, writes two bash export lines to that path via `fs.writeFileSync()`
3. If absent, skips silently (env var not available = older CC version or non-bash shell)

### Exact content to write

```bash
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
export CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1
```

### Why this placement

- After service startup (Qdrant/CliProxy/Angel) — those are infrastructure, not session logic
- Before `createSession()` — env vars should be set before any session-specific work
- CC reads the env file **after** the hook process exits, not during — so placement within the hook is about readability, not execution order

### Item coverage

| Item | How covered |
|------|-------------|
| X3 | `process.env.CLAUDE_ENV_FILE` read + `fs.writeFileSync()` |
| T1 | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` disables all 3 CC auto-memory subsystems (injection, retrieval, extraction) |
| T2 | Same env var — when `isAutoMemoryEnabled()` returns false, `loadMemoryPrompt()` returns null, removing ~4-5K token behavioral instructions |
| T8 | `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1` preserves hook `additionalContext` in transcript JSONL |
| B6 | We only write session-agnostic boolean flags. Session ID comes from `input.session_id` (hook payload), never from env file. No code change needed — document as safe-by-design. |

### Implementation detail

```typescript
// Write CLAUDE_ENV_FILE — inject env flags for CC's bash environment.
// CC sources this file before every BashTool command for the session.
// T1/T2: Disable CC auto-memory (~11K tokens/turn saved).
// T8: Preserve hook additionalContext in transcripts for session resume.
// B6: Only session-agnostic flags — session ID sourced from hook payload, not env file.
try {
  const envFilePath = process.env.CLAUDE_ENV_FILE;
  if (envFilePath) {
    fs.writeFileSync(envFilePath, [
      'export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
      'export CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1',
      '',
    ].join('\n'));
  }
} catch { /* Non-fatal — env file mechanism is best-effort */ }
```

Lines added: ~10. No new imports needed (`fs` already imported).

### Verification

- `process.env.CLAUDE_ENV_FILE` is set by CC for SessionStart hooks (confirmed in CC source: `hooks.ts`, `sessionEnvironment.ts:74`)
- The env file uses bash export syntax — CC sources it as a bash script
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is priority 1 in CC's gate chain (`paths.ts:30-54`), overriding all GrowthBook flags and settings.json
- `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1` preserves hook context in transcript JSONL

---

## Wave 2 — GrowthBook flag monitoring (C1)

**File:** `src/adapters/cc-hooks/session-start.ts`

### What to do

Add a CC auto-memory conflict detection block after `createSession()` (after the orphan cleanup block). This checks for unexpected CC auto-memory file activity despite our env var disabling it.

### Why needed

GrowthBook flags (`tengu_passport_quail`, `tengu_onyx_plover`, `tengu_moth_copse`, `tengu_marble_fox`) are server-side and not exposed to hooks. Our `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` takes priority 1 in CC's gate chain, overriding all flags. But if the mechanism fails (CC bug, env file not read), CC memory subsystems could activate silently. This check detects that scenario.

### Implementation detail

```typescript
// C1: GrowthBook flag conflict detection — verify CC auto-memory stays disabled.
// If CC wrote memory files since our last session, the env flag mechanism may have failed.
try {
  const ccAutoMemDir = path.join(os.homedir(), '.claude', 'projects',
    ctx.scope ?? ctx.project, 'memory');
  if (fs.existsSync(ccAutoMemDir)) {
    // Get last session's start time as baseline
    const lastSession = cachedPrepare(ctx.db,
      `SELECT created_at_epoch FROM sessions WHERE project = ? AND session_id != ? ORDER BY created_at_epoch DESC LIMIT 1`
    ).get(ctx.project, input.session_id) as { created_at_epoch: number } | undefined;

    if (lastSession) {
      const baselineMs = lastSession.created_at_epoch * 1000;
      const entries = fs.readdirSync(ccAutoMemDir).filter(f => f.endsWith('.md'));
      const newFiles = entries.filter(f => {
        try {
          const stat = fs.statSync(path.join(ccAutoMemDir, f));
          return stat.mtimeMs > baselineMs;
        } catch { return false; }
      });

      if (newFiles.length > 0) {
        recordEvent(ctx.db, input.session_id, ctx.project,
          'cc_memory_conflict', 'session_start', 'warning',
          JSON.stringify({ new_files: newFiles, since_epoch: lastSession.created_at_epoch }),
        );
      }
    }
  }
} catch { /* Non-fatal — detection is best-effort */ }
```

Lines added: ~25. No new imports needed (`cachedPrepare`, `recordEvent`, `path`, `os`, `fs` already imported).

### C2 coverage

C2 (prevent auto-dream MEMORY.md rewrite) is automatically covered by T1/X3. `autoDreamEnabled` calls `isAutoMemoryEnabled()` internally — when `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set, auto-dream cannot run. The C1 conflict detection also catches dream-generated files (they'd appear as new `.md` files in the memory directory). No separate implementation needed.

---

## Wave 3 — Tests

**File:** `src/tests/adapters/cc-hooks/hooks.test.ts` (add new describe block)

### Test cases

1. **`writeClaudeEnvFile writes correct exports when CLAUDE_ENV_FILE is set`**
   - Set `process.env.CLAUDE_ENV_FILE` to a temp path
   - Call the env file write logic (extracted as testable function or inline)
   - Read the file back, verify it contains both export lines
   - Clean up env var and temp file

2. **`writeClaudeEnvFile skips silently when CLAUDE_ENV_FILE is not set`**
   - Ensure `process.env.CLAUDE_ENV_FILE` is unset
   - Verify no error thrown, no file written

3. **`writeClaudeEnvFile handles write failure gracefully`**
   - Set `CLAUDE_ENV_FILE` to an invalid/unwritable path
   - Verify no error propagated (non-fatal)

4. **`C1 detection finds new memory files after baseline`**
   - Create a test memory directory with files whose mtime is after a baseline epoch
   - Run C1 detection logic
   - Verify `cc_memory_conflict` event recorded in DB

5. **`C1 detection is silent when no new files exist`**
   - Create memory directory with old files
   - Run C1 detection logic
   - Verify no `cc_memory_conflict` event recorded

6. **`env file only contains session-agnostic flags (B6 guard)`**
   - Write env file, parse content
   - Verify no session_id, no session-specific values present
   - Only boolean flags allowed

### Testability approach

Extract the env file write and C1 detection into standalone functions (either in `session-start.ts` as named functions, or in `src/adapters/shared/env-file.ts` if we want reuse by future CwdChanged/FileChanged hooks). The main `wrapHook` callback calls these functions. Tests import and call them directly.

**Recommendation:** Create `src/adapters/shared/env-file.ts` with:
- `writeClaudeEnvFile(): void` — reads `process.env.CLAUDE_ENV_FILE`, writes exports
- `detectCcMemoryConflict(db, sessionId, project, scope): string[]` — returns list of conflicting files

This keeps session-start.ts clean and enables reuse when CwdChanged/FileChanged hooks are added in later phases.

---

## File Changes Summary

| File | Action | Lines |
|------|--------|-------|
| `src/adapters/shared/env-file.ts` | **CREATE** | ~40 |
| `src/adapters/cc-hooks/session-start.ts` | EDIT — add import + 2 call sites | ~10 |
| `src/tests/adapters/cc-hooks/hooks.test.ts` | EDIT — add `describe('Environment flags')` block | ~80 |

**Total:** ~130 lines across 3 files (1 new, 2 modified).

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `CLAUDE_ENV_FILE` not set on Windows | Low (CC sets it for bash hooks, our hooks run via Node.js) | Silent skip — no regression if absent |
| CC changes env var gate chain priority | Very low | C1 detection catches the failure retroactively |
| File write fails (permissions, disk) | Very low | Non-fatal try/catch, hook continues normally |
| C1 false positive (user manually created memory file) | Low | Warning event only — informational, not blocking |

---

## Acceptance Criteria

1. After session start, `CLAUDE_ENV_FILE` contains both export lines (when env var is present)
2. CC auto-memory is disabled for the session (verified by absence of new files in `~/.claude/projects/<scope>/memory/`)
3. Hook `additionalContext` is preserved in transcript JSONL (verified by checking transcript after a few turns)
4. `cc_memory_conflict` event is recorded if CC memory files appear despite the disable flag
5. No session ID or session-specific data written to env file (B6)
6. All 6 test cases pass
7. Existing tests unaffected (`bun run test` passes)
