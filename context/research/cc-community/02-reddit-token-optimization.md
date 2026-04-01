# CC Token Optimization — Street Knowledge Research

**Date:** 2026-04-01
**Scope:** Reddit, GitHub Issues, HN, community blogs — real practitioner knowledge about CC token usage, weekly limits, and optimization strategies.

---

## Q1: How do cached vs uncached tokens count toward the weekly limit?

**Short answer:** Both count, but at different effective weights. Cache reads are billed at 10% of base input token price, but they still consume weekly quota — and this is the central community complaint.

### Confirmed findings

**Cache reads consume quota.** The most-cited GitHub issue (#24147) documented a 30-day period where cache reads constituted **99.93% of total token consumption** — a 1,310:1 ratio of cache reads to actual I/O tokens. The full JSONL measurement:

```
I/O tokens (actual work):     3,887,759
Cache creation tokens:      176,498,498
Cache read tokens:        5,092,500,074   ← 99.93% of total
```

This user had a ~57KB CLAUDE.md (≈15,000 tokens). At 15,000 cache reads per message, a 100-message session costs **1.5M cache reads** from instructions alone — before any actual conversation tokens. — [Source: GitHub #24147](https://github.com/anthropics/claude-code/issues/24147)

**Cache scaling is super-linear.** The same issue shows cache reads scaled with CLAUDE.md growth, not workload:
- Week 1: 276M cache reads
- Week 4 (peak): 1,474M cache reads
- This happened without changing the workload — only the CLAUDE.md grew.

**Cache TTL matters.** Cache expires after approximately 60 minutes (5-minute TTL for writes, 1-hour TTL for longer retention). After idle periods exceeding the TTL, the entire conversation cache rebuilds from scratch. One HN commenter: *"Every time you use --resume, your entire conversation cache rebuilds from scratch. One resume on a large conversation costs $0.15 that should cost near zero."* — [HN discussion](https://news.ycombinator.com/item?id=47586176)

**Compaction destroys cache (except system prompt).** A traced session found that compaction invalidates the entire conversation cache, keeping only the system prompt cached. This adds approximately $0.25 hidden cost per compaction event for the hidden context-reading API call. — [DEV Community: Where Do Your Tokens Actually Go](https://dev.to/slima4/where-do-your-claude-code-tokens-actually-go-we-traced-every-single-one-423e)

**Official position:** The CC cost docs state "prompt caching reduces costs for repeated content like system prompts" but do not clarify how cache reads are weighted against the weekly limit. — [CC Docs: Manage Costs](https://code.claude.com/docs/en/costs)

**Community measurement tool:** GitHub #24147 includes a Python script (`claude_token_analyzer.py`) that parses `~/.claude/projects/<project>/<session-id>.jsonl` to extract all four token categories by day/week/model.

---

## Q2: What strategies do people use to conserve tokens?

Ranked by community consensus and measured impact:

### Tier 1 — Highest impact (30–70% reduction reported)

**1. Keep CLAUDE.md under 200 lines / ~1,000 tokens.**
The #1 structural fix. Official docs recommend "aim to keep CLAUDE.md under 200 lines by including only essentials." A bloated CLAUDE.md costs tokens on *every message* across *all sessions*. Move specialized workflows to skills that load on-demand. One team reduced costs from $189/month to $72/month just by restructuring CLAUDE.md. — [CC Docs: Costs](https://code.claude.com/docs/en/costs), [Medium: Stop Wasting Tokens](https://medium.com/@jpranav97/stop-wasting-tokens-how-to-optimize-claude-code-context-by-60-bfad6fd477e5)

**2. Disable unused MCP servers.**
With 7 MCP servers active, tool definitions consume **67,300 tokens (33.7% of 200k context)** before any conversation begins. Even 3 servers = 42,600 tokens. Per-tool costs: Playwright (~3,442 tokens for 22 tools), Gmail (~2,640 tokens for 7 tools), SQLite (~385 tokens for 6 tools). Use `/mcp` to disable unused servers. — [MCP Token Cost Breakdown](https://www.jdhodges.com/blog/claude-code-mcp-server-token-costs/), [GitHub Issue #11364](https://github.com/anthropics/claude-code/issues/11364)

**3. Start fresh sessions frequently.**
"The single highest-impact change" per multiple sources. Ten tasks in one conversation costs 5.5x more than ten separate conversations (conversation history re-transmitted every turn). "30-Minute Rule": if a session lasts >30 minutes, start fresh. — [The Token Guide (Substack)](https://limitededitionjonathan.substack.com/p/why-you-keep-hitting-claudes-usage)

**4. Switch to Sonnet, use Opus sparingly.**
Opus costs approximately 1.7x more per token than Sonnet and comes with tighter weekly hour caps. Community target: 80%+ Sonnet, <20% Opus. Use `/model` to switch mid-session. — [Faros.ai: Token Limits Guide](https://www.faros.ai/blog/claude-code-token-limits)

**5. Add `.claudeignore`.**
Prevents CC from scanning build artifacts, lock files, node_modules, generated code. Saves thousands of tokens per session from file indexing. — [CC Docs: Costs](https://code.claude.com/docs/en/costs)

### Tier 2 — Medium impact (20–40% reduction reported)

**6. Use `/compact` proactively, not reactively.**
Run `/compact` at session end and every ~40 messages. Accepts focus parameters: `/compact "Focus on code samples and API usage"`. The official compaction trigger fires at ~83% context (167k tokens in a 200k window), leaving 33k unused headroom. Triggering it manually at 60% recovers that headroom. — [GitHub Gist: Token Workflow](https://gist.github.com/dholdaway/8009f089d3407e14f3d753f2a70eb63e), [CC Docs: Costs](https://code.claude.com/docs/en/costs)

**7. Disable extended thinking for simple tasks.**
Extended thinking is enabled by default. Default budget: up to 31,999 thinking tokens per request, billed as output tokens. Set `MAX_THINKING_TOKENS=8000` or lower with `/effort` for routine tasks. — [CC Docs: Costs](https://code.claude.com/docs/en/costs)

**8. Delegate verbose operations to subagents.**
Running tests, fetching docs, processing log files generates verbose output. Use subagents to isolate this output — only a summary returns to the main context. — [CC Docs: Costs](https://code.claude.com/docs/en/costs)

**9. Shift heavy work to off-peak hours.**
Peak hours (5am–11am PT weekdays) consume the 5-hour session window faster than off-peak. The same task that uses 20% of quota off-peak may use 35–40% during peak. — [TechRadar: Peak Hours Change](https://www.techradar.com/ai-platforms-assistants/claude/claude-is-limiting-usage-more-aggressively-during-peak-hours-heres-what-changed)

**10. Use hooks to preprocess data before Claude sees it.**
A PreToolUse hook that filters test output to show only failures reduces context from tens of thousands of tokens to hundreds. A hook that grep's logs before Claude reads them is 100x more token-efficient than letting Claude read a 10,000-line log file. — [CC Docs: Costs](https://code.claude.com/docs/en/costs)

### Tier 3 — Structural fixes

**11. Replace exploratory prompts with scoped ones.**
"Improve this codebase" triggers broad file scanning. "Add input validation to the login function in auth.ts" scopes the work. Token reduction per task: measured at 58–74% by pre-indexing or specifying exact file paths. — [DEV Community: 70% Waste Analysis](https://dev.to/nicolalessi/i-tracked-every-token-my-ai-coding-agent-consumed-for-a-week-70-was-waste-465)

**12. Cache research in markdown files.**
Re-reading web searches and documentation repeatedly wastes tokens. One 30-day study found caching research in markdown reduced per-research-cycle costs by ~73%. — [DEV Community: 30-Day Token Math](https://dev.to/yurukusa/the-token-per-dollar-math-running-claude-max-for-30-days-2k1o)

**13. Use CLI tools instead of MCP where possible.**
`gh`, `aws`, `gcloud` add zero per-tool token overhead. MCP equivalents add 500–850 tokens per tool definition every message. — [CC Docs: Costs](https://code.claude.com/docs/en/costs)

**14. Use npx instead of the standalone binary (workaround for cache bug).**
The Bun-based binary contains a sentinel string replacement bug that can break cache prefixes, causing 10–20x token overconsumption. Running via `npx @anthropic-ai/claude-code` avoids this. — [DEV Community: 10-20x Token Burn Fix](https://dev.to/fillip_kosorukov/claude-code-is-silently-burning-10-20x-your-token-budget-heres-the-fix-4mpk)

**15. Control the `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var.**
Values 1–100 control at what percentage of context usage auto-compaction fires. Higher values give more usable context before compaction triggers. — [ClaudeFa.st: Context Buffer Management](https://claudefa.st/blog/guide/mechanics/context-buffer-management)

---

## Q3: What are the actual weekly limit numbers? How do they work?

### The limit structure (as of 2026-04)

There are two overlapping rate limit systems:

**5-hour rolling session window** — controls burst activity:
- Pro: ~44,000 tokens per window (~45 prompts)
- Max 5x: ~88,000 tokens per window
- Max 20x: ~220,000 tokens per window

**Weekly ceiling** — caps total active compute hours:
- Pro: 40–80 active Sonnet hours/week
- Max 5x: 140–280 Sonnet hours/week (15–35 Opus hours)
- Max 20x: 240–480 Sonnet hours/week (24–40 Opus hours)

Source: [Portkey.ai: Everything We Know About CC Limits](https://portkey.ai/blog/claude-code-limits/), [Faros.ai](https://www.faros.ai/blog/claude-code-token-limits)

**"Active hours" definition:** Periods when models are actively processing — excludes idle time, file browsing, conversational pauses. — [TrueFoundry: CC Limits Explained](https://www.truefoundry.com/blog/claude-code-limits-explained)

**Weekly limits introduced:** August 28, 2025, on top of the 5-hour session limits. Designed to address a small subset of power users consuming disproportionate resources. — [Portkey.ai](https://portkey.ai/blog/claude-code-limits/)

**Opaque accounting:** Anthropic does not publish exact token counts for weekly limits. Users have no visibility into how much of their weekly allowance remains or what reset time they're tracking. Multiple GitHub issues report the reset time shifting silently (e.g., reset scheduled for Wed 10pm moving to Thu 11:59am). — [GitHub #9094](https://github.com/anthropics/claude-code/issues/9094)

**Peak-hours weighting (March 2026):** During 5am–11am PT weekdays, the 5-hour window burns faster. Anthropic describes it as redistributing capacity toward off-peak to increase overall availability. Net weekly limit is unchanged; distribution across the day shifts. — [Anthropic: Claude March 2026 Usage Promotion](https://support.claude.com/en/articles/14063676-claude-march-2026-usage-promotion)

**Real-world user reports (from GitHub #9424 and #9094):**
- Pro users hitting weekly limit in 1–2 days of normal use
- Max 5x users hitting weekly limit in 4 days
- Max 20x users hitting weekly limit in 1–2 days
- One user (Issue #9094): expected 40–50 hours/week of Sonnet, got 6–8 hours post-Sept 29, 2025 (~85% reduction)
- Source: [GitHub #9424](https://github.com/anthropics/claude-code/issues/9424), [GitHub #9094](https://github.com/anthropics/claude-code/issues/9094)

**The March 2026 crisis (three overlapping causes):**
1. Intentional peak-hours adjustment (new policy)
2. Confirmed counter-desync bug (sessions draining in 19 minutes)
3. End of the March 2x off-peak promotion

Anthropic response: *"People are hitting usage limits in Claude Code way faster than expected. We're actively investigating... it's the top priority for the team."* — [The Register: Anthropic Admits](https://www.theregister.com/2026/03/31/anthropic_claude_code_limits/)

---

## Q4: How does compaction affect token usage?

### Mechanics

Auto-compaction fires at ~83% of the 200k context window (~167k tokens), leaving a 33k buffer. When it fires:
1. CC sends a hidden API call that reads the full ~167k context
2. Claude generates a summarized replacement
3. The summary (11–19k tokens) replaces the full conversation history
4. Only the system prompt (CLAUDE.md + tool definitions, ~14k tokens) remains cached

**Hidden compaction cost:** The summary-generation API call is billed separately and costs approximately $0.22–$0.47 per compaction in Opus pricing. This is not shown in session cost reporting. — [DEV Community: Where Tokens Actually Go](https://dev.to/slima4/where-do-your-claude-code-tokens-actually-go-we-traced-every-single-one-423e)

**Compaction is lossy by design.** Community report from [golev.com](https://golev.com/post/claude-saves-tokens-forgets-everything/):
- Project instructions and coding conventions established before compaction are violated ~100% of the time afterward
- Claude forgets which repository it was working in
- Previously established preferences must be reiterated
- "Claude is definitely dumber after compaction"

**Compaction destroys context cache (except system prompt).** All accumulated cache tokens for conversation history are lost. The 10x cache discount disappears and the next message re-incurs full input token pricing until a new cache builds. This can make compaction events net-negative in terms of total token cost when measured over the post-compaction session.

**Community position:** Treat compaction as a failure mode to avoid, not a feature to rely on. Recommended practice: manual `/compact` at logical breakpoints, saving critical state to `docs/progress.md` before compaction, committing to git before compaction so state can be reconstructed.

**Context buffer reduction (early 2026):** The compaction buffer was reduced to ~33,000 tokens (16.5%), meaning the context ceiling before compaction is now ~167k rather than 155k. This gives slightly more working space but doesn't change the fundamental loss mechanics. — [ClaudeFa.st: Context Buffer Management](https://claudefa.st/blog/guide/mechanics/context-buffer-management)

---

## Q5: How does context window management affect weekly limits?

### The compounding problem

Each message in a conversation includes the full prior conversation history. Turn 5 costs more than Turn 1. At turn 15, context grows exponentially. One measurement found that **23 tool calls per prompt on average** — with 20+ sequential file reads — are typical in unoptimized sessions. — [DEV Community: 70% Waste](https://dev.to/nicolalessi/i-tracked-every-token-my-ai-coding-agent-consumed-for-a-week-70-was-waste-465)

**Cache as the mitigation (when it works).** In a well-functioning session, prior turns are cached and cost only 10% of fresh input. A 157-turn session traced at 98% cache reads. When caching works, long conversations are affordable. When it breaks (see Q7 on bugs), they become prohibitively expensive.

**The 200k limit:** Out of the nominal 200k context window, approximately 14k is consumed by system prompt (CLAUDE.md + tool definitions) as a constant tax on every segment. Effective working space: ~186k tokens before accounting for subagents, MCP servers, and conversation history.

**1M context window (as of early 2026):** Generally available for Opus 4.6 and Sonnet 4.6. Presented by Anthropic as eliminating the need for frequent compaction. Whether the 1M window affects how quickly weekly limits are consumed is not yet clear from community data. — [ClaudeFa.st](https://claudefa.st/blog/guide/mechanics/context-buffer-management)

**Subagent context multiplication.** Each subagent has its own context window. Agent teams use approximately 4–7x more tokens than single-session sequential work. At the extreme, 49 parallel subagents sustained 887,000 tokens/minute and cost $8,000–$15,000 in 2.5 hours. — [AICosts.ai: Subagent Cost Explosion](https://www.aicosts.ai/blog/claude-code-subagent-cost-explosion-887k-tokens-minute-crisis)

---

## Q6: Are there known token-wasting behaviors in CC?

### Documented bugs (not user error)

**Bug 1: Sentinel string cache invalidation (Bun binary)**
The standalone CC binary (custom Bun fork) contains a Zig module that replaces a billing sentinel string (`cch=85c62`) in every outgoing HTTP request. If conversation text contains this string (e.g., when discussing billing or reading CC source), the replacement corrupts the cache prefix, causing 10–20x token overconsumption. Fix: use `npx @anthropic-ai/claude-code` instead of the binary. — [DEV Community: 10-20x Bug](https://dev.to/fillip_kosorukov/claude-code-is-silently-burning-10-20x-your-token-budget-heres-the-fix-4mpk), [PANews](https://www.panewslab.com/en/articles/019d41f7-bf1f-763a-8df5-46eed106fd39)

**Bug 2: Resume/continue session cache prefix mismatch (v2.1.69+)**
Using `--resume` or `--continue` causes a cache prefix mismatch that forces the entire conversation history to rewrite instead of reading from cache. One resume on a large conversation costs $0.15+ that should cost near zero. — [GitHub #38029](https://github.com/anthropics/claude-code/issues/38029), [HN](https://news.ycombinator.com/item?id=47586176)

**Bug 3: Eager context compression (v2.0.15 regression)**
Between v2.0.0 and v2.0.15, CC introduced eager context compression that fires long before actual context limits are reached. This was identified in GitHub #9424 as a root cause of faster Opus consumption: compression overhead inflates token counts even when working within the context window. — [GitHub #9424](https://github.com/anthropics/claude-code/issues/9424)

**Bug 4: Counter desync (March 2026)**
Confirmed by Anthropic — a backend bug caused usage counters to desynced from actual consumption, draining some Max 20x sessions in 19 minutes. Anthropic's response: acknowledged and investigating. — [The Register](https://www.theregister.com/2026/03/31/anthropic_claude_code_limits/)

**Bug 5: Thinking token delivery gap (contested)**
GitHub #20350 claimed CC delivers only 10% of requested thinking tokens while charging full price. A technical review found the original methodology used invalid chunk counting (`chunks × 32`). The actual API usage field was not used. The issue was closed as "not planned" — the original claim is likely wrong, but raised valid transparency concerns. — [GitHub #20350](https://github.com/anthropics/claude-code/issues/20350)

### Structural waste (by design, not bug)

**Architectural: full instruction resend every message.** The entire CLAUDE.md + system prompt is re-sent with every message regardless of changes. No delta compression. This is why CLAUDE.md size directly determines cache read volume. — [GitHub #24147](https://github.com/anthropics/claude-code/issues/24147)

**MCP unconditional schema injection.** Before tool deferral was added, MCP connectors injected complete tool definitions regardless of whether those tools would ever be used. With 7 servers: 67,300 tokens consumed before first message. Tool deferral (added later) reduced this by ~85% by loading only tool names initially. — [GitHub #11364](https://github.com/anthropics/claude-code/issues/11364)

**Explore/Plan agents (agentic mode).** Features like "Explore agents" and "Plan agents" burn tokens at rates users didn't expect. Agentic sub-features running in background consume tokens even when users aren't actively prompting. — [Faros.ai](https://www.faros.ai/blog/claude-code-token-limits)

**Agent idle time.** Active teammates continue consuming tokens even when idle. Agent teams are approximately 7x more expensive than single-agent sessions in plan mode. Official docs: "Clean up teams when work is done." — [CC Docs: Costs](https://code.claude.com/docs/en/costs)

---

## Q7: What CC features consume the most tokens unnecessarily?

Ranked by community consensus:

| Feature | Token Impact | Notes |
|---|---|---|
| Bloated CLAUDE.md | Extreme — scales with every message | 15k tokens = 1.5M cache reads per 100-message session |
| Unused MCP servers | High — 7 servers = 67k tokens before message 1 | Tool deferral reduces to ~10k |
| Extended thinking (default high effort) | High — up to 31,999 tokens per request | Set `MAX_THINKING_TOKENS=8000` for simple tasks |
| Agent teams / parallel subagents | Extreme at scale — 4–7x single-session | Each agent = separate full context window |
| `--resume` / `--continue` (buggy) | High — full cache rebuild per resume | Fixed partially; use fresh sessions instead |
| Auto-compaction (reactive) | Moderate — $0.22–$0.47 hidden cost + cache loss | Use `/compact` proactively at 60% |
| Opus model for routine tasks | Moderate — 1.7x Sonnet token cost | Reserve for architectural decisions only |
| Glob/file scanning without scoping | High — 23 tool calls average per unscoped prompt | Specify exact file paths |
| PDF attachments | Very high — 75k–150k tokens per 50-page PDF | Preprocess text extraction before attaching |
| Full-screen screenshots | Moderate — ~1,334 tokens per 1000×1000px | Crop to region of interest (~54 tokens for 200×200) |

Sources: [The Token Guide](https://limitededitionjonathan.substack.com/p/why-you-keep-hitting-claudes-usage), [CC Docs](https://code.claude.com/docs/en/costs), [GitHub #11364](https://github.com/anthropics/claude-code/issues/11364), [DEV Community: 70% Waste](https://dev.to/nicolalessi/i-tracked-every-token-my-ai-coding-agent-consumed-for-a-week-70-was-waste-465)

---

## Q8: Has anyone measured the token cost of CC's built-in memory system?

### What "built-in memory" means in CC

CC's native memory consists of:
1. **CLAUDE.md files** — loaded into context at session start (global + project-level)
2. **Auto memory** — notes Claude writes to `~/.claude/CLAUDE.md` during sessions
3. **Background conversation summarization** — for `claude --resume` feature

### Measurements found

**CLAUDE.md baseline cost:** ~14,000 tokens system prompt tax on every API call, per session trace in [DEV Community: Where Tokens Actually Go](https://dev.to/slima4/where-do-your-claude-code-tokens-actually-go-we-traced-every-single-one-423e). This is the minimum per-message cost for any CC session.

**At 15k tokens (57KB CLAUDE.md):** 1.5M cache reads per 100-message session. Over a 30-day period with normal usage: 5.09 billion cache reads from CLAUDE.md alone, constituting 99.93% of all token consumption. — [GitHub #24147](https://github.com/anthropics/claude-code/issues/24147)

**Scaling pattern:** Cache reads scale with CLAUDE.md size × message count. Growth is non-linear because both variables tend to increase together as sessions mature and files grow.

**Double-loading bug:** GitHub issue #24044 documented MEMORY.md being loaded twice per session (mentioned as distinct from the #24147 architectural issue). Token cost: doubled overhead for whatever that file contains.

**Background summarization cost:** Official docs state background jobs for `claude --resume` consume "under $0.04 per session." Community members report the actual cost is higher when conversations exceed 100k tokens.

**Community measurement tool:** The Python script from GitHub #24147 is the primary community tool for measuring native memory overhead. It parses JSONL session files and can break down by token category, day, week, and model.

### Claudex comparison context

CC's native memory system has no retrieval selectivity — the entire CLAUDE.md loads every turn regardless of relevance. A vector-based system like Claudex that retrieves only relevant chunks on demand would eliminate the structural waste identified in #24147, replacing 1.5M cache reads per 100-message session with a small number of targeted retrievals.

---

## Key Sources

### GitHub Issues
- [#24147 — Cache reads consume 99.93% of quota (CLAUDE.md architectural issue)](https://github.com/anthropics/claude-code/issues/24147)
- [#9424 — Weekly limits making subscriptions unusable](https://github.com/anthropics/claude-code/issues/9424)
- [#9094 — Unexpected limit change Sept 29, 2025 (30+ reports)](https://github.com/anthropics/claude-code/issues/9094)
- [#11364 — Lazy-load MCP tool definitions (67k tokens with 7 servers)](https://github.com/anthropics/claude-code/issues/11364)
- [#20350 — Thinking token billing (methodology flawed, closed not-planned)](https://github.com/anthropics/claude-code/issues/20350)
- [#38029 — Abnormal consumption on session resume](https://github.com/anthropics/claude-code/issues/38029)

### Official Documentation
- [CC Docs: Manage Costs](https://code.claude.com/docs/en/costs)
- [Claude Support: Understanding usage limits](https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits)
- [Claude Support: March 2026 usage promotion](https://support.claude.com/en/articles/14063676-claude-march-2026-usage-promotion)

### News / Analysis
- [The Register: CC quotas running out too fast](https://www.theregister.com/2026/03/31/anthropic_claude_code_limits/)
- [The Register: CC devs complain about surprise usage limits](https://www.theregister.com/2026/01/05/claude_devs_usage_limits/)
- [TechRadar: Peak hours throttling explained](https://www.techradar.com/ai-platforms-assistants/claude/claude-is-limiting-usage-more-aggressively-during-peak-hours-heres-what-changed)
- [MacRumors: Rapid rate limit drain bug](https://www.macrumors.com/2026/03/26/claude-code-users-rapid-rate-limit-drain-bug/)
- [PANews: Two caching bugs silently 10-20x costs](https://www.panewslab.com/en/articles/019d41f7-bf1f-763a-8df5-46eed106fd39)

### Community Blogs / DEV
- [DEV Community: Where Your Tokens Actually Go (traced session)](https://dev.to/slima4/where-do-your-claude-code-tokens-actually-go-we-traced-every-single-one-423e)
- [DEV Community: 70% Was Waste — 1 Week Tracking](https://dev.to/nicolalessi/i-tracked-every-token-my-ai-coding-agent-consumed-for-a-week-70-was-waste-465)
- [DEV Community: 10-20x Token Burn Silent Bug + Fix](https://dev.to/fillip_kosorukov/claude-code-is-silently-burning-10-20x-your-token-budget-heres-the-fix-4mpk)
- [DEV Community: 30-Day Token Math (Max subscription)](https://dev.to/yurukusa/the-token-per-dollar-math-running-claude-max-for-30-days-2k1o)
- [The Token Guide: How Limits Actually Work](https://limitededitionjonathan.substack.com/p/why-you-keep-hitting-claudes-usage)
- [golev.com: Claude Saves Tokens, Forgets Everything (compaction losses)](https://golev.com/post/claude-saves-tokens-forgets-everything/)
- [AICosts.ai: Subagent Cost Explosion (887k tokens/min)](https://www.aicosts.ai/blog/claude-code-subagent-cost-explosion-887k-tokens-minute-crisis)
- [Portkey.ai: Everything We Know About CC Limits](https://portkey.ai/blog/claude-code-limits/)
- [Faros.ai: Token Limits Guide for Engineering Leaders](https://www.faros.ai/blog/claude-code-token-limits)
- [MCP Server Token Costs Full Breakdown](https://www.jdhodges.com/blog/claude-code-mcp-server-token-costs/)
- [roborhythms.com: Rate Limit Draining March 2026](https://www.roborhythms.com/claude-code-rate-limit-draining-march-2026/)
- [Hacker News discussion: CC usage limits faster than expected](https://news.ycombinator.com/item?id=47586176)
- [Medium: Stop Wasting Tokens (60% reduction strategies)](https://medium.com/@jpranav97/stop-wasting-tokens-how-to-optimize-claude-code-context-by-60-bfad6fd477e5)
- [GitHub Gist: Token workflow with compaction strategies](https://gist.github.com/dholdaway/8009f089d3407e14f3d753f2a70eb63e)
