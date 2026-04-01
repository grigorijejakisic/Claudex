# CC Research Synthesis — Complete Upgrade List

**Date:** 2026-04-02
**Sources:** 24 research documents (17 CC source, 7 community/street knowledge)
**Scope:** Every actionable item for Claudex derived from CC source analysis

---

## Category 1: Token Optimization (Weekly Limit Savings)

### T1. Disable CC auto-memory system
**What:** Set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in SessionStart hook via CLAUDE_ENV_FILE.
**Why:** CC has THREE memory subsystems all burning tokens: (a) static MEMORY.md injection (~6K tokens), (b) per-turn Sonnet AI selector making a separate API call to pick relevant files (~5K tokens/turn), (c) background extractor at session end. Claudex's 5-channel RRF hybrid retrieval is strictly superior. Disabling all three with one env var saves ~11K tokens/turn minimum.
**Source:** 04-memory-system.md

### T2. Eliminate 5K fixed memory instruction overhead
**What:** With auto-memory disabled, CC's `loadMemoryPrompt()` still costs ~5K tokens of behavioral instructions in the system prompt even when MEMORY.md is empty.
**Why:** These instructions tell the model how to use CC's memory system — completely redundant when Claudex handles memory. The env var disable eliminates this entire section.
**Source:** 04-memory-system.md

### T3. Minimize UserPromptSubmit injection size
**What:** Move bulk context from UserPromptSubmit hook to SessionStart hook. Keep UserPromptSubmit under 1KB for truly dynamic content only (experience patterns, signals, messages).
**Why:** There is NO deduplication of hook attachments. UserPromptSubmit fires every turn, and each injection accumulates in the context window. Over 50 turns with 2KB/turn = 100KB of redundant repeated context. SessionStart fires once per boundary (startup/resume/compact) — efficient for bulk. UserPromptSubmit is truncated at 10K chars; SessionStart has no truncation.
**Source:** 15-attachments-system.md

### T4. Use MCP `instructions` for system-prompt injection
**What:** Set Claudex MCP server's `instructions` field to inject critical context at system-prompt level instead of user-message level via hooks.
**Why:** MCP instructions land in the dynamic section of the system prompt — better position than hook additionalContext (which lands as user-role meta message). System prompt content is globally cached and more authoritative. The `instructions` field is recomputed every turn from connected MCP servers — it's a `DANGEROUS_uncachedSystemPromptSection` which means it bypasses caching but allows truly dynamic system-level injection.
**Caveat:** MCP tool connection downgrades cache from `global` scope to `org` scope. Trade-off analysis needed.
**Source:** 01-query-engine-context-assembly.md

### T5. Cache-stable hook content
**What:** Ensure Claudex's injected content is as stable as possible across turns. Remove timestamps, changing counts, session-specific IDs from injected text.
**Why:** Prompt caching works on prefix matching. Any change in injected content breaks the cache for all subsequent messages. Cache reads are 10x cheaper than fresh input (0.1x vs 1.0x rate). Variable content in hook output = cache miss every turn = 10x token cost for that content.
**Source:** 08-cache-system.md

### T6. Reduce CLAUDE.md token footprint
**What:** Audit and trim both global and project CLAUDE.md. Use conditional rules in `.claude/rules/` with `paths:` frontmatter for context that's only needed when specific files are touched.
**Why:** CLAUDE.md is injected as the FIRST user message on EVERY API call. It's memoized (read once) but still counts tokens every turn. Conditional rules only load when file paths match — correct mechanism for reducing per-turn cost.
**Source:** 16-claudemd-config-loading.md

### T7. Post-compact duplication avoidance
**What:** Track whether SessionStart just fired post-compact. If so, skip or reduce the next UserPromptSubmit injection.
**Why:** After compaction, CC fires `processSessionStartHooks('compact')` which re-injects Claudex context. Then on the very next turn, UserPromptSubmit injects again — duplicating everything. CC's design doesn't suppress per-turn injection on the first post-compact turn. Claudex must handle this internally.
**Source:** 02-compaction-pipeline.md

### T8. CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT awareness
**What:** Set `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1` to preserve hook context in transcripts.
**Why:** Without this, hook additional_context attachments are filtered out for external (non-ANT) users. On session resume, context is lost. With it set, Claudex context survives to transcript JSONL. But this also means more data in transcript files — trade-off.
**Source:** 12-session-lifecycle.md

---

## Category 2: New Hook Capabilities (Undocumented — 20 new event types)

CC has 27 hook event types. Documentation mentions ~7. Claudex currently uses 6. Here are the 20+ we're not using:

### H1. SubagentStart hook
**What:** Fires inside `runAgent.ts` after agent is configured, before first query turn.
**Why:** Better injection point for worker context than PreToolUse on Agent tool. Fires at the actual agent start, not at the coordinator's tool dispatch. Can inject Claudex awareness directly into subagent context.
**Source:** 03-hook-system-deep-dive.md, 10-coordinator-remote.md

### H2. SubagentStop hook
**What:** Fires when a subagent completes.
**Why:** Claudex can capture subagent results, duration, success/failure for cross-session analytics and outcome tracking.
**Source:** 03-hook-system-deep-dive.md

### H3. PreCompact hook
**What:** Fires before compaction starts.
**Why:** Claudex can capture pre-compact state, prepare for re-injection, or inject instructions into the compaction prompt about what to preserve.
**Source:** 03-hook-system-deep-dive.md

### H4. PostCompact hook
**What:** Fires after compaction completes.
**Why:** Claudex can detect compaction events, trigger full re-assembly, and avoid duplicate injection on the next UserPromptSubmit turn.
**Source:** 03-hook-system-deep-dive.md

### H5. PermissionRequest hook
**What:** Fires when CC asks the user for tool permission. Can return `permissionDecision` and `updatedInput`.
**Why:** Claudex tracks behavioral patterns. Based on history, it could auto-allow known-safe operations or auto-deny dangerous ones — reducing user interruption while maintaining safety.
**Source:** 03-hook-system-deep-dive.md

### H6. PermissionDenied hook
**What:** Fires when user denies a tool. Can set `retry: true`.
**Why:** Claudex can track denial patterns, learn from them, and in specific cases suggest the model retry with a modified approach.
**Source:** 03-hook-system-deep-dive.md

### H7. Elicitation / ElicitationResult hooks
**What:** Fires when MCP tools request user input. Can intercept and auto-respond.
**Why:** Claudex MCP tools could use elicitation for structured input. These hooks let Claudex auto-respond to its own elicitations without bothering the user.
**Source:** 03-hook-system-deep-dive.md

### H8. ConfigChange hook
**What:** Fires when settings.json changes.
**Why:** Claudex can detect when the user changes CC configuration and adapt behavior accordingly.
**Source:** 03-hook-system-deep-dive.md

### H9. InstructionsLoaded hook
**What:** Fires when CLAUDE.md files are (re)loaded.
**Why:** Claudex can detect CLAUDE.md changes and update its own cached version. Currently there's a known bug: InstructionsLoaded doesn't fire after compaction (#30973).
**Source:** 03-hook-system-deep-dive.md, 05-github-issues.md

### H10. CwdChanged hook
**What:** Fires when the working directory changes.
**Why:** Claudex can detect project switches and adjust context injection accordingly. Critical for multi-project session support.
**Source:** 03-hook-system-deep-dive.md

### H11. FileChanged hook (with watchPaths)
**What:** Fires when watched files change on disk. Files watched via `watchPaths` from SessionStart or FileChanged hooks.
**Why:** Claudex already uses watchPaths for ACTIVE.md and CLAUDE.md. Can extend to watch any file relevant to the session.
**Source:** 03-hook-system-deep-dive.md

### H12. TeammateIdle hook
**What:** Fires when a teammate in team mode goes idle.
**Why:** Claudex cross-session coordination could detect idle workers and reassign tasks or notify the user.
**Source:** 03-hook-system-deep-dive.md

### H13. TaskCreated / TaskCompleted hooks
**What:** Fire when tasks are created or completed in CC's task system.
**Why:** Claudex can track task lifecycle for progress analytics and outcome tracking.
**Source:** 03-hook-system-deep-dive.md

### H14. PostToolUseFailure / StopFailure hooks
**What:** Fire when tool execution or stop hooks fail.
**Why:** Claudex can capture failures for pattern extraction and learning. Important for error tracking.
**Source:** 03-hook-system-deep-dive.md

### H15. Setup hook
**What:** Fires during initial CC setup.
**Why:** Claudex could auto-configure itself during first-time setup.
**Source:** 03-hook-system-deep-dive.md

### H16. WorktreeCreate / WorktreeRemove hooks
**What:** Fire when git worktrees are created or removed.
**Why:** Claudex can track multi-workspace sessions and adjust project context per worktree.
**Source:** 03-hook-system-deep-dive.md

### H17. SessionEnd hook
**What:** Fires at session end (distinct from Stop, which fires after each assistant turn).
**Why:** Claudex can run final cleanup, session summarization, handoff creation at the actual session boundary.
**Source:** 03-hook-system-deep-dive.md

---

## Category 3: Hook Execution Capabilities (Undocumented)

### X1. Async hook protocol
**What:** Hooks can output `{"async": true}` as first line to background themselves. Also `asyncRewake: true` for background monitoring that wakes Claude on exit code 2.
**Why:** Claudex hooks could run long operations (DB queries, embedding generation) in the background without blocking the model.
**Source:** 03-hook-system-deep-dive.md

### X2. Interactive prompt protocol
**What:** Hooks can output `{"prompt": "id", "message": "...", "options": [...]}` to request user input mid-execution. Completely undocumented.
**Why:** Claudex hooks could ask the user clarifying questions during hook execution — e.g., "Transfer received from session X. Accept? [yes/no]"
**Source:** 03-hook-system-deep-dive.md

### X3. CLAUDE_ENV_FILE environment injection
**What:** SessionStart, Setup, CwdChanged, FileChanged hooks receive `CLAUDE_ENV_FILE` path. Writing bash exports to this file injects env vars into ALL subsequent Bash commands for the session.
**Why:** Claudex can inject `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and other flags at session start, ensuring they're set for all subprocesses.
**Source:** 03-hook-system-deep-dive.md

### X4. `once: true` hook flag
**What:** On any hook, causes it to auto-remove after first successful execution.
**Why:** Useful for one-time setup hooks that shouldn't fire repeatedly.
**Source:** 03-hook-system-deep-dive.md

### X5. `agent` execution type
**What:** Hooks can be multi-turn LLM agents with tools, not just shell commands.
**Why:** Complex hook logic could use an LLM to reason about what context to inject, rather than relying on programmatic logic alone.
**Source:** 03-hook-system-deep-dive.md

### X6. `http` execution type
**What:** Hooks can POST to HTTP endpoints.
**Why:** Claudex could expose a local HTTP API that hooks call, enabling richer communication than stdout parsing.
**Source:** 03-hook-system-deep-dive.md

### X7. `prompt` execution type
**What:** Hooks that make one-shot LLM calls.
**Why:** Quick LLM-powered decisions in hooks without the overhead of a multi-turn agent.
**Source:** 03-hook-system-deep-dive.md

### X8. PreToolUse `permissionDecision`
**What:** PreToolUse can return `permissionDecision` to auto-allow/deny/ask without going through the normal permission flow.
**Why:** Claudex can auto-approve tools based on behavioral patterns — reducing user interruption.
**Source:** 03-hook-system-deep-dive.md

### X9. PostToolUse `updatedMCPToolOutput`
**What:** PostToolUse can replace MCP tool output (but NOT built-in tool output).
**Why:** Claudex can rewrite its own MCP tool results before the model sees them — useful for post-processing, formatting, or adding context to search results.
**Source:** 14-tools-pre-post-hooks.md

### X10. PreToolUse `updatedInput` with matcher patterns
**What:** PreToolUse can modify any tool's input via `updatedInput`. Matcher supports exact name, pipe-separated (`"Bash|Edit"`), regex, and `ToolName(pattern)` syntax (e.g., `Bash(git *)`).
**Why:** Deep interception capabilities — Claudex can modify Bash commands, file paths, search queries before execution based on context.
**Source:** 14-tools-pre-post-hooks.md

---

## Category 4: Injection Point Upgrades

### I1. initialUserMessage from SessionStart
**What:** SessionStart hook can return `initialUserMessage` which CC injects as the first user message, auto-triggering a Claude response.
**Why:** Claudex can auto-prime sessions with handoff task lists. Instead of the user running /starthere, the session starts with "Continue from handoff: [task list]" and the model begins working immediately.
**Source:** 03-hook-system-deep-dive.md

### I2. MCP tool annotations
**What:** MCP tools can include `_meta['anthropic/searchHint']` and `_meta['anthropic/alwaysLoad']` annotations.
**Why:** `searchHint` helps CC match user intent to Claudex tools. `alwaysLoad` ensures critical Claudex tools are always available to the model, not deferred.
**Source:** 11-mcp-skills-extensions.md

### I3. Conditional rules via .claude/rules/
**What:** Rules in `.claude/rules/*.md` with `paths:` frontmatter only load when the model touches matching files.
**Why:** Project-specific instructions that only activate when relevant — reducing base token cost. E.g., "When editing angel/*.ts, remember the heartbeat interval is 30s."
**Source:** 16-claudemd-config-loading.md

### I4. MCP skills (feature-flagged)
**What:** MCP servers can serve SKILL.md files as resources via `MCP_SKILLS` feature flag.
**Why:** Claudex MCP server could serve dynamic skills to CC — e.g., a "recall" skill that searches memory, or a "store" skill that saves observations.
**Source:** 11-mcp-skills-extensions.md

### I5. Plugin system
**What:** Full plugin manifest supporting commands, agents, skills, hooks, MCP servers, LSP servers, output styles, user config, channels.
**Why:** Claudex could be packaged as a CC plugin — self-contained, discoverable, with its own hooks, MCP server, and skills. Currently we wire everything manually.
**Source:** 11-mcp-skills-extensions.md

---

## Category 5: Conflict Prevention (Future-Proofing)

### C1. Monitor GrowthBook flags for memory activation
**What:** Track these flags: `tengu_passport_quail` (EXTRACT_MEMORIES), `tengu_onyx_plover` (auto-dream), `tengu_moth_copse` (per-turn Sonnet selector), `tengu_marble_fox` (COMPACTION_REMINDERS).
**Why:** Any of these could be enabled server-side by Anthropic at any time. When they activate, they'll conflict with Claudex. Claudex should detect their activation (via CC environment detection in session-start) and adapt.
**Source:** 05-extract-memories.md, 06-dream-kairos.md, 04-memory-system.md

### C2. Prevent auto-dream MEMORY.md rewrite
**What:** Ensure `autoDreamEnabled: false` in settings.json, or detect activation and redirect.
**Why:** Auto-dream rewrites and PRUNES MEMORY.md by its own taxonomy — it would delete Claudex observations it considers "derivable from code." Three-way conflict: extract-memories + auto-dream + Angel all writing to the same directory.
**Source:** 06-dream-kairos.md

### C3. KAIROS mode detection
**What:** Detect KAIROS activation (currently build-flag only, stubbed out) and adapt.
**Why:** KAIROS switches memory from MEMORY.md to append-only daily logs. If shipped, Angel and Dream would both consolidate memory. Pre-alignment needed.
**Source:** 06-dream-kairos.md

### C4. Compaction race condition awareness
**What:** Be aware that compaction is NOT atomic. Rate limits during compaction can destroy transcripts.
**Why:** If Claudex triggers heavy operations that coincide with compaction (e.g., large context re-injection), it could exacerbate the race. Keep post-compact injections lean.
**Source:** 05-github-issues.md

### C5. VERIFICATION_AGENT outcome capture
**What:** When CC's VERIFICATION_AGENT feature ships (structured PASS/FAIL/PARTIAL verdicts), capture results in Claudex's `solution_outcomes` table.
**Why:** Free structured outcome data from CC's built-in verification — feeds directly into Claudex's outcome tracking and pattern extraction.
**Source:** 13-new-features-buildable.md

---

## Category 6: Cache Optimization

### K1. MCP ↔ global cache trade-off
**What:** Having ANY non-deferred MCP tool connected downgrades system prompt cache from `global` scope to `org` scope.
**Why:** Global cache is shared across all users/orgs. Org cache is per-org. The downgrade means Claudex MCP connection slightly reduces cache efficiency. Need to measure whether the injection benefit outweighs the cache cost.
**Source:** 08-cache-system.md

### K2. TTL awareness
**What:** Cache TTL is 5 minutes default, 1 hour for subscribers. Both are latched session-stable.
**Why:** Session stability matters — starting a session latches the TTL. Mid-session changes don't affect it. Keep sessions alive for better cache utilization.
**Source:** 08-cache-system.md

### K3. Sticky-on latched headers
**What:** Beta headers (fast mode, cache editing, thinking-clear) are never removed mid-session once sent. Only cleared on /clear or /compact.
**Why:** Understanding this prevents confusion about why features persist after being toggled.
**Source:** 08-cache-system.md

### K4. cch= billing sentinel bug workaround
**What:** The standalone binary performs global string substitution of billing hashes across all historical tool results, permanently breaking prompt cache. The string `cch=f92fb` in any tool result triggers it.
**Why:** If Claudex hook output ever contains this string pattern, it breaks caching for the entire session. Ensure Claudex never outputs strings matching `cch=XXX` patterns.
**Source:** 05-github-issues.md

---

## Category 7: Bug Workarounds (Known CC Issues)

### B1. Auto-memory truncation bug (#40210)
**What:** CC appends new memories at bottom of MEMORY.md but truncates from the bottom — newest memories lost first.
**Why:** If Claudex writes to MEMORY.md (even indirectly), new entries get deleted first. Reinforces the case for disabling CC's memory and using Claudex DB exclusively.
**Source:** 05-github-issues.md

### B2. Resume cache regression (#34629)
**What:** Since v2.1.69, only system prompt is cached on resume — 20x cost increase.
**Why:** Resumed sessions burn through weekly limit faster. Understanding this helps prioritize when to resume vs start fresh.
**Source:** 05-github-issues.md

### B3. InstructionsLoaded not firing after compaction (#30973)
**What:** The InstructionsLoaded hook doesn't fire after compaction events.
**Why:** If Claudex relies on InstructionsLoaded for detecting CLAUDE.md changes, it won't work post-compact. Use PostCompact hook instead.
**Source:** 05-github-issues.md

### B4. Duplicate compaction agents (#41607)
**What:** Duplicate compaction subagents consuming up to 65% of session quota.
**Why:** Known CC bug that wastes massive tokens. No Claudex fix possible — but awareness helps explain sudden quota drain.
**Source:** 05-github-issues.md

### B5. Edit tool changes reverted during compaction (#34674)
**What:** File edits can be silently reverted when compaction happens mid-edit.
**Why:** Data loss risk. Claudex should track edit operations and verify they survived compaction.
**Source:** 05-github-issues.md

### B6. CLAUDE_ENV_FILE session ID mismatch on resume (#40391)
**What:** CLAUDE_ENV_FILE gets wrong session ID after resume.
**Why:** If Claudex uses CLAUDE_ENV_FILE for session-specific env vars, they'll break on resume. Use session_id from hook payload instead.
**Source:** 05-github-issues.md

### B7. Agent-type hooks fail on SessionEnd (#40010)
**What:** Agent-type hooks silently fail on SessionEnd/Stop events.
**Why:** If Claudex uses agent-type hooks for stop processing, they won't work. Use command-type hooks for stop events.
**Source:** 05-github-issues.md

### B8. Plugin hook scripts lose execute permissions (#40050, #40187)
**What:** Hook scripts installed by plugins lose execute permissions after install.
**Why:** If Claudex is packaged as a plugin, hook scripts need explicit chmod after install.
**Source:** 05-github-issues.md

---

## Category 8: Extension Surface Opportunities

### E1. Package Claudex as CC plugin
**What:** Use CC's plugin system to package Claudex as a discoverable, self-installing plugin.
**Why:** Currently Claudex hooks are wired manually via settings.json. A plugin manifest would auto-register hooks, MCP server, skills, and configuration.
**Source:** 11-mcp-skills-extensions.md

### E2. Channel MCP servers
**What:** CC supports channel-type MCP servers for messaging integrations.
**Why:** Claudex cross-session messaging could use this as a native CC communication channel instead of piggy-backing on hook injection.
**Source:** 11-mcp-skills-extensions.md

### E3. MCP searchHint and alwaysLoad
**What:** MCP tool annotations that help CC discover and prioritize tools.
**Why:** Ensures Claudex tools are always available and correctly matched to user intent.
**Source:** 11-mcp-skills-extensions.md

---

## Implementation Order (No Prioritization — Everything Gets Done)

All items listed. None deferred. None hidden. Implementation groups for efficient execution:

**Group A — Environment & Flags (quick, high token savings):**
T1, T2, X3, C1, C2

**Group B — Injection Architecture (medium, structural improvement):**
T3, T4, T5, T6, T7, T8

**Group C — New Hook Registration (medium, new capabilities):**
H1-H17, X1-X10

**Group D — Conflict Prevention (quick, defensive):**
C3, C4, C5

**Group E — Bug Workarounds (quick, defensive):**
B1-B8, K4

**Group F — Advanced Injection (medium, strategic):**
I1-I5

**Group G — Cache Optimization (research + implementation):**
K1-K3

**Group H — Extension Surface (longer term):**
E1-E3

**Group I — Angel/CC Intelligence Integration (medium-high, strategic):**
A1-A13

**Group J — Angel Engineering Patterns (medium, improvements):**
P1-P6

---

## Category 9: Angel/CC Intelligence Integration (13 items)

### A1. /dream consolidation — learn or replace
**What:** CC's /dream skill does 4-phase memory consolidation: orient → gather → consolidate → prune. autoDream runs it automatically (gated by tengu_onyx_plover).
**Why:** Angel does multi-session consolidation but with a different approach (pattern extraction → CARA reasoning). Dream's 4-phase prompt is more structured. Angel could adopt Dream's consolidation structure while keeping its own DB-backed storage. Or: disable Dream, let Angel be the sole consolidator.
**Source:** 18-skills-angel-overlap.md

### A2. extractMemories — disable or bridge
**What:** CC's extractMemories fires every turn end as a forked agent with prompt cache sharing. Cursor-based incremental (only processes new messages since last run).
**Why:** Directly conflicts with Angel's session-end pattern extraction. The forked-agent-with-cache-sharing pattern is brilliant though — near-zero marginal cost. Angel could adopt this pattern for its own extraction if CC's is disabled.
**Source:** 18-skills-angel-overlap.md

### A3. /remember — manual retention sweep
**What:** CC skill that classifies memory entries across layers, detects duplicates and conflicts. Manual version of what Angel's retention sweep does automatically.
**Why:** Angel's retention sweep could learn from /remember's classification taxonomy. The skill has a structured approach to detecting stale vs active memories.
**Source:** 18-skills-angel-overlap.md

### A4. Session Memory — cheap compaction complement
**What:** CC maintains a within-session running summary that feeds into SM-Compact, replacing expensive compaction API calls with summary-based compaction.
**Why:** Does NOT conflict with Angel — different scope (within-session vs cross-session). Could complement Angel by providing a pre-summarized session state that Angel reads instead of processing raw transcripts.
**Source:** 18-skills-angel-overlap.md

### A5. Away Summary — idle detection complement
**What:** CC detects terminal blur → 5min idle → generates recap using session memory context.
**Why:** Angel already does idle detection (heartbeat monitoring). CC's away summary could feed into Angel's session monitoring — Angel gets a pre-built recap instead of building one from scratch.
**Source:** 18-skills-angel-overlap.md

### A6. Magic Docs — auto-updating documentation
**What:** CC feature that maintains living documentation files that auto-update from conversation context.
**Why:** Could conflict with Angel's entity summaries if both try to update the same files. Could complement if they target different outputs — Magic Docs for user-facing docs, Angel for internal knowledge base.
**Source:** 18-skills-angel-overlap.md

### A7. Agent Summary — subagent status
**What:** 30s forked subagent that generates status summaries with cache sharing.
**Why:** Angel's session monitoring could consume these summaries for cross-session awareness. Currently Angel monitors sessions via heartbeat — agent summaries would give richer state.
**Source:** 18-skills-angel-overlap.md

### A8. Skill Improvement — correction detection
**What:** CC detects user corrections during skill execution and rewrites SKILL.md automatically.
**Why:** Angel already does correction detection. CC's approach (rewrite the skill file immediately) is more aggressive than Angel's (store as pattern, gradually promote). Could bridge: Angel detects corrections → triggers CC's skill rewrite mechanism.
**Source:** 18-skills-angel-overlap.md

### A9. findRelevantMemories — LLM selection
**What:** CC's per-turn Sonnet call that selects relevant memory files against the current query. Deduplicates already-surfaced entries.
**Why:** Redundant with Claudex's hybrid retrieval. But the deduplication logic (tracking what's already been surfaced) is something Claudex should adopt — avoid re-injecting the same observations across turns.
**Source:** 18-skills-angel-overlap.md

### A10. /skillify — pattern-to-skill pipeline
**What:** CC skill that creates new skills from observed patterns.
**Why:** Complementary with Angel's pattern extraction. Angel extracts patterns → /skillify could turn them into executable CC skills. Pipeline: observation → pattern → skill.
**Source:** 18-skills-angel-overlap.md

### A11. /stuck — session recovery
**What:** CC skill for when the model is stuck. Analyzes situation and suggests approaches.
**Why:** Angel's session monitoring detects stuck states (repeated errors, idle). Could trigger /stuck automatically when Angel detects a stuck pattern.
**Source:** 18-skills-angel-overlap.md

### A12. Memory file race prevention
**What:** Both Angel and CC features write to ~/.claude/projects/<slug>/memory/. Races possible.
**Why:** Need file locking or ownership protocol — Angel writes to Claudex DB, CC features write to memory files. If CC memory is disabled (T1), races are eliminated. If any CC memory features remain active, need mutual exclusion.
**Source:** 18-skills-angel-overlap.md

### A13. 30-day transcript cleanup awareness
**What:** CC has a 30-day cleanup window for transcript JSONL files.
**Why:** Angel's cross-session indexing relies on transcripts for retroactive analysis. If transcripts are cleaned up before Angel indexes them, data is lost. Angel should index within the cleanup window.
**Source:** 18-skills-angel-overlap.md

---

## Category 10: Angel Engineering Patterns (from CC) (6 items)

### P1. Forked agent with cache sharing
**What:** CC's extractMemories and autoDream use `runForkedAgent` which shares the parent's prompt cache. The entire conversation is already cached — the fork adds only its instruction prompt + a few turns of output.
**Why:** Near-zero marginal cost for background LLM work. Angel currently uses Ollama for local processing. For tasks that need Claude-level reasoning (not just embeddings), Angel could leverage this pattern by triggering CC's forked agent mechanism via hooks.
**Source:** 18-skills-angel-overlap.md

### P2. Cursor-based incremental extraction
**What:** extractMemories tracks a cursor of which messages have been processed. Each run only analyzes new messages since the last cursor position.
**Why:** Angel's pattern extractor processes full conversations. Adopting cursor-based incremental processing would reduce redundant work and speed up extraction.
**Source:** 18-skills-angel-overlap.md

### P3. Pre-injecting manifests
**What:** CC pre-injects file manifests (list of memory files with descriptions) so the agent doesn't waste turns on `ls` commands.
**Why:** Angel could adopt this for its own LLM-based reasoning — pre-inject relevant observation summaries instead of having the reasoning step query the DB.
**Source:** 18-skills-angel-overlap.md

### P4. Scan throttling (10-minute debounce)
**What:** autoDream uses a 10-minute debounce on session file scans to prevent excessive disk I/O.
**Why:** Angel could adopt similar throttling for its monitoring loops — especially for file-watching and session discovery.
**Source:** 18-skills-angel-overlap.md

### P5. Hard turn budgets
**What:** extractMemories caps at 5 turns (expected 2-4). Prevents runaway background agents.
**Why:** Angel's long-running processes should have similar hard caps to prevent resource waste.
**Source:** 18-skills-angel-overlap.md

### A14. Angel-Dream symbiosis
**What:** Instead of Angel and Dream competing, make Angel the input curator and output consumer for Dream. Angel deposits structured observations as markdown → Dream consolidates (forked agent, cache sharing, near-zero cost) → Angel reads consolidated output → ingests into DB.
**Why:** Angel gets Claude-level reasoning for consolidation at near-zero token cost. Dream gets better input (pre-filtered observations instead of raw conversations). Clear ownership: Angel owns DB, Dream owns markdown consolidation. No conflict.
**Source:** Session 43 architectural discussion

### A15. Buddy as Claudex notification UI
**What:** Use Buddy's `companionReaction` AppState field and speech bubble observer to surface Angel messages, session transfers, signals, and warnings.
**Why:** Solves the session transfer notification problem architecturally. Currently transfers arrive in system-reminder context and the model may not surface them. With Buddy integration, Angel pushes notifications to the speech bubble — visible to the user immediately, independent of the model's attention. `companionMuted` is the built-in opt-out.
**Source:** 19-buddy-system.md

### P6. Mutual exclusion via skip logic
**What:** CC features detect if another process already wrote to the target and skip their own write.
**Why:** Angel and CC features sharing the memory directory need this. If Angel detects CC already consolidated, it skips. If CC detects Angel already extracted, it skips.
**Source:** 18-skills-angel-overlap.md
