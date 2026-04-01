# CC Community Research: Dev Blogs, Hacker News, Technical Analysis
**Date:** 2026-04-01
**Researcher:** Crux (Session 43)
**Scope:** Claude Code internals — architecture, system prompt, token usage, hooks, optimization, source analysis

---

## 1. Has Anyone Published a Detailed Architecture Analysis?

Yes — multiple high-quality analyses exist. The most significant catalysts were two source-level events:

### 1a. The npm Source Leak (March 31, 2026)
The single most impactful event for CC analysis. Anthropic accidentally shipped the complete TypeScript source inside an npm package — a missing `.npmignore` entry caused a 59.8 MB source map file to be included in Claude Code v2.1.88, exposing 512,000+ lines across ~1,900 files.

- **VentureBeat coverage:** [Claude Code's source code appears to have leaked](https://venturebeat.com/technology/claude-codes-source-code-appears-to-have-leaked-heres-what-we-know)
- **Hacker News post (HN #47586778):** [The Claude Code Source Leak: fake tools, frustration regexes, undercover mode](https://news.ycombinator.com/item?id=47586778) — became one of the top technical discussions on HN
- **Hacker News post (HN #47597085):** [Claude Code Unpacked: A visual guide](https://news.ycombinator.com/item?id=47597085)
- **Layer5 writeup:** [The Source Leak: 512,000 Lines, a Missing .npmignore, and the Fastest-Growing Repo in GitHub History](https://layer5.io/blog/engineering/the-claude-code-source-leak-512000-lines-a-missing-npmignore-and-the-fastest-growing-repo-in-github-history/)
- **DEV.to writeup:** [Claude Code's Entire Source Code Was Just Leaked via npm Source Maps](https://dev.to/gabrielanhaia/claude-codes-entire-source-code-was-just-leaked-via-npm-source-maps-heres-whats-inside-cjo)
- **Alex Kim blog (best technical post-leak analysis):** [Fake tools, frustration regexes, undercover mode, and more](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/)
- **Awesome post-leak insights curation:** [nblintao/awesome-claude-code-postleak-insights](https://github.com/nblintao/awesome-claude-code-postleak-insights)

**Technical mechanism of leak:** CC is built on Bun (Anthropic acquired Bun in late 2025). Bun generates source maps by default. A known Bun bug (issue #28001, filed March 11, 2026) reports that source maps are served in production builds even when documentation says they shouldn't be. The bug was open 20 days before the incident.

### 1b. Pre-Leak Reverse Engineering (2025)
Before the source leak, several developers reverse-engineered CC through API traffic observation and system prompt extraction:

- **Kir Shatrov (kirshatrov.com):** [Reverse engineering Claude Code](https://kirshatrov.com/posts/claude-code-internals) — analysis via API traffic observation
- **Sathwick (sathwick.xyz):** [Reverse-Engineering Claude Code: A Deep Dive into Anthropic's AI-Powered CLI](https://sathwick.xyz/blog/claude-code.html) — detailed, covers QueryEngine, tool system, terminal rendering, caching, hooks, multi-agent
- **Sabrina.dev:** [Reverse-Engineering Claude Code Using Claude Sub Agents (Part 1)](https://www.sabrina.dev/p/reverse-engineering-claude-code-using) — used sub-agents to deobfuscate and analyze minified JS
- **Weaxsey.org:** [A Brief Analysis of Claude Code's Execution and Prompts](https://weaxsey.org/en/articles/2025-10-12/) — execution flow, sub-agent types, tool system
- **GitHub — ComeOnOliver:** [claude-code-analysis](https://github.com/ComeOnOliver/claude-code-analysis) — comprehensive reverse-engineering analysis
- **GitHub — Ringmast4r:** [learn-real-claude-code](https://github.com/Ringmast4r/674019130-learn-real-claude-code) — post-leak study repo
- **Glorics:** [Inside Claude Code: Tamagotchi Pets, Hidden Codenames & the Full Architecture](https://glorics.com/claude-code-architecture-deep-dive)

---

## 2. What Optimization Techniques Have Experts Written About?

### 2a. Prompt Caching
CC automatically inserts cache control breakpoints. Tools are sorted **alphabetically** before API submission to maintain consistent ordering across requests, maximizing cache hit rates. This was confirmed in the leaked source.

- **ClaudeFast blog:** [Claude Code 1M Context Window: What It Means for Your Workflow](https://claudefa.st/blog/guide/mechanics/1m-context-ga)
- **AWS blog:** [Supercharge your development with Claude Code and Amazon Bedrock prompt caching](https://aws.amazon.com/blogs/machine-learning/supercharge-your-development-with-claude-code-and-amazon-bedrock-prompt-caching/)
- **Claude Code Camp:** [How Prompt Caching Actually Works in Claude Code](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code) — "The Hidden System That Makes Claude Code 80% Cheaper"
- **ClaudeFA.st cost optimization:** [Claude Code Pricing: Optimize Your Token Usage & Costs](https://claudefa.st/blog/guide/development/usage-optimization)
- **Practical savings:** Without caching, a long Opus coding session (100 turns + compaction) can cost $50-100 in input tokens; with caching, $10-19.

**Leaked source confirmation:** The leaked code revealed CC tracks 14 distinct cache-break vectors with "sticky latches" preventing mode toggles from invalidating caches.

### 2b. Context Window Management and Auto-Compaction
- **ClaudeFast blog:** [Claude Code Context Buffer: The 33K-45K Token Problem](https://claudefa.st/blog/guide/mechanics/context-buffer-management)
- **Sathwick reverse-engineering:** auto-compaction triggers when tokens exceed `context_window - 13,000`
- Buffer was reduced from 45K → 33K tokens in early 2026 (unreleased change)
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var shifts trigger percentage (does NOT change buffer size)
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is a common misconception — controls response length only, not compaction
- A comment in the leaked source revealed "1,279 sessions wasting ~250K API calls daily" due to consecutive autocompaction failures — a real-world bug

**Auto-compaction flow (from sathwick.xyz deep-dive):**
1. Strip images/documents from older messages (replace with `[image]` markers)
2. Group messages by API round
3. Call compaction model to summarize
4. Replace old messages with `CompactBoundaryMessage`
5. Re-inject up to 5 files + skills (50K tokens for files, 25K for skills)

Circuit breaker limits to 3 consecutive failures. **Microcompaction** handles lighter compression via time-based and size-based tool result clearing.

### 2c. CLAUDE.md and Context Engineering
- **ClaudeFast tip:** Keep CLAUDE.md under 200 lines; use progressive disclosure across Skills to recover ~15,000 tokens per session
- **Best practices:** [Best Practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- **Power user patterns:** [Claude Code Best Practices: Tips from Power Users for 2025](https://www.sidetool.co/post/claude-code-best-practices-tips-power-users-2025)
- **sankalp.bearblog.dev:** [A Guide to Claude Code 2.0 and getting better at using coding agents](https://sankalp.bearblog.dev/my-experience-with-claude-code-20-and-how-to-get-better-at-using-coding-agents/)
  - Start fresh or compact at 60% context for complex tasks
  - "Recitation manipulation" — repeatedly rewrite todo lists into context to combat lost-in-the-middle issues
  - Effective context window is likely 50-60% of stated maximum due to attention degradation

### 2d. Skills / Progressive Disclosure
- **Lee Hanchung (leehanchung.github.io):** [Claude Agent Skills: A First Principles Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/) — best external technical analysis of the Skills architecture
- **Medium / Data Science Collective:** [Claude Skills: A Technical Deep-Dive into Context Injection Architecture](https://medium.com/data-science-collective/claude-skills-a-technical-deep-dive-into-context-injection-architecture-ee6bf30cf514)
- **Anthropic engineering post:** [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)

Skills mechanism: ~18 tools are hidden by default, discoverable via `ToolSearchTool`. This keeps the base prompt under 200K tokens while enabling elastic capability expansion.

### 2e. Deferred Tool Discovery
The leaked source confirmed a `ToolSearchTool` pattern: ~18 tools are hidden from the base tool list. Claude requests them by keyword, and they're injected on demand. This keeps per-request token overhead minimal while preserving full capability.

---

## 3. What HN Discussions Exist About CC Internals?

| HN Thread | Points | Topic |
|-----------|--------|-------|
| [HN #47586778](https://news.ycombinator.com/item?id=47586778) | High | Source leak: fake tools, frustration regexes, undercover mode |
| [HN #47597085](https://news.ycombinator.com/item?id=47597085) | High | Claude Code Unpacked visual guide |
| [HN #44981014](https://news.ycombinator.com/item?id=44981014) | - | What Claude Code Does Differently: Inside Its Internals |
| [HN #44998295](https://news.ycombinator.com/item?id=44998295) | - | What makes Claude Code so damn good |
| [HN #44153053](https://news.ycombinator.com/item?id=44153053) | - | Claude Code: An Agentic cleanroom analysis |
| [HN #46546937](https://news.ycombinator.com/item?id=46546937) | - | Exploring internals via transcripts (JSONL/UUID analysis) |
| [HN #45546037](https://news.ycombinator.com/item?id=45546037) | - | Memory system for Claude solving context loss |
| [HN #44864185](https://news.ycombinator.com/item?id=44864185) | - | Claude Code is all you need |
| [HN #47524704](https://news.ycombinator.com/item?id=47524704) | - | Show HN: Plain-text cognitive architecture for Claude Code |
| [HN #47584540](https://news.ycombinator.com/item?id=47584540) | - | Regex sentiment detection vs models, anti-distillation |

**Key HN technical finding (from #46546937):** JSONL transcript structure:
- `uuid`/`parentUuid` threading for conversation chains
- Queue-operation records for messages sent during tool execution
- `file-history-snapshots` at every file modification
- Subagent sidechains as `agent-*.jsonl` files when Task tool spawns workers
- `isCompactSummary`, `isVisibleInTranscriptOnly`, `isMeta` flags control API vs. UI visibility

**`cleanupPeriodDays`** in `~/.claude/settings.json` controls retention (from HN #46546937 comment).

---

## 4. Has Anyone Benchmarked CC's Token Usage?

### Real-World Token Consumption Data
- **Faros.ai engineering blog:** [Claude Code Token Limits: A Guide for Engineering Leaders](https://www.faros.ai/blog/claude-code-token-limits)
  - Average: ~$6/developer/day, 90% under $12/day
  - Team API with Sonnet: ~$100-200/developer/month
  - Heavy users exhaust weekly allocations within days
  - 21% more tasks completed but 91% longer PR review times observed in high-usage teams

### Rate Limit Structure (as of early 2026)
- 5-hour rolling window (starts on first message)
- Pro tier: ~44,000 tokens/window
- Max5 tier: ~88,000 tokens/window
- Max20 tier: ~220,000 tokens/window
- Weekly caps introduced August 2025 after unsustainable usage patterns emerged

### Context Buffer Analysis (ClaudeFast)
- Buffer reduced from 45K → 33K tokens in early 2026 (unanounced)
- Usable context improved from ~155K to ~167K out of 200K window
- Auto-compaction fires at 83.5% of window (up from ~77-78%)
- The 33K buffer is hardcoded — feature requests to make it configurable have been closed as duplicates
- Source: [Claude Code Context Buffer: The 33K-45K Token Problem](https://claudefa.st/blog/guide/mechanics/context-buffer-management)

### 1M Token Context (March 2026)
- GA for Opus 4.6 and Sonnet 4.6 as of March 13, 2026, at no pricing premium
- Opus 4.6 scores 78.3% on MRCR v2 at 1M tokens
- 15% decrease in compaction events observed across real CC usage after 1M window shipped
- Source: [Claude's 1 Million Context Window guide](https://karozieminski.substack.com/p/claude-1-million-context-window-guide-2026)

---

## 5. Has Anyone Analyzed CC's System Prompt?

### Most Comprehensive: Piebald-AI Repository
**[claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)** — tracks ALL parts of CC's system prompt across 138 versions (v2.0.14 → v2.1.89).

Findings:
- CC does NOT use a monolithic system prompt. It's 110+ conditionally-assembled strings
- Roughly 40 specialized agents/sub-agents with documented token counts
- ~30 dynamic system reminders that fire on file modification, IDE events, hook execution, memory updates
- Over 50 discrete system prompt segments
- Embedded API documentation for Python, TypeScript, Java, Go, C#, PHP, Ruby (923–5,106 tokens each)
- Sub-agent token counts: Explore (494 tks), Plan mode enhanced (636 tks), `/security-review` (2,607 tks), Verification specialist (2,866 tks), Conversation summarization (1,121 tks)

### Yuyz0112 Visualization Tool
- **[claude-code-reverse](https://github.com/Yuyz0112/claude-code-reverse)** — Tool to visualize CC's LLM interactions
- **[claude-code-reverse GitHub Pages](https://yuyz0112.github.io/claude-code-reverse/)** — Updated for July 2025 version

### Key System Prompt Discoveries

**Main agent core directive:**
> "You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail."

**Context injection structure (from sathwick.xyz and weaxsey.org):**
- Execution flow: quota check (Haiku) → topic detection → Main/Core Agent (Sonnet 4)
- Main agent has 14 tools (11 read-only, 3 edit, 1 execution/Bash, 1 special/Task)
- Five sub-agent types with isolated contexts: general-purpose, explore (Haiku), output-style-setup, statusline-setup, session-memory

**Tool preference hierarchy (verbatim from CC system prompt):**
> "ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command"
> "Use these tools VERY frequently to ensure that you are tracking your tasks" (re: TodoWrite)

**Bash security:** 23 numbered security checks including Zsh builtins, equals expansion exploits, zero-width space injection, IFS null-byte injection.

**Compaction summary structure** requires eight sections: "Primary Request and Intent," "Files and Code Sections," "Current Work," etc.

**Security analysis from InversePrompt research:**
- CVE-2025-54794 & CVE-2025-54795 — high-severity vulnerabilities discovered during Research Preview allowing escape of CC's intended restrictions
- Source: [InversePrompt: Turning Claude Against Itself (CVE-2025-54794 & CVE-2025-54795)](https://cymulate.com/blog/cve-2025-547954-54795-claude-inverseprompt/)
- Cisco security blog: [Identifying and remediating a persistent memory compromise in Claude Code](https://blogs.cisco.com/ai/identifying-and-remediating-a-persistent-memory-compromise-in-claude-code)

---

## 6. What Advanced CC Techniques Are People Blogging About?

### Hooks Deep Dives
- **GitButler blog:** [Automate Your AI Workflows with Claude Code Hooks](https://blog.gitbutler.com/automate-your-ai-workflows-with-claude-code-hooks) — best hooks tutorial
- **Complete guide:** [Creating Claude Code Hooks](https://suiteinsider.com/complete-guide-creating-claude-code-hooks/)
- **GitHub — disler:** [claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery)

Hook technical protocol:
- Six event types: UserPromptSubmit, PreToolUse, PostToolUse, Notification, PreCompact, Stop
- Config locations (priority order): `~/.claude/settings.json` → `.claude/settings.json` → `.claude/settings.local.json`
- STDIN payload is JSON; hooks communicate back via STDOUT and exit codes
- Released June 2025 (CC 1.0.59+)

**STDIN payload example for Stop event:**
```json
{
  "session_id": "unique-identifier",
  "transcript_path": "/Users/name/.claude/projects/path/session.jsonl",
  "cwd": "/project/directory",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
```

**Git integration pattern via hooks:**
- PreToolUse: Init session-specific git index with `git read-tree --index-output=index_file HEAD`
- PostToolUse: Stage files to session index
- Stop: Commit session tree (`git write-tree` → `git commit-tree` → `git update-ref`)

### Multi-Agent Patterns
- **apiyi.com:** [Claude Code Maximum Utilization Guide: 12 Advanced Tips](https://help.apiyi.com/en/claude-code-maximize-usage-power-user-tips-agent-teams-hooks-guide-en.html)
- Fan-out pattern: `claude -p "prompt"` in CI, pre-commit hooks, or scripts; multiple simultaneous instances

### CLAUDE.md / Skills / Progressive Disclosure
- **GitHub — FlorianBruniaux:** [claude-code-ultimate-guide](https://github.com/FlorianBruniaux/claude-code-ultimate-guide) — production-ready templates
- **GitHub — hesreallyhim:** [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — curated hooks, skills, slash commands
- **DEV.to:** [The Ultimate Claude Code Guide: Every Hidden Trick, Hack, and Power Feature](https://dev.to/holasoymalva/the-ultimate-claude-code-guide-every-hidden-trick-hack-and-power-feature-you-need-to-know-2l45)
- **egghead.io:** [Become a Claude Code Power-User](https://egghead.io/workshop/claude-code)

### Agent Skills Architecture (Technical)
From **leehanchung.github.io** first-principles deep dive:
- Skill tool is a meta-tool that aggregates all skills into its description (15,000-char token budget)
- Skill selection is pure LLM reasoning — no embeddings, classifiers, or pattern matching
- Two-message injection: Message 1 (visible metadata, `isMeta: false`) + Message 2 (full skill prompt, `isMeta: true`, hidden from UI)
- `contextModifier` function temporarily pre-approves specified tools (scoped to skill duration)
- Optional `model:` frontmatter field overrides session model for skill execution
- Skills live in the `tools` array, NOT in system prompts
- `{baseDir}` variable resolves to skill's installation directory for portability
- Token overhead: ~1,500+ tokens per turn vs. ~100 for traditional tools

---

## 7. Are There Any CC Source Code Analysis Posts?

### Post-Leak Analyses (April 2026)
All triggered by the March 31, 2026 npm source map leak:

1. **Alex Kim** — [Fake tools, frustration regexes, undercover mode](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/) — most detailed technical post
2. **DEV.to / Gabriel Anhaia** — [Source Leaked via npm Source Maps](https://dev.to/gabrielanhaia/claude-codes-entire-source-code-was-just-leaked-via-npm-source-maps-heres-whats-inside-cjo) — architecture overview
3. **WaveSpeed AI** — [BUDDY, KAIROS & Every Hidden Feature Inside](https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/)
4. **Medium / nblintao** — [How an AI Reads the Web: A Deep Dive into Claude Code's WebFetchTool](https://medium.com/@nblintao/how-an-ai-reads-the-web-a-deep-dive-into-claude-codes-webfetchtool-0abee4446343) — 1,173-line WebFetch implementation analysis
5. **redreamality.com** — [Claude Code Leak: A Deep Dive into Anthropic's AI Coding Agent Architecture](https://redreamality.com/blog/claude-code-source-leak-architecture-analysis/)
6. **Hugging Face Discuss** — [Claude Code Source Leak: Production AI Architecture Patterns](https://discuss.huggingface.co/t/claude-code-source-leak-production-ai-architecture-patterns-from-512-000-lines/174846)
7. **Medium / Analyst Uttam** — [The Claude Code Leak: 512,000 Lines of TypeScript and What They Reveal](https://medium.com/@analystuttam/the-claude-code-leak-512-000-lines-of-typescript-and-what-they-reveal-76ce148766f1)
8. **winbuzzer.com** — [Claude Code Source Leak Exposes Anti-Distillation Traps](https://winbuzzer.com/2026/04/01/claude-code-source-leak-anti-distillation-traps-undercover-mode-xcxwbn/)

### Pre-Leak Source Analysis
- **GitHub — Yuyz0112** — [claude-code-reverse](https://github.com/Yuyz0112/claude-code-reverse) — Runtime visualization via API traffic
- **GitHub — nirholas** — [claude-code/docs/architecture.md](https://github.com/nirholas/claude-code/blob/main/docs/architecture.md)
- **GitHub — shareAI-lab** — [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) — Harness engineering analysis
- **GitHub — Kuberwastaken** — [Claude Code in Rust + Breakdown](https://github.com/Kuberwastaken/claude-code) — Clean-room Rust rewrite (hit 50K stars in 2 hours after leak)

---

## 8. What Patterns Have Emerged From CC Power Users?

### Workflow Patterns
**Context management discipline:**
- Compact or start fresh at 60-70% context for complex tasks (attention degrades before tokens run out)
- Effective context window is ~50-60% of stated maximum due to transformer attention degradation
- At 70% context: precision starts dropping; 85%: hallucinations increase; 90%+: responses become erratic
- Source: [Claude Code Best Practices: Tips from Power Users 2025](https://www.sidetool.co/post/claude-code-best-practices-tips-power-users-2025)

**Task decomposition:**
- Smaller contained tasks consistently outperform ambitious refactoring attempts
- "Throw-away first draft" pattern for complex features
- Use Explore agent (read-only, Haiku-backed) for fast codebase search before expensive Sonnet calls
- Interrupt with ESC mid-plan to correct trajectory — visible planning is a key CC differentiator

**Recitation manipulation:**
- Repeatedly rewrite todo lists into recent context to combat lost-in-the-middle
- System reminders (tagged injections) push objectives into recent attention span

**Multi-agent fan-out:**
- Parallel instances via `claude -p "prompt"` for independent tasks
- Coordinator+worker model: coordinator synthesizes (never says "based on your findings"), workers execute
- Each worker has an independent context window

### Community Resources
- **Simon Willison transcripts tool:** [simonw/claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) — tools for publishing/analyzing CC session JSONL files
- **Deepwiki:** [instructkr/claude-code](https://deepwiki.com/instructkr/claude-code) — wiki-style CC documentation
- **Scrimba:** [Best Claude Code Tutorials and Courses in 2026](https://scrimba.com/articles/best-claude-code-tutorials-and-courses-in-2026/)

---

## Key Internals Discovered in the Source Leak

Detailed findings from Alex Kim's analysis and the awesome-postleak-insights curation:

### Anti-Distillation System (ANTI_DISTILLATION_CC flag)
CC poisons competitors who scrape API traffic for training data:
- Sends `anti_distillation: ['fake_tools']` in API requests
- Server silently injects decoy/malformed tool definitions into the system prompt
- Requires 4 conditions: compile-time flag + CLI entrypoint + first-party API + GrowthBook flag `tengu_anti_distill_fake_tool_injection`
- Secondary mechanism: connector-text between tool calls is summarized with cryptographic signatures and returned as summaries instead of full reasoning (scoped to internal users with `USER_TYPE === 'ant'`)

### Undercover Mode (`undercover.ts`)
- Instructs CC to strip AI involvement from outputs when running in non-internal repos
- Blocks mentioning "Claude Code", internal codenames (Capybara, Tengu), Slack channels
- Blocks co-authorship attribution lines in git commits
- Cannot be disabled externally (no force-OFF switch)
- Forced ON via `CLAUDE_CODE_UNDERCOVER=1` env var
- Dead-code-eliminated in external builds

### Frustration Regex (`userPromptKeywords.ts`)
- 20+ keyword regex detects user frustration: profanity, "wtf", "wth", "ffs", "omfg", "this sucks", "so frustrating"
- Community noted the "peak irony" of an LLM company using regex for sentiment analysis
- Acknowledged as cost-efficient vs. inference-based detection

### Native Client Attestation
- API requests include `cch=346be` placeholder headers
- Bun's native HTTP stack (written in Zig) overwrites placeholders with computed hashes below the JavaScript runtime level
- Cryptographically proves requests originate from legitimate CC binaries
- Gated behind `NATIVE_CLIENT_ATTESTATION` flag

### KAIROS (Unreleased Autonomous Mode)
Feature-flagged system for persistent/proactive agent behavior:
- Maintains append-only daily observation logs
- Triggers autonomous actions based on context
- "Dreaming" process: nightly memory distillation/consolidation
- GitHub webhook subscriptions
- Background daemon workers with 5-minute cron cycles
- `/dream` skill for nightly consolidation

### BUDDY Companion System (April Fools' 2026)
- 18 species (duck, dragon, axolotl, capybara, mushroom, ghost, etc.)
- Rarity tiers: Common → Legendary (1% shiny rate)
- 5 RPG stats: Debugging, Patience, Chaos, Wisdom, Snark
- Deterministic generation from user ID hash
- Species names encoded via `String.fromCharCode()` to evade build-system grep checks
- Teaser planned April 1-7, 2026; full launch targeted May 2026

### ULTRAPLAN (Unreleased)
- Offloads complex planning to Claude Opus for up to 30 minutes
- Browser-based approval interface

### WebFetchTool Internals (1,173-line implementation)
From nblintao's Medium deep-dive:
- ~90 pre-approved domains for silent access (Python/Rust/Go docs, React, AWS, Kubernetes, Anthropic)
- Server-side blacklist checked before every fetch (5-minute cache on success, failures NOT cached)
- Redirect sandboxing: same-domain jumps allowed (up to 10 hops), cross-domain redirects require re-permission
- HTML → Markdown via Turndown library (lazy-loaded singleton, ~1.4MB heap)
- Secondary Haiku model summarizes content before primary model sees it
- Axios response buffer nullified before Haiku processing (prevents double memory spike during DOM tree expansion)
- Hidden: HTTP 402 micropayment handler (`x402` headers) — feature-flagged, suggests future autonomous purchasing

### Internal Model Codenames
- "Tengu" — internal CC codename
- "Fennec" — internal model codename
- "Capybara" — referenced in undercover mode forbidden terms
- References to "opus-4-8" suggest internal evaluation stages

### Memory Leak Discovery
Early multi-agent implementations experienced **36.8GB memory leaks with 292 agents** before `TEAMMATE_MESSAGES_UI_CAP = 50` was implemented.

### Terminal Rendering Architecture
- Custom React reconciler + Yoga layout engine (flexbox for terminal)
- Double buffering (front/back frame swapping, no flicker)
- Blitting (copies unchanged regions from previous frame)
- Three interning pools: CharPool (string→integer IDs), StylePool (ANSI transition sequences), HyperlinkPool (OSC 8 URLs, reset every 5 min)
- Hardware scroll regions via `CSI n S`

---

## Summary: What the Community Knows About CC

| Question | Status |
|----------|--------|
| System prompt fully documented? | Yes — Piebald-AI tracks 138 versions, 110+ strings |
| Architecture documented? | Yes — sathwick.xyz pre-leak + dev.to post-leak are comprehensive |
| Token benchmarks? | Yes — faros.ai + claudefa.st have real-world data |
| Caching mechanics? | Yes — alphabetical tool sorting for cache stability confirmed in source |
| Hooks internals? | Yes — GitButler + official docs cover protocol fully |
| Anti-distillation? | Confirmed in source leak (March 31, 2026) |
| Unreleased features? | KAIROS, ULTRAPLAN, BUDDY, Voice Mode, Web Browser Tool, Daemon Mode documented |
| Source available? | Yes — leaked via npm source map, widely mirrored |

---

## Key URLs Quick Reference

| Resource | URL |
|----------|-----|
| Piebald-AI system prompts repo | https://github.com/Piebald-AI/claude-code-system-prompts |
| Sathwick deep-dive (pre-leak) | https://sathwick.xyz/blog/claude-code.html |
| Alex Kim source leak analysis | https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/ |
| Kir Shatrov internals | https://kirshatrov.com/posts/claude-code-internals |
| Weaxsey execution/prompts analysis | https://weaxsey.org/en/articles/2025-10-12/ |
| GitButler hooks tutorial | https://blog.gitbutler.com/automate-your-ai-workflows-with-claude-code-hooks |
| Lee Hanchung skills deep-dive | https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/ |
| ClaudeFast context buffer | https://claudefa.st/blog/guide/mechanics/context-buffer-management |
| Faros.ai token limits guide | https://www.faros.ai/blog/claude-code-token-limits |
| nblintao WebFetchTool analysis | https://medium.com/@nblintao/how-an-ai-reads-the-web-a-deep-dive-into-claude-codes-webfetchtool-0abee4446343 |
| Post-leak insights curation | https://github.com/nblintao/awesome-claude-code-postleak-insights |
| Awesome Claude Code | https://github.com/hesreallyhim/awesome-claude-code |
| Sankalp CC 2.0 guide | https://sankalp.bearblog.dev/my-experience-with-claude-code-20-and-how-to-get-better-at-using-coding-agents/ |
| HN source leak discussion | https://news.ycombinator.com/item?id=47586778 |
| HN transcript internals | https://news.ycombinator.com/item?id=46546937 |
| HN what makes CC good | https://news.ycombinator.com/item?id=44998295 |
| redreamality architecture analysis | https://redreamality.com/blog/claude-code-source-leak-architecture-analysis/ |
| WaveSpeed hidden features | https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/ |
