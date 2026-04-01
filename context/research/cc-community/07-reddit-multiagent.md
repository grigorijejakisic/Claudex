# CC Multi-Agent: Community Knowledge Research
*Date: 2026-04-01*
*Sources: Official docs, leaked source analysis, community blogs, GitHub repos, Reddit threads*

---

## Executive Summary

Claude Code's multi-agent story in 2026 has four distinct layers: (1) **subagents** — in-session workers, stable and widely used; (2) **agent teams** — cross-session coordination, experimental since Feb 2026; (3) **coordinator mode** — undisclosed internal feature flagged in leaked source; (4) **external ecosystems** — community-built orchestration on top of CC that matured faster than native features. The community has embraced parallelism enthusiastically but consistently hits token cost, context isolation, and coordination-overhead walls. Nobody has solved persistent cross-session memory in a way that CC natively supports — this is Claudex's gap to own.

---

## 1. What Is Coordinator Mode?

### Official Status: Internal / Feature-Flagged

Coordinator mode (`CLAUDE_CODE_COORDINATOR_MODE=1`) was discovered in the March 31, 2026 source code leak (Anthropic accidentally shipped CC v2.1.88 to npm with a 60MB source map containing 1,906 source files, 510K lines of TypeScript).

### What It Does (from leaked source analysis)

- Transforms CC from single-agent assistant into a **multi-agent orchestrator**
- One "coordinator" Claude instance spawns and manages multiple "worker" Claude instances running in parallel
- Coordinator provides explicit rules for: when to parallelize, when NOT to delegate trivial tasks, how worker notifications arrive, how to continue or stop workers
- Workers communicate via a **mailbox system** (async message passing via Unix domain sockets)
- Coordinator synthesizes findings across workers and directs implementation
- Key file: `coordinatorMode.ts` (in `src/coordinator/`)
- Companion: **daemon mode** (`DAEMON`) — runs CC as background process without terminal attachment, enabling persistent inter-process communication

### Community Reaction

> "Coordinator Mode lets one Claude spawn and manage multiple worker agents in parallel. Project manager Claude delegating to specialist Claudes." — [Threads @heynickquick](https://www.threads.com/@heynickquick/post/DWkDe3ekWwa/coordinator-mode-ultraplan-coordinator-mode-lets-one-claude-spawn-and-manage)

> "Both feature-gated and invisible in external builds. The codebase is significantly ahead of the public product, hidden behind compile-time flags that get stripped from what you download." — same source

### Strategic Assessment

Coordinator mode formalizes what the community has been building manually (via git worktrees + multiple terminals). It's architecturally more principled than the ad-hoc approaches — explicit parallelization rules, formal worker lifecycle, mailbox-based IPC. Not yet publicly accessible.

**Sources:**
- [Claude Code Leaked Source: BUDDY, KAIROS & Every Hidden Feature Inside | WaveSpeedAI](https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/)
- [Claude Code Source Leaked: 5 Hidden Features Found in 510K Lines | HarrisonSec](https://harrisonsec.com/blog/claude-code-source-leaked-hidden-features/)
- [Bridge and Coordinator Mode — Claude-Code-VS-OpenCode](https://github.com/0xtresser/Claude-Code-VS-OpenCode/blob/main/EN/Chapter_11_Claude_Code_Commercial/11.6_Bridge_and_Coordinator_Mode.md)
- [Claude Code system prompts repo (Piebald-AI)](https://github.com/Piebald-AI/claude-code-system-prompts)

---

## 2. What Is Remote Mode / Bridge Mode?

### What It Is

Remote mode (also called Bridge mode) is CC's infrastructure for making a local CLI session **remotely accessible** from web or mobile surfaces. Entry point: `claude remote-control`. Key files in `src/bridge/`: `bridgeMain.ts`, `initReplBridge.ts`, `replBridge.ts`, `bridgeApi.ts`.

### What It Does

- Local CC session becomes accessible from any browser or the Claude iOS app
- Session persists across devices — can be resumed rather than terminating with the terminal
- VentureBeat described it as "a mobile version of Claude Code called Remote Control" ([VentureBeat](https://venturebeat.com/orchestration/anthropic-just-released-a-mobile-version-of-claude-code-called-remote))
- Files and MCP servers **never leave your machine** — only chat messages and tool results flow through the encrypted bridge
- Supports `--continue` and `--session-id` flags for session resumption

### ULTRAPLAN — The Cloud Planning Feature

ULTRAPLAN (found in leaked source under `INTERNAL_ONLY_COMMANDS`) is a remote planning mode that:
- Offloads complex planning to a **remote Opus 4.6 instance** running in Anthropic's Cloud Container Runtime (CCR)
- Allows **up to 30 minutes** of unattended planning time
- Generates diagram-rich plans; user approves from browser before implementation
- Currently restricted to Anthropic engineers only (internal command)
- The Piebald-AI system prompts repo notes this as: "Remote plan mode (ultraplan)" — 652-token system reminder configuring remote planning sessions

### KAIROS — Assistant Mode

The leaked source also references KAIROS, described as an "assistant mode" with:
- Scheduled check-ins
- Session resumption
- Remote-control continuation
- Architectural shift: from "isolated prompt-response loop" to "ongoing collaborator" with persistent session relationships

This is architecturally adjacent to what Claudex does (persistent session relationships, cross-session context). Anthropic is building toward this; Claudex is already doing it.

**Sources:**
- [Bridge and Coordinator Mode analysis](https://github.com/0xtresser/Claude-Code-VS-OpenCode/blob/main/EN/Chapter_11_Claude_Code_Commercial/11.6_Bridge_and_Coordinator_Mode.md)
- [Claude Code Leaked Source analysis (WaveSpeedAI)](https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/)
- [Anthropic released Remote Control (VentureBeat)](https://venturebeat.com/orchestration/anthropic-just-released-a-mobile-version-of-claude-code-called-remote)
- [Claude Code overview docs](https://code.claude.com/docs/en/overview)

---

## 3. How People Coordinate Multiple CC Sessions

### Pattern 1: Git Worktrees (Most Common, Manual)

The community's de-facto approach before agent teams:
- `git worktree add ../project-worktree/branch-name -b feat/branch-name`
- Open separate terminal per worktree
- Run independent CC sessions in each
- Each session works on isolated branch, no file conflicts
- CC now supports **built-in worktree isolation** for subagents (`isolation: worktree` frontmatter field) — subagent gets temporary branch + repo copy, auto-cleaned if no changes

**Community experience:**
> "Context switching is like moderating two separate meetings in neighboring conference rooms — the mental gymnastics can wear you out." — [dev.to/datadeer](https://dev.to/datadeer/part-2-running-multiple-claude-code-sessions-in-parallel-with-git-worktree-165i)

> "Setup overhead — copying untracked files, installing dependencies — often isn't worth it for changes Claude finishes in 10 minutes." — same source

CC now has **built-in git worktree support** announced by Boris Cherny (Anthropic): "Now, agents can run in parallel without interfering with one another." — [Threads announcement](https://www.threads.com/@boris_cherny/post/DVAAnexgRUj/)

### Pattern 2: Agent Teams (Native, Experimental since v2.1.32, Feb 2026)

Enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json.

**Architecture:**
- One **team lead** session creates the team, spawns teammates, coordinates
- **Teammates** are fully independent CC instances with their own context windows
- **Shared task list** stored at `~/.claude/tasks/{team-name}/` — teammates self-claim tasks
- **Mailbox system** for direct teammate-to-teammate messaging (no hub required)
- Task dependencies auto-resolve when blocking tasks complete
- File locking prevents race conditions on task claiming

**How sessions communicate:**
- Teammates can message each other directly (unlike subagents which only report to parent)
- Lead doesn't need to poll — messages delivered automatically
- `SendMessage` tool used for resuming stopped subagents (requires agent teams enabled)

**Display modes:**
- In-process: all teammates in main terminal, Shift+Down to cycle
- Split panes: each teammate in own tmux/iTerm2 pane (Mac-friendly; known issues on Windows Terminal, VS Code terminal, Ghostty)

### Pattern 3: File-Based Coordination (External Tools)

The claude_code_agent_farm approach — pure prompt-driven, no code:
- Each agent generates timestamp-based ID
- Lock files in `/coordination/` directory claim specific files before editing
- Stale locks auto-released after 2 hours
- Central registry tracks active work, completed work, planned queue
- Can scale to 50+ agents; requires `--dangerously-skip-permissions`

**Sources:**
- [Claude Code Docs: Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Docs: Sub-Agents](https://code.claude.com/docs/en/sub-agents)
- [dev.to: Running Multiple Sessions with Git Worktree](https://dev.to/datadeer/part-2-running-multiple-claude-code-sessions-in-parallel-with-git-worktree-165i)
- [claude_code_agent_farm (768 stars)](https://github.com/Dicklesworthstone/claude_code_agent_farm)
- [MindStudio: Git Worktrees Guide](https://www.mindstudio.ai/blog/claude-code-git-worktrees-parallel-branches)

---

## 4. Subagents — Architecture and Experience

### What Subagents Are

In-session workers: specialized CC instances spawned by the main agent, each with its own context window, custom system prompt, specific tool access, and independent permissions. Defined as `.md` files with YAML frontmatter in `.claude/agents/` (project) or `~/.claude/agents/` (user).

**Built-in subagents:**
- **Explore**: Haiku model, read-only tools, codebase search and analysis
- **Plan**: read-only, gathers context before presenting plan (prevents infinite nesting — subagents cannot spawn other subagents)
- **General-purpose**: full tools, complex multi-step tasks
- **Bash**, **statusline-setup**, **Claude Code Guide**: auto-invoked helpers

**Key frontmatter fields:**
- `model`: `haiku`, `sonnet`, `opus`, `inherit`, or full model ID
- `tools` / `disallowedTools`: allowlist/denylist
- `permissionMode`: `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan`
- `isolation: worktree` — run in temporary git worktree
- `memory: user|project|local` — persistent memory across sessions
- `background: true` — run concurrently with main conversation
- `maxTurns`, `hooks`, `mcpServers`, `skills`, `effort`

**The critical constraint:** Subagents cannot spawn other subagents. Nested delegation requires agent teams or skill-based chaining from main conversation.

**Task tool renamed:** In v2.1.63, the `Task` tool was renamed to `Agent`. Existing `Task(...)` references still work as aliases.

### Community Experience: What Works

From [Claude Subagents vs Teams (Medium)](https://medium.com/@dev.aguillin/claude-subagents-vs-teams-3dfb93d7d201):
> "A subagent makes it possible to delegate part of the cognitive load. Above all, it is a context-management technique."

Context isolation is the primary value: verbose exploration output stays in the subagent's context window; only the summary returns to the main conversation. This prevents "context rot" — performance degradation from overly long context windows (the article notes this happens even with 1M token capacity due to noise, not raw limits).

### Community Experience: What Doesn't Work

- **No peer communication**: subagents can only report back to the parent, cannot coordinate with each other
- **Bottleneck at parent**: main agent still accumulates coordination noise from all subagent outputs
- **Context cost on return**: running many subagents that each return detailed results can fill main context quickly
- **Single-subagent-at-a-time**: background subagents run concurrently but require pre-approved permissions; missing permissions cause silent failure (cannot ask mid-task)

**Sources:**
- [Claude Code Docs: Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Subagents vs Teams (Medium, @dev.aguillin)](https://medium.com/@dev.aguillin/claude-subagents-vs-teams-3dfb93d7d201)
- [Claude Code Sub-Agents: Parallel vs Sequential Patterns (claudefa.st)](https://claudefa.st/blog/guide/agents/sub-agent-best-practices)

---

## 5. Limitations of CC's Built-In Multi-Agent

### Token Costs (The Biggest Complaint)

- **Subagents**: 4-7x more tokens than single-agent sessions (Anthropic's own docs)
- **Agent Teams**: ~15x standard usage (each teammate is a full independent context window)
- Broken prompt caching (March 2026 regression): users burning 7% of 5-hour Max session per prompt, with some sessions jumping "from 21% straight to 100%"
- Rate limit draining: Max 5x users ($100/month) expected ~88,000 tokens per 5-hour window, getting "a tenth of that on complex projects" when caching fails

**Practical impact:** Long-running agentic tasks are exactly the use case most exposed to cache invalidation. [roborhythms.com analysis](https://www.roborhythms.com/claude-code-rate-limit-draining-march-2026/)

Multi-agent workflows are financially unsustainable for many users on lower tiers; Claude Max accounts are frequently mentioned as required for sustained agent team use.

### Model Lock (Agent Teams)

As of March 2026, **all agents in a team must run the same model** — Opus 4.6 is required for agent teams. The community has repeatedly requested role-based model selection (lead on Opus, implementers on Sonnet, test agents on Haiku) — not yet available.

oh-my-claudecode solves this with **smart model routing**: Haiku for simple ops, Opus for complex reasoning, claiming 30-50% token savings without quality loss.

### File Conflicts

Two teammates editing the same file leads to overwrites. Anthropic's docs say "the single most important rule for implementation tasks." Workarounds: domain separation (frontend/backend/tests), worktree isolation (`isolation: worktree`), file lock systems (agent farm approach).

### Coordination Overhead

- Costs scale linearly with team size — not sublinearly
- More teammates = more communication, task coordination, potential conflicts
- "Diminishing returns beyond 3-5 teammates" — Anthropic's own guideline
- "Sweet spot is 3 agents" — community experience (30 Tips article)

### No Session Resumption for In-Process Teams

`/resume` and `/rewind` do not restore in-process teammates. After resuming a session, lead may attempt to message teammates that no longer exist.

### Task Status Lag

Teammates sometimes fail to mark tasks completed, blocking dependent tasks. Manual intervention required.

### No Nested Teams

Teammates cannot spawn their own teams. Only the lead manages the team. No promoted teammates — the session that creates the team is lead for its lifetime.

### No Persistent Memory Across Sessions

CC's agent teams have zero built-in cross-session memory. Each teammate starts fresh with only: CLAUDE.md, MCP servers, skills, and the spawn prompt. No history of what previous team runs discovered. **This is Claudex's primary competitive gap.**

### tmux Dependency for Split-Pane Mode

Split-pane mode requires tmux or iTerm2. Known issues on Windows Terminal, VS Code integrated terminal, Ghostty. Effectively Mac-only in the polished experience.

**Sources:**
- [Agent Teams Docs — Limitations section](https://code.claude.com/docs/en/agent-teams)
- [30 Tips for Claude Code Agent Teams (getpushtoprod)](https://getpushtoprod.substack.com/p/30-tips-for-claude-code-agent-teams)
- [Claude Code rate limit draining (roborhythms)](https://www.roborhythms.com/claude-code-rate-limit-draining-march-2026/)
- [Shipyard: Multi-agent orchestration 2026](https://shipyard.build/blog/claude-code-multi-agent/)
- [Addy Osmani: The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)

---

## 6. External Coordination Built on Top of CC

### oh-my-claudecode (858 GitHub stars in 24 hours, trending #1)

**GitHub:** [yeachan-heo/oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode)

- 32 specialized agents + 40+ skills
- **Ultrapilot mode**: 5 concurrent CC instances in isolated git worktrees with shared task list
- **Smart model routing**: Haiku for simple ops, Opus for complex reasoning
- **Team mode**: staged pipeline with real-time messaging and native agent teams
- **Ralph mode**: persistent execution with verification loops (Geoffrey Huntley's Ralph Loop pattern)
- Claimed 3-5x speedup, 30-50% token savings
- Example: database migration 50 min (Ultrapilot) vs 4 hours (single-threaded)
- Zero-config: installs from Claude Code marketplace, `/omc-setup` to configure

### claude_code_agent_farm (768 stars, 83 forks)

**GitHub:** [Dicklesworthstone/claude_code_agent_farm](https://github.com/Dicklesworthstone/claude_code_agent_farm)

- File-based coordination — pure prompt-driven, no code changes needed
- Lock files prevent simultaneous edits; stale locks auto-released after 2h
- Three workflow types: bug fixing, best practices, cooperating agents
- 34 supported tech stacks; scales to 50+ agents
- Real-time tmux monitoring dashboard
- Requires `--dangerously-skip-permissions`

### wshobson/agents (112 specialized agents)

**GitHub:** [wshobson/agents](https://github.com/wshobson/agents)

- 112 agents, 16 orchestrators, 146 skills, 79 plugins
- Production-ready multi-agent orchestration layer for Claude Code

### ruflo (ruvnet)

**GitHub:** [ruvnet/ruflo](https://github.com/ruvnet/ruflo)

- "Leading agent orchestration platform for Claude" — 313 MCP tools
- Swarm intelligence, RAG integration, native CC/Codex integration
- Enterprise-grade distributed swarm architecture

### mohsen1/claude-code-orchestrator

**GitHub:** [mohsen1/claude-code-orchestrator](https://github.com/mohsen1/claude-code-orchestrator)

- Hierarchical coordination: Director → Engineering Managers → Workers
- Uses git worktrees for isolation

### Gas Town (Steve Yegge) and Multiclaude (Dan Lorenc)

- **Gas Town**: Kubernetes-style for AI agents — "mayor" agent decomposes tasks, spawns specialized workers. Gas Town users maintain multiple concurrent Claude Max accounts for operational velocity.
- **Multiclaude**: Continuous forward progress philosophy — auto-merges PRs when tests pass, optional team review modes.

### barkain/claude-code-workflow-orchestration

**GitHub:** [barkain/claude-code-workflow-orchestration](https://github.com/barkain/claude-code-workflow-orchestration)

- Claude Code plugin for multi-step workflow orchestration
- Automatic task decomposition, parallel agent execution
- Specialized agent delegation with native plan mode integration

**Sources:**
- [oh-my-claudecode GitHub](https://github.com/yeachan-heo/oh-my-claudecode)
- [oh-my-claudecode overview (byteiota)](https://byteiota.com/oh-my-claudecode-multi-agent-orchestration-for-claude-code/)
- [claude_code_agent_farm GitHub](https://github.com/Dicklesworthstone/claude_code_agent_farm)
- [wshobson/agents GitHub](https://github.com/wshobson/agents)
- [ruflo GitHub](https://github.com/ruvnet/ruflo)
- [awesome-claude-code GitHub](https://github.com/hesreallyhim/awesome-claude-code)
- [Shipyard: Multi-agent orchestration 2026](https://shipyard.build/blog/claude-code-multi-agent/)

---

## 7. The Subagent / Agent Tool Experience

### The Discovery Timeline

Developer kieranklaassen discovered `TeammateTool` — a fully implemented but feature-flagged multi-agent system hiding inside the CC binary (v2.1.29) — on January 26, 2026. Two weeks later, Anthropic officially launched agent teams as a research preview (v2.1.32). The community reverse-engineered the feature before it launched.

### Subagent System Prompts (from Piebald-AI analysis)

CC's internal agents have specific system prompts:
- **Explore agent**: 494-token system prompt — codebase exploration, analysis
- **Plan agent (enhanced)**: 636-token prompt — main planning subagent
- **Plan agent (iterative)**: 936-token prompt — coordinator workflows with user interviewing
- **Subagent delegation examples**: 606-token prompt showing coordinator agent how to task subagents, manage waiting states, consolidate results
- **General-purpose subagent**: 285-token prompt — searches and edits code, reports concisely to main agent
- **Fork-based execution guidelines**: 419-token guidelines on when to spawn vs execute directly, restrictions against mid-flight output reading or fabricating results

### Community Experience with Subagents

**What works:**
- Context preservation — the primary use case; keeping verbose exploration out of main context
- Tool restriction — creating read-only researcher agents, preventing write access
- Model routing — routing to Haiku for cheap exploration, Opus for complex reasoning
- Worktree isolation — `isolation: worktree` field (new) gives subagents isolated repo copies
- Persistent memory — `memory: user|project|local` accumulates knowledge across sessions
- Background execution — `background: true` for non-blocking parallel work

**What doesn't work:**
- Instruction ambiguity compounds across agents: "The instruction file contradicting itself is a bigger failure mode than agent errors. Agents follow instructions too literally — so inconsistencies compound." — community commenter on getpushtoprod
- No direct peer communication between subagents
- Background subagents silently fail on missing permissions (can't ask mid-task)
- Subagents cannot spawn subagents — no nested delegation

**Sources:**
- [Claude Code system prompts (Piebald-AI)](https://github.com/Piebald-AI/claude-code-system-prompts)
- [30 Tips for Agent Teams (getpushtoprod)](https://getpushtoprod.substack.com/p/30-tips-for-claude-code-agent-teams)
- [Claude Code Docs: Sub-Agents](https://code.claude.com/docs/en/sub-agents)

---

## 8. Feature Requests and Community Gaps

### Most Requested (from community analysis)

1. **Role-based model selection in agent teams** — lead on Opus, implementers on Sonnet, test agents on Haiku. Currently enforced as same-model-for-all.

2. **Session resumption with in-process teammates** — `/resume` doesn't restore teammates; lead tries to message non-existent sessions after resume.

3. **Nested teams** — teammates cannot spawn their own teams. Hard limit in current architecture.

4. **Persistent memory across team sessions** — no built-in mechanism for agent teams to remember what previous runs discovered. Every team starts fresh (CLAUDE.md only). Tools like oh-my-claudecode build this manually via shared files.

5. **Better permission ergonomics** — "too many permission prompts" is explicitly listed in Anthropic's own troubleshooting section. Pre-approving common operations required before spawning teammates.

6. **Windows / non-tmux support for split-pane mode** — tmux requirement is effectively a Mac-only restriction for the best multi-agent experience.

7. **Cross-agent file locking** — Anthropic's guidance says "avoid file conflicts" but provides no native locking. Community built this themselves (agent farm approach).

8. **ULTRAPLAN for regular users** — the community knows it exists (leaked source); engineers want it.

### The Gap Nobody Has Solved (That Claudex Owns)

All CC multi-agent approaches — subagents, agent teams, external orchestrators — share a fundamental limitation: **no persistent cross-session memory that accumulates intelligence over time**. Each run starts fresh. Patterns discovered in session 1 must be manually re-encoded in CLAUDE.md or task descriptions for session 2.

oh-my-claudecode's `memory: user|project` field per subagent is the closest CC native approach — but it's flat file storage (MEMORY.md), not a queryable knowledge base with hybrid retrieval, embedding-based recall, or CARA-style pattern promotion.

Claudex's architecture — shared SQLite DB, Qdrant acceleration, Angel pattern extraction, experience-pattern RL, session signals — addresses exactly this gap at a depth that CC's built-in memory cannot match.

**Sources:**
- [Agent Teams Docs — Limitations](https://code.claude.com/docs/en/agent-teams)
- [30 Tips for Agent Teams](https://getpushtoprod.substack.com/p/30-tips-for-claude-code-agent-teams)
- [Claude Subagents vs Teams](https://medium.com/@dev.aguillin/claude-subagents-vs-teams-3dfb93d7d201)
- [Addy Osmani: Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)

---

## 9. How CC Multi-Agent Compares to Alternatives (2026)

### The February 2026 Convergence

"In February 2026, every major tool shipped multi-agent in the same two-week window: Grok Build (8 agents), Windsurf (5 parallel agents), Claude Code Agent Teams, Codex CLI (Agents SDK), Devin (parallel sessions)." — [morphllm.com analysis](https://www.morphllm.com/ai-coding-agent)

Multi-agent is now table stakes. Differentiation is in coordination quality, not raw parallelism.

### Tier 1: In-Process (CC Native)

- **CC Subagents**: zero additional tooling, in-session, no peer comms, context managed
- **CC Agent Teams**: experimental, cross-session comms, shared task list, tmux preferred

### Tier 2: Local Orchestrators (Community-Built)

- **oh-my-claudecode**: model routing, worktree isolation, Ralph mode, zero-config
- **claude_code_agent_farm**: pure prompt-driven, file locking, 50+ agent scale
- **Gas Town**: Kubernetes-style, hierarchical mayor/worker architecture
- **Conductor** (Mac-only): visual dashboard, git worktrees, diff review
- **Vibe Kanban**: task-card interface with in-board diff review

### Tier 3: Cloud Async (Competitors)

- **Claude Code Web**: browser-based, GitHub integration, no terminal
- **GitHub Copilot Coding Agent**: fully async on GitHub, auto self-review before PR, MCP support
- **Jules (Google)**: plan approval before execution, audio changelogs, auto-reads AGENTS.md
- **Codex Web (OpenAI)**: containerized isolation, verifiable evidence (terminal logs as citations), Agent SDK
- **Devin**: parallel sessions with cloud containers

### What CC Does Better

- Deepest codebase understanding (80.8% SWE-bench)
- Most advanced native multi-agent coordination (agent teams with shared task list, peer messaging)
- Direct teammate interaction — you can message any teammate without going through lead
- Hooks integration with agent lifecycle (`SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`)
- `46% "most loved" rating among developers` vs Cursor (19%), Copilot (9%) — [NxCode comparison](https://www.nxcode.io/resources/news/cursor-vs-claude-code-vs-github-copilot-2026-ultimate-comparison)

### What CC Does Worse

- **Token cost** — agent teams at ~15x standard usage; competitors with containerized isolation reuse context better
- **No persistent memory** across agent team runs — competitors like Jules auto-read AGENTS.md for continuity
- **Mac-centric split-pane** — tmux requirement excludes Windows/VS Code terminal users
- **Experimental instability** — agent teams still "susceptible to rough edges"
- **Same-model enforcement** — no per-role model routing in native teams

**Sources:**
- [We Tested 15 AI Coding Agents (morphllm)](https://www.morphllm.com/ai-coding-agent)
- [Cursor vs Claude Code vs GitHub Copilot 2026 (NxCode)](https://www.nxcode.io/resources/news/cursor-vs-claude-code-vs-github-copilot-2026-ultimate-comparison)
- [Addy Osmani: Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- [Shipyard: Multi-agent 2026](https://shipyard.build/blog/claude-code-multi-agent/)

---

## 10. Claudex Positioning: What This Means

### What Claudex Is Doing That CC Isn't

| Capability | CC Native | Claudex |
|---|---|---|
| Persistent cross-session memory | CLAUDE.md only (flat file) | SQLite + Qdrant, hybrid retrieval, embeddings |
| Pattern extraction from agent behavior | None | Angel — extracts from full conversations |
| Cross-session signals | None | `session_signals` table, stigmergic coordination |
| Experience-pattern RL | None | Q-value + UCB, exponential decay |
| Agent-to-agent messaging | Agent teams only (same session group) | `session_messages` table, cross-project |
| Session naming and discovery | None | `sessions.name`, claudex_session tool |
| Memory pressure management | None | Pressure monitor, retention sweep |
| CARA opinions | None | `angel_opinions` table, confidence dynamics |

### The Core Insight

CC's multi-agent is **stateless orchestration**. Each team run starts fresh. Claudex is **stateful intelligence accumulation**. The gap CC is trying to close with KAIROS (persistent sessions) and CLAUDE.md (manual memory) is what Claudex has already built as infrastructure.

The community's biggest pain: they're building CLAUDE.md files, AGENTS.md files, task lists, and memory directories manually — exactly what Claudex automates.

---

## All URLs Referenced

- [Claude Code Docs: Overview](https://code.claude.com/docs/en/overview)
- [Claude Code Docs: Sub-Agents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Docs: Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code system prompts (Piebald-AI)](https://github.com/Piebald-AI/claude-code-system-prompts)
- [Bridge and Coordinator Mode (Claude-Code-VS-OpenCode)](https://github.com/0xtresser/Claude-Code-VS-OpenCode/blob/main/EN/Chapter_11_Claude_Code_Commercial/11.6_Bridge_and_Coordinator_Mode.md)
- [Claude Code Leaked Source: Hidden Features (WaveSpeedAI)](https://wavespeed.ai/blog/posts/claude-code-leaked-source-hidden-features/)
- [Claude Code Source Leaked: 5 Hidden Features (HarrisonSec)](https://harrisonsec.com/blog/claude-code-source-leaked-hidden-features/)
- [Claude Code Source Leak: 512K Lines (Medium, @analystuttam)](https://medium.com/@analystuttam/the-claude-code-leak-512-000-lines-of-typescript-and-what-they-reveal-76ce148766f1)
- [COORDINATOR MODE + ULTRAPLAN (Threads @heynickquick)](https://www.threads.com/@heynickquick/post/DWkDe3ekWwa/coordinator-mode-ultraplan-coordinator-mode-lets-one-claude-spawn-and-manage)
- [Built-in git worktree support (Threads @boris_cherny)](https://www.threads.com/@boris_cherny/post/DVAAnexgRUj/)
- [Anthropic released Remote Control (VentureBeat)](https://venturebeat.com/orchestration/anthropic-just-released-a-mobile-version-of-claude-code-called-remote)
- [Addy Osmani: The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- [Shipyard: Multi-agent orchestration 2026](https://shipyard.build/blog/claude-code-multi-agent/)
- [30 Tips for Claude Code Agent Teams (getpushtoprod)](https://getpushtoprod.substack.com/p/30-tips-for-claude-code-agent-teams)
- [Claude Subagents VS Teams (Medium, @dev.aguillin)](https://medium.com/@dev.aguillin/claude-subagents-vs-teams-3dfb93d7d201)
- [Collaborating with Agent Teams (Heeki Park, Medium)](https://heeki.medium.com/collaborating-with-agents-teams-in-claude-code-f64a465f3c11)
- [Agent Teams in Claude Code (Daniel Avila, Medium)](https://medium.com/@dan.avila7/agent-teams-in-claude-code-d6bb90b3333b)
- [From Tasks to Swarms: Agent Teams (alexop.dev)](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/)
- [Claude Code Agent Teams Setup 2026 (claudefa.st)](https://claudefa.st/blog/guide/agents/agent-teams)
- [Sub-Agent Best Practices (claudefa.st)](https://claudefa.st/blog/guide/agents/sub-agent-best-practices)
- [Claude Code Agents & Subagents: What They Actually Unlock (ksred)](https://www.ksred.com/claude-code-agents-and-subagents-what-they-actually-unlock/)
- [Running Multiple Sessions with Git Worktree (dev.to/datadeer)](https://dev.to/datadeer/part-2-running-multiple-claude-code-sessions-in-parallel-with-git-worktree-165i)
- [Parallel Vibe Coding with Git Worktrees (dandoescode)](https://www.dandoescode.com/blog/parallel-vibe-coding-with-git-worktrees)
- [Shipping faster with CC and Git Worktrees (incident.io)](https://incident.io/blog/shipping-faster-with-claude-code-and-git-worktrees)
- [Claude Code rate limit draining March 2026 (roborhythms)](https://www.roborhythms.com/claude-code-rate-limit-draining-march-2026/)
- [Multi-Agent Orchestration (DEV Community, bredmond1019)](https://dev.to/bredmond1019/multi-agent-orchestration-running-10-claude-instances-in-parallel-part-3-29da)
- [oh-my-claudecode GitHub](https://github.com/yeachan-heo/oh-my-claudecode)
- [oh-my-claudecode overview (byteiota)](https://byteiota.com/oh-my-claudecode-multi-agent-orchestration-for-claude-code/)
- [oh-my-claudecode (AIToolly)](https://aitoolly.com/ai-news/article/2026-03-29-oh-my-claudecode-a-new-multi-agent-orchestration-tool-designed-for-enhanced-team-collaboration)
- [claude_code_agent_farm GitHub (768 stars)](https://github.com/Dicklesworthstone/claude_code_agent_farm)
- [wshobson/agents GitHub](https://github.com/wshobson/agents)
- [ruflo GitHub](https://github.com/ruvnet/ruflo)
- [awesome-claude-code GitHub](https://github.com/hesreallyhim/awesome-claude-code)
- [barkain/claude-code-workflow-orchestration GitHub](https://github.com/barkain/claude-code-workflow-orchestration)
- [mohsen1/claude-code-orchestrator GitHub](https://github.com/mohsen1/claude-code-orchestrator)
- [We Tested 15 AI Coding Agents (morphllm)](https://www.morphllm.com/ai-coding-agent)
- [Cursor vs Claude Code vs GitHub Copilot 2026 (NxCode)](https://www.nxcode.io/resources/news/cursor-vs-claude-code-vs-github-copilot-2026-ultimate-comparison)
- [Claude Code vs GitHub Copilot vs Cursor 2026 (cosmicjs)](https://www.cosmicjs.com/blog/claude-code-vs-github-copilot-vs-cursor-which-ai-coding-agent-should-you-use-2026)
- [claude-code-ultimate-guide (FlorianBruniaux)](https://github.com/FlorianBruniaux/claude-code-ultimate-guide/blob/main/guide/workflows/agent-teams.md)
- [How Claude Code Sub-Agents work (zachwills.net)](https://zachwills.net/how-to-use-claude-code-subagents-to-parallelize-development/)
