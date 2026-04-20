# Phase 12: Engineering Patterns, Extension Surfaces & Cache Polish - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Final phase of the CC Source-Informed Upgrades milestone. Covers Angel engineering patterns (P1-P6), extension surfaces (E1-E3), remaining cache items (K2-K3), and two hook registrations (H11-H12). Of 13 items, 7 are already done or require doc-only treatment. The remaining 4 items require implementation.

Key constraint: Angel runs as a separate Node.js process (different PID from CC). It cannot use CC's forked-agent cache sharing pattern. CC's plugin and channel APIs are feature-flagged and unstable — stub/defer only.

</domain>

<decisions>
## Implementation Decisions

### P1: Forked Agent with Cache Sharing Pattern (DOC-ONLY)
- CC's `runForkedAgent` shares the parent's prompt cache — near-zero marginal cost for background LLM work
- Angel CANNOT use this pattern: it runs as a separate process (different PID), not a CC subagent. Cache sharing only works within CC's conversation fork (`src/angel/pattern-extractor.ts:13-18` documents this)
- Angel uses CliProxy (Sonnet via localhost:8317) or Ollama for all LLM tasks instead
- The pattern IS available for hook-triggered work (e.g., SubagentStart could request extraction), but hooks are ephemeral — they can't run multi-turn forked agents either
- **No code — doc comment in `pattern-extractor.ts` already explains the constraint. Verify doc is accurate and mark done.**

### P2: Cursor-Based Incremental Extraction (IMPLEMENT)
**Files:** `src/angel/pattern-extractor.ts`, `src/core/migrations.ts`

Current state: `extractPatternsFromSession()` calls `getSessionTurns()` which fetches ALL turns for a session. `.claude/rules/angel-architecture.md` claims cursor-based extraction exists, but no cursor tracking is in the code.

Current architecture only extracts from **completed** sessions. Cursor-based extraction enables future incremental extraction from active sessions, and prevents re-processing already-seen turns on retry.

**Implementation:**
1. Add `extraction_cursor` column to `sessions` table via migration (INTEGER, nullable, default NULL — last processed turn_number)
2. Modify `getSessionTurns()` to accept optional `afterTurn` parameter
3. In `extractPatternsFromSession()`:
   - Read current cursor: `SELECT extraction_cursor FROM sessions WHERE session_id = ?`
   - Pass cursor to `getSessionTurns(db, sessionId, afterTurn)`
   - After successful extraction, update cursor: `UPDATE sessions SET extraction_cursor = ? WHERE session_id = ?` with max turn_number processed
4. `getSessionTurns()` WHERE clause becomes: `WHERE session_id = ? AND turn_number > COALESCE(?, 0) ORDER BY turn_number ASC`
5. Context windowing: even with cursor, include last 2 turns before cursor as overlap for LLM context continuity

**Edge cases:**
- NULL cursor = never extracted, process all turns (backwards compatible)
- Session with 0 new turns since cursor = skip extraction (return early)
- Failed extraction = don't update cursor (retry next tick — already handled by the definitive-outcome check in heartbeat.ts:216-219)

### P3: Pre-Injecting Manifests for Angel LLM Reasoning (IMPLEMENT)
**File:** `src/angel/pattern-extractor.ts`

Current state: `extractPatternsFromSession()` sends raw transcript + directive candidates to LLM. The LLM has no knowledge of existing patterns, active CARA opinions, or session context beyond the transcript.

**Implementation:**
1. Build a `buildExtractionManifest()` function that assembles:
   - **Recent patterns** (last 10 from same project, summary only): prevents duplicate extraction
   - **Active CARA opinions** (top 5 by confidence from `angel_opinions`): provides Angel's current worldview
   - **Session metadata**: project name, duration, turn count, thread topic
2. Inject manifest as a `--- EXISTING CONTEXT ---` section before the transcript in the LLM prompt
3. Modify the system prompt to instruct: "Do NOT re-extract patterns that overlap with existing ones listed below"
4. Cap manifest at ~1000 chars to stay within Ollama context limits

**Why this matters:** Without existing context, Angel re-extracts the same patterns across sessions. The directive-candidate pre-filter (`extractDirectiveCandidates()` at lines 195-208) and the review phase dedup check (Gate 1 in `reviewCandidatePatterns()`) catch some duplicates, but the LLM itself should know what already exists.

### P4: 10-Minute Debounce on Angel Monitoring Loops (ALREADY DONE)
- `src/angel/heartbeat.ts:911-915` implements a 5-tier adaptive interval system:
  - 30s when backlog exists (processing queue)
  - 2min when active sessions exist (user working)
  - 5min when work was done this tick (cooling down)
  - 10-30min exponential backoff when idle
- `src/angel/consolidator.ts:49` has a 5-minute consolidation interval constant
- `src/angel/heartbeat.ts:974-1033` `computeNextInterval()` implements the full adaptive strategy
- **Exceeds the spec — no changes needed.**

### P5: Hard 5-Turn Cap on Angel Background Processes (ALREADY DONE)
- Angel LLM calls are single-shot (not multi-turn agents): `callOllama()` and `callCliProxy()` in `pattern-extractor.ts`
- `src/angel/types.ts:81` has `maxPatternsPerSession: 5` as extraction cap
- `.claude/rules/angel-architecture.md` documents "5-turn hard budget on background LLM processes"
- **Inherently satisfied by architecture — no changes needed.**

### P6: Mutual Exclusion Skip Logic for Angel/CC Shared Writes (ALREADY DONE)
- CC's memory system is disabled via `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (Phase 1, X3/T1)
- Angel is the sole consolidator (`src/angel/consolidator.ts:14-26` documents A1 decision)
- `detectDreamReactivation()` guard exists for future Dream re-enablement
- **No contention exists — architectural decision in Phase 1 eliminated the problem.**

### E1: Claudex Plugin Manifest (DOC/STUB)
- CC's plugin system is feature-flagged and unstable
- All plugin components already exist separately: hooks in settings.json, MCP server, skills in `.claude/skills/`
- **Create a stub `plugin.json` at project root** documenting the manifest structure but not wired
- The stub serves as a ready-to-activate blueprint when CC's plugin API stabilizes

**Stub structure:**
```json
{
  "name": "claudex",
  "version": "3.0.0",
  "description": "Persistent memory system for Claude Code",
  "hooks": { "...": "see settings.json" },
  "mcp": { "server": "dist/mcp/recall-server.cjs" },
  "skills": { "directory": ".claude/skills" },
  "config": { "...": "see shared/config.ts" }
}
```

### E2: Channel MCP Server for Cross-Session Messaging (DEFERRED)
- Current cross-session messaging works via `session_messages` table + hook injection in UserPromptSubmit
- CC's channel MCP API is not stable
- **No code — defer until CC channel API stabilizes**
- Document the deferral reason in this CONTEXT.md (done)

### E3: MCP searchHint and alwaysLoad Annotations (ALREADY DONE)
- All 6 MCP tools have `searchHint` annotations (`src/mcp/recall-server.ts:98-606`)
- `claudex_search` (line 100) and `claudex_events` (line 488) have `alwaysLoad: true`
- The other 4 tools (recall, store, message, session) are intentionally deferred — only primary discovery tools need always-load
- **Complete as designed — no changes needed.**

### K2: TTL Awareness in Session Management (ALREADY DONE)
- Cache TTL knowledge (5min default, 1hr subscribers, latched session-stable) captured in SYNTHESIS.md
- `src/mcp/recall-server.ts:50-56` documents the K1 cache trade-off analysis
- Session lifecycle already avoids unnecessary restarts
- **Documented knowledge — no changes needed.**

### K3: Latched Header Awareness (ALREADY DONE)
- Beta headers (fast mode, cache editing, thinking-clear) are sticky-on: never removed mid-session, only cleared on /clear or /compact
- Knowledge captured in SYNTHESIS.md K3 entry
- **Documented knowledge — no changes needed.**

### H11: Extended File Watching via watchPaths (ALREADY DONE)
- `src/adapters/cc-hooks/session-start.ts:417-485` builds watchPaths for ACTIVE.md and CLAUDE.md
- `src/adapters/cc-hooks/cwd-changed.ts:40-52` rebuilds watchPaths on directory change
- Tests in `src/tests/adapters/cc-hooks/cwd-changed.test.ts:97-141`
- **Complete with tests — no changes needed.**

### H12: TeammateIdle Detection Hook (IMPLEMENT)
**Files:** New `src/adapters/cc-hooks/teammate-idle.ts`, settings.json registration

CC fires `TeammateIdle` when a teammate in team mode goes idle. Claudex should capture this for cross-session coordination.

**Implementation:**
1. Create `src/adapters/cc-hooks/teammate-idle.ts` following the standard hook pattern (readStdin, bootstrap, wrapHook)
2. Extract teammate info from payload: `teammate_id`, `session_id`, `idle_duration`
3. Record as `session_event` with type `teammate_idle`
4. If Angel's session monitor detects the idle teammate belongs to a coordinated task, send a notification to the coordinating session via `session_messages`
5. Register in settings.json under `hooks.TeammateIdle`

**Payload fields** (from CC source — TeammateIdle hook payload):
- `hook_event_name`: "TeammateIdle"
- `session_id`: the idle teammate's session ID
- `teammate_name`: display name of the idle teammate
- Standard fields: `cwd`, etc.

</decisions>

<risks>
## Risks & Mitigations

1. **P2 cursor migration**: Adding a column to `sessions` table. Migration is additive (nullable column) — no data loss risk. Existing rows get NULL cursor (= process all turns). Standard migration pattern used throughout Claudex.

2. **P3 manifest size**: Must stay within Ollama context limits (~4K for local models). Cap manifest at 1000 chars. CliProxy/API models have much larger context — manifest size only matters for Ollama fallback path.

3. **H12 payload uncertainty**: TeammateIdle hook payload fields are inferred from CC source patterns, not verified by real capture. The hook should log the full payload on first invocation for field verification (standard Claudex practice per CLAUDE.md: "Never assume field names. Capture real payloads to verify.").

4. **E1 stub drift**: Plugin manifest stub may diverge from CC's eventual stable API. Mitigated by keeping it minimal and clearly marked as a stub.

</risks>

<scope>
## Final Scope

### IMPLEMENT (4 items)
| Item | File(s) | Effort |
|------|---------|--------|
| P2 | pattern-extractor.ts, migrations.ts | Small |
| P3 | pattern-extractor.ts | Medium |
| H12 | New teammate-idle.ts, settings.json | Small |
| E1 | New plugin.json (stub only) | Trivial |

### DOC-ONLY (2 items)
| Item | Action |
|------|--------|
| P1 | Verify existing doc comment in pattern-extractor.ts is accurate |
| E2 | Documented as deferred in this CONTEXT.md |

### ALREADY DONE (7 items)
P4, P5, P6, E3, K2, K3, H11

### Total Implementation Effort
~4 files modified, ~1 new file, ~1 stub file. Small-medium phase.

</scope>
