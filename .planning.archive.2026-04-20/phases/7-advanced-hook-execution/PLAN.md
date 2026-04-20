# Phase 7: Advanced Hook Execution — PLAN

**Status:** COMPLETE
**Type:** LIGHT PHASE — config + documentation only, no new source files

---

## Implement (4 items)

### X1: PostToolUse async flag
- **File:** `~/.claude/settings.json`
- **Change:** Add `"async": true` to PostToolUse hook command
- **Rationale:** PostToolUse does extraction work (observations, decisions, DB writes) that blocks the model between tool calls. With async, CC backgrounds the hook — model proceeds immediately.

### X6: PreCompact prompt-type hook
- **File:** `~/.claude/settings.json`
- **Change:** Add a second hook entry under PreCompact with `"type": "prompt"`, `"model": "claude-haiku-4-5"`, `"timeout": 15`
- **Rationale:** Demonstrates prompt-type hooks. Checks whether critical unsaved state exists before compaction. Runs alongside existing command hook (CC runs all matching hooks in parallel). Cost: one Haiku call per compaction (~2-5 per session).

### X9: JSDoc for CC env vars on wrapHook()
- **File:** `src/adapters/cc-hooks/infrastructure.ts`
- **Change:** Add JSDoc comment to `wrapHook()` documenting CC-provided env vars (CLAUDE_PROJECT_DIR, CLAUDE_ENV_FILE, CLAUDE_PLUGIN_*)
- **Rationale:** Documents available env vars for future contributors. No behavioral change.

### X10: Expand PreToolUse matcher to "" (all tools)
- **File:** `~/.claude/settings.json`
- **Change:** Change PreToolUse matcher from `"Agent"` to `""`
- **Rationale:** Enables permission decisions for any tool (X8 infrastructure already wired). Existing code handles non-Agent tools gracefully (returns `{}`).

---

## Deferred (document only, no implementation)

| Item | Capability | Reason for deferral |
|------|-----------|---------------------|
| X2 | Interactive prompt protocol (bidirectional stdin) | Requires fundamental rewrite of hook I/O model. No compelling use case. |
| X4 | Agent-type hooks (full multi-turn subagent) | Expensive (API tokens per invocation). B7 bug on Stop/SessionEnd. |
| X5 | HTTP-type hooks (POST to URL) | Requires Angel HTTP API — separate body of work. DB communication sufficient. |
| X7 | Command arrays | NOT SUPPORTED by CC. Schema defines `command` as string only. |

---

## Verification

- `bun run build` — must succeed
- `bun run test` — must pass (no behavioral changes, so no new test failures expected)
- Manual: confirm settings.json is valid JSON after edits
