# REQUIREMENTS: CC Source-Informed Upgrades (81 Items)

All items from `context/research/SYNTHESIS.md`. None deferred.

---

## Category 1: Token Optimization (T1-T8)

| ID | Title | Description | Constraint |
|----|-------|-------------|------------|
| T1 | Disable CC auto-memory | Set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` via CLAUDE_ENV_FILE in SessionStart. Saves ~11K tokens/turn by killing 3 CC memory subsystems. | Via X3 (CLAUDE_ENV_FILE) |
| T2 | Eliminate 5K fixed memory instructions | With T1, CC's `loadMemoryPrompt()` 5K token overhead disappears. Verify no residual injection. | Depends on T1 |
| T3 | Minimize UserPromptSubmit injection | Move bulk context to SessionStart. Keep UserPromptSubmit under 1KB. No dedup in CC — repeated every turn. SessionStart has no truncation; UPS truncated at 10K chars. | Critical Reminders tier defines per-section budgets |
| T4 | MCP instructions for system-prompt injection | Set Claudex MCP server `instructions` field for system-prompt-level context. Trade-off: downgrades cache from global to org scope (K1). | Requires K1 analysis |
| T5 | Cache-stable hook content | Remove timestamps, counts, session IDs from injected text. Cache prefix matching — any change = 10x cost. | |
| T6 | Reduce CLAUDE.md footprint | Audit both CLAUDE.md files. Move conditional content to `.claude/rules/` with `paths:` frontmatter. | |
| T7 | Post-compact duplication avoidance | Track SessionStart post-compact firing. Skip/reduce next UserPromptSubmit to prevent double-injection. | Depends on H4 (PostCompact) |
| T8 | SAVE_HOOK_ADDITIONAL_CONTEXT | Set `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1` to preserve context in transcripts for resume. Trade-off: larger transcript files. | Via X3 |

## Category 2: New Hook Types (H1-H17)

| ID | Title | Description |
|----|-------|-------------|
| H1 | SubagentStart | Inject Claudex awareness at actual agent start, not coordinator dispatch. |
| H2 | SubagentStop | Capture subagent results, duration, success/failure for analytics. |
| H3 | PreCompact | Capture pre-compact state. Inject preservation instructions into compaction prompt. |
| H4 | PostCompact | Detect compaction events. Trigger full re-assembly. Prevent duplicate injection (T7). |
| H5 | PermissionRequest | Auto-allow/deny based on behavioral patterns. Return `permissionDecision`. |
| H6 | PermissionDenied | Track denial patterns. Optionally `retry: true`. |
| H7 | Elicitation/ElicitationResult | Intercept MCP elicitation requests. Auto-respond to Claudex's own elicitations. |
| H8 | ConfigChange | Detect settings.json changes. Adapt behavior. |
| H9 | InstructionsLoaded | Detect CLAUDE.md reloads. Known bug: doesn't fire post-compact (#30973). |
| H10 | CwdChanged | Detect project switches. Adjust context injection. |
| H11 | FileChanged (watchPaths) | Fires when watched files change. Already used for ACTIVE.md/CLAUDE.md. Extend. |
| H12 | TeammateIdle | Detect idle teammates in team mode. Reassign or notify. |
| H13 | TaskCreated/TaskCompleted | Track CC task lifecycle for progress analytics. |
| H14 | PostToolUseFailure/StopFailure | Capture hook failures for pattern extraction. |
| H15 | Setup | Auto-configure Claudex during first-time CC setup. |
| H16 | WorktreeCreate/WorktreeRemove | Track git worktrees for multi-workspace sessions. |
| H17 | SessionEnd | Final cleanup, summarization, handoff at actual session boundary. |

## Category 3: Hook Execution Capabilities (X1-X10)

| ID | Title | Description |
|----|-------|-------------|
| X1 | Async hook protocol | Output `{"async": true}` to background. `asyncRewake: true` for monitoring (exit code 2 wakes Claude). |
| X2 | Interactive prompt protocol | Output `{"prompt": "id", "message": "...", "options": [...]}` for user input mid-hook. |
| X3 | CLAUDE_ENV_FILE injection | Write bash exports to CLAUDE_ENV_FILE. Injects env vars into all Bash commands for session. |
| X4 | `once: true` hook flag | Auto-remove hook after first success. For one-time setup. |
| X5 | `agent` execution type | Multi-turn LLM agent hooks with tool access. |
| X6 | `http` execution type | POST to HTTP endpoints from hooks. |
| X7 | `prompt` execution type | One-shot LLM call hooks. |
| X8 | PreToolUse `permissionDecision` | Auto-allow/deny without normal permission flow. |
| X9 | PostToolUse `updatedMCPToolOutput` | Replace MCP tool output (not built-in tools). |
| X10 | PreToolUse `updatedInput` with matchers | Modify tool input. Matchers: exact, pipe-separated, regex, `ToolName(pattern)`. |

## Category 4: Injection Point Upgrades (I1-I5)

| ID | Title | Description |
|----|-------|-------------|
| I1 | initialUserMessage from SessionStart | Auto-prime sessions with handoff tasks. Model starts working immediately. |
| I2 | MCP tool annotations | `searchHint` and `alwaysLoad` for tool discovery. |
| I3 | Conditional rules via .claude/rules/ | Rules with `paths:` frontmatter. Only load when matching files touched. |
| I4 | MCP skills (feature-flagged) | Serve SKILL.md files as MCP resources via `MCP_SKILLS` flag. |
| I5 | Plugin system | Package Claudex as CC plugin (manifest with hooks, MCP, skills, config). |

## Category 5: Conflict Prevention (C1-C5)

| ID | Title | Description |
|----|-------|-------------|
| C1 | Monitor GrowthBook flags | Track `tengu_passport_quail`, `tengu_onyx_plover`, `tengu_moth_copse`, `tengu_marble_fox`. Detect activation, adapt. |
| C2 | Prevent auto-dream MEMORY.md rewrite | Ensure `autoDreamEnabled: false`. Detect activation and redirect. |
| C3 | KAIROS mode detection | Detect KAIROS activation (append-only daily logs). Pre-align Angel. |
| C4 | Compaction race awareness | Keep post-compact injections lean. Compaction is non-atomic. |
| C5 | VERIFICATION_AGENT outcome capture | When CC ships structured PASS/FAIL/PARTIAL, capture in `solution_outcomes`. |

## Category 6: Cache Optimization (K1-K4)

| ID | Title | Description |
|----|-------|-------------|
| K1 | MCP ↔ global cache trade-off | Measure whether MCP injection benefit outweighs cache scope downgrade (global→org). |
| K2 | TTL awareness | Session-stable TTL. 5min default, 1hr subscriber. Keep sessions alive. |
| K3 | Sticky-on latched headers | Beta headers never removed mid-session. Only cleared on /clear or /compact. |
| K4 | cch= billing sentinel | Never output strings matching `cch=XXX` pattern. Global substitution breaks cache. |

## Category 7: Bug Workarounds (B1-B8)

| ID | Title | Description |
|----|-------|-------------|
| B1 | Auto-memory truncation bug (#40210) | Newest memories lost first. Reinforces case for Claudex DB-only. |
| B2 | Resume cache regression (#34629) | Only system prompt cached on resume since v2.1.69. 20x cost increase. |
| B3 | InstructionsLoaded not firing post-compact (#30973) | Use PostCompact hook instead. |
| B4 | Duplicate compaction agents (#41607) | Up to 65% quota drain. Awareness only — no Claudex fix possible. |
| B5 | Edit tool changes reverted during compaction (#34674) | Track edits, verify post-compact survival. |
| B6 | CLAUDE_ENV_FILE session ID mismatch on resume (#40391) | Use session_id from hook payload, not env file. |
| B7 | Agent-type hooks fail on SessionEnd (#40010) | Use command-type hooks for stop/end events. |
| B8 | Plugin hook scripts lose execute permissions (#40050, #40187) | Explicit chmod after plugin install. |

## Category 8: Extension Surfaces (E1-E3)

| ID | Title | Description |
|----|-------|-------------|
| E1 | Package Claudex as CC plugin | Plugin manifest: auto-register hooks, MCP server, skills, config. |
| E2 | Channel MCP servers | Native CC communication channel for cross-session messaging. |
| E3 | MCP searchHint and alwaysLoad | Ensure Claudex tools always available and correctly matched. |

## Category 9: Angel/CC Integration (A1-A15)

| ID | Title | Description |
|----|-------|-------------|
| A1 | /dream consolidation | Angel adopts Dream's 4-phase structure OR disables Dream, sole consolidator. |
| A2 | extractMemories — disable or bridge | Disable CC's extraction (conflicts with Angel). Adopt forked-agent-with-cache pattern. |
| A3 | /remember — retention sweep | Angel learns from /remember's classification taxonomy for retention sweep. |
| A4 | Session Memory complement | CC's within-session summary feeds Angel instead of raw transcripts. |
| A5 | Away Summary complement | CC idle → recap feeds Angel's session monitoring. |
| A6 | Magic Docs awareness | Prevent conflicts with Angel entity summaries. Target different outputs. |
| A7 | Agent Summary consumption | Angel consumes 30s forked agent status summaries for richer cross-session state. |
| A8 | Skill Improvement bridge | Angel detects corrections → triggers CC's skill rewrite mechanism. |
| A9 | findRelevantMemories dedup | Adopt deduplication logic — track what's been surfaced, avoid re-injection. |
| A10 | /skillify pipeline | Angel extracts patterns → /skillify turns them into CC skills. |
| A11 | /stuck auto-trigger | Angel detects stuck patterns → auto-triggers /stuck skill. |
| A12 | Memory file race prevention | File locking or ownership protocol. With T1 disabled, races eliminated. |
| A13 | 30-day transcript cleanup | Angel indexes within cleanup window. |
| A14 | Angel-Dream symbiosis | Angel = input curator + output consumer. Dream = forked-agent consolidator. Clear ownership. |
| A15 | Buddy as Claudex notification UI | Use Buddy's companionReaction + speech bubble for Angel notifications, transfers, signals. |

## Category 10: Angel Engineering Patterns (P1-P6)

| ID | Title | Description |
|----|-------|-------------|
| P1 | Forked agent with cache sharing | Near-zero cost background LLM work. Trigger CC's forked agent mechanism via hooks. |
| P2 | Cursor-based incremental extraction | Track message cursor. Only analyze new messages. Reduce redundant extraction. |
| P3 | Pre-injecting manifests | Pre-inject observation summaries for Angel LLM reasoning instead of DB queries. |
| P4 | Scan throttling (10-min debounce) | Debounce Angel monitoring loops. Especially file-watching and session discovery. |
| P5 | Hard turn budgets | Cap Angel processes at 5 turns. Prevent runaway background agents. |
| P6 | Mutual exclusion via skip logic | Angel and CC features detect prior writes and skip. Ownership protocol. |
