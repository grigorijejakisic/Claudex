# Phase 8: MCP & Injection Points — Implementation Plan

**Status:** PLANNED
**Items:** I2, T4, I1, K1 (I4 DEFERRED)
**Files Modified:** `src/mcp/recall-server.ts`, `src/adapters/cc-hooks/session-start.ts`, `~/.claude/CLAUDE.md`

---

## Execution Order

### 1. I2 — MCP Tool Annotations

**File:** `src/mcp/recall-server.ts`
**Change:** Migrate all 6 `server.tool()` calls to `server.registerTool()` with `_meta` annotations.

**Pattern change:**
```typescript
// Before (deprecated)
server.tool('claudex_search', 'description', { schema }, async (args) => { ... });

// After
server.registerTool('claudex_search', {
  description: 'description',
  inputSchema: { schema },
  _meta: {
    'anthropic/searchHint': '...',
    'anthropic/alwaysLoad': true,
  },
}, async ({ query, ... }) => { ... });
```

**Annotations:**

| Tool | `alwaysLoad` | `searchHint` |
|------|-------------|--------------|
| `claudex_search` | `true` | memory recall knowledge decisions learnings observations project history past sessions |
| `claudex_recall` | — | artifact file specific ID reference lookup get retrieve |
| `claudex_store` | — | save persist remember decision learning directive store |
| `claudex_events` | `true` | session history recent work what happened last session events timeline activity |
| `claudex_message` | — | cross-session message send notify transfer communicate other session teammate |
| `claudex_session` | — | session management name list signal active sessions coordination stigmergic |

**Risk:** LOW. Same callbacks, different registration method.

---

### 2. T4 — MCP Instructions

**File:** `src/mcp/recall-server.ts`
**Change:** Add `instructions` string to McpServer constructor options.

Content (~500 tokens): Claudex identity, tool table, navigation rule, safety rules. Hardcoded constant — changes with code releases, not runtime.

**Then:** Trim overlapping content from `~/.claude/CLAUDE.md`:
- Remove MCP tool table section (~200 tokens)
- Remove Navigation Rule section (~50 tokens)
- Simplify Context Injection note (overlaps with MCP instructions)
- Keep: Rules, Reference Docs, Platform Guards, Engineering Standards, Key Preferences, Cross-Session Communication

**Risk:** LOW. Additive — CC renders alongside other MCP instructions.

---

### 3. I1 — initialUserMessage Auto-Priming

**File:** `src/adapters/cc-hooks/session-start.ts`
**Change:** Add opt-in auto-priming when handoff exists.

**Logic:**
1. Check `input.type` — only proceed for `'startup'` (not resume/compact)
2. Check opt-in: read `auto_prime` from `~/.claudex/config.json` (default: false)
3. Check for `context/handoffs/ACTIVE.md` with `status: active` frontmatter
4. Extract priority list, compose short directive
5. Return `initialUserMessage` in `hookSpecificOutput`

**Opt-in:** New `auto_prime` field in ClaudexConfig (boolean, default false). Added to config type and validation.

**Risk:** MEDIUM. Mitigated by opt-in default and startup-only gating.

---

### 4. K1 — Cache Documentation

**File:** `src/mcp/recall-server.ts`
**Change:** Add code comment near server constructor explaining the global-to-org cache scope downgrade.

**Risk:** NONE.

---

### 5. I4 — MCP Skills Serving SKILL.md Resources (DEFERRED)

**Why deferred:** `MCP_SKILLS` is a GrowthBook feature flag — unclear if enabled. The 6 MCP tools already provide all functionality. Skills would add UX polish but not new capability.

**Future implementation notes:**
- Add `resources: {}` to server capabilities
- Implement `resources/list` and `resources/read` handlers
- Serve SKILL.md files for: `/claudex-status`, `/claudex-handoff`, `/claudex-history`
- Gate behind runtime check for `MCP_SKILLS` flag

---

## Verification

1. `bun run build` succeeds
2. `bun run test` passes (existing recall-server tests + new tests)
3. After build, MCP server still connects and all 6 tools respond
4. `claudex_search` and `claudex_events` have `alwaysLoad: true`
5. Instructions content appears in CC system prompt as `## claudex-recall`
6. `~/.claude/CLAUDE.md` trimmed version retains all non-Claudex-system rules
7. With `auto_prime: false` (default), no `initialUserMessage` returned
