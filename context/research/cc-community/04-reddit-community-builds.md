# Claude Code Community Builds, Forks, and Modifications
**Research date:** 2026-04-01
**Purpose:** Street knowledge survey of what the community has built on top of or around Claude Code (CC).

---

## Context: The March 31 Source Leak

Everything in this document is downstream of a single event. On March 31, 2026, Anthropic accidentally shipped a 59.8 MB JavaScript source map file (`.map`) in npm package `@anthropic-ai/claude-code` version 2.1.88. The file was omitted from `.npmignore` — a packaging error, not a breach. The map contained ~1,900 unobfuscated TypeScript files and 512,000+ lines of code.

**Within hours:**
- Mirrors spread across GitHub
- Anthropic pushed an update removing the map, then deleted old npm versions
- Anthropic issued 8,100+ DMCA takedowns on GitHub
- Community forks, rewrites, and analyses multiplied faster than takedowns could land

This was actually the **second** such leak — an earlier version had the same npm source map issue in February 2025.

**Sources:**
- [The Register — Anthropic accidentally exposes Claude Code source code](https://www.theregister.com/2026/03/31/anthropic_claude_code_source_code/)
- [Cybernews — Full source code for Anthropic's Claude Code leaks](https://cybernews.com/security/anthropic-claude-code-source-leak/)
- [GitHub enforces Anthropic DMCA notices](https://piunikaweb.com/2026/04/01/anthropic-dmca-claude-code-leak-github/)
- [The Hacker News — Claude Code leaked via npm packaging error, Anthropic confirms](https://thehackernews.com/2026/04/claude-code-tleaked-via-npm-packaging.html)

---

## 1. Community Forks: What Exists

### 1.1 beita6969/claude-code — "Buildable Research Fork"
**URL:** https://github.com/beita6969/claude-code
**Stars:** ~219 (small; research-oriented)
**Purpose:** Reverse-engineered build system around the raw leaked TypeScript, which had no build config and could not compile or run.

**What they added:**
- `package.json` with 60+ reverse-engineered dependencies
- `tsconfig.json` for TypeScript compilation
- `bunfig.toml` for Bun runtime
- `scripts/postinstall.sh` to auto-generate `bun:bundle` polyfill
- Stub modules for ~100 missing packages: 4 Anthropic internal packages (`@ant/*`), 3 native addons, 6 cloud provider SDKs, 10 OpenTelemetry exporters

**Source patches applied:**
- Fixed Commander.js flag incompatibility
- Added missing `isReplBridgeActive()` export
- Injected runtime `MACRO` constant handling
- Created `isConnectorTextBlock` function stub

**Build instructions:**
```bash
git clone https://github.com/beita6969/claude-code.git
cd claude-code
bun install
bun src/main.tsx -p "prompt here" --output-format text
```
Requires Bun >= 1.3.x and valid Anthropic auth (OAuth via `claude login` or `ANTHROPIC_API_KEY`).

**config-ui directory:** The repo includes a `config-ui/` directory in its file structure but the README provides no documentation on its purpose. Given the leak context, this is likely a partially-exposed web-based settings interface that was included in the source but never shipped in the binary. No working implementation documented.

**Scope:** Positioned as educational research resource. Includes architectural docs, extension mechanism notes, and feature flag explanations beyond minimal buildability.

---

### 1.2 paoloanzn/free-code — "The Free Build"
**URL:** https://github.com/paoloanzn/free-code
**Stars:** ~3,500
**Purpose:** Modified build with telemetry stripped, guardrails removed, and all unlockable experimental flags enabled.

**Telemetry removed:**
- All OpenTelemetry/gRPC outbound channels (dead-code eliminated)
- Sentry crash reporting
- GrowthBook analytics callbacks (local evaluation only, no calls home)
- Session fingerprinting and usage tracking

**Guardrails stripped:**
- Hardcoded refusal patterns removed
- Injected "cyber risk" instruction blocks removed
- Managed-settings security overlays removed
- Model's inherent safety training is **not** affected — only CC's injected prompt layers

**Experimental features enabled (54 of 88 flags):**
- `ULTRAPLAN` — multi-agent planning via remote web service (Claude Opus, up to 30 min)
- `ULTRATHINK` — extended deep reasoning mode
- `VOICE_MODE` — push-to-talk input
- Agent triggers, memory extraction, IDE bridge capabilities

**Multi-provider support:**
| Provider | Environment Variable |
|---|---|
| Anthropic (default) | — |
| OpenAI Codex | `CLAUDE_CODE_USE_OPENAI=1` |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` |
| Anthropic Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` |

**Installation:**
```bash
curl -fsSL https://raw.githubusercontent.com/paoloanzn/free-code/main/install.sh | bash
```
Requires Bun >= 1.3.11. Authenticate via `/login` command.

**Update strategy:** None documented. The fork is pinned to the March 31 snapshot. No sync mechanism with Anthropic's ongoing binary releases has been published.

---

### 1.3 sanbuphy/claude-code-source-code — "Research & Analysis"
**URL:** https://github.com/sanbuphy/claude-code-source-code
**Stars:** ~10,500 | **Forks:** ~19,100
**Purpose:** Educational analysis repository. Compiled from publicly available online references about CC architecture. Contains quadrilingual documentation (English, Japanese, Korean, Chinese).

**What's documented:**
- Telemetry and privacy: two analytics sinks, no UI-exposed opt-out
- Hidden features and codenames (full list — see Section 4 below)
- Undercover Mode: implementation details, `USER_TYPE === 'ant'` trigger, no force-OFF
- Remote control and killswitches: hourly polling of `/api/claude_code/settings`; 6+ killswitches
- Future roadmap: Numbat codename, KAIROS, voice mode, 17 unreleased tools

**Not a runnable fork** — this is purely documentation and analysis, compiled from the leaked source.

---

### 1.4 chauncygu/collection-claude-code-source-code — "Collection with Clean-Room Rewrite"
**URL:** https://github.com/chauncygu/collection-claude-code-source-code
**Purpose:** Two subprojects in one repo.

**Subproject 1: claude-code-source-code (TypeScript)**
- Decompiled archive of v2.1.88
- ~163,318 lines across 1,884 files
- Complete functional implementation: core agent loop (`query.ts` at 785KB), 40+ tools, 87 slash commands, full permission and context management, React/Ink terminal UI

**Subproject 2: claw-code (Python)**
- Clean-room architectural rewrite, ~5,000 lines across 66 files
- Built independently without copying original source
- JSON snapshot-driven metadata for commands/tools
- Parity audit capabilities, execution registry, session management
- **Stars at peak:** ~44,500 | **Forks:** ~55,800+ — likely fastest-growing GitHub repo in history at time of creation

---

### 1.5 DonutShinobu/claude-code-fork and hesreallyhim/claude-code-fork
**URLs:**
- https://github.com/DonutShinobu/claude-code-fork
- https://github.com/hesreallyhim/claude-code-fork

Both are relatively unmodified mirrors of the leaked source with minimal additional work. Preserved the source with Anthropic copyright notices intact. Primarily value: keeping the mirror alive during DMCA wave.

---

### 1.6 Kuberwastaken/claude-code — "Rust Rewrite"
**URL:** https://github.com/Kuberwastaken/claude-code
**Purpose:** Claude Code re-implemented in Rust. A clean-room architectural study. Not a direct fork of the TypeScript source — uses the leak as a specification.

---

## 2. Modifications People Have Made to CC

### 2.1 npm Version Patching (cli.js)
The npm version (`@anthropic-ai/claude-code`) ships a readable `cli.js` bundle. This is the primary patching surface the community uses:

- **Why npm over binary:** The standalone binary uses a custom Bun fork that has a sentinel value replacement bug — it rewrites the string `cch=85c62` in requests, potentially corrupting cache prefixes. npm avoids this entirely.
- **How to patch:** Install locally, locate `cli.js`, modify directly. The file is minified but readable JavaScript.
- **Wrapper script pattern:** Create `~/.local/bin/claude-npm` pointing to the npm install, allowing pinned version control via `@version` syntax.

Source: [npm vs Binary for Claude Code — BSWEN](https://docs.bswen.com/blog/2026-04-01-npm-vs-binary/)

### 2.2 Feature Flag Activation
The leaked source revealed 88 GrowthBook feature flags, 54 of which compile cleanly. Community patches enable them via:
- Environment variable injection before launch
- Direct modification of `cli.js` to hardcode flag values
- The `free-code` fork enables all 54 via build-time patching

### 2.3 Telemetry Stripping
Documented in free-code; others apply the same patches individually:
- Dead-code eliminate OpenTelemetry exports
- Stub Sentry `captureException` calls
- Disable GrowthBook remote evaluation, keep local

### 2.4 Undercover Mode Disabling
A patch to set `USER_TYPE !== 'ant'` is trivial — the mode activates based on a user type check. Community members have flagged this as a transparency fix. Note: there is **no force-OFF** in the original — any attempt to disable it requires patching the source.

### 2.5 Anti-Distillation Bypass
Two mechanisms exposed by the leak:
1. **Fake tool injection:** The server injects decoy tool definitions when `anti_distillation: ['fake_tools']` is set. Can be bypassed by patching the flag before the API request.
2. **Connector-text summarization:** Buffers and summarizes assistant reasoning with cryptographic signatures. Bypassed with knowledge of the environment variables.

Source: [Alex Kim's blog — CC Source Leak findings](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/)

---

## 3. Tools and Extensions Built Alongside CC (Official Plugin System + Community)

### 3.1 Official Plugin System (Anthropic)
Claude Code added a plugin system in October 2025. Plugins extend CC with:
- Custom slash commands
- Specialized subagents
- Hooks (lifecycle automation)
- MCP server integrations

**Official plugin registry:** `anthropics/claude-plugins-official` — curated Anthropic-maintained directory.

### 3.2 Community Curation Repositories

| Repo | Stars | What It Contains |
|---|---|---|
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | 35.5k | Skills, hooks, slash-commands, orchestrators, apps, plugins |
| [rohitg00/awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit) | — | 135 agents, 35 skills, 42 commands, 150+ plugins, 19 hooks, 15 rules, 8 MCP configs |
| [jeremylongshore/claude-code-plugins-plus-skills](https://github.com/jeremylongshore/claude-code-plugins-plus-skills) | — | 340 plugins + 1367 skills, CCPI package manager |
| [ComposioHQ/awesome-claude-plugins](https://github.com/ComposioHQ/awesome-claude-plugins) | — | Plugin list with commands, agents, hooks, MCP servers |
| [quemsah/awesome-claude-plugins](https://github.com/quemsah/awesome-claude-plugins) | — | 9988 repos indexed; automated adoption metrics |

### 3.3 Notable Community-Built Tools

**Web UIs / Dashboards:**
- **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** (CloudCLI) — 9.3k stars, 1.2k forks, 52 releases. Web UI for CC sessions accessible from any device. Chat interface, file explorer, git integration, shell terminal, session management, plugin system. Writes directly to CC config; auto-discovers sessions from `~/.claude`.
- **[t09911221/claude-code-ui](https://github.com/t09911221/claude-code-ui)** — Real-time session dashboard for project visibility and collaboration.

**Session/Usage Monitoring:**
- **ccflare** — Comprehensive metrics dashboard with detailed UI
- **CC Usage** — Token consumption and cost analysis CLI
- **claude-devtools** — Desktop app for observability into CC sessions via log analysis

**Memory Systems:**
- **claude-mem** — 35,900+ stars. Captures and compresses everything CC does, SQLite full-text search.

**Multi-Agent Orchestration:**
- **Auto-Claude** — Multi-agent framework with kanban UI
- **Claude Squad** — Terminal app managing simultaneous agent instances
- **vibe-kanban** — 23,200+ stars. Isolated git worktrees for 10+ agents collaborating simultaneously
- **TSK** — Rust CLI with sandboxed Docker task delegation
- **Ruflo** — Multi-agent orchestration with memory systems and security guardrails

**Autonomous Operations:**
- **jarvis** — Turns idle subscriptions into 24/7 AI ops systems with Discord integration, 76 scheduled tasks

**Safety/Quality:**
- **VibeGuard** — 88 rules and 13 hooks across 5 languages, blocks hallucinated code
- **[trailofbits/claude-code-config](https://github.com/trailofbits/claude-code-config)** — Trail of Bits opinionated defaults, security workflows

**Cross-Platform Bridges:**
- **[Enderfga/openclaw-claude-code](https://github.com/Enderfga/openclaw-claude-code)** — OpenClaw plugin that wraps CC CLI as a programmable headless coding engine with a clean tool-based API. Drives CC, Codex, and Gemini through a single `ISession` interface.
- **[moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw)** — Lightweight OpenClaw-style autonomous agent built on CC. Adds cron jobs, heartbeats, Telegram/Discord bridges. Runs as background daemon.
- **CC Channels** (official, v2.1.80) — Anthropic's own response to OpenClaw: native Telegram/Discord messaging channels via `--channels` flag.

**Configuration:**
- **[feiskyer/claude-code-settings](https://github.com/feiskyer/claude-code-settings)** — Settings, commands, agents for vibe coding
- **agnix** — Linter for agent configuration files with IDE plugins

---

## 4. Hidden Features Discovered in the Leaked Source

These were documented by the community from the leak. None are currently user-accessible without patches.

### 4.1 BUDDY (April–May 2026 planned)
Virtual Tamagotchi companion system:
- 18 species: duck, dragon, axolotl, capybara, mushroom, ghost, etc.
- Rarity tiers: Common to Legendary (1% drop rate)
- 5 stats: Debugging, Patience, Chaos, Wisdom, Snark
- Deterministically generated from user ID hash
- Planned teaser: April 1–7, 2026; full launch: May 2026

### 4.2 KAIROS ("the right moment")
Persistent autonomous agent mode:
- Always-on proactive monitoring without user prompts
- Append-only daily observation logs
- Event-triggered autonomous actions
- Nighttime `autoDream` process: memory consolidation, contradiction removal, insight verification
- Gated behind internal flag unavailable to public

### 4.3 ULTRAPLAN
Remote cloud planning:
- Offloads planning phase to Claude Opus for up to 30 minutes
- Browser interface to monitor and approve before execution
- Requires server-side component; partial client code in the leak

### 4.4 Coordinator Mode
Multi-agent orchestration:
- Parallel workers with mailbox routing
- Orchestrator assigns tasks, collects results
- Internal to CC's agent framework

### 4.5 Voice Mode
Push-to-talk input. Gated by `tengu_amber_quartz_disabled` kill switch. free-code enables it.

### 4.6 ULTRATHINK
Extended deep reasoning mode. Enabled in free-code.

### 4.7 Undercover Mode (`undercover.ts`)
~90 lines. Activates for Anthropic employees (`USER_TYPE === 'ant'`) on non-internal repositories:
- Instructs Claude to "NEVER mention you are an AI"
- Strips `Co-Authored-By: Claude` from commits
- Hides internal codenames (Capybara, Tengu, Numbat) from responses
- **No force-OFF mechanism exists**

### 4.8 Anti-Distillation Mechanisms
- Fake tool injection: server inserts decoy tool definitions to pollute competitor training data
- Connector-text summarization: returns only cryptographically-signed summaries of reasoning chains to external observers

### 4.9 Model Codenames Documented
- **Tengu** — product/telemetry prefix; all 250+ analytics events use `tengu_*`
- **Capybara v8** — current Sonnet series; documented bugs (29-30% false-claims rate vs v4's 16.7%, stop sequence false triggers at ~10%, over-commenting)
- **Fennec** — predecessor to Opus 4.6
- **Numbat** — upcoming model (placeholder code present)

### 4.10 Hidden Commands
Active but undocumented: `/btw`, `/stickers`, `/thinkback`, `/effort`
Placeholder stubs (not working): `/good-claude`, `/bughunter`

### 4.11 Frustration Detection
Uses hardcoded regex (not an LLM) to detect user frustration through specific profanities and phrases. Adjusts behavior accordingly.

Source: [sanbuphy docs — hidden features](https://github.com/sanbuphy/claude-code-source-code/blob/main/docs/en/02-hidden-features-and-codenames.md)
Source: [WaveSpeed AI — BUDDY, KAIROS & every hidden feature](https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/)
Source: [Alex Kim's blog — fake tools, frustration regexes, undercover mode](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/)

---

## 5. OpenClaw: The Dominant Ecosystem Alternative

OpenClaw is not a CC fork — it is an independent open-source AI assistant that competes with CC. Understanding it matters because large parts of the CC community migrated to or bridged with it.

**Creator:** Peter Steinberger (founder of PSPDFKit). Weekend project, November 2025. Originally "Clawdbot" → renamed after Anthropic trademark complaint → "Moltbot" → "OpenClaw."

**Growth:** 60,000 stars in 72 hours (January 2026). Now: 246,000+ stars, 35k forks, 11,440+ commits.

**February 14, 2026:** Creator announced joining OpenAI. OpenClaw transfers to open-source foundation with OpenAI financial backing.

**Key differences from Claude Code:**

| Dimension | Claude Code | OpenClaw |
|---|---|---|
| Primary interface | Terminal / IDE integration | Messaging platforms (WhatsApp, Telegram, Slack, Discord) |
| Purpose | Coding agent | General-purpose life assistant |
| Model support | Anthropic + 5 providers (with free-code) | Claude, GPT-4o, DeepSeek, Gemini, Ollama local |
| Hosting | Anthropic-managed binary | Fully self-hosted |
| Cost | $20/mo subscription | Free (API costs only) |
| Skills/extensions | Plugin system, ~150+ plugins | ClawHub registry, 5,700+ skills |
| Security | Production-grade sandboxed | CVE-2026-25253 (CVSS 8.8, RCE via WebSocket bypass); 12% of skills were malicious |

**Community bridges built between CC and OpenClaw:**
- Enderfga/openclaw-claude-code: wraps CC as OpenClaw engine
- freema/openclaw-mcp: MCP server bridging OpenClaw to Claude.ai
- claudeclaw (moazbuilds): OpenClaw-style daemon built on CC internals

**Anthropic's response:** Shipped CC Channels (v2.1.80) with native Telegram/Discord support via `--channels` flag — direct feature response to OpenClaw's messaging integration.

Sources:
- [OpenClaw vs Claude Code — Claudefa.st](https://claudefa.st/blog/tools/extensions/openclaw-vs-claude-code)
- [OpenClaw vs Claude Code — DataCamp](https://www.datacamp.com/blog/openclaw-vs-claude-code)
- [VentureBeat — Anthropic ships Claude Code Channels](https://venturebeat.com/orchestration/anthropic-just-shipped-an-openclaw-killer-called-claude-code-channels)

---

## 6. How People Handle CC Updates With Custom Modifications

This is the weakest area of community documentation. Key findings:

**The fundamental problem:** Official CC is a compiled binary (or bundled npm package). Anthropic pushes updates frequently. Community forks are pinned to the March 31 snapshot — they cannot automatically track upstream changes.

**Documented approaches:**

1. **Pin to snapshot, accept divergence** — free-code and beita6969 both do this. They represent a frozen moment. New CC features don't automatically propagate.

2. **npm version + manual patching** — Install CC from npm, locally modify `cli.js`. Each CC update requires re-patching. Described as "readable JavaScript" so diff-and-reapply is feasible. No automation tooling documented yet.

3. **Plugin/hook layer (non-invasive)** — Most community tools avoid touching CC internals entirely. They use the official plugin system, hooks, CLAUDE.md injection, and MCP servers. These survive CC updates automatically.

4. **Clean-room rewrite** — claw-code and Kuberwastaken/claude-code took this path. They implement CC's architecture independently, so Anthropic's updates don't affect them directly.

5. **No sync mechanism** — Neither free-code nor beita6969 document a procedure for incorporating future Anthropic releases. The expectation appears to be that if another source map leaks (it happened twice), forks update to that snapshot.

Source: [npm vs Binary — BSWEN](https://docs.bswen.com/blog/2026-04-01-npm-vs-binary/)
Source: [Claude Code gets forked — Topify](https://topify.ai/blog/claude-code-fork-open-source)

---

## 7. Post-Leak Analysis Collections

Two notable repos collecting high-signal analyses from the leak:

**[nblintao/awesome-claude-code-postleak-insights](https://github.com/nblintao/awesome-claude-code-postleak-insights)**
Curated list of technical breakdowns. Covers:
- Fake tool injection and connector-text summarization (with file/line references)
- Zig-based attestation stack
- Five subsystems: Tool System, Query Engine, Multi-Agent Orchestration, IDE Bridge, Persistent Memory
- WebFetchTool deep dive (1,173 lines; domain whitelisting, server-side blacklists, Haiku-based summarization)
- Memory: three-layer compression (MicroCompact → AutoCompact → Full Compact) + four-phase AutoDream flow

**Yuyz0112/claude-code-reverse** (2,287 stars)
LLM interaction visualization tool — renders CC's actual LLM calls in a readable interface.

**hitmux/HitCC** (433 stars)
Complete CLI logic documentation.

**N1-AI/claude-hidden-toolkit**
Catalog of 37 internal Claude tools not exposed in the public binary.

---

## 8. DMCA Takedown Dynamics and Survival Strategies

- 8,100+ repos removed under DMCA
- Entire fork network of nirholas/claude-code taken down
- Collateral damage: some repos mirroring only public materials received takedowns
- **Surviving strategy:** Clean-room rewrites avoid DMCA entirely (new code, same concepts)
- OpenCode (multi-provider CC alternative) gained major traction as a DMCA-immune successor
- Mirrors hosted outside GitHub (self-hosted Gitea, Codeberg) not affected by GitHub enforcement
- The ideas spread faster than enforcement — within one day, functional open-source alternatives existed

Source: [Piunika Web — GitHub enforces Anthropic DMCA notices, spin-offs remain online](https://piunikaweb.com/2026/04/01/anthropic-dmca-claude-code-leak-github/)

---

## Summary Table

| Build | Author | Stars | What It Adds | Status |
|---|---|---|---|---|
| beita6969/claude-code | beita6969 | ~219 | Buildable build system for raw leak | Active; pinned to March 31 snapshot |
| paoloanzn/free-code | paoloanzn | ~3,500 | No telemetry, no guardrails, 54 flags enabled, 5 providers | Active; no upstream sync |
| sanbuphy/claude-code-source-code | sanbuphy | ~10,500 | Documentation + analysis of leak (4 languages) | Active |
| chauncygu/collection + claw-code | chauncygu | ~44,500 (claw-code) | Archive + Python/Rust clean-room rewrite | Active |
| Kuberwastaken/claude-code | Kuberwastaken | — | Rust rewrite | Active |
| siteboon/claudecodeui | siteboon | ~9,300 | Web/mobile UI for CC sessions | Active; 52 releases |
| hesreallyhim/awesome-claude-code | hesreallyhim | ~35,500 | Curated skills/hooks/plugins ecosystem | Active |
| nblintao/awesome-claude-code-postleak-insights | nblintao | — | Post-leak technical analysis collection | Active |

---

## Sources Index

- https://github.com/beita6969/claude-code
- https://github.com/paoloanzn/free-code
- https://github.com/sanbuphy/claude-code-source-code
- https://github.com/sanbuphy/claude-code-source-code/blob/main/docs/en/02-hidden-features-and-codenames.md
- https://github.com/chauncygu/collection-claude-code-source-code
- https://github.com/hesreallyhim/awesome-claude-code
- https://github.com/rohitg00/awesome-claude-code-toolkit
- https://github.com/siteboon/claudecodeui
- https://github.com/nblintao/awesome-claude-code-postleak-insights
- https://github.com/Enderfga/openclaw-claude-code
- https://github.com/moazbuilds/claudeclaw
- https://github.com/trailofbits/claude-code-config
- https://github.com/DonutShinobu/claude-code-fork
- https://github.com/Kuberwastaken/claude-code
- https://www.theregister.com/2026/03/31/anthropic_claude_code_source_code/
- https://cybernews.com/security/anthropic-claude-code-source-leak/
- https://thehackernews.com/2026/04/claude-code-tleaked-via-npm-packaging.html
- https://piunikaweb.com/2026/04/01/anthropic-dmca-claude-code-leak-github/
- https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/
- https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/
- https://claudefa.st/blog/tools/extensions/openclaw-vs-claude-code
- https://www.datacamp.com/blog/openclaw-vs-claude-code
- https://venturebeat.com/orchestration/anthropic-just-shipped-an-openclaw-killer-called-claude-code-channels
- https://topify.ai/blog/claude-code-fork-open-source
- https://docs.bswen.com/blog/2026-04-01-npm-vs-binary/
- https://eu.36kr.com/en/p/3747613304193796
- https://eu.36kr.com/en/p/3746797195117063
