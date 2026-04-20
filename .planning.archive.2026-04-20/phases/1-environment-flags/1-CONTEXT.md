# Phase 1 Context: Environment Flags & CLAUDE_ENV_FILE

**Phase:** 1 of 12
**Items:** X3, T1, T2, T8, C1, C2, B6
**Status:** CONTEXT GATHERED
**Sources:** SYNTHESIS.md, 03-hook-system-deep-dive.md, 04-memory-system.md, 05-github-issues.md, 07-feature-flags-inventory.md, 01-reddit-hooks.md

---

## Item Analysis

### X3 — CLAUDE_ENV_FILE injection (linchpin)

**Mechanism:** CC passes `CLAUDE_ENV_FILE` env var to SessionStart, Setup, CwdChanged, FileChanged hooks. The hook writes bash `export` statements to that file path. CC sources the file before every BashTool command for the rest of the session.

**Implementation:** In `session-start.ts`, read `process.env.CLAUDE_ENV_FILE`, write export lines via `fs.writeFileSync()`. Simple file write, no DB interaction.

**Platform note:** CC source says "bash only, not PowerShell." Our hooks are invoked as `node 'path\to\session-start.cjs'` — Node.js sees the env var via `process.env.CLAUDE_ENV_FILE` regardless of shell. The file content needs bash export syntax (`export KEY=value`).

**Key file:** `src/adapters/cc-hooks/session-start.ts` (line 163, `wrapHook` callback)

### T1 — Disable CC auto-memory

**Env var:** `export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`

**What it disables (all three subsystems):**
1. MEMORY.md static injection into system prompt (~500-2K tokens)
2. `findRelevantMemories` per-turn Sonnet AI selector (~500 tokens/turn + API call)
3. `extractMemories` background agent at turn end (~500-2K tokens/turn)

**What it does NOT disable:** CLAUDE.md loading (separate path via `getMemoryFiles()` which processes User/Project/Local/Managed types independently of AutoMem).

**Gate chain** (`src/memdir/paths.ts:30-54`):
```
1. CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 -> false (HIGHEST PRIORITY)
2. CLAUDE_CODE_SIMPLE (--bare) -> false
3. CLAUDE_CODE_REMOTE && !REMOTE_MEMORY_DIR -> false
4. settings.json autoMemoryEnabled -> its value
5. Default: true
```

**Savings:** ~5,000-11,000 tokens/turn depending on memory dir size and feature flags active.

### T2 — Eliminate memory instruction overhead

**Same mechanism as T1.** When `isAutoMemoryEnabled()` returns false, `loadMemoryPrompt()` returns null. This removes the ~4,000-5,000 token behavioral instructions section from the system prompt (memory type taxonomy, save instructions, access guidelines, etc.).

**T1 + T2 = one env var write.** No separate implementation needed.

### T8 — Save hook additional context

**Env var:** `export CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1`

**Effect:** Preserves hook `additionalContext` in transcript JSONL files. Without this, hook context is filtered out for non-Anthropic users. On session resume, our injected context would be lost.

**Trade-off:** Larger transcript files on disk. Benefit (context preservation on resume) outweighs cost.

**Source:** `12-session-lifecycle.md`

### C1 — GrowthBook flag monitoring

**Flags to monitor:**
- `tengu_passport_quail` — EXTRACT_MEMORIES activation
- `tengu_onyx_plover` — auto-dream activation
- `tengu_moth_copse` — per-turn Sonnet memory selector
- `tengu_marble_fox` — COMPACTION_REMINDERS

**Problem:** These are server-side GrowthBook flags evaluated inside CC's runtime. Not exposed to hook processes. Cannot read them directly.

**Resolution:** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` takes priority 1 in the gate chain, overriding all GrowthBook flags. C1 becomes a defensive verification: scan CC's auto-memory directory for unexpected new files since last session, log warning event if found.

**Practical scope:** Check `~/.claude/projects/<scope>/memory/` for files with mtime newer than last session start. Log `cc_memory_conflict` event if detected.

### C2 — Prevent auto-dream MEMORY.md rewrite

**Already covered by T1/X3.** `autoDreamEnabled` calls `isAutoMemoryEnabled()` internally. When `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set, auto-dream cannot run.

**Belt-and-suspenders option:** Also set `autoDreamEnabled: false` in settings.json. Lower priority than env var but provides fallback.

### B6 — Session ID from hook payload, not env file

**Bug:** #40391 — CLAUDE_ENV_FILE gets wrong session ID after resume.

**Already safe.** Current code uses `input.session_id` from hook payload (session-start.ts line 182). We never read session ID from CLAUDE_ENV_FILE.

**Guard:** Only write session-agnostic env vars (boolean flags) to CLAUDE_ENV_FILE. The two vars we write (DISABLE_AUTO_MEMORY, SAVE_HOOK_ADDITIONAL_CONTEXT) are session-agnostic. B6 is a non-issue.

---

## Design Decisions

### 1. Env file write placement

CC reads the env file **after** the hook completes, not during. Placement within the hook is irrelevant to CC behavior. For readability, place immediately after service startup block (Qdrant/CliProxy/Angel) and before `createSession()`.

### 2. Utility function for reuse

Create a `writeClaudeEnvFile(envVars: Record<string, string>)` function. Future hooks (CwdChanged, FileChanged) will also need to write to CLAUDE_ENV_FILE. Keep it in `src/adapters/shared/` or inline in session-start.ts (depending on whether other hooks need it in Phase 1).

### 3. C1 detection approach

Simple filesystem check at session start:
- Compute CC auto-memory path: `~/.claude/projects/<scope>/memory/`
- Scan for `.md` files with mtime after last session's `created_at_epoch`
- If found, record `cc_memory_conflict` warning event
- Non-blocking, non-fatal — informational only

### 4. Settings.json fallback (decision needed)

Options:
- (A) Env file only — simpler, single mechanism
- (B) Env file + settings.json `autoMemoryEnabled: false` — belt-and-suspenders

Recommendation: (A) for now. The env var is highest priority in CC's gate chain. If it fails, settings.json won't help because the env var mechanism itself would be broken (not a flag priority issue).

---

## Existing Code Touchpoints

| File | Current State | Changes Needed |
|------|--------------|----------------|
| `src/adapters/cc-hooks/session-start.ts` | 383 lines, handles session init, Qdrant/Angel startup, assembly | Add env file write block (~15 lines), add C1 check block (~15 lines) |
| `src/adapters/cc-hooks/infrastructure.ts` | HookInput interface, wrapHook | No changes needed — CLAUDE_ENV_FILE comes from process.env, not stdin payload |

## Dependencies

- **None.** Phase 1 has no dependencies on other phases.
- Phase 1 **enables** Phases 2-3 (injection architecture) by establishing the env flag mechanism.

## Risk Assessment

- **Low risk.** Writing 2 export lines to a file. Failure mode: env var not set, CC memory stays active (current behavior — no regression).
- **Platform risk:** Verify `CLAUDE_ENV_FILE` is available on Windows. CC source confirms it's set for bash-type hooks. Our hooks run via Node.js spawned by CC — env var should propagate.
- **Resume risk:** Mitigated by B6 analysis — we only write session-agnostic vars.

## Estimated Scope

- ~20-30 lines added to `session-start.ts`
- ~1 utility function (optional, for reuse)
- ~50-80 lines of tests
- No new files required, no schema changes, no new dependencies
- Primary value: ~11K tokens/turn savings from disabling CC's memory system
