# CC Hooks: Community Street Knowledge
**Date:** 2026-04-01
**Researcher:** Crux (Claudex session)
**Scope:** Reddit, GitHub issues, blogs, docs, source leak analysis

---

## Executive Summary

Claude Code hooks have evolved from a simple 5-event system (mid-2025) to a 21-event lifecycle platform by March 2026. Community has built sophisticated memory systems, multi-agent observability layers, and CI/CD pipelines on top of hooks. The dominant discovery: hooks are more powerful and more fragile than documented — especially exit code handling, which has been reliably broken across multiple versions. A source code leak (March 31, 2026) revealed unreleased features including KAIROS (always-on daemon), Coordinator Mode, and Undercover Mode. Two critical CVEs showed hooks can be weaponized for RCE via malicious project files.

---

## Layer 1: What Exists — Real Implementations

### Memory Systems Built on Hooks

**claude-map-reduce-memory** — agynio
- URL: https://github.com/agynio/claude-map-reduce-memory
- Architecture: PreToolUse hook reads the current transcript + runs retrieval before every tool call. Notes stored in chunk JSON files in `~/.claude-memory/chunks/` with plain-language `--when` activation conditions. Retrieval uses Claude Haiku per-chunk (parallel) to reason about relevance — not keyword matching. PostToolUse hook adds a static reminder to consider writing memory.
- Key innovation: Scatter-gather map-reduce across chunks. "Chunk system prompts are stable so prompt caching keeps per-call cost low."
- Source: https://github.com/agynio/claude-map-reduce-memory

**Cortex** — CalebDane7
- URL: https://github.com/CalebDane7/cortex
- 6,000+ entries, months of production use, zero external dependencies, Python stdlib only
- Hook roles: Capture hooks detect corrections + session ends; Enforcement gate PreToolUse blocks Claude's edit/bash/write tools until it acknowledges injected memories from prior sessions
- Three-layer deduplication: >50% similarity = skip; 30–50% = replace; <30% = append
- Scoring: `(keyword_match + stem_match + substring_match) × tag_boost(2.0) × correction_boost(1.5) × recency_decay × coverage_factor`
- Injection tiers: HOT (≥0.3), WARM (0.15–0.3 summaries only), COLD (<0.15 not injected)
- Recency decay: 81% after 1 week, 7% after 3 months
- Source: https://github.com/CalebDane7/cortex

**idnotbe/claude-memory**
- URL: https://github.com/idnotbe/claude-memory
- Structured memory management plugin for Claude Code

**cog** — marciopuga
- URL: https://github.com/marciopuga/cog
- Convention-based (no code): CLAUDE.md rules + slash commands. Three-tier: Hot (~50 lines always loaded) / Warm (domain files) / Glacier (cold archive with YAML frontmatter). L0/L1/L2 tiered loading protocol — each file opens with `<!-- L0: one-line summary -->`. Zettelkasten threads: topic appearing 3+ times across 2+ weeks gets a permanent synthesis file. `/reflect`, `/evolve`, `/housekeeping` pipelines.
- Source: https://github.com/marciopuga/cog

### Multi-Agent Observability via Hooks

**claude-code-hooks-multi-agent-observability** — disler
- URL: https://github.com/disler/claude-code-hooks-multi-agent-observability
- Monitors 12 hook events: PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, SubagentStart, SubagentStop, UserPromptSubmit, Notification, PermissionRequest, PreCompact, Stop
- Architecture: hook scripts POST JSON to Bun server → WebSocket → real-time dashboard
- Each session gets distinct color; tool types get emoji. `SubagentStop` captures full transcript paths for post-mortem analysis
- `stop_hook_active` env var prevents infinite recursion in Stop hooks
- Source: https://github.com/disler/claude-code-hooks-multi-agent-observability

**claude-code-hooks-mastery** — disler
- URL: https://github.com/disler/claude-code-hooks-mastery

### CI/CD + Quality Gate Hooks

**claudekit** — Carl Rannaberg
- URL: https://github.com/carlrannaberg/claudekit
- Auto-save checkpointing, code quality hooks, specification generation

**GitButler session-isolated Git indexing**
- Blog: https://blog.gitbutler.com/automate-your-ai-workflows-with-claude-code-hooks
- Three-hook pattern: PreToolUse initializes per-session Git index; PostToolUse stages to shadow index only; Stop commits to `refs/heads/claude/<session-id>` branches
- Uses `GIT_INDEX_FILE` env var for shadow indexes — avoids working-directory pollution, allows parallel Claude sessions to commit independently
- Discovered: transcript JSONL at `~/.claude/projects/<project-hash>/<session-id>.jsonl` with `userType`, `gitBranch`, message content fields

**Blake Crosley's 95-Hook System**
- Blog: https://blakecrosley.com/blog/claude-code-hooks
- Built from incidents, not theory. Three foundational hooks that created measurable value:
  - `git-safety-guardian.sh` (PreToolUse) — blocked 8 destructive force-push operations over 9 months
  - `recursion-guard.sh` (PreToolUse:Task) — distributes parent budget instead of depth limits; intercepted 23 runaway spawn attempts
  - `blog-quality-gate.sh` (Stop) — 12-module linter for passive voice, dangling footnotes, citation integrity
- Lesson: "Start with three hooks, not 25 — overhead of loading 25 hooks on every tool call was measurable"
- Config-driven (JSON thresholds) beats hardcoded values — 30-second tuning instead of redeployment

**everything-claude-code** — affaan-m
- URL: https://github.com/affaan-m/everything-claude-code
- Built at Claude Code Hackathon (Cerebral Valley x Anthropic, Feb 2026)
- Skills, instincts, memory, security, research-first development

### Collections

**awesome-claude-code** — hesreallyhim
- URL: https://github.com/hesreallyhim/awesome-claude-code
- Curated list of hooks, skills, slash-commands, agent orchestrators

**claude-code-new-features-early-2026** — coleam00
- URL: https://github.com/coleam00/claude-code-new-features-early-2026

**claude-howto** — luongnv89
- URL: https://github.com/luongnv89/claude-howto
- Visual, example-driven guide with copy-paste templates

### Voice Hooks

**claude-code-hooks** — shanraisshan
- URL: https://github.com/shanraisshan/claude-code-hooks
- Adding voice to Claude Code via hooks

### Self-Hosted RAG Memory (github.com/anthropics/claude-code issue #32627)
- Community-built RAG MCP server: Qdrant + Ollama, hybrid search (dense 768D + sparse BM25 + RRF)
- Benchmarks on AMD EPYC 16-core VPS: warm embed 87ms, full search 79ms → 7ms cache hit
- Bulk ingestion: extracted 2,237 GitHub issues, summarized with Qwen 2.5 1.5B
- Integrated with 10-phase spec-driven development pipeline
- Source: https://github.com/anthropics/claude-code/issues/32627

---

## Layer 2: Why It Works — Architecture & Official Schema

### Complete Hook Event List (as of March 2026 — 21+ events)

**Tool Execution:** PreToolUse, PostToolUse, PostToolUseFailure
**User Interaction:** UserPromptSubmit, PermissionRequest, PermissionDenied, Notification, Elicitation, ElicitationResult
**Session:** SessionStart, SessionEnd
**Agent:** SubagentStart, SubagentStop
**Compaction:** PreCompact, PostCompact
**Config/Instructions:** ConfigChange, InstructionsLoaded
**Team (agent teams):** TeammateIdle, TaskCreated, TaskCompleted
**Worktree:** WorktreeCreate, WorktreeRemove
**Error:** StopFailure
**Reactive (no matchers):** CwdChanged, FileChanged

Source: https://code.claude.com/docs/en/hooks, https://smartscope.blog/en/generative-ai/claude/claude-code-hooks-guide/

### Four Handler Types

| Type | Default Timeout | Use Case |
|------|----------------|----------|
| `command` | 600s | Shell scripts; 95% of community usage |
| `http` | 30s | External services, webhooks |
| `prompt` | 30s | LLM yes/no semantic decisions |
| `agent` | 60s | Subagent with tool access for deep verification |

### Exit Code Semantics — Critical for Claudex

| Code | Meaning | Nuance |
|------|---------|--------|
| 0 | Success | stdout JSON processed; most events show output only in verbose mode |
| 2 | Blocking | stderr fed to Claude/user; JSON stdout ignored |
| Other | Non-blocking error | stderr shown in verbose only; execution continues |

**CRITICAL:** `UserPromptSubmit` and `SessionStart` are the only events where exit-0 stdout is added as context Claude sees. All other hooks' stdout goes to verbose mode only.

### PreToolUse Decision Control (JSON output)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "...",
    "updatedInput": { "modified": "fields" },
    "additionalContext": "Context for Claude"
  }
}
```

Precedence when multiple hooks conflict: `deny > defer > ask > allow`

The `"defer"` decision is new (v2.1.89): headless sessions can pause at a tool call and resume with `-p --resume`.

### PreToolUse `updatedInput` — Input Modification

Hooks can modify tool inputs before execution. Critical nuance: must return `permissionDecision: "allow"` alongside `updatedInput`. Example use: redirecting all file writes to `/sandbox` prefix.

### `PostToolUse` `updatedMCPToolOutput`

For MCP tools only: PostToolUse hooks can return a replacement output that Claude sees instead of the real tool result.

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedMCPToolOutput": "replacement output text"
  }
}
```

This is a significant underdocumented capability — hooks can lie to Claude about what MCP tools returned.

### CLAUDE_ENV_FILE — Environment Persistence

`SessionStart`, `CwdChanged`, `FileChanged` hooks support the `CLAUDE_ENV_FILE` env var. Writing to this file persists environment variables across the hook boundary. Enables direnv-style per-directory environment management.

Added v2.1.83 (January 2026).

Source: https://code.claude.com/docs/en/hooks

### `if` Field — Conditional Filtering (v2.1.89)

```json
{
  "type": "command",
  "command": "my-script.sh",
  "if": "Bash(git *)"
}
```

Uses permission rule syntax to skip hook spawning entirely when condition doesn't match. Reduces process spawning overhead without requiring the script to filter itself.

Bug discovered and fixed v2.1.89: `if` condition was not matching compound commands (`ls && git push`) or commands with env-var prefixes (`FOO=bar git push`).

### Hook Deduplication

Identical hooks (same command string, URL, or prompt content) are automatically deduplicated. All matching hooks run in parallel.

### Output Size Limit

`additionalContext`, `systemMessage`, and stdout: 10,000 character cap. Excess saved to file with preview + path. Same handling as large tool results. (Changed at 50K in earlier versions, now 10K.)

### `once: true` — Skill-Scoped Hooks

Hooks defined in skill frontmatter with `once: true` fire exactly once per skill invocation, then remove themselves. Active only while skill is running.

### Agent SDK Hooks vs CC Shell Hooks

The Agent SDK (Python + TypeScript) exposes hooks as callback functions rather than shell commands. Notable differences:
- `SessionStart` and `SessionEnd` are **TypeScript SDK only**, not available in Python SDK callbacks (Python must use shell command hooks in settings files)
- `agent_id` and `agent_type` available in Python SDK only on PreToolUse, PostToolUse, PostToolUseFailure — not on all events
- Async output: return `{"async": true, "asyncTimeout": 30000}` to proceed immediately; hook continues in background
- Recursive hook loop risk: `UserPromptSubmit` hooks that spawn subagents can loop — must check for subagent context

Source: https://platform.claude.com/docs/en/agent-sdk/hooks

---

## Layer 3: What's Wrong — Failures, Bugs, Limitations

### Bug 1: PostToolUse Does Not Fire on Failed Commands
- **Issue:** #6371 (closed NOT_PLANNED, Jan 14, 2026)
- Hooks completely skip when Bash command fails with non-zero exit
- Anthropic stance: documented intended behavior — PostToolUse is for success only
- **Workaround:** Wrap commands to always exit 0 (hides failure signal from Claude)
- **Fix delivered:** `PostToolUseFailure` event added (separate event, Issue #15346 completed Dec 25, 2025)
- Source: https://github.com/anthropics/claude-code/issues/6371

### Bug 2: Hooks Completely Non-Functional in Subdirectories
- **Issue:** #10367 (closed NOT_PLANNED, Oct 26, 2025)
- All hook types fail silently when CC runs from any subdirectory
- Root cause: `~/.claude/settings.json` not read when `process.cwd()` ≠ home directory; path resolution broken
- No workarounds found (absolute paths, symlinks, inline commands all failed)
- Impact: CI/CD pipelines, multi-agent workflows, security validation all broken
- Source: https://github.com/anthropics/claude-code/issues/10367

### Bug 3: PreToolUse Exit Code 1 Ignored — Operations Proceed
- **Issue:** #21988 (closed as duplicate, Jan 30, 2026; unresolved)
- Non-zero exit codes from PreToolUse do NOT block tool execution in some versions
- Only exit code 2 is the official blocking signal — exit code 1 is non-blocking by design
- Community confusion: many believed any non-zero exit would block
- Related: #3514 (preventContinuation:true not blocking), #13756 (exit 2 not blocking in some versions), #4669 (permissionDecision:deny ignored)
- **False security risk:** users believe files are protected when they aren't
- Source: https://github.com/anthropics/claude-code/issues/21988

### Bug 4: Hook Error Messages on Successful Exit 0
- **Issue:** #34858 (closed March 16, 2026, but related issues #34801, #17088, #33656 still open)
- Transcript shows "PreToolUse:Bash hook error" on every tool call even when hook exits 0
- Hooks function correctly but transcript is noisy
- Root cause not identified; appears to be disconnect between exit code handling and display logic
- Source: https://github.com/anthropics/claude-code/issues/34858

### Bug 5: Multiple Hook Types Combined Cause Cancellation
- **Issue:** #4113
- When PreToolUse + PostToolUse + UserPromptSubmit all configured, ESC key fails with "PostToolUse:Read hook execution cancelled"
- Source: https://github.com/anthropics/claude-code/issues/4113

### Bug 6: PostToolUse Exit Code 1 Blocks Claude Execution
- **Issue:** #4809
- PostToolUse exit code 1 (which should be non-blocking) caused Claude to stop entirely in some versions
- Source: https://github.com/anthropics/claude-code/issues/4809

### Bug 7: WSL2 Hooks Not Triggering
- **Issue:** #3179
- PreToolUse/PostToolUse not triggering on WSL2 despite correct configuration
- Source: https://github.com/anthropics/claude-code/issues/3179

### Bug 8: Uninstalled Plugin Hooks Persist Until Session End
- Fixed in v2.1.83
- Previously: removing a plugin mid-session kept its hooks firing until restart
- Source: CHANGELOG

### Performance Limitation: Hook Startup Cost
- Each synchronous hook adds its full execution time before tool proceeds
- 5 hooks × 200ms each = 1 second per tool event (measurable in production)
- Blake Crosley: "overhead of loading 25 hooks on every tool call was measurable"
- Community recommendation: <1 second per hook, use `async: true` for anything longer
- Agent-type hooks spawn full Claude sessions (API credits + latency overhead)
- Source: https://blakecrosley.com/blog/claude-code-hooks

### Security Vulnerability: Hook-Based RCE via Malicious Project Files
- **CVE-2025-59536** (CVSS 8.7): Hooks in `.claude/settings.json` execute arbitrary shell commands without confirmation when user opens a project. Exploited via malicious PR, honeypot repo, or compromised internal codebase.
- **CVE-2026-21852** (CVSS 5.3): `ANTHROPIC_BASE_URL` set in project settings exfiltrates API keys before trust dialog
- Attack: SessionStart hook triggers on project open → RCE before user sees trust prompt
- Fix: Enhanced warning dialog; deferred network ops until after consent
- Source: https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/

### Anti-Pattern: `approve: false` Syntax (Not Real API)
- Many community scripts used `{"approve": false}` which is not documented and was silently ignored
- Correct syntax: `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", ...}}`
- Source: https://github.com/anthropics/claude-code/issues/4362

### Anti-Pattern: Shell Profile Text Breaking JSON Parsing
- If `.bashrc`/`.zshrc` prints text on startup, hook stdout contains non-JSON text before the JSON object
- Official docs warn: "Hook stdout must contain ONLY valid JSON"

### Anti-Pattern: Stop Hook Infinite Loops
- Stop hooks that take actions can cause Claude to never finish
- Must check `stop_hook_active: true` flag to prevent recursion

---

## Layer 4: Adjacent Fields — Cross-Domain Insights

### Git Hooks as Prior Art
- Same lifecycle interception model: pre-commit, pre-push, post-merge
- CC hooks mirror this pattern but fire at AI-action boundaries rather than VCS boundaries
- GitButler extended this analogy by using both systems in tandem: CC PreToolUse + PostToolUse manage shadow Git indexes; conventional git pre-commit catches remaining issues
- Defense-in-depth from two independent hook systems
- Source: https://blog.gitbutler.com/automate-your-ai-workflows-with-claude-code-hooks

### React Lifecycle Methods
- CC hooks reference explicitly compared to React lifecycle (componentDidMount = SessionStart, shouldComponentUpdate = PreToolUse)
- Irony: leaked source code revealed CC's UI is literally built on React — 470 useState + 372 useEffect hooks in a terminal app
- The analogy is structural, not metaphorical
- Source: https://dev.to/kolkov/we-reverse-engineered-12-versions-of-claude-code-then-it-leaked-its-own-source-code-pij

### Distributed Tracing / OpenTelemetry
- Hook-as-observability pattern (disler's multi-agent system) maps directly to distributed tracing
- Each hook event = a span; SubagentStop captures transcript_path = trace context
- session_id correlates events across the agent hierarchy
- The multi-agent color system mirrors trace waterfall diagrams
- Claudex's approach (hook → DB → retrieval) is the observability-as-memory pattern

### OS Signal Handlers / Interrupt Architecture
- Exit code 2 as "blocking signal" parallels Unix SIGTERM/SIGKILL semantics
- "Non-blocking errors" (exit 1) mirror SIGCONT — note the error but continue
- The PreToolUse `defer` decision (v2.1.89) mirrors SIGSTOP — pause and resume later

### Biological: Immune System Pattern
- Cortex's enforcement gate (block all file writes until memories acknowledged) parallels immune checkpoints — must pass validation before proceeding
- Three-tier deduplication (skip/replace/append) maps to immune tolerance mechanisms: familiar antigens ignored, similar ones updated, novel ones added

---

## Layer 5: Frontier — What's Next

### KAIROS (Unreleased — Found in Source Leak March 31, 2026)
- Always-on autonomous background daemon that persists after terminal closes
- 15-second blocking budget: actions that would interrupt user longer are deferred
- `autoDream`: nightly memory consolidation while user is idle — merges observations, removes contradictions, converts vague notes to concrete facts
- Append-only daily log files + GitHub webhook subscriptions
- Background daemon workers on 5-minute cron refresh
- `/dream` skill for on-demand memory distillation
- Maturity: **In Anthropic's codebase, unreleased**
- Source: https://www.theinformation.com/newsletters/ai-agenda/claude-code-leak-reveals-always-kairos-agent

### Coordinator Mode (Unreleased — Source Leak)
- Transforms Claude Code into an orchestrator managing parallel worker agents
- Relation to TeammateIdle/TaskCreated/TaskCompleted hooks: these events are likely the coordination surface
- Maturity: **In Anthropic's codebase, unreleased**

### BUDDY (Unreleased — Source Leak)
- Companion pet system with 18 species, rarity tiers, stats
- Gamified interaction layer — unexpected direction
- Maturity: **In Anthropic's codebase, unreleased**

### Undercover Mode (Unreleased — Source Leak)
- Auto-activated for Anthropic employees on public repos
- Strips AI attribution from commit messages
- Not hook-based, but suggests hook behavior can be silently modified based on organizational identity
- Maturity: **Internal only**

### Data Poisoning Defense (Source Leak)
- Injects fake tools into API requests to corrupt competitor training data scraping
- If applied to hooks: hook outputs could include deliberate misinformation for scraping defense
- Maturity: **Internal only**

### PostToolUseFailure Hook (Recently Shipped, Dec 2025)
- Resolves the long-standing PostToolUse-skips-failed-commands problem
- Fires when tool execution fails, receives `exit_code`, `error_output`
- Supports `additionalContext` to inject debug guidance into Claude's context
- Maturity: **Shipped in v2.1.x**
- Source: https://github.com/anthropics/claude-code/issues/15346 (closed complete Dec 25, 2025)

### PermissionDenied Hook with `retry: true` (v2.1.89)
- When auto-mode classifier denies an action, hook can return `{retry: true}` to tell Claude it can retry
- Enables dynamic permission escalation workflows
- Maturity: **Shipped**

### WorktreeCreate Hook — Custom Worktree Provision (v2.1.84)
- Hook completely replaces the default worktree creation mechanism
- Must print the absolute path of the created worktree on stdout
- Enables custom workspace provisioning (cloud VMs, containers, named directories)
- Maturity: **Shipped**

### HTTP Hooks for Webhook Integration
- Hooks can POST directly to external services (Slack, PagerDuty, webhooks)
- Default timeout 30s; non-2xx responses are non-blocking (execution continues)
- Environment variable interpolation in headers via `allowedEnvVars`
- Maturity: **Shipped, underused by community**

### AskUserQuestion Satisfaction via Hook (v2.1.85)
- PreToolUse hooks can now pre-answer `AskUserQuestion` tool calls by returning `updatedInput` with answers
- Enables headless/automated pipelines that provide answers via their own UI instead of Claude's prompt
- Maturity: **Shipped**

### CwdChanged + FileChanged Reactive Hooks (v2.1.83, Jan 2026)
- Fire on directory change or watched file modification
- Enable direnv-style automatic environment management
- `matcher` for FileChanged = pipe-separated list of basenames to watch
- Claudex could use FileChanged to watch CLAUDE.md for live rule reloads
- Maturity: **Shipped, barely documented in community**

### InstructionsLoaded Hook (v2.1.x)
- Fires when CLAUDE.md or `.claude/rules/*.md` is loaded into context
- Fires at session start for eagerly-loaded files; fires again when lazily loaded
- Enables injection of additional context tied specifically to when rules activate
- Maturity: **Shipped, minimal community adoption**

### StopFailure Hook (v2.1.78)
- Fires when turn ends due to API error (rate limit, auth failure, etc.)
- Previously, API errors during Stop hooks caused infinite loops — this event enables graceful recovery
- Maturity: **Shipped**

---

## Synthesis: Implications for Claudex

### 1. Hook Firing is Authoritative — Trust the Event, Not the Field Name
The community has repeatedly hit wrong field name bugs (the CLAUDE.md truth table: `tool_response` vs `tool_output`, `prompt` vs `user_prompt`, `last_assistant_message` vs `stop_assistant_turn`). This is independently confirmed by the `approve: false` vs `permissionDecision: "deny"` community failure. Always capture real payloads. Claudex correctly documented this.

### 2. UserPromptSubmit and SessionStart Are Context Injection Points
These two events are special: exit-0 stdout is added to Claude's context, not to verbose-only logs. Every other hook's stdout goes to verbose. Claudex's Claudex-awareness injection via PreToolUse hook (subagent prompt injection) is hitting the right surface.

### 3. The `updatedMCPToolOutput` Field Is Underexplored
PostToolUse hooks can return a replacement for what an MCP tool outputs. This is a hook-level capability to intercept and rewrite MCP responses before Claude sees them — not used by anyone in the community. Potential Claudex use: enrich or annotate MCP recall results at the hook level.

### 4. The Subdirectory Bug is Critical and Unresolved
Issue #10367 (closed NOT_PLANNED) means hooks silently fail when CC starts from any non-home directory. This is the most dangerous latent failure mode for Claudex. Verify hooks fire in actual session paths.

### 5. Exit Code 2 Only — Exit Code 1 Does Not Block
Multiple community members built "blocking" hooks using exit code 1 that silently did nothing. Claudex hooks must use exit code 2 exclusively for blocking.

### 6. Performance Budget: <1s Per Hook, Use Async for Anything Heavier
Blake Crosley's 9-month production data: 25 hooks with measurable overhead. Claudex's DB write hooks should profile to verify they stay under 200ms each. The `async: true` flag is available for observability-only hooks (e.g., activation decay, retrieval feedback).

### 7. KAIROS Architecture Maps to What Claudex Calls Angel
Anthropic's unreleased KAIROS daemon does: nightly memory consolidation, observation merging, contradiction removal. Angel does the same. The source leak validates the architectural approach. But KAIROS has a 15-second blocking budget and defers longer work — Claudex's Angel runs as a fully separate process, which is cleaner.

### 8. PostToolUseFailure Is Now Available
Claudex can use this hook to capture when Claude's tool calls fail — useful for enriching error context and tracking outcome patterns. Previously impossible because PostToolUse skipped failures.

### 9. FileChanged + CLAUDE.md Live Reload
The FileChanged hook (v2.1.83) watching CLAUDE.md files is already on Claudex's watchPaths feature. This is now officially supported at the hook layer.

### 10. Security: `.claude/settings.json` Hooks Are an Attack Surface
CVE-2025-59536 confirms project-level hooks execute without confirmation. Claudex hooks in project settings are as trusted as any code that runs on the machine. The user needs to be aware of this when using shared repos.

---

## Common Hook Patterns / Recipes (Community Cookbook)

### Pattern 1: Auto-Format on File Edit
```bash
# PostToolUse hook matching Edit|Write
jq -r '.tool_input.file_path' | xargs npx prettier --write
```

### Pattern 2: Protect Sensitive Files
```bash
# PreToolUse, exit 2 to block
file_path=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
if [[ "$file_path" == *".env"* ]]; then
  echo "Blocked: .env files are protected" >&2
  exit 2
fi
```

### Pattern 3: Block Dangerous Git Operations
```bash
# PreToolUse matching Bash(git *)
command=$(echo "$INPUT" | jq -r '.tool_input.command')
if echo "$command" | grep -qE "git push.*--force|git reset.*--hard"; then
  echo "Force push to main blocked" >&2
  exit 2
fi
```

### Pattern 4: Desktop Notifications When Claude Finishes
```bash
# Stop hook
osascript -e "display notification 'Claude has finished!' with title 'Claude Done'"
```

### Pattern 5: Context Injection via SessionStart
```bash
# SessionStart hook — stdout added to Claude's context
echo "Current git branch: $(git branch --show-current)"
echo "Active todos: $(cat .todo 2>/dev/null | head -5)"
```

### Pattern 6: Recursion Guard via Budget
```bash
# PreToolUse:Task
budget=$(cat /tmp/agent-budget-$SESSION_ID 2>/dev/null || echo 5)
if [ "$budget" -le 0 ]; then
  echo "Recursion budget exhausted" >&2
  exit 2
fi
echo $((budget - 1)) > /tmp/agent-budget-$SESSION_ID
```

### Pattern 7: Stop Hook Infinite Loop Prevention
```bash
# Stop hook — must check flag
if [ "${stop_hook_active}" = "true" ]; then
  exit 0
fi
# ... do work ...
```

### Pattern 8: Async Logging (Fire and Forget)
```json
{
  "type": "command",
  "command": "log-to-db.sh",
  "async": true
}
```

### Pattern 9: Input Modification (Sandbox Redirect)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "file_path": "/sandbox/original/path/here"
    }
  }
}
```

### Pattern 10: HTTP Webhook on PostToolUse
```json
{
  "type": "http",
  "url": "https://hooks.slack.com/services/YOUR/WEBHOOK",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer $SLACK_TOKEN"
  },
  "allowedEnvVars": ["SLACK_TOKEN"]
}
```

---

## Community Sentiment Summary

Reddit direct findings were sparse (search operators didn't yield threads). From indirect sources:
- Medium blog: "power users on Reddit are calling hooks a game-changer, though approximately nobody is using them"
- 4,200+ weekly contributors to r/ClaudeCode — active community but hooks are not a mainstream topic
- Power users who do use hooks are building serious infrastructure (95-hook systems, multi-agent observability layers, full memory systems)
- Most developers use CC without hooks at all
- The March 2026 source leak drove massive spike in interest (KAIROS discovery, hidden features)
- Developer sentiment: "hooks are deterministic control over a probabilistic system" — viewed as the key differentiator vs Cursor

**Memory systems via hooks:**
- Multiple community members independently built hook-based memory (Cortex, claude-map-reduce-memory, cog, idnotbe/claude-memory)
- The rechedev9 RAG system (GitHub issue #32627) is the most technically sophisticated community implementation
- None have reached Claudex's level: hybrid retrieval, Qdrant + dual embeddings, CARA opinions, pattern promotion, session signals, multi-agent coordination
- Community approaches are all single-user local; Claudex is the only multi-session, cross-agent system

---

## Sources

- [Hooks reference — Claude Code Docs](https://code.claude.com/docs/en/hooks)
- [Intercept and control agent behavior with hooks — Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [claude-map-reduce-memory](https://github.com/agynio/claude-map-reduce-memory)
- [Cortex](https://github.com/CalebDane7/cortex)
- [cog](https://github.com/marciopuga/cog)
- [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- [claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery)
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
- [everything-claude-code](https://github.com/affaan-m/everything-claude-code)
- [claude-code-new-features-early-2026](https://github.com/coleam00/claude-code-new-features-early-2026/blob/main/CHEATSHEET.md)
- [Building a Complete AI Development Ecosystem (Issue #32627)](https://github.com/anthropics/claude-code/issues/32627)
- [Claude Code Hooks: Why Each of My 95 Hooks Exists — Blake Crosley](https://blakecrosley.com/blog/claude-code-hooks)
- [Automate Your AI Workflows with Claude Code Hooks — GitButler](https://blog.gitbutler.com/automate-your-ai-workflows-with-claude-code-hooks)
- [Claude Code Hooks Mastery — yuv.ai](https://yuv.ai/blog/claude-code-hooks-mastery)
- [Claude Code Hooks Reference: All 12 Events — Pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Claude Code Hooks Complete Guide March 2026 — smartscope.blog](https://smartscope.blog/en/generative-ai/claude/claude-code-hooks-guide/)
- [How I Automated My Entire Claude Code Workflow with Hooks — DEV Community](https://dev.to/ji_ai/how-i-automated-my-entire-claude-code-workflow-with-hooks-5cp8)
- [Post/PreToolUse Hooks Not Executing — Issue #6305](https://github.com/anthropics/claude-code/issues/6305)
- [PostToolUse hooks don't execute for failed Bash commands — Issue #6371](https://github.com/anthropics/claude-code/issues/6371)
- [Hooks Completely Non-Functional in Subdirectories — Issue #10367](https://github.com/anthropics/claude-code/issues/10367)
- [PreToolUse hooks cannot block tool execution — Issue #4362](https://github.com/anthropics/claude-code/issues/4362)
- [PreToolUse hooks exit code ignored — Issue #21988](https://github.com/anthropics/claude-code/issues/21988)
- [PostToolUse Hook Exit Code 1 Blocks Execution — Issue #4809](https://github.com/anthropics/claude-code/issues/4809)
- [Hook error messages shown on every tool call — Issue #34858](https://github.com/anthropics/claude-code/issues/34858)
- [Hook Execution Failure When Multiple Hook Types Combined — Issue #4113](https://github.com/anthropics/claude-code/issues/4113)
- [Feature Request: PostToolUseError hook — Issue #15346](https://github.com/anthropics/claude-code/issues/15346)
- [CHANGELOG — anthropics/claude-code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Caught in the Hook: RCE and API Token Exfiltration — Check Point Research](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/)
- [Claude Code Leak Reveals Always-On KAIROS Agent — The Information](https://www.theinformation.com/newsletters/ai-agenda/claude-code-leak-reveals-always-kairos-agent)
- [Always-on agent and AI pet Buddy: Hidden features — The Week](https://www.theweek.in/news/sci-tech/2026/04/01/always-on-agent-and-ai-pet-buddy-anthropics-claude-source-code-leak-reveals-hidden-features.html)
- [We Reverse-Engineered 12 Versions of Claude Code — DEV Community](https://dev.to/kolkov/we-reverse-engineered-12-versions-of-claude-code-then-it-leaked-its-own-source-code-pij)
- [awesome-claude-code-postleak-insights](https://github.com/nblintao/awesome-claude-code-postleak-insights)
- [Claude Code Kit — Hacker News](https://news.ycombinator.com/item?id=45789960)
