# Phase 7 Context: Advanced Hook Execution

**Phase:** 7 of 12
**Items:** X1, X2, X4, X5, X6, X7, X9, X10
**Status:** CONTEXT GATHERED
**Sources:** SYNTHESIS.md, 03-hook-system-deep-dive.md, 14-tools-pre-post-hooks.md, existing hook infrastructure
**Dependencies:** None (execution model changes, independent of hook events)

---

## Pre-existing State

**All current hooks** are `type: "command"` — Node.js scripts spawned by CC, communicating via stdin (JSON payload) and stdout (JSON response). Phase 7 expands the execution model with async, prompt, agent, and HTTP types.

**infrastructure.ts** (`src/adapters/cc-hooks/infrastructure.ts`): Contains `wrapHook()` — the shared wrapper for all hook entry points. Reads stdin once, bootstraps DB, runs handler, writes JSON to stdout. Currently synchronous (completes before returning).

**settings.json** (`~/.claude/settings.json`): Registers hooks under event keys. All hooks use `"type": "command"`. Phase 7 adds `"async": true` config and one `"type": "prompt"` hook.

**PreToolUse** (`src/adapters/cc-hooks/pre-tool-use.ts`): Matches `"Agent"` only. Injects Claudex awareness into subagent prompts. Phase 7 could add `if` conditions for finer filtering.

**PostToolUse** (`src/adapters/cc-hooks/post-tool-use.ts`): Matches `""` (all tools). Extraction work (observations, decisions, patterns). Candidate for `"async": true` to avoid blocking the model.

---

## Item Analysis

### X1 -- Async Hook Protocol (IMPLEMENT: config-only)

**CC capability:**
- Settings-level: `"async": true` on any hook command in settings.json
- Runtime-level: hook outputs `{"async": true}` as first stdout line (CC backgrounds immediately)
- `asyncTimeout` defaults to 15 seconds
- `asyncRewake: true` — background hook that wakes model on exit code 2 (via notification queue)

**Decision: PostToolUse gets `"async": true` in settings.json.** No code changes. CC manages the backgrounding — the hook script runs identically, CC just doesn't wait for it.

**Rationale:** PostToolUse does extraction work (observations, decisions, patterns, DB writes). This blocks the model between tool calls. With async, the model proceeds to its next action while extraction happens in background. CC sequences async hook completion before the next hook dispatch, so DB ordering is maintained.

**What NOT to make async:**
- SessionStart — model needs the additionalContext before proceeding
- UserPromptSubmit — model needs the additionalContext before proceeding
- PreToolUse — model needs the permissionDecision/updatedInput before tool execution
- Stop — model needs the continue/block decision before ending

**Implementation:**
- Add `"async": true` to PostToolUse hook config in settings.json
- No code changes to any `.ts` files
- Verify via manual test: model should not wait for PostToolUse extraction to complete

**Risk:** LOW. Config-only change. Revert by removing `"async": true`.

---

### X2 -- Interactive Prompt Protocol (DEFER: document only)

**CC capability:**
- Hook writes `{"prompt": "id", "message": "...", "options": [...]}` to stdout
- CC displays dialog to user, response comes back on stdin as `{"prompt_response": "id", "selected": "..."}`
- Confirmed in CC source (hooks.ts lines 1062-1105)
- Completely undocumented

**Decision: DEFER.** The current `readStdin()` in infrastructure.ts reads all stdin at once and resolves. Interactive prompts require bidirectional streaming stdin — a fundamental rewrite of the hook I/O model. No compelling use case justifies this now.

**Potential future use cases:**
- Session transfer acceptance: "Transfer received from session X. Accept? [yes/no]"
- Dangerous operation confirmation during hooks
- Ambiguous context resolution

**Documentation:** Record capability details in this CONTEXT.md. No code or config changes.

---

### X4 -- Agent-Type Hooks (DEFER: document only)

**CC capability:**
- `"type": "agent"` in settings.json — spawns a full multi-turn Claude subagent with tool access
- Returns `{"ok": true/false, "reason": "..."}` via SyntheticOutputTool
- Max 50 turns, default 60s timeout
- `$ARGUMENTS` substitution in prompt field
- Can specify model (e.g., `claude-sonnet-4-6`)

**Decision: DEFER.** Agent hooks are expensive (each fires a full API call chain). Claudex already does verification and extraction programmatically. No current hook event benefits enough from LLM reasoning to justify the token cost.

**Critical constraint (B7):** Agent-type hooks silently fail on SessionEnd/Stop events. Must use command-type for those. This is a hard CC bug, not a Claudex issue.

**Documentation:** Record capability details and B7 restriction in this CONTEXT.md. No code or config changes.

---

### X5 -- HTTP-Type Hooks (DEFER: document only)

**CC capability:**
- `"type": "http"` in settings.json — POSTs JSON to a URL
- Supports env var interpolation in headers via `allowedEnvVars`
- SSRF guard: blocks private/link-local IPs, allows loopback
- NOT supported for SessionStart or Setup (sandbox deadlock risk)
- URL allowlist: `settings.allowedHttpHookUrls`

**Decision: DEFER.** Requires Angel to expose an HTTP API, which is a separate body of work. Hook-to-Angel communication currently works via shared SQLite DB, which is sufficient.

**Potential future use:** If Angel adds an HTTP server, hooks could POST directly to `http://localhost:PORT/hook` for richer communication than DB polling.

**Documentation:** Record capability details and SessionStart/Setup exclusion in this CONTEXT.md. No code or config changes.

---

### X6 -- Prompt-Type Hooks (IMPLEMENT: one example hook)

**CC capability:**
- `"type": "prompt"` in settings.json — one-shot LLM call
- `$ARGUMENTS` substitution in prompt text
- Returns `{"ok": true/false}`
- Default 30s timeout, can specify model
- CC manages the LLM call — does NOT violate the hook deadlock rule (Claudex code doesn't call CC's API; CC itself does)

**Decision: Add one example prompt-type hook for demonstration.** A PreCompact prompt hook that asks whether important unsaved context exists before compaction. Uses `claude-haiku-4-5` for minimal cost.

**Implementation:**
- Add a prompt-type PreCompact hook to settings.json:
  ```json
  {
    "type": "prompt",
    "prompt": "The following is a compaction event payload. Check if the custom_instructions mention any critical unsaved state that should be preserved. If the instructions are null or empty, return ok. Payload: $ARGUMENTS",
    "model": "claude-haiku-4-5",
    "timeout": 15
  }
  ```
- This is a config-only addition. No code changes.
- The existing command-type PreCompact hook continues to run in parallel (CC runs all matching hooks in parallel)

**Risk:** LOW. Prompt hooks that return `{"ok": true}` are pass-through. Worst case: 15s timeout, treated as non-blocking error.

**Trade-off:** Each PreCompact event costs one Haiku API call. Compaction is infrequent (typically 2-5 times per session), so token cost is negligible.

---

### X7 -- Command Arrays (NOT SUPPORTED: document only)

**CC state:** The hook command schema in `coreSchemas.ts` defines `command` as `string`. There is no array variant. The `shell` field controls which shell parses the string command.

**Decision: NOT IMPLEMENTABLE.** CC does not support command arrays. All hooks must use string commands. Shell injection is not a risk for Claudex because all hook commands are static `node 'path/to/script.cjs'` strings with no dynamic interpolation.

**Documentation:** Record as "not available in current CC version, monitor for future support."

---

### X9 -- Environment Variables in Hooks (IMPLEMENT: documentation)

**CC provides these env vars to hook commands:**

```bash
# Always present
CLAUDE_PROJECT_DIR=/absolute/path/to/project/root  # NOT worktree path, always real root

# Present for SessionStart, Setup, CwdChanged, FileChanged hooks (bash only, not PowerShell)
CLAUDE_ENV_FILE=/path/to/env-file.sh  # write bash exports here to set env for BashTool

# Present for plugins and skills
CLAUDE_PLUGIN_ROOT=/path/to/plugin-or-skill/root
CLAUDE_PLUGIN_DATA=/path/to/plugin/data-dir
CLAUDE_PLUGIN_OPTION_*=value  # from plugin manifest userConfig
```

**Current Claudex state:** Hooks use `cwd` from stdin JSON payload, not `CLAUDE_PROJECT_DIR` env var. `CLAUDE_ENV_FILE` is handled by `writeClaudeEnvFile()` in `env-file.ts` (Phase 1 work). Plugin vars are irrelevant until Claudex becomes a plugin (Phase 12/E1).

**Decision: Document available env vars in infrastructure.ts code comments.** No behavioral changes. The `CLAUDE_PROJECT_DIR` env var is a useful fallback if stdin parsing fails, but the current stdin-based approach is more reliable (env vars are only set for command-type hooks in bash shell, not PowerShell).

**Implementation:**
- Add JSDoc comment to `wrapHook()` in infrastructure.ts documenting available env vars
- No behavioral changes

---

### X10 -- Matchers Beyond tool_name (IMPLEMENT: config tuning)

**CC matcher capabilities:**
- Empty/`*` = match all
- `Write` = exact match
- `Write|Edit|Bash` = pipe-separated OR
- `^Write.*` = full JS regex
- `if` field: second-level filter using permission rule syntax (PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest only)
  - `"if": "Bash(git push*)"` = only fire for Bash tool calls matching `git push*`
  - `"if": "Write(/etc/*)"` = only fire for Write tool calls targeting `/etc/`

**Per-event matcher targets (complete table):**

| Event | Matched Against |
|-------|----------------|
| PreToolUse | `tool_name` |
| PostToolUse | `tool_name` |
| SessionStart | `source` ('startup'/'resume'/'clear'/'compact') |
| PreCompact | `trigger` ('manual'/'auto') |
| PostCompact | `trigger` ('manual'/'auto') |
| SessionEnd | `reason` |
| StopFailure | `error` type |
| SubagentStart | `agent_type` |
| SubagentStop | `agent_type` |
| ConfigChange | `source` |
| InstructionsLoaded | `load_reason` |
| FileChanged | `basename(file_path)` |
| Stop, UserPromptSubmit, TeammateIdle, TaskCreated, TaskCompleted, CwdChanged, WorktreeCreate, WorktreeRemove | N/A (no matcher, always fires) |

**Current state:**
- PreToolUse: `matcher: "Agent"` — only fires for Agent tool calls
- PostToolUse: `matcher: ""` — fires for all tools
- All other hooks: `matcher: ""` — fires for all events

**Decision: Do NOT split PostToolUse into multiple matchers.** Process spawn overhead (one Node.js process per matched hook) makes splitting counterproductive. The single PostToolUse hook already dispatches internally based on tool_name.

**Decision: Expand PreToolUse matcher from "Agent" to "" (all tools).** Currently PreToolUse only fires for Agent tool calls. With empty matcher, it fires for all tools, enabling:
- X8 permission decisions for any tool (infrastructure already wired in pre-tool-use.ts)
- Future `if` conditions for targeted interception

**Implementation:**
- Change PreToolUse matcher from `"Agent"` to `""` in settings.json
- The existing code already handles non-Agent tools (returns `{}` or permission decision)
- No code changes needed

**Risk:** LOW. PreToolUse already handles non-Agent tools gracefully. Expanding the matcher just means it fires more often. Performance impact: one extra Node.js spawn per tool call (~50ms).

---

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | X1: PostToolUse async via settings config only | CC manages async sequencing. No code change needed. PostToolUse is the only hook where blocking costs model time. |
| D2 | X2: DEFER interactive prompts | stdin rewrite is high-risk infrastructure for speculative use case. |
| D3 | X4: DEFER agent-type hooks | Expensive (API tokens per invocation). B7 bug on Stop/SessionEnd. No current use case justifies cost. |
| D4 | X5: DEFER HTTP hooks | Requires Angel HTTP API — separate body of work. DB-based communication is sufficient. |
| D5 | X6: One prompt-type PreCompact hook as example | Demonstrates capability. Haiku model, minimal cost, infrequent event. |
| D6 | X7: NOT SUPPORTED by CC | Command schema is `string` only. No array variant exists. |
| D7 | X9: Document env vars in code comments | No behavioral change. Env vars are informational. stdin payload is the reliable data source. |
| D8 | X10: Expand PreToolUse matcher to "" (all tools) | Enables X8 permission decisions for any tool. No code changes — existing handler is compatible. |
| D9 | X10: Do NOT split PostToolUse by matcher | Process spawn overhead outweighs benefit. Internal dispatch is cheaper. |

---

## Files to Create

None. Phase 7 is config + documentation only.

## Files to Modify

| File | Changes |
|------|---------|
| `~/.claude/settings.json` | (1) Add `"async": true` to PostToolUse hook. (2) Add prompt-type PreCompact hook. (3) Change PreToolUse matcher from `"Agent"` to `""`. |
| `src/adapters/cc-hooks/infrastructure.ts` | Add JSDoc documenting CC-provided env vars to `wrapHook()`. |

## Settings.json Changes (Exact)

**PostToolUse — add async:**
```json
"PostToolUse": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "node 'C:\\Users\\Grigorije\\Desktop\\Projects\\CLAUDEXv3\\dist\\adapters\\cc-hooks\\post-tool-use.cjs'",
        "async": true
      }
    ]
  }
]
```

**PreCompact — add prompt-type hook alongside existing command hook:**
```json
"PreCompact": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "node 'C:\\Users\\Grigorije\\Desktop\\Projects\\CLAUDEXv3\\dist\\adapters\\cc-hooks\\pre-compact.cjs'"
      },
      {
        "type": "prompt",
        "prompt": "The following is a compaction event payload. If custom_instructions is null or empty, return ok=true. If custom_instructions contains text, check whether it mentions unsaved work, critical state, or items that must survive compaction. Return ok=true if nothing critical, ok=false if critical state may be lost. Payload: $ARGUMENTS",
        "model": "claude-haiku-4-5",
        "timeout": 15
      }
    ]
  }
]
```

**PreToolUse — expand matcher:**
```json
"PreToolUse": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "node 'C:\\Users\\Grigorije\\Desktop\\Projects\\CLAUDEXv3\\dist\\adapters\\cc-hooks\\pre-tool-use.cjs'"
      }
    ]
  }
]
```

---

## Implementation Order

1. **settings.json: PostToolUse async** (X1) — add `"async": true`
2. **settings.json: PreToolUse matcher expansion** (X10) — change `"Agent"` to `""`
3. **settings.json: PreCompact prompt hook** (X6) — add prompt-type hook
4. **infrastructure.ts: env var documentation** (X9) — JSDoc comment
5. **Verification** — manual test: confirm model doesn't wait for PostToolUse, PreToolUse fires for non-Agent tools, PreCompact prompt hook runs alongside command hook

---

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| X1 PostToolUse async | LOW — config-only, CC manages sequencing | Revert by removing `"async": true` |
| X6 PreCompact prompt | LOW — pass-through on `ok: true`, infrequent event | 15s timeout, Haiku model, non-blocking on failure |
| X10 PreToolUse matcher "" | LOW — existing code handles non-Agent tools gracefully | Returns `{}` for non-Agent, adds ~50ms per tool call |
| X9 env var docs | NONE — code comment only | No behavioral change |
| X2/X4/X5/X7 deferred | NONE — no implementation | Documented for future phases |

---

## CC Source References

| File | Relevant Finding |
|------|-----------------|
| `03-hook-system-deep-dive.md` S12 | Async protocol: `{"async": true}` first line or settings `"async": true`. `asyncTimeout` default 15s. `asyncRewake` for monitoring hooks. |
| `03-hook-system-deep-dive.md` S19 | Interactive prompt protocol: `{"prompt": "id", "message": "...", "options": [...]}` on stdout. Response on stdin. |
| `03-hook-system-deep-dive.md` S13 | 6 hook types: command, prompt, agent, http, callback, function. Prompt: `$ARGUMENTS` substitution, `{"ok": true/false}` return. Agent: 50-turn max, SyntheticOutputTool. HTTP: SSRF guard, allowedEnvVars. |
| `03-hook-system-deep-dive.md` S15 | Env vars: CLAUDE_PROJECT_DIR (always), CLAUDE_ENV_FILE (SessionStart/Setup/CwdChanged/FileChanged), CLAUDE_PLUGIN_* (plugins). |
| `03-hook-system-deep-dive.md` S17 | Matcher: empty/`*`/exact/pipe-separated/regex. `if` field: permission rule syntax for PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest. |
| `14-tools-pre-post-hooks.md` | updatedInput: replaces full processed input, no re-validation. updatedMCPToolOutput: MCP-only. |
| `05-github-issues.md` | B7: Agent-type hooks silently fail on SessionEnd/Stop (#40010). |

---

## Deferred Capabilities Reference

For future phases, these capabilities are available but not implemented:

**Interactive Prompts (X2):**
- Protocol: `{"prompt": "id", "message": "text", "options": [{key, label}]}` on stdout
- Response: `{"prompt_response": "id", "selected": "key"}` on stdin
- Requires streaming stdin (infrastructure.ts rewrite)

**Agent Hooks (X4):**
- Config: `{"type": "agent", "prompt": "...", "model": "claude-sonnet-4-6", "timeout": 60}`
- Returns: `{"ok": true/false, "reason": "..."}`
- Constraint: B7 — cannot use for Stop/SessionEnd events
- Cost: Full API call chain per invocation

**HTTP Hooks (X5):**
- Config: `{"type": "http", "url": "...", "headers": {"Authorization": "Bearer $TOKEN"}, "allowedEnvVars": ["TOKEN"]}`
- Constraint: Not supported for SessionStart/Setup
- Requires: HTTP endpoint (Angel/OpenClaw)

**Command Arrays (X7):**
- Not supported by CC. Schema: `command: string` only.
- Monitor CC updates for future array support.

**asyncRewake (X1 variant):**
- `"asyncRewake": true` — background hook that wakes model on exit code 2
- Useful for monitoring hooks. Not implemented yet — no monitoring hooks exist that need this pattern.
