# anthropics/claude-code — GitHub Issues Research
**Date:** 2026-04-01
**Source:** github.com/anthropics/claude-code (public issue tracker)
**Coverage:** Hook, memory, cache, token, compaction, resume issues — open and recently closed

---

## Overview

The anthropics/claude-code repository has 42,000+ issues as of April 2026. The tracker actively receives bug reports at hundreds per day. Anthropic's response pattern is sparse: the auto-bot (github-actions) labels and flags duplicates; human Anthropic engineers comment only on highest-priority or confirmed bugs. The March 23–April 1 token drain incident revealed severe communication breakdown — no status page, no blog post, engineer responses via personal Twitter only.

---

## 1. Hook-Related Issues

### Bug Reports

**#41926 — WorktreeCreate hook hang (v2.1.87)**
URL: https://github.com/anthropics/claude-code/issues/41926
Status: OPEN, labeled `bug`
`claude -w` hangs indefinitely when any `WorktreeCreate` hook is configured. Even trivial hooks (`echo ok < /dev/null`) reproduce the hang. The hook completes successfully but CC never proceeds. SessionStart hooks with worktree detection work as a workaround. No other hook types affected.

**#30973 — InstructionsLoaded hook does not fire after compaction**
URL: https://github.com/anthropics/claude-code/issues/30973
Status: OPEN, labeled `area:hooks`
`InstructionsLoaded` fires at session start with `load_reason: "session_start"` but does NOT fire after compaction. SessionStart fires with `"source": "compact"`, but no InstructionsLoaded follows. Instructions ARE re-injected (confirmed via system-reminder tags) but the hook is blind to this. No Anthropic response.

**#40010 — SessionEnd: agent-type hooks silently ignored**
URL: https://github.com/anthropics/claude-code/issues/40010
Status: OPEN, labeled `bug`, `area:hooks`
Agent-type hooks work on SessionStart/PostToolUse but are silently ignored on the SessionEnd event. Command-type hooks on SessionEnd work fine.

**#39184 — Agent-type hooks error on all event types**
URL: https://github.com/anthropics/claude-code/issues/39184
Status: OPEN, labeled `bug`, `area:hooks`
Agent-type hooks (not command-type) produce errors when configured for SessionStart, UserPromptSubmit, PostToolUse. No Anthropic response.

**#22925 — Stop hook fires inconsistently (intermittent)**
URL: https://github.com/anthropics/claude-code/issues/22925
Status: OPEN, labeled `bug`, `has repro`
Stop hook triggers intermittently in the same session, not on every assistant turn. Root cause unknown.

**#40029 — Stop hook does not fire in VSCode extension**
URL: https://github.com/anthropics/claude-code/issues/40029
Status: OPEN, labeled `bug`, `area:hooks`
Stop hook works in CLI but not in the VSCode extension UI. Platform-specific failure.

**#8985 — Notification hook broken in VSCode native UI mode**
URL: https://github.com/anthropics/claude-code/issues/8985
Status: OPEN, labeled `bug`
"Notification" hook type non-functional in VSCode native UI mode.

**#34573 — Plugin hooks.json command hooks silently dropped for PreToolUse/PostToolUse**
URL: https://github.com/anthropics/claude-code/issues/34573
Status: OPEN, labeled `bug`, `area:hooks`, `area:plugins`, stale
Plugin hooks defined in hooks.json have their command hooks silently dropped for PreToolUse/PostToolUse events.

**#29963 — HTTP hook intermittently fails with ECONNREFUSED**
URL: https://github.com/anthropics/claude-code/issues/29963
Status: OPEN, labeled `bug`, `area:hooks`
HTTP-type hooks intermittently fail with ECONNREFUSED despite the hook server being healthy.

**#34039 — SessionStart hook and skills listing re-injected on every --resume (regression)**
URL: https://github.com/anthropics/claude-code/issues/34039
Status: OPEN, labeled `bug`, `regression`, `area:hooks`, `area:skills`
Fixed in v2.1.69/v2.1.70, broken again in v2.1.74. SessionStart hook re-fires on every `--resume` instead of only on fresh sessions.

**#40391 — CLAUDE_ENV_FILE: session ID mismatch on resume causes env files written to wrong directory**
URL: https://github.com/anthropics/claude-code/issues/40391
Status: OPEN, labeled `bug`, `area:hooks`
When using `CLAUDE_ENV_FILE` hook mechanism, session ID differs between initial session and resumed session, causing env files to be written to incorrect directory.

**#37559 — Hook documentation misleading — Stop hooks broken, prompt hooks can't inject context**
URL: https://github.com/anthropics/claude-code/issues/37559
Status: OPEN, labeled `bug`, `documentation`, `area:hooks`
Official docs claim prompt hooks can inject context into UserPromptSubmit — they cannot. Stop hooks described as reliable — they are not. Capabilities per event type are undocumented.

**#34431 — SessionStart:resume hook payload missing 'cwd' field**
URL: https://github.com/anthropics/claude-code/issues/34431
Status: OPEN, labeled `bug`, `area:hooks`, stale
When SessionStart fires with `"source": "resume"`, the hook payload omits the `cwd` field, which is present for `"source": "session_start"`.

**#18547 — Plugin hooks registered but not firing in VSCode extension**
URL: https://github.com/anthropics/claude-code/issues/18547
Status: OPEN, labeled `bug`, `area:ide`
Plugin-registered hooks (PreToolUse, PostToolUse) are acknowledged but never fire in the VSCode extension.

**#40187 — Plugin hook scripts lose execute permissions after install**
URL: https://github.com/anthropics/claude-code/issues/40187
Status: OPEN, labeled `bug`, `area:hooks`, `area:plugins`
After plugin install, hook scripts lose execute permissions, causing SessionStart:resume hook to fail with permission error.

**#40050 — Plugin manager does not preserve execute permissions on hook scripts**
URL: https://github.com/anthropics/claude-code/issues/40050
Status: OPEN, labeled `bug`, `area:hooks`, `area:plugins`
Related to #40187 — the plugin manager strips execute bits.

### Feature Requests

**#33088 — Graceful context compaction: PreCompact hook data + background compaction**
URL: https://github.com/anthropics/claude-code/issues/33088
Status: OPEN, labeled `enhancement`, `area:hooks`, `area:core`
High-detail request for enriched PreCompact hook payload (context_tokens_before, context_tokens_after_estimate, messages_count, compaction_reason) plus background/incremental compaction. Community has built workarounds (Cozempic pruner, git checkpoint hooks). No Anthropic response.

**#38018 — PostCompact hook event to invalidate cached knowledge state**
URL: https://github.com/anthropics/claude-code/issues/38018
Status: OPEN, labeled `enhancement`, `area:hooks`
Request for PostCompact hook so extensions can react after compaction — e.g. invalidate knowledge-gate markers.

**#40492 — PostCompact hook for post-compaction verification**
URL: https://github.com/anthropics/claude-code/issues/40492
Status: OPEN (duplicate), labeled `enhancement`, `area:hooks`

**#34299 — Pre-compaction hook and warning before automatic compression**
URL: https://github.com/anthropics/claude-code/issues/34299
Status: OPEN (stale), labeled `enhancement`, `area:hooks`

**#36749 — Support prompt/agent hook types for PreCompact/PostCompact events**
URL: https://github.com/anthropics/claude-code/issues/36749
Status: OPEN, labeled `enhancement`, `area:hooks`
Current PreCompact/PostCompact only support command-type hooks; request to support prompt and agent hook types.

**#38924 / #38925 — Programmatic context compaction trigger from hooks**
URL: https://github.com/anthropics/claude-code/issues/38925
Status: OPEN, labeled `enhancement`, `area:hooks`, `area:core`
Request for hooks to be able to programmatically trigger compaction (not just react to it).

**#38524 — ContextThreshold hook event for proactive memory management**
URL: https://github.com/anthropics/claude-code/issues/38524
Status: OPEN (duplicate), labeled `enhancement`, `area:hooks`

**#25689 — Context usage threshold hook event**
URL: https://github.com/anthropics/claude-code/issues/25689
Status: OPEN, labeled `enhancement`
Hook that fires when context usage crosses a configurable percentage threshold.

**#26551 — Hook that fires when approaching usage limits**
URL: https://github.com/anthropics/claude-code/issues/26551
Status: OPEN, labeled (none)
Session-level usage limit threshold hook.

**#14259 — PrePlanMode and PostPlanMode Hook Events**
URL: https://github.com/anthropics/claude-code/issues/14259
Status: OPEN, labeled `enhancement`, `area:core`
Hook events for entry/exit of plan mode.

**#10168 — Add hook for user input/question events (UserInputRequired)**
URL: https://github.com/anthropics/claude-code/issues/10168
Status: OPEN, labeled `enhancement`, `area:core`
Hook that fires when Claude is waiting for user input — enables notification systems.

**#26521 — Server/IPC hook type for persistent hook processes**
URL: https://github.com/anthropics/claude-code/issues/26521
Status: OPEN (stale), labeled (none)
Alternative hook type that connects to a long-lived server via IPC/socket rather than spawning a new process per-event.

**#31242 — Post-trust hardening: per-hook visibility, headless mode protections, sandboxing**
URL: https://github.com/anthropics/claude-code/issues/31242
Status: OPEN (stale), labeled `enhancement`, `area:hooks`, `area:security`

**#30806 — Expose model and effort level to plugins/hooks API**
URL: https://github.com/anthropics/claude-code/issues/30806
Status: OPEN, labeled `enhancement`, `area:hooks`, `area:plugins`
Request for hook payloads to include current model name and effort level.

**#38024 — Include hook block reason and hook type in tool_decision OTEL event**
URL: https://github.com/anthropics/claude-code/issues/38024
Status: OPEN, labeled `enhancement`, `area:hooks`
Observability request for OpenTelemetry events.

---

## 2. Memory System Bugs

### Functional Bugs

**#41671 — Auto-memory writes inline content to MEMORY.md instead of creating linked files**
URL: https://github.com/anthropics/claude-code/issues/41671
Status: OPEN, labeled `bug`, `area:model`
The auto-memory system should create separate linked files for memories but instead dumps content inline into MEMORY.md, making the file unwieldy and defeating the hierarchy design.

**#40210 — Memory index appends new entries at bottom but truncates from bottom — newest memories lost first**
URL: https://github.com/anthropics/claude-code/issues/40210
Status: OPEN, labeled `bug`, `platform:windows`
Critical design inversion: new memories are appended to the bottom of MEMORY.md, but the file is truncated from the bottom when the 200-line limit is hit. Result: the most recent memories are always the first lost.

**#36973 — System prompt memory instructions direct writes to wrong path — memories never auto-load**
URL: https://github.com/anthropics/claude-code/issues/36973
Status: OPEN, labeled `bug`, `has repro`, `platform:wsl`
System prompt instructs Claude to write memories to a path that the memory auto-loader does not read. Memories written but never surfaced on subsequent sessions.

**#33619 — Auto-Memory folder not opening on Windows in /memory command**
URL: https://github.com/anthropics/claude-code/issues/33619
Status: OPEN, labeled `bug`, `platform:windows`
`/memory` command fails to open folder on Windows. The path handling for Windows is broken.

**#31294 — Subagents with `memory` field never create or update MEMORY.md**
URL: https://github.com/anthropics/claude-code/issues/31294
Status: OPEN, labeled `bug`, `platform:windows`, `area:agents`
Task() subagents with the `memory` parameter set do nothing — no MEMORY.md is created or updated. Memory system not functional for subagents.

**#38465 — Memories loaded but not honored as context window fills**
URL: https://github.com/anthropics/claude-code/issues/38465
Status: OPEN, labeled `bug`
Memories are injected at session start but are progressively ignored as context fills. The model stops following memory instructions without acknowledging it.

**#40374 — Memory not automatically updated after code changes in conversation**
URL: https://github.com/anthropics/claude-code/issues/40374
Status: OPEN (labeled as bug), `platform:macos`
Auto-memory does not capture code-level changes made during a conversation.

**#30667 — Auto-memory resolves to main repo path for git worktrees, preventing per-worktree memory**
URL: https://github.com/anthropics/claude-code/issues/30667
Status: OPEN, labeled `bug`, `has repro`, `area:core`
When working inside a git worktree, auto-memory uses the main repo path, not the worktree path. All worktrees share one MEMORY.md.

**#40877 — Active sessions missing from sidebar + memory/session persistence unreliable**
URL: https://github.com/anthropics/claude-code/issues/40877
Status: OPEN, labeled `bug`, `platform:windows`, `area:tui`, `area:desktop`

**#33481 — Switching branches despite memory to NOT**
URL: https://github.com/anthropics/claude-code/issues/33481
Status: OPEN, labeled `bug`, `area:model`
MEMORY.md contains explicit instruction not to switch branches. Claude ignores it.

**#27551 — /memory menu cannot be dismissed after selecting a memory location**
URL: https://github.com/anthropics/claude-code/issues/27551
Status: OPEN (stale)

**#41283 — Memory identity derived from filesystem path, causing orphaned memories**
URL: https://github.com/anthropics/claude-code/issues/41283
Status: OPEN, labeled `enhancement`, `area:core`
Memory scoping by directory path means renaming/moving a project orphans all its memories. Human-vs-project memory distinction also missing.

**#35798 — [BUG] # memory (MEMORY.md rendering issue)**
URL: https://github.com/anthropics/claude-code/issues/35798
Status: OPEN, labeled `bug`, `area:tui`

### Process Memory (RAM) Leaks

Multiple open issues report catastrophic RAM consumption — these are process-level memory leaks, not the AI memory system:

- **#33507** — 18GB private memory, macOS (duplicate)
- **#33735** — 18GB private memory, Windows 11
- **#33589** — BytesInternalReadableStreamSource ArrayBuffer accumulation (3.3GB in 59s)
- **#25023** — "huge memory leak", Linux/TUI
- **#34652** — Memory leak Ubuntu (duplicate)
- **#31651** — OOM on Ubuntu
- **#39531** — 61GB/hour growth rate in v2.1.76
- **#17615** — 304GB+ memory, macOS (stale)
- **#24827** — Windows memory leak
- **#41113** — VSCode extension: External/ArrayBuffer leak ~2MB/sec during tool use
- **#42169** — 13+GB virtual memory on Windows, resource exhaustion
- **#41342** — Closing terminal tab does not close Claude process — zombie processes accumulate

Pattern: Most are labeled `perf:memory` and marked stale/needs-repro. No confirmed Anthropic fix has shipped for the underlying leak.

### Feature Requests

**#40614 — Hierarchical memory to prevent silent loss at 200-line limit**
URL: https://github.com/anthropics/claude-code/issues/40614
Status: OPEN, labeled `enhancement`
Request for hierarchical memory with index + linked files to escape the 200-line truncation trap.

**#42198 — Move project memory to .claude/memory/ inside project**
URL: https://github.com/anthropics/claude-code/issues/42198
Status: OPEN, labeled `enhancement`, `memory`
Memory should live in the project directory, not in a global user location.

**#41532 / #28276 — Allow configurable memory storage path (memoryDirectory setting)**
URL: https://github.com/anthropics/claude-code/issues/41532
Status: OPEN, labeled `enhancement`, `memory`
User-configurable memory storage location.

**#41918 — Memory Per Project**
URL: https://github.com/anthropics/claude-code/issues/41918
Status: OPEN, labeled `enhancement`

**#36045 — Branch-aware auto-memory: scope MEMORY.md to git branch**
URL: https://github.com/anthropics/claude-code/issues/36045
Status: OPEN, labeled `enhancement`, `memory`
Per-branch memory scoping.

**#41192 — Feature request: Built-in procedural memory / session learning**
URL: https://github.com/anthropics/claude-code/issues/41192
Status: OPEN, labeled `enhancement`, `memory`

**#31515 — Observational Memory**
URL: https://github.com/anthropics/claude-code/issues/31515
Status: OPEN (stale), labeled `enhancement`, `memory`

**#40718 — Support named memory profiles (work vs. personal contexts)**
URL: https://github.com/anthropics/claude-code/issues/40718
Status: OPEN, labeled `enhancement`, `memory`

**#37102 — Automatic memory review and pruning of redundant entries**
URL: https://github.com/anthropics/claude-code/issues/37102
Status: OPEN, labeled `enhancement`, `memory`

**#34776 — Memory system governance for long-running users**
URL: https://github.com/anthropics/claude-code/issues/34776
Status: OPEN (stale), labeled `enhancement`, `memory`

**#34716 — Add memory-compaction-proof ~/.claude/INVARIANT.md**
URL: https://github.com/anthropics/claude-code/issues/34716
Status: OPEN (stale), labeled `enhancement`, `area:core`
A file that survives compaction and cannot be overwritten by the model.

**#39915 — Memory-backed constraint enforcement and pre-action gating**
URL: https://github.com/anthropics/claude-code/issues/39915
Status: OPEN, labeled `enhancement`, `memory`

**#38536 — Shared Team Memory for Claude Code**
URL: https://github.com/anthropics/claude-code/issues/38536
Status: OPEN, labeled `enhancement`

**#34192 — Persistent memory API for cross-session state**
URL: https://github.com/anthropics/claude-code/issues/34192
Status: OPEN, labeled `enhancement`

---

## 3. Cache Bugs

### The March 2026 Cache Regression Cluster (High Severity)

These bugs collectively caused the March 23 – April 1 token drain incident affecting all paid tiers.

**#40652 — CLI mutates historical tool results via cch= billing hash substitution, permanently breaking prompt cache**
URL: https://github.com/anthropics/claude-code/issues/40652
Status: OPEN, labeled `bug`, `has repro`, `area:core`
**Severity: Critical.** The standalone Claude Code binary (custom Bun fork) performs a global string substitution of `cch=XXXXX` billing attribution sentinels across the entire serialized message array before each API call. When any tool result contains a `cch=` value from the same session (e.g. via proxy logs, reading own JSONL, or grepping session files), the substitution mutates historical messages. This changes the cache prefix, invalidating the entire prompt cache for all subsequent turns. Once triggered, `cache_read_input_tokens` drops to the system-prompt-only baseline (~14.5K) and never recovers — every turn pays full cache_creation cost (10–20x more expensive against quota). Minimum reproducer: sending the string `cch=00000` as a user message. Community workaround: use `npx @anthropic-ai/claude-code` instead of the standalone binary (the npm version does not perform this substitution). Anthropic engineer Thariq Shihipar confirmed on March 31 they are "actively looking into this."

**#34629 — Prompt cache regression in --print --resume since v2.1.69: cache_read never grows, ~20x cost increase [CLOSED]**
URL: https://github.com/anthropics/claude-code/issues/34629
Status: CLOSED, labeled `bug`, `regression`, `has repro`, `area:cost`
In `--print --resume` sessions, only Claude Code's internal system prompt (~14.5K tokens) is cached. All conversation history is cache_created from scratch on every message since v2.1.69. Cost increase: ~20x per message. Regression bisected to v2.1.69. Workaround: pin to v2.1.68. This issue was closed but the root cause appears to persist — it's listed as a component of the March 2026 token drain incident.

**#40524 — Conversation history invalidated on subsequent turns (cache regression)**
URL: https://github.com/anthropics/claude-code/issues/40524
Status: OPEN, labeled `bug`, `regression`, `has repro`, `area:core`
Related to the cch= sentinel bug. Conversation history prefix is being invalidated on subsequent turns. Anthropic engineer Thariq Shihipar flagged as under active investigation (March 31).

**#41284 — Forking a session re-creates context cache**
URL: https://github.com/anthropics/claude-code/issues/41284
Status: OPEN, labeled `bug`, `has repro`, `area:cost`, `platform:wsl`
Using `/fork` to branch a conversation rebuilds the cache from scratch instead of inheriting from the parent session.

**#27048 — Prompt Cache Invalidation on Session Resume: Tool-Use Content Not Cached, Plugin State Changes Cause Full User Content Rewrite**
URL: https://github.com/anthropics/claude-code/issues/27048
Status: OPEN, labeled `bug`
Plugin state mutations cause the entire user-turn content to be rewritten on session resume, invalidating the prompt cache.

**#37188 — Background agents fail with cache_control TTL ordering error (1h after 5m)**
URL: https://github.com/anthropics/claude-code/issues/37188
Status: OPEN, labeled `bug`, `has repro`, `area:mcp`, `area:agents`
With 12+ MCP servers configured (~100+ tools), background agents fail with API 400 error: `"a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block"`. Intermittent with concurrent agents; sequential agents avoid it. Misleadingly surfaced to agents as "Not logged in" error.

**#38542 — cache_control TTL ordering error when hooks/MCP inject additionalContext into long conversations**
URL: https://github.com/anthropics/claude-code/issues/38542
Status: OPEN (duplicate), labeled `bug`, `has repro`, `area:hooks`, `area:mcp`
Same TTL ordering error triggered by hook/MCP context injection in long sessions.

**#41454 — Cache breakpoints misplaced when using --resume and -p flags**
URL: https://github.com/anthropics/claude-code/issues/41454
Status: OPEN, labeled `bug`, `area:cost`, `area:cli`, `needs-repro`

**#41663 — Prompt Cache causes excessive token consumption (10–20x inflation)**
URL: https://github.com/anthropics/claude-code/issues/41663
Status: OPEN (duplicate), labeled `bug`, `area:cost`

**#41731 — VS Code extension sends unsupported `scope` field in cache_control, causing 400 API errors**
URL: https://github.com/anthropics/claude-code/issues/41731
Status: OPEN, labeled `bug`
The VSCode extension adds a `scope` field to cache_control blocks that the API does not support.

**#39732 — Prompt caching disabled for SDK query() and V2 sessions**
URL: https://github.com/anthropics/claude-code/issues/39732
Status: OPEN, labeled `bug`, `area:agent-sdk`
Prompt caching is only enabled in REPL mode; disabled for `sdk.query()` and V2 session types. Significant cost penalty for SDK users.

**#29966 — Agent SDK subagents have prompt caching disabled by default**
URL: https://github.com/anthropics/claude-code/issues/29966
Status: OPEN (stale), labeled `bug`, `has repro`, `area:agent-sdk`
`enablePromptCaching: false` is the default for SDK subagents. Users must explicitly opt in.

**#32102 — SDK consumers cannot control prompt cache segmentation**
URL: https://github.com/anthropics/claude-code/issues/32102
Status: OPEN (stale), labeled `enhancement`, `area:agent-sdk`

**#38356 — Parallel API during user turn causes significant prompt cache write penalty on Bedrock**
URL: https://github.com/anthropics/claude-code/issues/38356
Status: OPEN, labeled `bug`, `has repro`, `api:bedrock`

**#34334 — Honor MCP tool result _meta.cache_hint to control prompt caching**
URL: https://github.com/anthropics/claude-code/issues/34334
Status: OPEN (stale), labeled `enhancement`, `area:mcp`

**#29230 — Claude Code v2.1.62 — Server-Side KV Cache Stale Context Regression [CLOSED]**
URL: https://github.com/anthropics/claude-code/issues/29230
Status: CLOSED, labeled `bug`, `needs-repro`, `area:core`
An earlier server-side KV cache regression where stale context was served from cache. Closed without confirmed resolution.

**#40567 — Token cache guard [marked invalid]**
URL: https://github.com/anthropics/claude-code/issues/40567
Status: OPEN, labeled `invalid` (not a CC issue per maintainers)

**#30103 — System scaffold tokens should use global cache and not be billed as user input**
URL: https://github.com/anthropics/claude-code/issues/30103
Status: OPEN (stale), labeled `enhancement`, `area:cost`

**#22417 — Reduce unexpected cache write costs on Bedrock**
URL: https://github.com/anthropics/claude-code/issues/22417
Status: OPEN, labeled `enhancement`, `api:bedrock`, `area:cost`

---

## 4. Token Usage Concerns

### Major Incident: March 23 – April 1, 2026 Token Drain

**#41930 — Critical: Widespread abnormal usage limit drain across all paid tiers since March 23**
URL: https://github.com/anthropics/claude-code/issues/41930
Status: OPEN, labeled `bug`
Comprehensive incident report. Community identified at least four overlapping causes:
1. Intentional peak-hour throttling (confirmed by Anthropic on March 26 via engineer personal X post)
2. Two prompt-caching bugs inflating token costs 10–20x (cch= sentinel + resume flag cache invalidation)
3. Session-resume bugs triggering full context reprocessing
4. Expiration of 2x off-peak promotion on March 28

Documented user impact: single "hello" consuming 2–7% of 5-hour session quota; sessions depleting in 19 minutes. Community workarounds: downgrade to v2.1.34; use `npx @anthropic-ai/claude-code` instead of standalone binary; avoid `--resume`/`--continue` flags; use `/clear` for fresh sessions. No official blog post, email, or status page entry as of April 1.

**#39803 — Anomalous cache read token consumption with agent-based workflows (19.5M tokens)**
URL: https://github.com/anthropics/claude-code/issues/39803
Status: OPEN, labeled `bug`, `area:cost`, `area:agents`, `platform:wsl`
19.5M tokens consumed for a single fullstack feature via agent workflows — mostly cache_read tokens, indicating the cache accounting is wrong or the compaction loop was re-running.

**#41607 — Duplicate compaction subagents spawned (5x identical work, 65% of session quota)**
URL: https://github.com/anthropics/claude-code/issues/41607
Status: OPEN, labeled `bug`, `has repro`, `area:cost`, `area:agents`
Compaction subagents spawn 5 identical concurrent copies, each doing identical work. Changelog claimed fix in a recent version — still broken in v2.1.85–87. 65% of one session's quota consumed by duplicate compaction agents at Opus rates.

**#41346 — Extended thinking generates duplicate .jsonl entries with identical input tokens, causing 2–3x token inflation in usage tracking**
URL: https://github.com/anthropics/claude-code/issues/41346
Status: OPEN, labeled `bug`, `has repro`, `area:cost`
Each API response with N content blocks (thinking + text + tool_use) is logged as N separate assistant entries, each carrying the full `usage` object. If quota is summed from JSONL entries rather than deduplicated by requestId, every session with extended thinking is 2–3x overcounted.

**#36727 — Sub-agent has no tool call / token / time limits, causing unbounded token consumption**
URL: https://github.com/anthropics/claude-code/issues/36727
Status: OPEN, labeled `enhancement`, `area:cost`, `area:agents`
No mechanism to constrain subagent resource usage.

**#35565 — Excessive token waste from unnecessary parallel agent launches**
URL: https://github.com/anthropics/claude-code/issues/35565
Status: OPEN, labeled `bug`, `area:cost`, `area:agents`

**#41461 — Background agents cannot be stopped; Claude lies about stopping; massive token waste (~1.4M tokens)**
URL: https://github.com/anthropics/claude-code/issues/41461
Status: OPEN, labeled `bug`, `area:agents`, `area:cost`, `platform:windows`, `platform:vscode`

**#40790 — Excessive token consumption spike since March 23**
URL: https://github.com/anthropics/claude-code/issues/40790
Status: OPEN, labeled `bug`, `area:cost`

**#41288 — Unnecessary token consumption due to model errors**
URL: https://github.com/anthropics/claude-code/issues/41288
Status: OPEN, labeled `bug`, `area:cost`, `area:model`
When the model encounters errors, it retries consuming tokens without informing the user.

**#40646 — Context window deduplication for repeated token sequences**
URL: https://github.com/anthropics/claude-code/issues/40646
Status: OPEN, labeled `enhancement`, `area:core`
Feature request: deduplicate identical token sequences in context window before sending to API.

**#38000 — Token limit dialog should account for token reset timing**
URL: https://github.com/anthropics/claude-code/issues/38000
Status: OPEN, labeled `enhancement`, `area:tui`
The UI shows "limit reached" without indicating when the limit resets.

**#35563 — Option to choose Token Budget vs. Effort level**
URL: https://github.com/anthropics/claude-code/issues/35563
Status: OPEN, labeled `enhancement`, `area:model`

**#13579 — Community Learnings: 7 Critical Token-Wasting Patterns (700K+ tokens saved)**
URL: https://github.com/anthropics/claude-code/issues/13579
Status: OPEN (community resource thread)
High-value community document identifying: (1) reading large files unnecessarily, (2) not using `.claudeignore`, (3) over-indexing on irrelevant context, (4) not using subagents for isolated tasks, (5) compaction loops, (6) not clearing session before topic switch, (7) verbose tool results.

---

## 5. Compaction Issues

### Data Loss / Correctness Bugs

**#40352 — Compaction race condition: rate limit during compaction destroys entire conversation transcript**
URL: https://github.com/anthropics/claude-code/issues/40352
Status: OPEN, labeled `bug`, `has repro`, `area:core`, `data-loss`
**Critical data-loss bug.** Compaction clears all message content in the JSONL transcript as a first step, then calls the API to generate a summary. If the API call fails (rate limit), the original content is permanently lost — 4,252 out of 4,319 messages emptied. No rollback mechanism exists. Fix: make compaction atomic — don't clear original content until the summary API call succeeds. Community workaround: PreCompact hook that commits changes to git before compaction fires.

**#41984 — Frequent premature compaction + infinite loop + prompt freezing with Opus 4.6 on 1M context**
URL: https://github.com/anthropics/claude-code/issues/41984
Status: OPEN, labeled `bug`
Compaction fires far too early (at ~16% of 1M context), enters a loop, and freezes the prompt indefinitely.

**#34254 — Context compaction triggers at ~16% usage on Opus 4.6 (1M context) [duplicate]**
URL: https://github.com/anthropics/claude-code/issues/34254
Status: OPEN (duplicate)

**#41198 — Context compaction retry loop burns ~1M tokens with no user present**
URL: https://github.com/anthropics/claude-code/issues/41198
Status: OPEN, labeled `bug`, `has repro`, `area:core`, `area:cost`
Compaction retry loop runs indefinitely, consuming ~1M tokens with no user present. The documented circuit-breaker (stops after 3 failures) is either not working or not triggering.

**#34278 — Context window docs missing auto-compaction circuit breaker behavior**
URL: https://github.com/anthropics/claude-code/issues/34278
Status: OPEN, labeled `documentation`, `area:docs`
Auto-compaction stops after 3 failures but this is undocumented. Related to the thrash-loop bug.

**#34674 — Edit tool changes to git-tracked files silently reverted during context compaction**
URL: https://github.com/anthropics/claude-code/issues/34674
Status: OPEN, labeled `bug`, `has repro`, `area:tools`, `area:core`, `data-loss`
File changes made with the Edit tool are silently rolled back during context compaction. Data loss.

**#40665 — Auto-compaction can leave zero usable context in long sessions**
URL: https://github.com/anthropics/claude-code/issues/40665
Status: OPEN, labeled `bug`, `has repro`, `area:core`
After auto-compaction, the remaining usable context can be zero or near-zero, making the session unusable.

**#33898 — Session name reverts after context compaction**
URL: https://github.com/anthropics/claude-code/issues/33898
Status: OPEN, labeled `bug`, `has repro`, `area:tui`
Custom session name is lost/reset after compaction.

**#29922 — Session name lost after context compaction**
URL: https://github.com/anthropics/claude-code/issues/29922
Status: OPEN, labeled `bug`, `regression`

**#34718 — Context compaction clears terminal scrollback history**
URL: https://github.com/anthropics/claude-code/issues/34718
Status: OPEN, labeled `bug`, `area:tui`
Compaction clears the visible terminal scrollback, losing conversation display. Also reported in #41903.

**#40193 — Skill invocations persist through context compaction and are re-executed as new requests**
URL: https://github.com/anthropics/claude-code/issues/40193
Status: OPEN, labeled `bug`, `area:core`, `platform:wsl`
Skill invocations are baked into the compacted context and re-triggered after compaction as if new.

**#31828 — Auto compaction becomes silent (regression)**
URL: https://github.com/anthropics/claude-code/issues/31828
Status: OPEN, labeled `bug`, `regression`, `area:tui`
Auto-compaction triggers with no visual indication or notification.

**#30961 — Tasks lost during conversation compaction**
URL: https://github.com/anthropics/claude-code/issues/30961
Status: OPEN (stale), labeled `bug`, `regression`, `area:core`

**#35897 — Compaction with paths to corrupted images fails**
URL: https://github.com/anthropics/claude-code/issues/35897
Status: OPEN, labeled `bug`, `area:core`
Compaction fails completely if the conversation contains references to corrupted or missing image files.

**#24591 — Context compaction fails with multiple subagents**
URL: https://github.com/anthropics/claude-code/issues/24591
Status: OPEN (stale), labeled `bug`, `has repro`, `area:mcp`

**#34832 — Cowork MCP connectors lose auth after context compaction**
URL: https://github.com/anthropics/claude-code/issues/34832
Status: OPEN, labeled `bug`, `area:mcp`, `area:cowork`

**#37273 — Cowork: Context compaction permanently removes scrollable conversation history**
URL: https://github.com/anthropics/claude-code/issues/37273
Status: OPEN, labeled `bug`, `area:cowork`

**#41027 — Claude Code keeps coming back to /skill after compacting memory**
URL: https://github.com/anthropics/claude-code/issues/41027
Status: OPEN, labeled `bug`, `area:skills`

**#32691 — Context compaction triggers too frequently and takes too long**
URL: https://github.com/anthropics/claude-code/issues/32691
Status: OPEN, labeled `bug`, `area:core`, `performance`

**#41486 — Telegram plugin: duplicate process after compaction causes 409 Conflict**
URL: https://github.com/anthropics/claude-code/issues/41486
Status: OPEN, labeled `bug`, `area:plugins`

**#30400 — Context limit reached without automatic compaction triggering**
URL: https://github.com/anthropics/claude-code/issues/30400
Status: OPEN, labeled `bug`, `area:core`

### Compaction Feature Requests

**#32946 — Rolling asynchronous compaction**
URL: https://github.com/anthropics/claude-code/issues/32946
Status: OPEN, labeled `enhancement`, `memory`
Compact oldest N messages continuously in background rather than hitting a wall.

**#41037 / #34925 / #41818 — Configurable auto-compaction threshold**
URL: https://github.com/anthropics/claude-code/issues/41037
Status: OPEN, labeled `enhancement`, `area:core`
Many duplicate requests to control the % threshold at which auto-compaction fires (current 80% feels too aggressive especially for 1M context models).

**#33026 — Allow Claude to self-initiate context compaction**
URL: https://github.com/anthropics/claude-code/issues/33026
Status: OPEN, labeled `enhancement`, `area:core`

**#39574 — Compact tool for programmatic context compaction**
URL: https://github.com/anthropics/claude-code/issues/39574
Status: OPEN, labeled `enhancement`, `area:core`

**#42149 — Add autoCompact: false setting to fully disable auto-compaction**
URL: https://github.com/anthropics/claude-code/issues/42149
Status: OPEN

**#34202 — Compaction trigger threshold (150K) does not scale with 1M context window**
URL: https://github.com/anthropics/claude-code/issues/34202
Status: OPEN (duplicate), labeled `enhancement`, stale

**#41796 — [DOCS] Auto-compaction docs omit thrash-loop stop condition**
URL: https://github.com/anthropics/claude-code/issues/41796
Status: OPEN

**#34716 — Add memory-compaction-proof INVARIANT.md**
URL: https://github.com/anthropics/claude-code/issues/34716
Status: OPEN (stale), labeled `enhancement`, `area:core`

**#31563 — Persist PR workflow context across compaction**
URL: https://github.com/anthropics/claude-code/issues/31563
Status: OPEN (stale), labeled `enhancement`, `memory`

**#31420 — Auto-backup Task outputs before context compaction**
URL: https://github.com/anthropics/claude-code/issues/31420
Status: OPEN (stale), labeled `enhancement`, `area:hooks`, `area:agents`

---

## 6. Session Resume Bugs

**#40319 — Session resume loads zero conversation history — silently drops all context**
URL: https://github.com/anthropics/claude-code/issues/40319
Status: OPEN, labeled `bug`, `has repro`, `area:core`
`--resume` loads the session file but provides zero conversation history. The session starts blank despite history existing on disk.

**#33912 — claude --resume <session-id> always returns 'No conversation found' even though session files exist**
URL: https://github.com/anthropics/claude-code/issues/33912
Status: OPEN, labeled `bug`, `has repro`, `area:cli`
Session files present on disk, yet `--resume` reports no conversation found.

**#42030 — /resume shows only stale sessions — recent sessions missing (v2.1.89, no sessions-index.json)**
URL: https://github.com/anthropics/claude-code/issues/42030
Status: OPEN
Recent sessions (within hours) not appearing in `/resume` picker. `sessions-index.json` not being written.

**#38317 — /resume only shows ~5–10 recent sessions (regression persists in v2.1.81)**
URL: https://github.com/anthropics/claude-code/issues/38317
Status: OPEN (duplicate), labeled `bug`, `has repro`, `area:cli`
Resume picker truncates to 5–10 sessions regardless of actual session count.

**#40620 — Session resume fails immediately after logout**
URL: https://github.com/anthropics/claude-code/issues/40620
Status: OPEN, labeled `bug`, `has repro`, `platform:windows`, `area:cli`

**#34661 — Agent --resume ignores MEMORY.md: complete context loss on session resume**
URL: https://github.com/anthropics/claude-code/issues/34661
Status: OPEN, labeled `bug`, `platform:windows`, `area:core`
Agents resumed via `--resume` do not load MEMORY.md. Decision instability results.

**#40022 — SDK Stop hook: structured output enforcement skipped on resumed sessions**
URL: https://github.com/anthropics/claude-code/issues/40022
Status: OPEN, labeled `bug`, `has repro`, `area:agent-sdk`
`--resume + --json-schema` sessions skip the structured output enforcement that Stop hooks provide.

**#39291 — claude --resume does not resume, but -r does**
URL: https://github.com/anthropics/claude-code/issues/39291
Status: OPEN, labeled `bug`, `has repro`, `area:cli`
Long form `--resume` flag broken; short `-r` flag works.

**#39249 — /branch command outputs incorrect resume command — missing --resume flag**
URL: https://github.com/anthropics/claude-code/issues/39249
Status: OPEN, labeled `bug`, `has repro`, `area:cli`

**#35732 — /fork command outputs broken resume command**
URL: https://github.com/anthropics/claude-code/issues/35732
Status: OPEN, labeled `bug`, `area:cli`

**#38089 — --resume should not require matching working directory**
URL: https://github.com/anthropics/claude-code/issues/38089
Status: OPEN, labeled `bug`, `area:cli`
`--resume` fails if CWD does not match the original session's CWD. Working directory lock is wrong behavior.

**#37099 — Sessions started with TeamCreate permanently hidden from --resume**
URL: https://github.com/anthropics/claude-code/issues/37099
Status: OPEN, labeled `bug`, `has repro`, `area:core`
Sessions created via TeamCreate (e.g. custom skills/agent spawning) never appear in the `--resume` picker.

**#39658 — slash-clear creates sessions invisible to slash-resume picker**
URL: https://github.com/anthropics/claude-code/issues/39658
Status: OPEN, labeled `bug`, `has repro`, `platform:windows`, `area:cli`
Using `/clear` within a session creates a malformed session file that `--resume` cannot find.

**#39414 — /resume picker doesn't show session names set via /rename**
URL: https://github.com/anthropics/claude-code/issues/39414
Status: OPEN, labeled `bug`, `area:tui`

**#37083 — /rename breaks /resume picker — shows only renamed session**
URL: https://github.com/anthropics/claude-code/issues/37083
Status: OPEN, labeled `bug`, `has repro`, `area:tui`

**#31394 — /rename command does not persist in /resume list**
URL: https://github.com/anthropics/claude-code/issues/31394
Status: OPEN, labeled `bug`, `area:tui`

**#40081 — Named session lost after system restart — not visible in /resume**
URL: https://github.com/anthropics/claude-code/issues/40081
Status: OPEN, labeled `bug`, `has repro`

**#40609 — Session files deleted after --print exit, making --resume impossible**
URL: https://github.com/anthropics/claude-code/issues/40609
Status: OPEN, labeled `bug`, `has repro`, `area:cli`
Session files are cleaned up after headless `--print` mode exits, preventing resume.

**#41470 — --resume crashes with EISDIR when a previously-read file path is now a directory**
URL: https://github.com/anthropics/claude-code/issues/41470
Status: OPEN, labeled `bug`, `has repro`, `area:core`, `area:agents`
If a path that was read as a file in a previous session has since become a directory, `--resume` crashes.

**#34039 — Regression: SessionStart hook and skills listing re-injected on every --resume**
URL: https://github.com/anthropics/claude-code/issues/34039
Status: OPEN, labeled `bug`, `regression`, `area:hooks`, `area:skills`
(Listed under hooks but directly affects resume behavior.)

**#38575 — Agent SDK session resume docs incomplete — hook messages can silently corrupt history reconstruction**
URL: https://github.com/anthropics/claude-code/issues/38575
Status: OPEN, labeled `documentation`, `area:hooks`, `area:agent-sdk`
Docs don't explain that hook messages injected into history can corrupt the session reconstruction logic on resume.

**#24809 — customTitle not restored when resuming session via --resume**
URL: https://github.com/anthropics/claude-code/issues/24809
Status: OPEN (stale), labeled `bug`, `has repro`, `area:tui`

**#35381 — /resume only shows named sessions, claude --resume shows all**
URL: https://github.com/anthropics/claude-code/issues/35381
Status: OPEN (stale), labeled `bug`, `area:cli`
Inconsistent session filtering between `/resume` command and `--resume` flag.

**#32984 — Agent resume fails with infinite retry loop when agent still running**
URL: https://github.com/anthropics/claude-code/issues/32984
Status: OPEN (stale), labeled `bug`, `has repro`, `area:agents`

**#32085 — Background agent resume creates retry loop**
URL: https://github.com/anthropics/claude-code/issues/32085
Status: OPEN (stale), labeled `bug`, `area:agents`

**#42146 — Resume with initial command runs command before large-context compaction prompt**
URL: https://github.com/anthropics/claude-code/issues/42146
Status: OPEN
Race condition between initial command execution and compaction prompt on resume.

**#40391 — CLAUDE_ENV_FILE: session ID mismatch on resume causes env files to wrong directory**
URL: https://github.com/anthropics/claude-code/issues/40391
Status: OPEN, labeled `bug`, `has repro`, `area:hooks`
(Duplicate from hooks section — directly a resume bug too.)

---

## 7. Hook Feature Requests (Extension Points)

Summary of the most-requested new hook events and capabilities:

| Requested Hook/Feature | Issue | Status |
|---|---|---|
| Enriched PreCompact payload (token counts, compaction reason) | #33088 | OPEN |
| PostCompact event | #38018, #40492 | OPEN |
| ContextThreshold event (% threshold) | #38524, #25689, #30590 | OPEN (duplicates) |
| UsageLimit approaching event | #26551 | OPEN |
| PrePlanMode / PostPlanMode events | #14259 | OPEN |
| UserInputRequired event | #10168 | OPEN |
| Persistent hook server/IPC type | #26521 | OPEN (stale) |
| Prompt/agent hook type for PreCompact/PostCompact | #36749 | OPEN |
| Expose model + effort level to hooks | #30806 | OPEN |
| Programmatic compaction trigger from hook | #38925 | OPEN |
| Per-hook visibility controls / sandboxing | #31242 | OPEN (stale) |
| Hook that fires before headless --resume tool decisions | #41791 | OPEN |

---

## 8. Anthropic Official Responses

Anthropic's response pattern on the issue tracker is sparse. Observations:

**Auto-bot (github-actions):** Runs on all issues. Flags potential duplicates within hours. Applies labels. Issues marked `stale` after ~2 weeks of inactivity get auto-closed warning. This is the primary triage mechanism.

**Human Anthropic responses confirmed:**
- **#41930** (March 23 token drain): Anthropic Reddit account stated it was "top priority" on March 31. Product lead Lydia Hallie acknowledged on X. No official blog post, no email, no status page.
- **#40652** (cch= cache sentinel bug): Engineer Thariq Shihipar stated on March 31 they are "actively looking into this in particular."
- **#40524** (cache regression): Same engineer, same statement.
- General token drain: PCWorld confirmed Anthropic acknowledged "adjusting limits" via direct outreach on March 26.

**No Anthropic responses found on:**
- Memory system bugs (#40210, #36973, #41671, #31294)
- Hook event gaps (#30973, #33088, #39184, #40010)
- Compaction data-loss bugs (#40352, #34674)
- Resume picker bugs (#42030, #40319, #33912)

---

## 9. Planned Features (Community-Surfaced via Issues)

No formal roadmap is published. From issue discussions and changelog references:

**Partially shipped / in progress:**
- "Fixed background subagents becoming invisible after context compaction, which could cause duplicate agents to be spawned" — in a recent changelog (but fix incomplete per #41607)
- "Improved memory usage and startup time when resuming large sessions" — shipped ~March 28 (mentioned in #41930 as potentially related to resume token generation bug)

**Frequently requested, no response:**
- Configurable compaction threshold (dozens of duplicates: #34925, #41037, #41818, #25679)
- PreCompact/PostCompact hook enrichment (#33088 — no Anthropic response)
- ContextThreshold hook event (#38524, #25689, #30590 — no Anthropic response)
- Per-worktree memory scoping (#36045, #30667 — no Anthropic response)
- Hierarchical memory (indexed files, not flat MEMORY.md) (#40614 — no Anthropic response)
- Background/async compaction (#32946 — no Anthropic response)
- Persistent hook server type (#26521 — no Anthropic response, stale)

---

## Key Findings for Claudex

1. **cch= billing sentinel cache bug** is the most actionable reverse-engineered finding. Workaround is `npx` instead of standalone binary. Claudex hooks should never output text containing `cch=` patterns to avoid self-poisoning.

2. **cache_control TTL ordering (1h after 5m)** is a real API constraint that hits systems injecting additionalContext via hooks with many MCP servers. Claudex hooks injecting context should be aware of TTL ordering rules.

3. **InstructionsLoaded does not fire after compaction** (#30973) — directly relevant to Claudex. CLAUDE.md changes after compaction are invisible to hooks that depend on InstructionsLoaded. SessionStart with `"source": "compact"` is the signal to use instead.

4. **Resume session ID mismatch** (#40391) — CLAUDE_ENV_FILE hook mechanism gets wrong session IDs on resume. Directly relevant to session-tracking in Claudex hooks.

5. **Compaction is not atomic** (#40352) — a PreCompact hook that checkpoints state to git or DB before compaction fires is the community's own recommended mitigation. This validates Claudex's checkpoint approach.

6. **Memory system design is widely considered broken** by the community — flat file, 200-line limit, bottom-truncation, wrong identity scoping. Claudex's SQLite+Qdrant approach sidesteps all of these.

7. **No PreCompact payload enrichment** (#33088) — hooks cannot see how many tokens are about to be compacted. Claudex's pressure system that monitors context from JSONL directly is the correct approach since the hook API doesn't expose this.

8. **Duplicate compaction agents** (#41607) — not yet fixed as of v2.1.87. Any system relying on CC's compaction for context management should expect quota inflation from this bug.
