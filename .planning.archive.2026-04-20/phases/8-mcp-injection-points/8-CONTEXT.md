# Phase 8 Context: MCP & Injection Points

**Phase:** 8 of 12
**Items:** T4, I1, I2, K1 (I4 DEFERRED)
**Status:** CONTEXT GATHERED
**Sources:** SYNTHESIS.md, 01-query-engine-context-assembly.md, 11-mcp-skills-extensions.md, 08-cache-system.md, src/mcp/recall-server.ts, src/adapters/cc-hooks/session-start.ts, src/assembly/sections.ts
**Dependencies:** None (MCP server and hooks already exist)

---

## Pre-existing State

**MCP Server** (`src/mcp/recall-server.ts`): Claudex MCP server running as `claudex-recall` via stdio transport. Registered in `~/.claude.json` as user-scope. 6 tools: `claudex_search`, `claudex_recall`, `claudex_store`, `claudex_events`, `claudex_message`, `claudex_session`. Uses deprecated `server.tool()` API. No `instructions` field set. No `resources` capability. No tool annotations (`_meta`).

**MCP Server Constructor** (line 49-52):
```typescript
const server = new McpServer(
  { name: 'claudex-recall', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
```

The second arg is `ServerOptions` which accepts `instructions?: string` and `capabilities?: ServerCapabilities`.

**SessionStart Hook** (`src/adapters/cc-hooks/session-start.ts`): Returns `hookSpecificOutput` with `hookEventName: 'SessionStart'`, `additionalContext`, and optionally `watchPaths`. Does NOT return `initialUserMessage`. Assembles full context via `assembleFullContext()`.

**Assembly Sections** (`src/assembly/sections.ts`): Identity, Claudex Ready, Experience Warnings, Project, Session Continuity, Checkpoint, Learnings, Proven Principles, etc. The `formatClaudexReadySection()` produces ~70 tokens of navigation guidance. `formatIdentitySection()` reads USER.md. `formatProvenPrinciplesSection()` renders always-inject patterns.

**CLAUDE.md** (`~/.claude/CLAUDE.md`): Contains ~300 tokens of Claudex identity/navigation that overlaps with what `formatClaudexReadySection()` produces and what T4 MCP instructions would carry.

**CC MCP Instructions Mechanism**: CC reads `instructions` from connected MCP servers via `getMcpInstructionsSection()` and injects as `DANGEROUS_uncachedSystemPromptSection` named `mcp_instructions` — position #14 in the system prompt (after session_guidance, memory, env_info, output_style). Recomputes every turn. Format:
```
# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

## claudex-recall
[instructions text]
```

**CC Tool Annotations**: CC reads `tool._meta['anthropic/searchHint']` and `tool._meta['anthropic/alwaysLoad']` from MCP tools. `searchHint` helps deferred tool matching. `alwaysLoad: true` prevents deferral. Available only via `registerTool()` API (not deprecated `tool()` API).

**CC `initialUserMessage`**: SessionStart hook can return `initialUserMessage` string. CC injects it as the first user message and auto-triggers a Claude response. The hook response schema at `src/types/hooks.ts` confirms:
```typescript
hookSpecificOutput: {
  hookEventName: 'SessionStart',
  additionalContext?: string,
  initialUserMessage?: string,
  watchPaths?: string[]
}
```

---

## Item Analysis

### I2 -- MCP Tool Annotations (IMPLEMENT: refactor + annotate)

**What:** Migrate all 6 tools from deprecated `server.tool()` to `server.registerTool()` and add `_meta` annotations for `searchHint` and `alwaysLoad`.

**Current registration pattern** (repeated 6x):
```typescript
server.tool(
  'claudex_search',
  'Search Claudex memory — decisions, learnings, ...',
  { query: z.string(), ... },
  async ({ query, ... }) => { ... },
);
```

**New registration pattern:**
```typescript
server.registerTool(
  'claudex_search',
  {
    description: 'Search Claudex memory — decisions, learnings, ...',
    inputSchema: { query: z.string(), ... },
    _meta: {
      'anthropic/searchHint': 'memory recall knowledge decisions learnings observations project history past sessions',
      'anthropic/alwaysLoad': true,
    },
  },
  async ({ query, ... }) => { ... },
);
```

**Annotation strategy:**

| Tool | `alwaysLoad` | `searchHint` | Rationale |
|------|-------------|--------------|-----------|
| `claudex_search` | `true` | "memory recall knowledge decisions learnings observations project history past sessions" | Primary memory interface. Matches many natural queries. Should never be deferred. |
| `claudex_recall` | `false` | "artifact file specific ID reference lookup get retrieve" | Specific artifact retrieval. Only needed when user has an ID or ref. |
| `claudex_store` | `false` | "save persist remember decision learning directive store" | Explicit storage. Used after decisions, not speculatively. |
| `claudex_events` | `true` | "session history recent work what happened last session events timeline activity" | Second most common query. "What did I do?" is frequent. Should never be deferred. |
| `claudex_message` | `false` | "cross-session message send notify transfer communicate other session teammate" | Cross-session only. Rare in single-session workflows. |
| `claudex_session` | `false` | "session management name list signal active sessions coordination stigmergic" | Session ops. Rarely needed by the model unprompted. |

**Implementation:** Mechanical refactor. Same callbacks, different registration API. The `registerTool()` method signature:
```typescript
registerTool(name: string, config: {
  title?: string;
  description?: string;
  inputSchema?: Args;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}, cb: ToolCallback<InputArgs>): RegisteredTool;
```

Note: `inputSchema` in `registerTool()` expects the same Zod shape as `tool()`. The callback receives parsed args identically.

**Risk:** LOW. Same behavior, different registration method. The `_meta` field is passed through to CC without validation — CC reads the specific keys it knows about and ignores the rest.

---

### T4 -- MCP `instructions` for System-Prompt Injection (IMPLEMENT)

**What:** Set the `instructions` field on the Claudex MCP server to inject stable identity/navigation content into the system prompt.

**Decision:** Hardcoded in server (not file-based). Content changes with code releases, not runtime. ~500 tokens.

**Content for instructions:**

```
Claudex is active on this machine — a persistent memory system giving you context continuity across sessions.

## When to Use Claudex Tools
- claudex_search: FIRST CHOICE for any question about past work, decisions, learnings, or project knowledge. Searches across all sessions and projects with relevance ranking.
- claudex_events: Session history — what happened, what was built, timeline of recent work.
- claudex_recall: Retrieve a specific artifact by ID or file path when you have an exact reference.
- claudex_store: Persist a decision or learning for future sessions after key decisions or user directives.
- claudex_message: Send messages to other active sessions (cross-session coordination).
- claudex_session: Session management — name sessions, list active sessions, create/clear signals.

## Navigation Rule
Query Claudex before exploring the filesystem for context. Only read code files when you need to MODIFY them.
All projects live in ~/Desktop/Projects/. The project registry is at ~/.claudex/projects.json.

## Safety
Never call CC's CLIProxyAPI from a hook (deadlock). The "cross-encoder" reranking uses bi-encoder cosine similarity, not a true neural cross-encoder.
```

**Where this content currently lives:**
- `~/.claude/CLAUDE.md`: MCP tool table (~200 tokens), Navigation Rule (~50 tokens), Safety Rules (~80 tokens)
- `src/assembly/sections.ts` `formatClaudexReadySection()`: ~70 tokens of navigation reinforcement

**Migration plan:**
1. Add `instructions` to MCP server
2. Verify CC picks it up (check `# MCP Server Instructions` section in system-reminder)
3. Remove overlapping content from `~/.claude/CLAUDE.md` (separate PR, careful — affects all projects)
4. Keep `formatClaudexReadySection()` — it reinforces in the user message stream (different injection point)

**Implementation:**
```typescript
const CLAUDEX_INSTRUCTIONS = `Claudex is active on this machine...`;

const server = new McpServer(
  { name: 'claudex-recall', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: CLAUDEX_INSTRUCTIONS },
);
```

**Token budget:** ~500 tokens for the instructions. This is in the dynamic section of the system prompt (after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) so it does NOT affect global cache scope — that's already downgraded to `org` scope by MCP tool presence.

**Cache implications:** The `instructions` field creates a `DANGEROUS_uncachedSystemPromptSection`. This means the text is re-read from the MCP server every turn. However, as long as the text is stable (no timestamps, no changing state), the system prompt hash remains identical across turns within the org scope, and the org-level cache hits normally.

**What NOT to put in instructions:**
- Experience patterns (per-turn dynamic)
- Session signals/messages (per-turn dynamic)
- Materialized context (varies per query)
- Timestamps, counts, session IDs
- Proven principles (these change as new patterns are promoted)

**Risk:** LOW. Adding instructions is additive — CC renders it alongside other MCP server instructions (currently claude-teams also provides instructions). If the text is wrong, it's a single constant to fix.

---

### I1 -- `initialUserMessage` from SessionStart for Auto-Priming (IMPLEMENT: opt-in)

**What:** When a handoff exists and session type is `startup`, return `initialUserMessage` to auto-prime the model with handoff priorities.

**Decision:** Opt-in only. Short directive only. `startup` type only (not resume/compact).

**Current SessionStart return** (line 400-409):
```typescript
if (fullContent) {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: fullContent,
      ...(watchPaths.length > 0 ? { watchPaths } : {}),
    },
  };
}
return {};
```

**New return with `initialUserMessage`:**
```typescript
if (fullContent) {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: fullContent,
      ...(watchPaths.length > 0 ? { watchPaths } : {}),
      ...(initialMessage ? { initialUserMessage: initialMessage } : {}),
    },
  };
}
```

**Handoff detection logic:**
1. Check for `context/handoffs/ACTIVE.md` in the project directory
2. Parse frontmatter for `status: active`
3. Extract priority list from `## Priority` or `## What I Was Working On` section
4. Compose short directive: "A handoff is active. Priorities: 1) [first] 2) [second]. Run /starthere for full context."

**Opt-in mechanism:** Check for a setting in Claudex config (`~/.claudex/config.json` or a DB flag):
```json
{ "auto_prime": true }
```
Default: `false`. User must explicitly enable.

**Session type gating:**
- `startup`: YES — fresh session, handoff is most relevant
- `resume`: NO — user was already working, don't re-inject
- `compact`: NO — mid-session compaction, user didn't leave

The session type is available in the hook payload as the `source` field matched against the SessionStart matcher. In the hook input, it appears as `input.type` or similar. Need to verify the exact field name from the payload.

**Payload field for session type:** From `03-hook-system-deep-dive.md`, SessionStart matcher matches against `source` which is `'startup' | 'resume' | 'clear' | 'compact'`. The field in the JSON payload is `session_start_type` or `type` — need to verify. The `input` object in `session-start.ts` receives the full CC hook payload.

**Implementation plan:**
1. Add handoff detection function (reads ACTIVE.md, parses priorities)
2. Add opt-in check (DB or config flag)
3. In `main` handler, after assembly: if opt-in AND type=startup AND handoff active, compose `initialUserMessage`
4. Return `initialUserMessage` in hookSpecificOutput

**Risk:** MEDIUM. The model auto-responding without user input could be surprising. Mitigated by opt-in default and short directive format (not a context dump). If the user dislikes it, they disable `auto_prime`.

---

### K1 -- Cache Trade-off Measurement (DOCUMENT ONLY)

**What:** Document the cache scope downgrade from MCP tools and accept it.

**The trade-off:**
- ANY non-deferred MCP tool connected → system prompt cache downgrades from `global` to `org` scope
- `global`: Shared across all Claude Code users. Very high hit rate.
- `org`: Shared within org only. Lower hit rate but still cached.
- This is a CC architectural constraint, not a Claudex bug.

**Current state:**
- 3+ MCP servers connected: claude-teams, Gmail, claudex-recall
- System prompt is ALREADY at `org` scope (claude-teams alone triggers the downgrade)
- Removing Claudex MCP would NOT restore `global` scope (other servers remain)
- With I2 annotations (`alwaysLoad: true` on 2 tools), Claudex tools contribute to the non-deferred tool count

**Measurement approach (for documentation):**
- CC's Stop hook payload includes `usage` with `cache_read_input_tokens` and `cache_creation_input_tokens`
- Observe across multiple turns: steady-state should show high `cache_read` / low `cache_creation` (cache hits)
- Record in the Claudex DB via the existing Stop hook token tracking

**Decision:** Accept `org` scope as permanent. The benefit of MCP tools (direct memory access, cross-session messaging) far outweighs the cache efficiency difference. Focus optimization on content stability (T5, Phase 3) not scope recovery.

**Documentation deliverable:** Add a section to `ARCHITECTURE.md` or a note in the MCP server file explaining the trade-off and why it's accepted.

---

### I4 -- MCP Skills Serving SKILL.md Resources (DEFERRED)

**What:** MCP server serves SKILL.md files as resources, CC creates slash commands from them.

**Why deferred:**
- `MCP_SKILLS` is a GrowthBook feature flag — unclear if enabled for external users
- The 6 Claudex MCP tools already provide all functionality
- Skills would add UX polish (slash commands) but not new capability
- Feature flag dependency makes this unreliable for production use

**Documented for future implementation:**
- Add `resources: {}` to server capabilities
- Implement `resources/list` and `resources/read` handlers
- Serve SKILL.md files for potential skills: `/claudex-status`, `/claudex-handoff`, `/claudex-history`
- MCP skills cannot execute inline shell commands (security restriction)
- Gate behind runtime check for `MCP_SKILLS` flag availability

---

## Three-Tier Content Split (Formalized)

The core architectural decision of this phase: formalizing where each type of Claudex content is injected.

| Tier | Delivery Mechanism | Content Type | Change Frequency | Budget |
|------|-------------------|--------------|-----------------|--------|
| **System Prompt** | MCP `instructions` (T4) | Claudex identity, tool table, navigation rules, safety rules | Never (per build) | ~500 tokens |
| **Session Boundary** | SessionStart `additionalContext` | Full assembly: identity, project, checkpoint, session continuity, learnings, proven principles, reference layer, materialization | Per session/compaction | ~3000-5000 tokens |
| **Per Turn** | UPS `additionalContext` | Experience patterns, critical reminders, intent-triggered patterns, signals, messages, materialized artifacts | Every turn | ~500-1500 tokens |

**The split matches CC's injection architecture:**
- MCP instructions → dynamic system prompt section (position #14, recomputed but stable)
- SessionStart additionalContext → user message before first turn (memoized by CC)
- UPS additionalContext → user message after each prompt (re-injected every turn, truncated at 10K chars)

**Migration from CLAUDE.md:** After T4 is confirmed working, remove from `~/.claude/CLAUDE.md`:
- MCP tool table (~200 tokens)
- Navigation Rule section (~50 tokens)
- Safety rules that are now in MCP instructions (~80 tokens)
- Keep: Workflow gates, quality standards, engineering method, key preferences (these are user behavior rules, not Claudex system rules)

---

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | I2 first: migrate to `registerTool()` with annotations | Fastest, highest impact. Mechanical refactor. Ensures tool discoverability. |
| D2 | T4: hardcoded instructions, not file-based | Content changes with code releases. File-based adds complexity without value. |
| D3 | T4: ~500 tokens of stable identity/navigation/safety | Matches "stable content → MCP instructions" design principle. |
| D4 | I1: opt-in auto-prime, startup-only | Prevents surprising behavior. User must enable `auto_prime`. |
| D5 | I1: short directive, not context dump | `initialUserMessage` becomes a real user message — keep it actionable, not informational. |
| D6 | K1: accept org scope, document trade-off | Other MCP servers already trigger downgrade. Not actionable. |
| D7 | I4: DEFERRED | Feature flag dependency makes it unreliable. Tools suffice. |
| D8 | Formalize three-tier content split | System prompt (stable), session boundary (per-session), per-turn (dynamic). |
| D9 | Keep `formatClaudexReadySection()` after T4 | Different injection point (user message vs system prompt). Reinforcement is valuable. |

---

## Files to Create

None.

## Files to Modify

| File | Changes |
|------|---------|
| `src/mcp/recall-server.ts` | (1) Add `instructions` string to McpServer constructor. (2) Migrate all 6 tools from `server.tool()` to `server.registerTool()` with `_meta` annotations. |
| `src/adapters/cc-hooks/session-start.ts` | (3) Add handoff detection and `initialUserMessage` return for opt-in auto-priming. |

## Implementation Order

1. **I2: Tool annotations** — Migrate `server.tool()` → `server.registerTool()` with `_meta` fields. Mechanical refactor.
2. **T4: MCP instructions** — Add `instructions` constant to McpServer constructor options. ~500 tokens of stable content.
3. **I1: initialUserMessage** — Add handoff detection + opt-in check to session-start.ts. Return `initialUserMessage` for startup sessions with active handoff.
4. **K1: Cache documentation** — Document trade-off in code comments. Accept org scope.
5. **Build + test** — `bun run build`, `bun run test`, verify MCP instructions appear in CC system prompt.

---

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| I2 tool annotations | LOW — same callbacks, different registration API | Verify all 6 tools still callable after refactor |
| T4 instructions | LOW — additive, does not remove existing injection paths | Verify CC renders instructions in `# MCP Server Instructions` section |
| I1 initialUserMessage | MEDIUM — model auto-responding without user input | Opt-in default false. Short directive only. Startup-only gating. |
| K1 documentation | NONE — no code changes | N/A |

---

## CC Source References

| File | Relevant Finding |
|------|-----------------|
| `01-query-engine-context-assembly.md` S7.G | MCP instructions → `DANGEROUS_uncachedSystemPromptSection` named `mcp_instructions`. Position #14 in system prompt. Format: `## serverName\n[instructions]`. |
| `01-query-engine-context-assembly.md` S10 | Hook `additionalContext` lands as `<system-reminder>` user messages AFTER the user's message. MCP instructions land in system prompt — better position. |
| `11-mcp-skills-extensions.md` S7 | `tool._meta['anthropic/searchHint']` and `tool._meta['anthropic/alwaysLoad']` read by CC at `client.ts:1779-1785`. |
| `11-mcp-skills-extensions.md` S4 | `MCP_SKILLS` feature flag gates `fetchMcpSkillsForClient`. Resources served but not loaded as skills without flag. |
| `08-cache-system.md` S1-S2 | Non-deferred MCP tools → `needsToolBasedCacheMarker` → `skipGlobalCacheForSystemPrompt` → org scope. |
| `03-hook-system-deep-dive.md` | SessionStart hook response schema: `additionalContext`, `initialUserMessage`, `watchPaths`. |

---

## Verification Criteria

1. **I2**: After build, `claude mcp list` shows claudex-recall connected. All 6 tools respond correctly. CC model can discover `claudex_search` and `claudex_events` without user mentioning them.
2. **T4**: After build, new session shows `# MCP Server Instructions` / `## claudex-recall` in a system-reminder tag. Content matches the instructions constant.
3. **I1**: With `auto_prime: true` and an active ACTIVE.md, starting a fresh session triggers model response without user typing. With `auto_prime: false` (default), no auto-response.
4. **K1**: Code comment in `recall-server.ts` explains the global→org cache downgrade and why it's accepted.
