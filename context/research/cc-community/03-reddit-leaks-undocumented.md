# CC Leaks, Undocumented Features & Community Discoveries

**Research date:** 2026-04-01
**Scope:** Claude Code source leaks, decompiled source, undocumented features, feature flags, internal architecture as discovered by the community through reverse engineering and the March 2026 npm source map leak.

---

## 1. The Specific Reddit Post (r/ClaudeCode)

**URL:** https://www.reddit.com/r/ClaudeCode/s/7W5Gu5jy8Y

Direct Reddit fetch is blocked from this environment. However, cross-referencing community curation and the `nblintao/awesome-claude-code-postleak-insights` GitHub repo (https://github.com/nblintao/awesome-claude-code-postleak-insights) confirms the post links to the March 31, 2026 npm source map exposure. The r/ClaudeCode subreddit thread is cited by multiple analyses as covering:

- The KAIROS always-on assistant discovery
- The BUDDY Tamagotchi companion feature
- The `cch` native client attestation header (Bun Zig-compiled tokens)
- The Capybara model variants and frustration telemetry
- Undercover mode and its implications for AI-assisted open source contributions

The r/ClaudeAI parallel thread (https://www.reddit.com/r/ClaudeAI/comments/1s8ifm6/) and r/LocalLLaMA thread (https://www.reddit.com/r/LocalLLaMA/comments/1s8ijfb/) contain the substantive community technical analysis.

---

## 2. The Leak Events — Timeline & Mechanism

### Leak 0: February 2025 — First Exposure

**Source:** https://thehuman2ai.com/blog/claude-code-source-leak

On **February 24, 2025**, developer Dave Shoemaker found an 18-million-character base64 string at the end of Claude Code's minified `cli.mjs` — an inline source map. Daniel Nakov published the extracted source on GitHub within hours. Anthropic removed the source map in approximately two hours by unpublishing the package.

What researchers extracted from this first leak:
- System prompts including `megathink` and `ultrathink` directives
- Architecture details: MCP integration, AWS Bedrock setup
- The complete agentic loop and tool implementations
- Permission systems and data flow

### Leak 1: January 2026 — Binary String Analysis (TeammateTool)

**Sources:** https://paddo.dev/blog/claude-code-hidden-swarm/ | https://byteiota.com/claude-code-swarms-hidden-multi-agent-feature-discovered/

On **January 24, 2026**, developer kieranklaassen ran `strings` on the Claude Code binary and discovered TeammateTool — a fully-implemented but feature-flagged multi-agent orchestration system:

```
strings ~/.local/share/claude/versions/2.1.29 | grep TeammateTool
```

This was not vaporware — 13 distinct operations with defined schemas were found. The feature was officially announced on February 5, 2026, eleven days later.

**TeammateTool's 13 operations:**
- Team lifecycle: `spawnTeam`, `discoverTeams`, `cleanup`
- Membership: `requestJoin`, `approveJoin`, `rejectJoin`
- Coordination: `write`, `broadcast`, `approvePlan`, `rejectPlan`
- Shutdown: `requestShutdown`, `approveShutdown`, `rejectShutdown`

**Directory structure:**
```
~/.claude/
├── teams/{team-name}/
│   ├── config.json
│   └── messages/{session-id}/
└── tasks/{team-name}/
```

**Environment variables:** `CLAUDE_CODE_TEAM_NAME`, `CLAUDE_CODE_AGENT_ID`, `CLAUDE_CODE_AGENT_TYPE`

Feature gating relied on two functions: `I9() && qFB()`. Both must return true; in public releases they don't. Developer mikekelly created `claude-sneakpeek` to bypass:
```
npx @realmikekelly/claude-sneakpeek quick --name claudesp
```

### Leak 2: March 7, 2026 — claude-agent-sdk Exposure

**Source:** https://thehuman2ai.com/blog/claude-code-source-leak

The `@anthropic-ai/claude-agent-sdk` npm package accidentally contained the full Claude Code CLI bundle — a 13,800-line minified `cli.js`. Researchers reverse-engineered this version and discovered the `TeammateTool` (Swarms) feature before its public announcement.

### Leak 3: March 31, 2026 — The Main Event (512K Lines)

**Sources:** https://venturebeat.com/technology/claude-codes-source-code-appears-to-have-leaked-heres-what-we-know | https://cybernews.com/tech/claude-code-leak-spawns-fastest-github-repo/ | https://analyticsindiamag.com/ai-news/anthropic-accidentally-leaks-claude-code

**Discovery:** Security researcher Chaofan Shou (@Fried_rice on X) discovered that `@anthropic-ai/claude-code` version **2.1.88** contained `cli.js.map` — a **59.8 MB source map** with `sourcesContent` fields embedding the full original TypeScript.

**Root cause:** Missing `*.map` in `.npmignore`, compounded by a Bun bundler bug that enables source maps by default. The `.map` file referenced a zip archive on Anthropic's public Cloudflare R2 bucket, enabling complete source reconstruction.

**Scale:** 1,906 TypeScript files, 512,000+ lines of code, covering the entire Claude Code CLI.

**Window:** Published March 31, 2026 between ~00:21 and ~03:29 UTC. Anthropic jumped from 2.1.87 directly to 2.1.89.

**Spread:** Mirrored to 8,100+ GitHub repositories within hours. The clean-room Rust reimplementation (`instructkr/claw-code`) hit 50,000 stars in two hours — reportedly the fastest-growing repo in GitHub history.

**Anthropic's response:** "A release packaging issue caused by human error, not a security breach. No sensitive customer data or credentials were involved." DMCA notices targeted 8,100+ repos; enforcement later scaled back after overcorrection hit legitimate public forks.

**Prior incident:** Just days earlier, Anthropic had accidentally made ~3,000 files public including a draft blog post about "Mythos/Capybara" — a new model tier larger than Opus. This was described by Fortune as "the second major security breach in five days."

---

## 3. Undocumented CC Features Discovered

### 3.1 KAIROS — Always-On Background Agent

**Sources:** https://read.engineerscodex.com/p/diving-into-claude-codes-source-code | https://kuber.studio/blog/AI/Claude-Code%27s-Entire-Source-Code-Got-Leaked-via-a-Sourcemap-in-npm%2C-Let%27s-Talk-About-it | https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/

KAIROS (also referenced via `PROACTIVE` flag) is a persistent daemon mode representing a fundamental shift from reactive to proactive AI assistance. It is mentioned 150+ times in the source.

**Architecture:**
- Maintains append-only daily observation logs
- Receives regular tick prompts: "anything worth doing right now?"
- Enforces a **15-second blocking budget** to avoid disrupting user workflow
- Runs `autoDream` nightly memory consolidation
- Feature flags: `tengu_kairos_brief`, `tengu_kairos_cron`

**Exclusive KAIROS tools** unavailable in standard CC:
- `SendUserFile` — push files to user when terminal is closed
- `PushNotification` — reach users asynchronously
- `SubscribePR` — monitor GitHub PRs and react autonomously

**Memory architecture:** Append-only daily logs with four-phase consolidation (Orient → Gather → Consolidate → Prune). Triggers on: 24-hour time gate, 5-session gate, consolidation lock (PID-based).

### 3.2 ULTRAPLAN — Remote 30-Minute Planning

**Sources:** https://kuber.studio/blog/AI/ | https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/ | https://ccu.galdoron.com/

Offloads complex planning to a remote Cloud Container Runtime (CCR) running Opus 4.6 with up to 30 minutes of thinking time.

**Mechanism:**
- User polls every 3 seconds for results
- Browser UI shows live planning progress
- Approval via phone or browser before results are returned
- Return sentinel: `__ULTRAPLAN_TELEPORT_LOCAL__` teleports results back to local terminal
- Flag: `turtle_carbon` | Status: hardcoded disabled in all public builds
- Slash command: `/ultraplan` (hardcoded disabled)

### 3.3 BUDDY — Tamagotchi Companion System

**Sources:** https://dev.to/picklepixel/how-i-reverse-engineered-claude-codes-hidden-pet-system-8l7 | https://kuber.studio/ | https://github.com/Kuberwastaken/claude-code

Compile-time flag: `BUDDY`. Teased April 1-7 2026, planned May 2026 full launch.

**Species (18):** duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail, ghost, axolotl, capybara, cactus, robot, rabbit, mushroom, chonk

**Rarity tiers:** Common (60%), Uncommon (25%), Rare (10%), Epic (4%), Legendary (1%), plus independent 1% shiny chance

**Stats per buddy:** DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK — distributed based on rarity floor/peak

**PRNG determinism:** Account UUID + salt `'friend-2026-401'` → 32-bit hash → Mulberry32 PRNG seeded deterministically. Production uses Bun's `Bun.hash()` (wyhash); Node.js fallback uses FNV-1a — producing different outputs for identical inputs, making external tools unable to reproduce exact results.

**Tamper protection:** Config stores only name/personality (user-editable). All other "bones" (species, rarity, stats) recompute on every read from account UUID. `getCompanion()` uses spread ordering `{ ...stored, ...bones }` — bones always overwrite manual config edits.

**Species names obfuscated** via `String.fromCharCode()` arrays to avoid triggering internal codename scanners.

### 3.4 Coordinator Mode — Multi-Agent Orchestration

**Sources:** https://github.com/Kuberwastaken/claude-code | https://ccu.galdoron.com/

Built-in multi-agent orchestration with one Claude instance managing parallel workers.

**Four-phase workflow:** Research → Synthesis → Implementation → Verification

**Infrastructure:** Shared scratchpad via `tengu_scratch` feature gate, tmux integration, color assignments per worker, mailbox-based communication via AsyncLocalStorage (hidden flag: `--agent-teams`, env: `EXPERIMENTAL_AGENT_TEAMS`)

### 3.5 Speculation — Pre-Execution Sandboxing

**Source:** https://www.zerotopete.com/p/i-found-a-hidden-feature-in-claude

Discovered by binary string analysis of `~/.local/share/claude/versions/2.1.83` (199MB Mach-O arm64). Controlled by `tengu_speculation` server flag (currently hardcoded disabled).

**Mechanism:** Claude finishes responding, generates a suggestion, then immediately forks a background API call and begins executing the predicted next prompt speculatively.

**Sandbox:** All writes redirect to `~/.claude/speculation/<pid>/<speculation_id>/`. Original files copied on first write. On user acceptance, overlays merge back; on rejection, overlays are deleted.

**Safety limits:** Max 20 tool-use turns, 100 messages. Read operations (Read, Glob, Grep, LSP) run freely. Write operations (Edit, Write, NotebookEdit) use overlays. Bash halts at boundaries requiring approval. Writes outside working directory unconditionally blocked.

**Telemetry:** Tracks acceptance rates, completion metrics, time savings per speculation, pipelined chain performance.

### 3.6 Penguin Mode — Fast Inference Endpoint

**Sources:** https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/ | https://ccu.galdoron.com/

Internal fast inference mode using dedicated endpoint `/api/claude_code_penguin_mode`. Killswitch: `tengu_penguins_off`. Exposed as `DISABLE_FAST_MODE` env variable.

### 3.7 autoDream — Background Memory Consolidation

**Sources:** https://discuss.huggingface.co/t/claude-code-source-leak-production-ai-architecture-patterns-from-512-000-lines/174846 | https://www.theregister.com/2026/04/01/claude_code_source_leak_privacy_nightmare/

A background subagent that periodically consolidates MEMORY.md files.

**Four phases:** Orient (read existing structure) → Gather (find signal from logs/transcripts) → Consolidate (write/update memory with absolute dates) → Prune (keep MEMORY.md under 200 lines / ~25KB)

**Three activation gates:** 24-hour time gap, 5+ sessions completed, no active consolidation lock (PID-based). Config: `autoDreamEnabled`, slash command: `/dream` (easter egg, works in production).

---

## 4. API Capabilities Beyond Documented Ones

### 4.1 Active API Beta Flags (30 Total Found)

**Source:** https://ccu.galdoron.com/ (extracted from v2.1.84 via AST parsing)

**Active betas (16):**
```
claude-code-20250219
interleaved-thinking-2025-05-14
context-1m-2025-08-07
context-management-2025-06-27
oauth-2025-04-20
redact-thinking-2026-02-12
structured-outputs-2025-12-15
web-search-2025-03-05
prompt-caching-scope-2026-01-05
effort-2025-11-24
task-budgets-2026-03-13
fast-mode-2026-02-01
afk-mode-2026-01-31
advisor-tool-2026-03-01
advanced-tool-use-2025-11-20
tool-search-tool-2025-10-19
```

**SDK/Infrastructure betas (10):** `bedrock`, `vertex`, `ccr-byoc`, `ccr-triggers`, `environments`, `mcp-servers`, `files-api`, `message-batches`, `token-counting`, `skills`

### 4.2 Anti-Distillation API Injection

**Source:** https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/

Flag `ANTI_DISTILLATION_CC` sends `anti_distillation: ['fake_tools']` in API requests to the Anthropic backend. This injects decoy tool definitions into the system prompt specifically for first-party CLI sessions, controlled by GrowthBook flag `tengu_anti_distill_fake_tool_injection`.

Separately, `CONNECTOR_TEXT` is a server-side mechanism that summarizes assistant output between tool calls with cryptographic signatures, preventing full reasoning chain interception.

### 4.3 Native Client Attestation Header

**Source:** https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/

`x-anthropic-billing-header` carries a cryptographic attestation signature proving the request originated from an authentic Bun-compiled CC binary. The `cch=a784b` placeholder in the source is replaced at runtime by a Zig-level hash computed by Bun's native HTTP stack.

**Bypass:** `CLAUDE_CODE_ATTRIBUTION_HEADER` env variable disables entirely. Killswitch: `tengu_attribution_header`. This attestation directly affects billing and access tier — the attestation proves first-party origin.

**Side effect discovered by community (Kolkov):** Any text discussion containing `cch=00000` corrupts active prompt cache keys, causing 10-20x more tokens to be consumed.

### 4.4 HTTP 402 Micropayment Handler

**Source:** https://medium.com/@nblintao/how-an-ai-reads-the-web-a-deep-dive-into-claude-codes-webfetchtool-0abee4446343

WebFetchTool contains a hidden handler for HTTP 402 "Payment Required" responses with `x402` headers, attempting to automatically complete a micropayment and retry the request. Currently gated behind a feature flag.

### 4.5 Remotely Managed Settings

**Source:** https://www.theregister.com/2026/04/01/claude_code_source_leak_privacy_nightmare/

CC polls hourly for policy objects from Anthropic's servers. These can override local environment variables and feature flags with hot reload — giving Anthropic the ability to remotely modify CC behavior without a client update. CC can also remotely disable specific versions via the auto-updater.

### 4.6 Multi-Provider Support

**Source:** https://github.com/paoloanzn/free-code (free-code fork analysis)

The source reveals native support for: Anthropic, OpenAI, AWS Bedrock, Google Vertex, and Anthropic Foundry — configurable via provider flags despite only Anthropic being advertised.

---

## 5. Feature Flags Discovered

### 5.1 Compile-Time Flags (Bun `bun:bundle` `feature()` system)

**Source:** https://github.com/paoloanzn/free-code | https://github.com/beita6969/claude-code

Total: 88 compile-time flags. 54 working in full build, 34 that don't compile cleanly.

**Interaction & UI:** `ULTRAPLAN`, `ULTRATHINK`, `VOICE_MODE`, `TOKEN_BUDGET`, `HISTORY_PICKER`

**Agents & Memory:** `BUILTIN_EXPLORE_PLAN_AGENTS`, `VERIFICATION_AGENT`, `EXTRACT_MEMORIES`, `TEAMMEM`, `KAIROS`, `PROACTIVE`, `COORDINATOR_MODE`

**Tools & Infrastructure:** `BRIDGE_MODE`, `BASH_CLASSIFIER`, `PROMPT_CACHE_BREAK_DETECTION`, `BUDDY`, `CHICAGO_MCP` (Computer Use), `ANTI_DISTILLATION_CC`, `NATIVE_CLIENT_ATTESTATION`

**Build:** `bun run build:dev:full` enables all 54 working flags. Default production build enables only `VOICE_MODE`.

### 5.2 Server-Side `tengu_*` Flags (GrowthBook/Statsig)

**Source:** https://ccu.galdoron.com/ (79 total tengu_* flags catalogued)

**HOT flags (actively managed):**
```
tengu_iron_gate_closed          # fail-closed safety for auto-mode
tengu_penguins_off              # penguin fast-mode killswitch
tengu_willow_mode               # idle detection (75 min + 100K tokens)
tengu_auto_background_agents    # background agent spawning
tengu_session_memory            # session memory extraction
tengu_kairos_brief              # kairos brief mode
tengu_kairos_cron               # kairos cron scheduling
tengu_speculation               # pre-execution speculation sandbox
tengu_anti_distill_fake_tool_injection  # anti-distillation
tengu_attribution_header        # native client attestation killswitch
```

**Named feature flags:**
```
tengu_amber_flint               # agent teams
tengu_turtle_carbon             # ultrathink/ultraplan
tengu_collage_kaleidoscope      # native clipboard detection
tengu_grey_wool                 # model name remapping
tengu_onyx_plover               # (unspecified)
tengu_sage_compass              # (unspecified)
tengu_iron_gate_closed          # iron gate safety
tengu_scratch                   # coordinator shared scratchpad
```

### 5.3 Hidden CLI Flags (15 documented)

**Source:** https://ccu.galdoron.com/

```
--agent-teams          # enable multi-agent coordination
--bare                 # minimal UI
--cowork               # collaborative mode
--spawn                # spawn subagent
--staging              # staging environment
--enable-auto-mode     # enable auto permission mode
--chrome-native-host   # Chrome native messaging host
--computer-use-mcp     # Computer Use via MCP
--claude-in-chrome-mcp # Claude in Chrome integration
--sdk-url              # custom SDK endpoint
--fork-session         # fork current session context
--no-session-persistence  # disable session persistence
--init-only            # initialize without running
--deep-link-origin     # deep link source tracking
--teleport             # session bundling/transfer to cloud
```

### 5.4 Environment Variables (from 280 total, 70+ documented)

**Source:** https://ccu.galdoron.com/

**Model config:**
```
ANTHROPIC_MODEL
ANTHROPIC_SMALL_FAST_MODEL
ANTHROPIC_BETAS
MAX_THINKING_TOKENS
CLAUDE_CODE_EFFORT_LEVEL
CLAUDE_CODE_SUBAGENT_MODEL
```

**Auth:**
```
ANTHROPIC_API_KEY
CLAUDE_CODE_OAUTH_TOKEN
CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
CLAUDE_CODE_CUSTOM_OAUTH_URL
```

**Disable flags:**
```
CLAUDE_CODE_DISABLE_ATTACHMENTS
DISABLE_CLAUDE_MDS
DISABLE_COMMAND_INJECTION_CHECK
DISABLE_CRON
DISABLE_FAST_MODE
DISABLE_THINKING
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS   # disables anti-distillation + betas
```

**Enable flags:**
```
CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING
ENABLE_PROMPT_SUGGESTION
ENABLE_TELEMETRY
EXPERIMENTAL_AGENT_TEAMS
```

**Performance tuning:**
```
AUTO_COMPACT_WINDOW
FILE_READ_MAX_OUTPUT_TOKENS
SLOW_OPERATION_THRESHOLD_MS
IDLE_THRESHOLD_MINUTES
```

**Debug/Remote:**
```
CLAUDE_CODE_DEBUG_LOGS_DIR
CLAUDE_CODE_REMOTE
CLAUDE_CODE_CONTAINER_ID
WORKER_EPOCH
CLAUDE_CODE_UNDERCOVER=1              # enable undercover mode (one-way, no force-off)
```

### 5.5 Hardcoded Disabled Slash Commands

**Source:** https://ccu.galdoron.com/

```
/ultraplan     # hardcoded disabled
/files         # hardcoded disabled
/bridge-kick   # hardcoded disabled
/version       # hardcoded disabled
/tag           # hardcoded disabled
```

**Flag-gated commands:**
```
/think-back
/thinkback-play
/web-setup
/schedule
```

**Easter eggs (functional):**
```
/stickers    # orders physical Anthropic stickers
/dream       # triggers manual autoDream memory consolidation
```

---

## 6. Internal CC Architecture Mapped by Community

### 6.1 Core Architecture

**Sources:** https://read.engineerscodex.com/p/diving-into-claude-codes-source-code | https://superframeworks.com/articles/claude-code-source-code-leak | https://dev.to/gabrielanhaia/

**Tech stack:** Bun runtime (dead code elimination via feature flags + faster startup), React + Ink (terminal UI), Zod v4 (validation), Commander.js (CLI parsing), Anthropic SDK

**Scale:**
- `785KB` main.tsx entry point
- `46,000-line` QueryEngine handling all LLM API calls, streaming, caching, and orchestration
- `29,000-line` Tool.ts base tool definition
- `25,000-line` commands.ts for slash commands
- `3,167-line` print.ts with 12-level nesting (486 cyclomatic complexity branches) — handles agent run loops, SIGINT, rate-limiting, AWS auth, MCP lifecycle, plugin ops, worktree bridging, team-lead polling, control dispatch, model switching, turn interruption

**Agentic loop pattern:** `while(true)` async generator (`query.ts`, `QueryEngine.ts`) — LLM query → tool invocations → result processing → repeat.

**Terminal renderer:** Uses game-engine techniques — Int32Array character pools, bitmask-encoded metadata, cursor-move patching — achieving ~50x reduction in `stringWidth` calls during token streaming. 470 `useState` + 372 `useEffect` hooks in a TTY environment.

### 6.2 Tool Architecture

**Sources:** https://superframeworks.com/ | https://ccu.galdoron.com/ | https://github.com/beita6969/claude-code

**66 built-in tools** partitioned into:
- **Concurrent tools** (read-only, run in parallel): Read, Glob, Grep, LSP tools
- **Serialized tools** (mutations: edit, write, bash — sequential for safety)

**Core tools:** AgentTool, BashTool, FileReadTool, FileEditTool, FileWriteTool, GrepTool, GlobTool, WebFetchTool, WebSearchTool, NotebookEditTool, SkillTool, REPLTool, LSPTool, TodoWriteTool, TaskStopTool, TaskOutputTool, AskUserQuestionTool, SendMessageTool, BriefTool, ListMcpResourcesTool, ReadMcpResourceTool, EnterPlanModeTool, ExitPlanModeV2Tool

**Backend/internal tools:** TaskCreateTool, ScheduleCronTool, RemoteTriggerTool, WorkflowTool, ConfigTool, TungstenTool, SuggestBackgroundPRTool

### 6.3 Hook System

**Sources:** https://code.claude.com/docs/en/hooks | https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/

**Five trigger points:**
1. `PreToolUse` — intercept before tool execution
2. `PostToolUse` — intercept after tool result
3. `UserPromptSubmit` — intercept at prompt submission
4. `SessionStart` — on session initialization
5. `SessionEnd` — on session teardown

**Five hook execution types:**
1. Shell command
2. LLM-injected context
3. Full agent verification loop
4. HTTP webhook
5. JavaScript function

**Exit codes:** 0 = allow, 2 = block, other = warn/continue

**Configuration path:** `.claude/settings.json` in project root (repository-controlled, auto-executed)

**Security implication (CVE-2025-59536, CVE-2026-21852):** Hook configs in `.claude/settings.json` execute before the trust dialog completes, enabling RCE and API key exfiltration from malicious repositories. Discovered by Check Point Research: https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/

### 6.4 Permission & Configuration System

**Source:** https://superframeworks.com/articles/claude-code-source-code-leak

**5-layer configuration hierarchy** (lowest to highest priority):
1. Environment variables
2. `~/.claude/settings.json` (user global)
3. `.claude.json` (project root)
4. `.claude/settings.json` (project settings)
5. `.claude/settings.local.json` (local machine — always wins)

**Three permission modes:**
- `bypass` — no checks, fastest
- `allow_edits` — auto-approves file modifications
- `auto` — ML classifier predicts user approval (2-stage LLM: fast + thinking, temperature=0, 4096 max tokens)

**Iron Gate** (`tengu_iron_gate_closed`): Fail-closed safety for auto-mode — blocks all actions when classifier unavailable.

**Total configuration settings:** 118 across 12 categories, including Model & AI (9), Permissions & Security (8), Sandbox (10), UI & Display (12), Memory & Context (6), MCP & Plugins (10), Git/Attribution (5), Hooks (5), Auth/Enterprise (8), Environment/Session (6), Auto Mode (5), Updates (3).

### 6.5 Memory Architecture (3-Layer)

**Sources:** https://www.latent.space/p/ainews-the-claude-code-source-leak | https://superframeworks.com/

**Layer 1 — Index** (always loaded, ~150 chars per pointer): `MEMORY.md` pointing to what exists
**Layer 2 — Topic files** (loaded on-demand): detailed project notes, team context
**Layer 3 — Transcripts** (grep-only, never loaded into context): raw session JSONL, queried by autoDream

**Four persistent memory types:**
- User memories (role, expertise, working style)
- Feedback memories (corrections, confirmed approaches)
- Project memories (deadlines, decisions, team context)
- Reference memories (external resource pointers: Linear, Grafana, Slack)

**CLAUDE.md:** Loaded into every prompt turn, up to 40,000 characters.

### 6.6 Context Compression System

**Sources:** https://discuss.huggingface.co/t/ | https://superframeworks.com/

**Five compaction strategies:**
- `MicroCompact` — local time-based clearing
- `AutoCompact` — near-limit summarization (13K buffer, 20K summary, circuit breaker)
- `Full Compact` — emergency compression with selective re-injection (50K budget)
- `Context Collapse` — conversation summarization
- `PTL Truncation` — oldest message groups dropped

**Bug discovered by community (Kolkov):** `autoCompact.ts` wasted ~250,000 API calls/day from cascade failures. `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` addresses it. Patch: three lines of code, quantified March 10, 2026.

### 6.7 Subagent Execution Models

**Sources:** https://superframeworks.com/ | https://read.engineerscodex.com/

**Three modes:**
- `Fork` — inherits parent context as byte-identical copy, optimized for KV cache reuse ("Parallelism is basically free")
- `Teammate` — separate pane interface, file-based mailbox communication
- `Worktree` — isolated git worktree, branch-per-agent isolation

**Four specialized agent types:** Explore (codebase discovery), Plan (pre-implementation strategy), General (complex multi-step), Guide (feature documentation/help)

### 6.8 Bash Security System

**Source:** https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/

`bashSecurity.ts` contains 23 numbered validation checks:
- 18 blocked Zsh builtins
- Defenses against equals expansion (`=curl` bypasses permission checks for `curl`)
- Unicode zero-width space injection prevention
- IFS null-byte injection blocking

### 6.9 System Prompt Architecture

**Sources:** https://medium.com/@marc.bara.iniesta/ | https://read.engineerscodex.com/

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker separates static (org-wide, heavily cached) from dynamic (user-specific, cache-breaking) sections.

`DANGEROUS_uncachedSystemPromptSection()` function explicitly marks cache-breaking modifications with a warning name to prevent accidental use.

`promptCacheBreakDetection.ts` tracks 14 cache-break vectors with "sticky latches" that prevent accidental invalidation. The attestation token replacement (`cch=00000`) is one of these vectors — any text containing that string breaks the cache.

### 6.10 WebFetchTool Internal Architecture

**Source:** https://medium.com/@nblintao/how-an-ai-reads-the-web-a-deep-dive-into-claude-codes-webfetchtool-0abee4446343

- ~90 pre-approved whitelisted domains (documentation sites, Anthropic resources)
- Server-side blacklist check before every request; successful checks cache 5 minutes, failures don't cache
- Cross-domain redirects disabled; same-domain redirects (including www) allowed up to 10 hops
- Haiku summarization layer: all non-markdown content processed by Claude Haiku before returning to primary model; bypassed for markdown under 100K characters
- Copyright constraints: quotes from non-whitelisted domains max 125 characters; song lyrics forbidden even in bypass-permissions mode
- Turndown HTML→Markdown converter loads lazily as singleton (1.4MB overhead)
- Axios response buffer immediately nulled before processing for early GC on large pages

---

## 7. Model Codenames Revealed

**Sources:** https://kuber.studio/ | https://read.engineerscodex.com/ | https://fortune.com/2026/03/31/

| Codename | Model |
|----------|-------|
| **Tengu** | Claude Code itself (internal project codename) — prefixes 100+ feature flags |
| **Capybara** (also: **Mythos**) | Claude 4.6 variant with 1M context window, fast-tier support |
| **Fennec** | Opus 4.6 (current) |
| **Numbat** | Unreleased upcoming model, launch window embedded in source |
| **Opus 4.7** | Already referenced in production code |
| **Sonnet 4.8** | Already referenced in production code |

**Mythos** was separately leaked days before via ~3,000 files made accidentally public, described as "a new tier of model even larger than Opus" with expanded context window in fast and slow variants.

---

## 8. Undercover Mode & Privacy Implications

### Undercover Mode (`undercover.ts`, ~90 lines)

**Source:** https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/

Activated when `USER_TYPE === 'ant'` (Anthropic employee) in public/non-internal repositories.

**Instructs Claude to:**
- Never mention internal codenames (Capybara, Tengu, etc.)
- Not reveal unreleased version numbers
- Strip `Co-Authored-By` git metadata (hiding AI authorship)
- Not mention internal Slack channels, repo names, or "Claude Code" itself

**Critical properties:**
- `CLAUDE_CODE_UNDERCOVER=1` enables it
- **No force-OFF exists** — source comment states "There is NO force-OFF" and defaults to hidden if uncertain
- Dead-code-eliminated in external builds
- Raises disclosure ethics questions for AI-assisted open source contributions

### Telemetry & Data Collection

**Source:** https://www.theregister.com/2026/04/01/claude_code_source_leak_privacy_nightmare/

Telemetry payload includes: user ID, session ID, app version, platform, terminal type, organization UUID, account UUID, email address, active feature gates.

Error reporting includes: current working directory, project names, paths, feature gates, user ID, email, session ID.

Every file Claude accesses is saved and uploaded to Anthropic. Session transcripts are stored as JSONL.

**Data retention:** Free/Pro/Max: 5 years (if opted into training) or 30 days. Commercial: 30-day default, zero-retention option available.

**Team Memory Sync (unreleased):** Bidirectional sync to shared organizational memory with secret pattern scanning for ~40 token/API key types.

---

## 9. What the Community Is Building

### 9.1 Direct Mirrors (DMCA'd)

**Source:** https://piunikaweb.com/2026/04/01/anthropic-dmca-claude-code-leak-github/

8,100+ repositories disabled by GitHub after Anthropic DMCA notices. Key mirrors that circulated:
- `leaked-claude-code/leaked-claude-code` — direct mirror
- `soufianebouaddis/claude-code` — TypeScript breakdown
- `chauncygu/collection-claude-code-source-code` — collection repo
- `sanbuphy/claude-code-source-code` — direct mirror

### 9.2 Buildable Research Forks

**`beita6969/claude-code` (Buildable Research Fork):** https://github.com/beita6969/claude-code

Reverse-engineered the build system from scratch: 60+ npm dependencies reconstructed by tracing imports across all 1,900 source files. Discovered ~90 feature-gated modules excluded from the source map. Required 25+ external package stubs. Key fix: `src/main.tsx` — added runtime MACRO constant injection.

**`paoloanzn/free-code` (Telemetry-stripped fork):** https://github.com/paoloanzn/free-code

Removed: OpenTelemetry/gRPC reporting, GrowthBook analytics callbacks, Sentry error reporting, custom event logging, session fingerprinting. Stripped: hardcoded refusal patterns, cyber-risk instruction blocks, managed-settings security overlays. Enabled: 54 of 88 compile-time flags via `bun run build:dev:full`.

### 9.3 Clean-Room Reimplementations

**`instructkr/claw-code` (Rust):** https://github.com/instructkr/claw-code

116K stars, 100K forks, built in ~2 hours post-leak using `oh-my-codex` AI-assisted parallel development. Architecture: modular Rust crates (`api-client`, `runtime`, `tools`, `commands`, `plugins`, `compat-harness`, `claw-cli`). Legally insulated as cleanroom — built from architectural understanding, not source copying.

**`Kuberwastaken/claude-code` (Rust + architectural breakdown):** https://github.com/Kuberwastaken/claude-code

Complete architectural analysis plus Rust reimplementation. Sources include full feature flag catalog, codename mapping, security architecture (YOLO classifier, risk tiers), and internal tool registry.

### 9.4 OpenCode — The Viable Alternative

**Source:** https://piunikaweb.com/2026/04/01/anthropic-dmca-claude-code-leak-github/

OpenCode emerged as the major rewrite: "similar AI coding assistant features but works with any LLM — GPT, DeepSeek, Gemini, Llama, MiniMax." Rapid adoption despite Anthropic cease-and-desist. Uses leaked architectural knowledge without source copying.

### 9.5 Analysis & Research Tools

**`ccunpacked.dev`:** https://ccunpacked.dev/ (403 at time of research — active community tool for browsing leaked source)

**`nblintao/awesome-claude-code-postleak-insights`:** https://github.com/nblintao/awesome-claude-code-postleak-insights — curated list of high-signal analyses, design notes, discussions

**`ccu.galdoron.com` (Claude Code Unleashed):** https://ccu.galdoron.com/ — comprehensive hidden features catalog for v2.1.84, methodology: native binary analysis (strings, otool, Ghidra) + npm AST parsing

**Reverse engineering by Kolkov:** https://dev.to/kolkov/we-reverse-engineered-12-versions-of-claude-code-then-it-leaked-its-own-source-code-pij — analysis of 12 CC versions (v2.1.74–v2.1.88), 1,571 session analysis, 148,444 tool calls

---

## 10. Community Ethics & Legal Analysis

**Sources:** https://dev.to/varshithvhegde/ | https://medium.com/@marc.bara.iniesta/ | https://thehuman2ai.com/blog/claude-code-source-leak

### Three Community Camps

**Pragmatists:** Treated leaked source as free documentation of production-grade AI agent design. Studied memory architecture, permission model, token management. Argued the patterns are now in the public domain.

**Cautious users:** Waited for patched versions, focused on the concurrent axios RAT supply chain attack (axios 1.14.1 and 0.30.4 contained a Remote Access Trojan targeting developers trying to compile the leaked code).

**Idealists:** Wrestled with ethics of using proprietary leaked source, especially given Anthropic's aggressive DMCA response and the legal ambiguity of AI-generated code copyright.

### Legal Reality

- DMCA worked on centralized platforms (GitHub), failed on decentralized mirrors (Gitlawb, torrent)
- Clean-room rewrites (claw-code) appear legally insulated via Phoenix Technologies v. IBM (1984) precedent
- AI copyright questions: portions of CC are Claude-generated, weakening takedown claims
- Anthropic sued OpenCode for unauthorized API access (March 2026) — separate but simultaneous
- Content at internet scale does not return; DMCA proved "performative" per community consensus

### The "Accidental PR Stunt" Debate

Multiple commenters noted suspicious timing:
- BUDDY feature had April 1-7 teaser window hardcoded in source
- Leak happened March 31 — one day before April Fools
- Mythos/Capybara model "accidentally" leaked days before
- Anthropic's restrained DMCA enforcement raised questions about intent
- Developer sentiment swung positive toward Anthropic after initial backlash over OpenCode cease-and-desist

### Marc Bara's Contrarian Take

**Source:** https://medium.com/@marc.bara.iniesta/

Most damaging is the exposed roadmap — "Anthropic can refactor code but cannot retract a product roadmap already read by every competitor." Source code arR $2.5B, enterprise 80% of revenue — competitors now have full architectural blueprints. Real damage is strategic, not technical.

### Anti-Distillation Assessment

The anti-distillation mechanisms (fake tool injection, cryptographic reasoning signatures) "provide no real protection — anyone serious about distilling would find workarounds in about an hour." Legal enforcement was always the real deterrent. Now both deterrents are weakened.

---

## 11. Critical Bugs Found in Production CC

**Sources:** https://dev.to/kolkov/ | https://medium.com/@marc.bara.iniesta/ | https://alex000kim.com/

| Bug | Impact | Quantified |
|-----|--------|------------|
| `autoCompact.ts` cascade failures | ~250,000 wasted API calls/day | Documented March 10, 2026 |
| Silent model downgrade | After 3× 529 errors, silently switches Opus→Sonnet with no user notification | Per reverse engineering |
| 5.4% orphaned tool calls | Tool executed, result never returned to agent | From 1,571 session analysis |
| `print.ts` 12-level nesting | 3,167-line function, ~486 cyclomatic complexity, unrelated concerns mixed | From source analysis |
| 16.3% overall failure rate | 1-in-6 API requests fails | Over 6 days, 3,539 requests |
| Streaming watchdog fires too late | Watchdog initialized after dangerous initial connection phase | Reverse engineered |
| `.claude.json` at 3.1 GB | Unmanaged flat file storage, inconsistent file locking | Pre-leak discovery |

---

## 12. Relevance to Claudex

The following discoveries from the CC leak are directly relevant to Claudex architecture decisions:

**Hook payload field names confirmed (via source):**
- `PostToolUse`: tool output is in `tool_response` (not `tool_output`)
- `UserPromptSubmit`: user text is in `prompt` (not `user_prompt`)
- `Stop`: assistant text is in `last_assistant_message` (not `stop_assistant_turn`)

(These match the CC Hook Payload Truth table in Claudex's own CLAUDE.md — independently confirmed by the leaked source.)

**SYSTEM_PROMPT_DYNAMIC_BOUNDARY pattern:** Claudex's own assembly uses a similar cached/dynamic split — the CC source confirms this is the production-proven approach.

**autoDream architecture:** Claudex's Angel runs a similar reflection loop — the CC implementation (24-hour gate, 5-session gate, PID lock, four phases) validates the design. Key difference: Claudex uses SQLite as truth store rather than JSONL; Angel uses hybrid retrieval rather than grep-only transcript access.

**Anti-distillation:** Claudex does not implement anti-distillation (this is appropriate — Claudex is the harness, not the model being distilled). The CONNECTOR_TEXT approach (cryptographic summaries between tool calls) is noted as inspiration for potential integrity verification of hook-injected context.

**3-layer memory:** CC's index/topic/transcript architecture closely mirrors Claudex's checkpoint/artifact/observation hierarchy. Claudex uses SQLite + Qdrant rather than flat files, providing stronger consistency guarantees.

**Speculation sandbox:** The `~/.claude/speculation/<pid>/<speculation_id>/` overlay pattern is worth studying for Claudex's correction-detection workflow — speculative execution before user confirmation is architecturally analogous to Claudex's `outcome_tracker` predicting outcomes before confirmation.

---

## Sources

- [Alex Kim: Fake tools, frustration regexes, undercover mode](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/)
- [VentureBeat: Claude Code source code appears to have leaked](https://venturebeat.com/technology/claude-codes-source-code-appears-to-have-leaked-heres-what-we-know)
- [Cybernews: Fastest growing GitHub repo](https://cybernews.com/tech/claude-code-leak-spawns-fastest-github-repo/)
- [Piunikaweb: DMCA enforcement and surviving spin-offs](https://piunikaweb.com/2026/04/01/anthropic-dmca-claude-code-leak-github/)
- [Gizmodo: Leaked at the exact wrong time](https://gizmodo.com/source-code-for-anthropics-claude-code-leaks-at-the-exact-wrong-time-2000740379)
- [Analytics India Magazine: Anthropic accidentally leaks Claude Code](https://analyticsindiamag.com/ai-news/anthropic-accidentally-leaks-claude-code)
- [Layer5: 512K lines, missing .npmignore, fastest-growing repo](https://layer5.io/blog/engineering/the-claude-code-source-leak-512000-lines-a-missing-npmignore-and-the-fastest-growing-repo-in-github-history/)
- [Lowcode Agency: What it contains](https://www.lowcode.agency/blog/claude-code-source-code-leaked)
- [Penligent: Source map leak analysis](https://www.penligent.ai/hackinglabs/claude-code-source-map-leak-what-was-exposed-and-what-it-means/)
- [Hacker News thread #47584540](https://news.ycombinator.com/item?id=47584540)
- [Hacker News thread #43217357](https://news.ycombinator.com/item?id=43217357)
- [GitHub: nblintao/awesome-claude-code-postleak-insights](https://github.com/nblintao/awesome-claude-code-postleak-insights)
- [GitHub: paoloanzn/free-code](https://github.com/paoloanzn/free-code)
- [GitHub: beita6969/claude-code (buildable fork)](https://github.com/beita6969/claude-code)
- [GitHub: Kuberwastaken/claude-code (Rust + analysis)](https://github.com/Kuberwastaken/claude-code)
- [GitHub: instructkr/claw-code (fastest-growing reimplementation)](https://github.com/instructkr/claw-code)
- [GitHub: leaked-claude-code/leaked-claude-code](https://github.com/leaked-claude-code/leaked-claude-code)
- [Engineers Codex: Diving into the leak](https://read.engineerscodex.com/p/diving-into-claude-codes-source-code)
- [DEV.to: Gabriel Anhaia — entire source code leaked via npm](https://dev.to/gabrielanhaia/claude-codes-entire-source-code-was-just-leaked-via-npm-source-maps-heres-whats-inside-cjo)
- [Kuber Studio: BUDDY, KAIROS, ULTRAPLAN](https://kuber.studio/blog/AI/Claude-Code's-Entire-Source-Code-Got-Leaked-via-a-Sourcemap-in-npm,-Let's-Talk-About-it)
- [nblintao on Medium: WebFetchTool deep dive](https://medium.com/@nblintao/how-an-ai-reads-the-web-a-deep-dive-into-claude-codes-webfetchtool-0abee4446343)
- [Hugging Face: Production AI architecture patterns](https://discuss.huggingface.co/t/claude-code-source-leak-production-ai-architecture-patterns-from-512-000-lines/174846)
- [The Register: Privacy nightmare](https://www.theregister.com/2026/04/01/claude_code_source_leak_privacy_nightmare/)
- [Latent Space: AINews summary](https://www.latent.space/p/ainews-the-claude-code-source-leak)
- [thehuman2ai: 13 months, nothing happened](https://thehuman2ai.com/blog/claude-code-source-leak)
- [WaveSpeed AI: BUDDY, KAIROS, every hidden feature](https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/)
- [The Information: KAIROS always-on agent](https://www.theinformation.com/newsletters/ai-agenda/claude-code-leak-reveals-always-kairos-agent)
- [Winbuzzer: Anti-distillation traps](https://winbuzzer.com/2026/04/01/claude-code-source-leak-anti-distillation-traps-undercover-mode-xcxwbn/)
- [Superframeworks: What 512K lines reveal](https://superframeworks.com/articles/claude-code-source-code-leak)
- [Marc Bara on Medium: What the leak actually reveals](https://medium.com/@marc.bara.iniesta/what-claude-codes-source-leak-actually-reveals-e571188ecb81)
- [Paddo: Claude Code's hidden multi-agent system](https://paddo.dev/blog/claude-code-hidden-swarm/)
- [DEV.to: picklepixel — reverse engineering hidden pet system](https://dev.to/picklepixel/how-i-reverse-engineered-claude-codes-hidden-pet-system-8l7)
- [Zero to Pete: Speculation hidden feature](https://www.zerotopete.com/p/i-found-a-hidden-feature-in-claude)
- [Claude Code Unleashed (ccu.galdoron.com)](https://ccu.galdoron.com/)
- [DEV.to: varshithvhegde — accident, incompetence, or PR stunt](https://dev.to/varshithvhegde/the-great-claude-code-leak-of-2026-accident-incompetence-or-the-best-pr-stunt-in-ai-history-3igm)
- [Blockchain Council: Technical takeaways for LLM developers](https://www.blockchain-council.org/claude-ai/inside-claude-source-code-leak-technical-takeaways-llm-developers-prompt-engineers/)
- [Check Point Research: CVE-2025-59536, CVE-2026-21852](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/)
- [Fortune: Second major security breach](https://fortune.com/2026/03/31/anthropic-source-code-claude-code-data-leak-second-security-lapse-days-after-accidentally-revealing-mythos/)
- [BleepingComputer: Source code accidentally leaked](https://www.bleepingcomputer.com/news/artificial-intelligence/claude-code-source-code-accidentally-leaked-in-npm-package/)
- [Kolkov on DEV.to: Reverse-engineered 12 versions](https://dev.to/kolkov/we-reverse-engineered-12-versions-of-claude-code-then-it-leaked-its-own-source-code-pij)
- [Claude Code Hooks reference (official)](https://code.claude.com/docs/en/hooks)
- [Addyosmani.com: Claude Code Swarms](https://addyosmani.com/blog/claude-code-agent-teams/)
- [Futurism: Tamagotchi feature leaked](https://futurism.com/artificial-intelligence/leaked-claude-code-tamagotchi)
- [The AI Corner: What's inside 2026](https://www.the-ai-corner.com/p/claude-code-source-code-leaked-2026)
