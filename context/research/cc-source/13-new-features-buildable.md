# CC Buildable: New Features vs Free/Leaked Versions

**Research date:** 2026-04-01  
**Source:** C:/Users/Grigorije/Desktop/Projects/claude-code-buildable/src/  
**Compared against:** claude-code-free/src/ and claude-code-leaked/src/

---

## Delta Summary: Files Exclusively in Buildable

Both the free and leaked repos are byte-identical in their directory listings. The following top-level entries exist **only in the buildable repo**:

| Entry | Type | Nature |
|---|---|---|
| `attributionTrailer.ts` | File | Stub (ant-only content, tree-shaken) |
| `cachedMicrocompact.ts` | File | Stub |
| `coreTypes.generated.ts` | File | Stub (generated types) |
| `devtools.ts` | File | Stub |
| `dream.ts` | File | Stub |
| `entry.ts` | File | Bun:bundle polyfill entry point |
| `global.d.ts` | File | Stub (global type declarations) |
| `hunter.ts` | File | Stub |
| `jobs/` | Dir | Stub (jobs/classifier.ts) |
| `proactive/` | Dir | Stubs (index.ts, useProactive.ts) |
| `protectedNamespace.ts` | File | Stub |
| `runSkillGenerator.ts` | File | Stub |
| `sdk/` | Dir | Stubs (runtimeTypes.ts, toolTypes.ts) |
| `ssh/` | Dir | Stub (createSSHSession.ts interface) |
| `stubs/` | Dir | Bun polyfills + ant-packages |
| `yolo-classifier-prompts/` | Dir | Empty prompt text files |

**Key insight:** Nearly all new top-level files are stubs. The actual feature implementations live in existing directories (`src/tools/`, `src/services/`, `src/utils/`, etc.) and are conditionally compiled via `bun:bundle` `feature()` flags. The buildable repo exposes these through the `stubs/bun-bundle-runtime.ts` polyfill.

---

## The Feature Flag System (bun:bundle)

This is the most important discovery. CC uses Bun's compile-time `feature()` API from `bun:bundle` for dead-code elimination (DCE). In production Ant builds, Bun constant-folds `feature('FLAG')` to `true`/`false` at bundle time, completely eliminating gated code from external builds.

**The polyfill** (`src/stubs/bun-bundle-runtime.ts`) reveals the full flag set and which are enabled. All are currently commented out (disabled) in the research build:

```typescript
const ENABLED_FEATURES = new Set<string>([
  // 'KAIROS',              // Assistant mode
  // 'PROACTIVE',           // Proactive mode
  // 'BRIDGE_MODE',         // IDE bridge
  // 'VOICE_MODE',          // Voice input
  // 'COORDINATOR_MODE',    // Multi-agent coordinator
  // 'TRANSCRIPT_CLASSIFIER', // Auto-mode classifier
  // 'BUDDY',               // Companion sprite
  // 'WEB_BROWSER_TOOL',    // Web browser tool
  // 'CHICAGO_MCP',         // Computer use MCP
  // 'DAEMON',              // Daemon mode
])
```

**Complete feature flag inventory** (usage count → flag name):

| Count | Flag | Category |
|---|---|---|
| 154 | KAIROS | Assistant mode (claude.ai chat interface) |
| 107 | TRANSCRIPT_CLASSIFIER | Auto-permission classifier |
| 51 | TEAMMEM | Shared team memory |
| 46 | VOICE_MODE | Voice input/STT |
| 45 | BASH_CLASSIFIER | Bash permission classifier |
| 39 | KAIROS_BRIEF | Brief tool (standalone) |
| 37 | PROACTIVE | Proactive/autonomous mode |
| 32 | COORDINATOR_MODE | Multi-agent coordinator |
| 28 | BRIDGE_MODE | Remote Control / IDE bridge |
| 21 | EXPERIMENTAL_SKILL_SEARCH | Auto skill discovery |
| 20 | CONTEXT_COLLAPSE | Context window UI |
| 19 | KAIROS_CHANNELS | Claude.ai channel routing |
| 17 | UDS_INBOX | Unix domain socket inbox |
| 16 | CHICAGO_MCP | Computer Use MCP |
| 16 | BUDDY | Companion sprite |
| 15 | HISTORY_SNIP | Message history snipping |
| 13 | MONITOR_TOOL | Monitor tool |
| 12 | COMMIT_ATTRIBUTION | PR/commit attribution trailers |
| 12 | CACHED_MICROCOMPACT | Cached microcompaction |
| 11 | BG_SESSIONS | Background sessions |
| 11 | AGENT_TRIGGERS | Remote scheduled triggers |
| 10 | WORKFLOW_SCRIPTS | Workflow scripts tool |
| 10 | ULTRAPLAN | Remote CCR ultra-planning |
| 10 | SHOT_STATS | Shot statistics tracking |
| 9 | TOKEN_BUDGET | Token budget system |
| 9 | PROMPT_CACHE_BREAK_DETECTION | Prompt cache break detection |
| 9 | MCP_SKILLS | MCP skill tools |
| 7 | EXTRACT_MEMORIES | Auto memory extraction |
| 7 | CONNECTOR_TEXT | Connector text |
| 6 | TEMPLATES | Templates |
| 6 | LODESTONE | Deep link protocol handler |
| 5 | TREE_SITTER_BASH_SHADOW | Tree-sitter Bash shadow |
| 5 | QUICK_SEARCH | Quick search |
| 5 | MESSAGE_ACTIONS | Message action buttons |
| 5 | DOWNLOAD_USER_SETTINGS | User settings download |
| 5 | DIRECT_CONNECT | Direct connect |
| 4 | WEB_BROWSER_TOOL | Web browser tool |
| 4 | VERIFICATION_AGENT | Auto adversarial verifier |
| 4 | TERMINAL_PANEL | Terminal panel |
| 4 | SSH_REMOTE | SSH remote sessions |
| 4 | REVIEW_ARTIFACT | Review artifact |
| 4 | REACTIVE_COMPACT | Reactive compaction |
| 4 | KAIROS_PUSH_NOTIFICATION | Push notifications |
| 4 | HISTORY_PICKER | History picker |
| 4 | FORK_SUBAGENT | Fork subagent pattern |
| 4 | CCR_MIRROR | CCR mirror mode |
| + many | ... | (dozens more 1-3 count flags) |

---

## Feature Deep-Dives

### 1. KAIROS — Assistant Mode

**What it is:** CC running as a persistent background assistant connected to claude.ai's chat interface. The model operates as an autonomous agent the user can talk to via the claude.ai web UI, receiving tasks and communicating back via the `SendUserMessage` (Brief) tool.

**How it works:**
- Gated by `feature('KAIROS')` — 154 usages, the most referenced flag
- `getKairosActive()` / `setKairosActive()` tracks whether the session is in assistant mode
- When active, the system prompt is replaced with a stripped-down "autonomous agent" prompt: `"You are an autonomous agent. Use the available tools to do useful work."`
- The full system prompt includes a `BRIEF_PROACTIVE_SECTION` requiring `SendUserMessage` for all user-visible output
- `assistantModule` and `kairosGate` are dynamically required at startup (`require('./assistant/index.js')`)
- `src/assistant/` contains: `gate.ts`, `index.ts`, `sessionDiscovery.ts`, `sessionHistory.ts`, `AssistantSessionChooser.tsx` — all stubbed in the buildable repo
- Integrates with `KAIROS_CHANNELS` for message routing, `KAIROS_BRIEF` for the Brief tool, `KAIROS_PUSH_NOTIFICATION` for push delivery, `KAIROS_DREAM` for background memory consolidation

**Feature flag:** `feature('KAIROS')` — ant/MAX-only, GrowthBook-gated via `tengu_kairos_brief`

**Hook/context interaction:** When `kairosActive` is true, the proactive system prompt path fires (`isProactiveActive()` from `proactive/index.ts`). Brief tool becomes mandatory for all output.

**Claudex relevance:** KAIROS is CC's answer to Claudex's persistent agent concept. The key difference: Claudex persists memory to SQLite across sessions; KAIROS persists state via the claude.ai session infrastructure. There is no conflict — Claudex hooks would fire normally in KAIROS sessions.

---

### 2. PROACTIVE — Autonomous Proactive Mode

**What it is:** A lighter-weight autonomous mode (overlaps with KAIROS) where CC operates without user-per-turn prompting.

**How it works:**
- `feature('PROACTIVE') || feature('KAIROS')` — the two flags share the same proactive system prompt path
- `proactiveModule?.isProactiveActive()` determines whether the proactive system prompt fires
- `src/proactive/index.ts` is stubbed — the real implementation is ant-only
- When proactive, system prompt reduces to minimal agent prompt + memory + MCP instructions

**Feature flag:** `feature('PROACTIVE')` — ant-only

**Claudex relevance:** PreToolUse hook already injects Claudex awareness into subagent prompts. In PROACTIVE mode this continues to work since Claudex hooks fire at the OS level, independent of CC's internal mode.

---

### 3. SendUserMessage / Brief Tool — KAIROS_BRIEF

**What it is:** A tool named `SendUserMessage` (legacy: `Brief`) that is the **only** user-visible output channel in KAIROS/proactive sessions. Normal text output is hidden in a collapsible "detail view."

**How it works:**
- Defined in `src/tools/BriefTool/BriefTool.ts` — fully implemented, not stubbed
- Schema: `{ message: string, attachments?: string[], status: 'normal' | 'proactive' }`
- `status: 'proactive'` signals unsolicited updates (task completion, blockers) vs replies
- `isBriefEnabled()` — requires `(kairosActive || userMsgOptIn) && isBriefEntitled()`
- `isBriefEntitled()` — requires `kairosActive || CLAUDE_CODE_BRIEF env || tengu_kairos_brief GB gate`
- Supports file attachments: images, diffs, logs are resolved and included
- Activation paths: `--brief` CLI flag, `defaultView: 'chat'` setting, `/brief` command, `SendUserMessage` in SDK tools option
- GrowthBook kill-switch: `tengu_kairos_brief` flipping off mid-session disables the tool on next 5-min refresh

**System prompt section** (`BRIEF_PROACTIVE_SECTION`):
> "SendUserMessage is where your replies go. Text outside it is visible if the user expands the detail view, but most won't — assume unread... every time the user says something, the reply they actually read comes through SendUserMessage. Even for 'hi'. Even for 'thanks'."

**Feature flag:** `feature('KAIROS') || feature('KAIROS_BRIEF')`

**Claudex interaction:** The Brief tool fires PostToolUse hooks. Claudex's PostToolUse hook captures `tool_response` from Brief calls, enabling extraction of what the model sent to the user. This is the correct payload field per the CC Hook Payload Truth table.

---

### 4. COORDINATOR_MODE — Multi-Agent Coordinator

**What it is:** CC running as a coordinator orchestrating multiple worker agents. A fundamentally different operating mode from normal interactive use.

**How it works:**
- Enabled by env var: `CLAUDE_CODE_COORDINATOR_MODE=1`
- `isCoordinatorMode()` in `src/coordinator/coordinatorMode.ts` checks `feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)`
- The coordinator receives worker results as `<task-notification>` XML in user-role messages
- Full coordinator system prompt included in `getCoordinatorSystemPrompt()` — defines the research/synthesis/implementation/verification workflow
- Workers are spawned via `AgentTool` with `subagent_type: 'worker'`
- Workers are continued via `SendMessageTool` (sending follow-ups to existing agents by ID)
- Workers notify back via `<task-notification>` XML on completion
- `matchSessionMode()` handles coordinator mode persistence across resumed sessions
- Mutually exclusive with FORK_SUBAGENT

**Coordinator system prompt philosophy:**
- Coordinator synthesizes research findings before delegating implementation — "never write 'based on your findings'"
- Continue vs spawn decision based on context overlap
- Parallelism is "the coordinator's superpower" — read-only tasks run in parallel
- Verification phase is adversarial and separate from implementation

**Feature flag:** `feature('COORDINATOR_MODE')` — env var activated

**Claudex relevance:** Claudex's cross-session coordination system parallels this. Coordinator workers would each get Claudex context injected via PreToolUse hooks. The main difference: Claudex coordinates via DB signals and messages; CC coordinator coordinates via in-process task-notification messaging.

---

### 5. FORK_SUBAGENT — Implicit Fork Pattern

**What it is:** When calling `AgentTool` without a `subagent_type`, an implicit "fork" is created — a child inheriting the parent's full conversation context and system prompt. Replaces the general-purpose agent delegation model.

**How it works:**
- Defined in `src/tools/AgentTool/forkSubagent.ts`
- `isForkSubagentEnabled()` — requires `feature('FORK_SUBAGENT')` and not coordinator mode and not non-interactive
- `FORK_AGENT` definition: `tools: ['*']`, `model: 'inherit'`, `permissionMode: 'bubble'`, `maxTurns: 200`
- The fork inherits the parent's rendered system prompt bytes (byte-exact, not re-rendered — prevents prompt cache busting)
- All agent spawns run async (background) — unified `<task-notification>` model
- `/fork <directive>` slash command available
- Recursive forking blocked: `isInForkChild()` detects fork boilerplate tag in conversation history
- Mutually exclusive with coordinator mode

**System prompt description:** "Calling AgentTool without a subagent_type creates a fork, which runs in the background and keeps its tool output out of your context — so you can keep chatting with the user while it works."

**Feature flag:** `feature('FORK_SUBAGENT')` — interactive-only

**Claudex interaction:** Fork children would receive Claudex context via PreToolUse hook injection (existing implementation in cc-hooks). The system prompt inheritance means Claudex-injected context from the parent's system prompt is also present in the fork.

---

### 6. VERIFICATION_AGENT — Adversarial Auto-Verifier

**What it is:** A built-in adversarial verification agent that automatically spawns after non-trivial implementation, tasked with trying to break the code rather than confirming it works.

**How it works:**
- Registered as built-in agent type `verification` via `VERIFICATION_AGENT_TYPE`
- Only enabled when `feature('VERIFICATION_AGENT')` AND GrowthBook gate `tengu_hive_evidence` is true (ant-only A/B)
- The system prompt for the verification agent is explicit about its failure modes: "verification avoidance" (reading code instead of running it) and "being seduced by the first 80%" (passing on a polished surface without testing edge cases)
- Includes type-specific strategies for frontend/backend/CLI/infrastructure/mobile/ML changes
- Strictly read-only for the project (can write to /tmp for test harnesses)
- Reports PASS/FAIL/PARTIAL verdicts with mandatory command output for each PASS
- The main model system prompt instructs: "when non-trivial implementation happens... independent adversarial verification must happen before you report completion"
- Non-trivial = 3+ file edits, backend/API changes, or infrastructure changes
- Main model must spot-check PASS results by re-running 2-3 commands from the verifier's report

**Feature flag:** `feature('VERIFICATION_AGENT')` + `tengu_hive_evidence` GB gate

**Claudex relevance:** Claudex's Angel system does post-session pattern extraction. The VERIFICATION_AGENT operates within-session as a peer quality gate. These are complementary, not conflicting.

---

### 7. EXTRACT_MEMORIES — End-of-Turn Memory Extraction

**What it is:** After each complete query loop, a forked agent automatically scans the conversation and writes durable memories to the auto-memory directory.

**How it works:**
- Fires via `handleStopHooks` in `stopHooks.ts` when `feature('EXTRACT_MEMORIES')` is active
- Uses `runForkedAgent` — a perfect fork sharing the parent's prompt cache
- Skips if the conversation already wrote to memory files this turn
- Counts new messages since last extraction, skips if below threshold
- Generates `createAutoMemCanUseTool` — restricted tool set (Read, Write, Edit, Bash, Glob, Grep, REPL)
- Writes to `~/.claude/projects/<path>/memory/` directory
- If `TEAMMEM` is also enabled, can write to both private and team memory directories
- Fires `drainPendingExtraction()` in `cli/print.ts` for non-interactive mode

**Feature flag:** `feature('EXTRACT_MEMORIES')` + `isAutoMemoryEnabled()`

**Claudex relevance:** This is a simplified version of what Claudex's session-end hooks do. Claudex extracts observations, decisions, and learnings to SQLite + Qdrant. CC's extract-memories writes markdown files. They operate on different storage systems and could both run without conflict.

---

### 8. TEAMMEM — Shared Team Memory

**What it is:** A shared memory directory synced across all users working in the same project directory. Private memory (`~/.claude/projects/<path>/memory/`) + team memory (`~/.claude/projects/<path>/memory/team/`) with path traversal hardening.

**How it works:**
- `isTeamMemoryEnabled()` — requires `isAutoMemoryEnabled()` + `tengu_herring_clock` GB gate
- Team memory lives at `<memdir>/team/` — a subdirectory of auto-memory, scoped per-project
- Extensive path traversal protection: null byte rejection, URL-encoded traversal, Unicode NFKC normalization attacks, symlink escape via `realpath()` (PSR M22186)
- `validateTeamMemWritePath()` and `validateTeamMemKey()` do two-pass validation: string-level + symlink-resolved
- Both auto-memory and team-memory have separate `MEMORY.md` index files
- The combined memory prompt (`buildCombinedMemoryPrompt`) presents both directories to the model with scope guidance
- Team scope vs private scope: team memories are "shared with and contributed by all users who work within this project directory"
- Sync mechanism: team memory files are synced at session start

**Feature flag:** `feature('TEAMMEM')` + `tengu_herring_clock` GB gate

**Claudex relevance:** Claudex already handles cross-session memory via shared SQLite DB. TEAMMEM is CC's filesystem-based equivalent. They are parallel systems — Claudex's approach is more structured (typed observations, hybrid retrieval) while TEAMMEM is freeform markdown.

---

### 9. BRIDGE_MODE — Remote Control / IDE Bridge

**What it is:** Bidirectional bridge connecting CC to claude.ai's CCR (Claude Code Remote) infrastructure, enabling IDE integration, remote sessions, and web UI control of local CC instances.

**How it works:**
- `isBridgeEnabled()` — requires `feature('BRIDGE_MODE')` + `isClaudeAISubscriber()` + `tengu_ccr_bridge` GB gate
- Requires claude.ai OAuth subscription (excludes Bedrock/Vertex/API key users)
- `isBridgeEnabledBlocking()` — awaits GrowthBook init for fresh server value (up to 5s)
- Version gating: `checkBridgeMinVersion()` enforces minimum CLI version from `tengu_bridge_min_version`
- Two bridge implementations: env-based (v1) and env-less/v2 (gated by `tengu_bridge_repl_v2`)
- `CCR_AUTO_CONNECT`: when enabled + `tengu_cobalt_harbor` gate, all sessions connect to CCR by default
- `CCR_MIRROR`: every local session spawns an outbound-only Remote Control session (`tengu_ccr_mirror` gate or `CLAUDE_CODE_CCR_MIRROR` env)
- `src/bridge/` contains 25+ files: session management, JWT utils, peer sessions, flush gate, capacity wake, trusted device, etc.

**Feature flag:** `feature('BRIDGE_MODE')` + claude.ai subscription

**Claudex relevance:** Bridge sessions would still receive Claudex context via hooks. The `replBridgeEnabled` state is checked in Brief tool's attachment resolution, meaning Claudex-stored file paths work correctly in bridge sessions.

---

### 10. BUDDY — Companion Sprite

**What it is:** An animated ASCII companion (pet) that sits beside the user's input box and occasionally comments in a speech bubble. Fully implemented with rarity system, stats, species variety, and hat accessories.

**How it works:**
- Defined in `src/buddy/` — fully implemented (not stubbed)
- Companion is deterministically generated from `hash(userId + salt)` — can't be faked by editing config
- Species: duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail, ghost, axolotl, capybara, cactus, robot, rabbit, mushroom, chonk (18 species)
- Rarity system: common (60%), uncommon (25%), rare (10%), epic (4%), legendary (1%)
- Stats: DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK — one peak stat, one dump stat
- Eyes: `·`, `✦`, `×`, `◉`, `@`, `°`
- Hats: none, crown, tophat, propeller, halo, wizard, beanie, tinyduck
- Shiny variant: 1% chance
- Sprite renders as ASCII art with 3 animation frames per species
- One species name is hex-encoded in source to avoid excluded-string detection (model codename collision)
- Stored state: `name`, `personality` (model-generated), `hatchedAt` — bones regenerated from hash on every read
- Companion introduces itself via `companion_intro` attachment, then speaks in speech bubbles
- When user addresses companion by name, the model stays out of the way (one line max)
- Muted via `config.companionMuted`

**Feature flag:** `feature('BUDDY')` + config.companion present

**Claudex relevance:** No conflict. Companion intro arrives as an attachment — Claudex's attachment extractor would see it. PostToolUse hook on `SendUserMessage` could capture companion speech bubble content.

---

### 11. CHICAGO_MCP — Computer Use MCP

**What it is:** A built-in MCP server providing computer use (screenshot, click, type) capabilities on macOS. Adds a `--computer-use-mcp` CLI mode that runs CC as a computer use MCP server.

**How it works:**
- `feature('CHICAGO_MCP')` gates entry at CLI level: `process.argv[2] === '--computer-use-mcp'`
- macOS-only and non-interactive-only: `getPlatform() === 'macos' && !getIsNonInteractiveSession()`
- `setupComputerUseMCP()` initializes the MCP server at session start
- `cleanupComputerUseAfterTurn()` runs at turn end (via `stopHooks.ts`)
- UI: `ComputerUseApproval` component shows an app allowlist panel or TCC (macOS permissions) panel
- Permission UI routes through existing permission system
- The MCP server runs as a long-lived process and exposes computer use tools to the main CC loop

**Feature flag:** `feature('CHICAGO_MCP')` — macOS-only, non-interactive

**Claudex relevance:** Computer use tool calls would fire PostToolUse hooks. Claudex could capture what the model clicked/typed/screenshotted.

---

### 12. ULTRAPLAN — Remote CCR Ultra-Planning

**What it is:** A `/ultraplan` slash command that launches a remote CCR session for collaborative multi-agent exploration and planning, then imports the resulting plan back to the local session.

**How it works:**
- Defined in `src/commands/ultraplan.tsx` — fully implemented
- Sends a task to CCR (Claude Code Remote) using the highest-capability model (configurable via `tengu_ultraplan_model`, defaults to `claude-opus-4-6`)
- Loads instructions from `src/utils/ultraplan/prompt.txt` — bundled at build time
- Dev override: `ULTRAPLAN_PROMPT_FILE` env var for ant builds
- The prompt is wrapped in `<system-reminder>` so the CCR browser hides scaffolding
- Polls for plan approval via `pollForApprovedExitPlanMode()` — 30 minute timeout
- Two poll phases: `needs_input` (user must approve the plan) and `approved`
- On approval, `archiveRemoteSession()` and `teleportToRemote()` handle session continuity
- Shows a `RemoteAgentTask` in the UI while polling
- Pending choice state: the user sees the proposed plan and can accept or reject
- On timeout: logs `tengu_ultraplan_failed` event
- On connection loss: `REMOTE_CONTROL_DISCONNECTED_MSG` is shown

**Feature flag:** `feature('ULTRAPLAN')` — requires CCR access

**Claudex relevance:** The ultraplan session runs on CCR. Claudex hooks would not fire on the CCR side. The local session that receives the plan result could be captured by Claudex's session summary hook.

---

### 13. LODESTONE — Deep Link Protocol Handler

**What it is:** Registers CC as a system protocol handler (`claude://` URI scheme) so external apps can launch CC sessions via deep links.

**How it works:**
- `feature('LODESTONE')` gates: `registerProtocolModule` loaded conditionally in `backgroundHousekeeping.ts`
- `registerProtocolHandler(claudePath)` called during interactive session init
- GrowthBook gate: `tengu_lodestone_enabled` must be true
- `src/utils/deepLink/registerProtocol.ts` — contains the registration logic
- `src/utils/deepLink/terminalPreference.ts` — companion file, avoids LODESTONE tree-shaking

**Feature flag:** `feature('LODESTONE')` + `tengu_lodestone_enabled` GB gate

**Claudex relevance:** Minimal. Protocol handler registration is a one-time startup task.

---

### 14. EXTRACT_MEMORIES + auto-dream (AutoDream)

**What it is:** Background memory consolidation that runs when enough sessions accumulate since the last consolidation. Fires the `/dream` prompt as a forked subagent to synthesize memories.

**How it works (autoDream.ts):**
- Gate: time since `lastConsolidatedAt` >= `minHours` (default: 24h) AND session count since last consolidation >= `minSessions` (default: 5)
- Config from `tengu_onyx_plover` GrowthBook feature value
- Scan throttle: 10 minute interval to avoid scanning on every turn when time gate passes but session gate doesn't
- Uses `runForkedAgent` (same pattern as extractMemories)
- `buildConsolidationPrompt()` generates the dream prompt
- `tryAcquireConsolidationLock()` / `rollbackConsolidationLock()` prevent parallel consolidations
- `KAIROS_DREAM` flag gates the dream feature specifically within Kairos sessions
- Registers a `DreamTask` visible in the UI (spinning indicator)

**Feature flag:** `isAutoDreamEnabled()` from `services/autoDream/config.ts` — separate from KAIROS_DREAM

**Claudex relevance:** Angel performs equivalent background pattern extraction. CC's autoDream uses markdown files; Claudex uses SQLite + Qdrant. Both could run simultaneously without conflict.

---

### 15. AWAY_SUMMARY — While-You-Were-Away Summary

**What it is:** After the terminal has been blurred for 5 minutes, CC generates a brief summary of what happened while the user was away and injects it as a special message.

**How it works:**
- `useAwaySummary` hook monitors terminal focus state (DECSET 1004 focus tracking)
- 5-minute blur delay before firing
- Fires only when: (a) 5min since blur, (b) no turn in progress, (c) no existing `away_summary` since last user message
- `generateAwaySummary(messages, signal)` produces the summary text
- Injected as `createAwaySummaryMessage()` — subtype `away_summary`
- GrowthBook gate: `tengu_sedge_lantern` (3P default: false)
- Focus state `'unknown'` (terminal doesn't support DECSET 1004) is a no-op

**Feature flag:** `feature('AWAY_SUMMARY')` + `tengu_sedge_lantern` GB gate

**Claudex relevance:** Away summaries are injected as system messages. Claudex's conversation capture (PostToolUse, Stop hooks) would not capture these since they're injected client-side, not from the model. No conflict.

---

### 16. UPSTREAMPROXY — CCR Container Proxy

**What it is:** When running inside a CCR session container, sets up a local HTTPS proxy relay that MITMs outbound HTTPS and injects auth headers. Includes security hardening via `prctl(PR_SET_DUMPABLE, 0)`.

**How it works (upstreamproxy.ts):**
- Activates only when `CLAUDE_CODE_REMOTE=1` AND `CCR_UPSTREAM_PROXY_ENABLED=1` (injected by CCR server-side)
- Reads session token from `/run/ccr/session_token`
- `setNonDumpable()`: calls `prctl(PR_SET_DUMPABLE, 0)` via `bun:ffi` → `libc.so.6` to block same-UID ptrace (prevents prompt injection via `gdb -p $PPID` scraping the token from heap)
- Downloads CCR's CA cert and concatenates with system bundle for cross-runtime trust
- Starts a local CONNECT→WebSocket relay on a random port
- Unlinks the token file after relay confirms up (token remains heap-only)
- Exposes `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` env vars for all subprocess inheritance
- NO_PROXY list excludes: anthropic.com (3 forms), github.com, npmjs.org, pypi.org, crates.io, proxy.golang.org, localhost, RFC1918 ranges, IMDS range
- Fails open: any error logs a warning and disables the proxy — never breaks the session

**Feature flag:** Environment variables (not bun:bundle feature flag)

**Claudex relevance:** Claudex hooks run as subprocesses of CC. They would inherit `HTTPS_PROXY` from the proxy env, which is intentional — their outbound traffic would route through the MITM proxy. Since Claudex calls Ollama locally (localhost is in NO_PROXY), this is not an issue. SQLite writes are local and unaffected.

---

### 17. VOICE_MODE — Voice Input

**What it is:** Voice input via speech-to-text, allowing users to speak to CC rather than type.

**How it works:**
- `isVoiceModeEnabled()` in `src/voice/voiceModeEnabled.ts`
- `/voice` slash command available when enabled
- `VoiceModeNotice` renders in the logo area to notify users when voice is available
- `normalizeLanguageForSTT()` in `useVoice.ts` — language normalization for STT provider
- `voiceEnabled: true` setting in user config opts in
- Notice shown max N times (`MAX_SHOW_COUNT` threshold)
- `src/voice/` directory contains only `voiceModeEnabled.ts` (single file)

**Feature flag:** `feature('VOICE_MODE')` + settings opt-in

**Claudex relevance:** Voice input is converted to text before being sent to the model. Claudex's UserPromptSubmit hook captures the text (`prompt` field), so voice input is automatically captured identically to typed input.

---

### 18. TRANSCRIPT_CLASSIFIER + BASH_CLASSIFIER — Auto Permission Classifiers

**What it is:** Two classifiers that automatically determine permission decisions. `TRANSCRIPT_CLASSIFIER` uses conversation transcript context. `BASH_CLASSIFIER` specifically handles Bash command permission decisions.

**How it works:**
- Both classifiers use system prompts from `src/yolo-classifier-prompts/` (currently empty in research build — prompts are ant-only content)
- Three prompt files: `auto_mode_system_prompt.txt`, `permissions_anthropic.txt`, `permissions_external.txt`
- `TRANSCRIPT_CLASSIFIER` — 107 usages, heavily integrated into the permission system
- `BASH_CLASSIFIER` — 45 usages, specific to Bash tool permission decisions
- Integration points: `components/permissions/hooks.ts`, `hooks/toolPermission/handlers/`, `hooks/useCanUseTool.tsx`
- The classifier produces a decision that routes to different permission handlers
- `coordinatorHandler.ts`, `interactiveHandler.ts`, `swarmWorkerHandler.ts` — different handler types per session mode

**Feature flag:** `feature('TRANSCRIPT_CLASSIFIER')`, `feature('BASH_CLASSIFIER')`

**Claudex relevance:** These classifiers determine whether tool calls are auto-approved. Claudex's PreToolUse hook fires before the classifier check in some paths. If a classifier approves a tool, the hook can still observe and record it.

---

### 19. native-ts — Pure TypeScript NAPI Port

**What it is:** Pure TypeScript ports of native Node.js addon (NAPI) modules. Currently contains `color-diff`, `file-index`, and `yoga-layout`.

**file-index/index.ts** — Complete TypeScript reimplementation of the Rust `file-index-napi` module (backed by Nucleo, a Helix editor fuzzy matcher):
- Implements the same API: `FileIndex.loadFromFileList()`, `FileIndex.search()`
- Nucleo-style scoring: SCORE_MATCH=16, boundary bonuses, camelCase bonuses, gap penalties
- Async variant with event loop yielding every 4ms (CHUNK_MS) for large indexes
- Bitmap-accelerated character pre-filter: 26-bit bitmap for a-z characters, O(1) rejection
- Top-k heap with threshold pruning — avoids full O(n log n) sort
- Smart case: lowercase query → case-insensitive; any uppercase → case-sensitive
- Test penalty: paths containing "test" get 1.05x score penalty
- Top-level cache: 100-entry cache for empty queries (returns directory roots)

**color-diff/index.ts** — Port of `color-diff-napi` (>10K tokens, not read in full)

**yoga-layout/** — Port of `yoga-layout-napi` (Facebook's flexbox layout engine)

**Purpose:** These ports allow the buildable/research build to run without native NAPI binaries. Production builds use the native modules for performance.

**Claudex relevance:** No direct relevance. FileIndex is used for quick file search in the CC UI. The TS port confirms CC uses nucleo-style fuzzy matching for file navigation.

---

### 20. moreright — Internal Right-Panel Hook

**What it is:** An internal (ant-only) hook for the "more right" panel — a second panel displayed to the right of the main terminal UI. The buildable repo contains only a stub.

**How it works (stub interface):**
- `useMoreRight({ enabled, setMessages, inputValue, setInputValue, setToolJSX })`
- Returns: `{ onBeforeQuery, onTurnComplete, render }`
- `onBeforeQuery` — fires before each user query, returns boolean (can cancel)
- `onTurnComplete` — fires after each complete turn
- `render` — renders the right panel content
- The stub returns no-ops and `null` render
- Comment: "Stub for external builds — the real hook is internal only"

**Feature flag:** Not feature-gated, but the implementation is internal only

**Claudex relevance:** The right panel hook intercepts queries and turn completions — exactly what Claudex's hooks do at the OS level. The internal implementation is invisible to Claudex, but they operate on the same events.

---

### 21. stubs/ant-packages — Internal Package Stubs

The `src/stubs/ant-packages/` directory provides empty stubs for ant-internal npm packages:

- `@ant/` — Ant-internal packages
- `@anthropic-ai/` — Anthropic internal SDKs (beyond the public SDK)
- `@aws-sdk/` — AWS SDK (for Bedrock)
- `@azure/` — Azure SDK (for Vertex/Azure)
- `@opentelemetry/` — OpenTelemetry for tracing
- `audio-capture-napi` — Native audio capture for voice mode
- `color-diff-napi` — Native color diff (replaced by native-ts port)
- `modifiers-napi` — Native keyboard modifiers
- `sharp` — Image processing
- `turndown` — HTML-to-markdown

**Claudex relevance:** The presence of `audio-capture-napi` confirms voice input uses a native audio capture module. `@opentelemetry/` suggests CC has internal tracing infrastructure. These are invisible at runtime for Claudex.

---

### 22. CACHED_MICROCOMPACT — Prompt Cache-Aware Compaction

**What it is:** A compaction strategy that uses prompt cache metadata to make smarter decisions about what to compact, preserving cache-hit-maximizing message sequences.

**How it works:**
- `feature('CACHED_MICROCOMPACT')` gates a require in `src/cachedMicrocompact.ts` (currently a stub)
- `isCachedMicrocompactEnabled()` in `services/compact/cachedMicrocompact.ts`
- `getCachedMCConfig()` loaded conditionally in `constants/prompts.ts`
- The microCompact service checks for cached MC module and calls `cachedMicrocompactPath()` when enabled
- `getPinnedCacheEdits()` returns cache edits that should be preserved
- Works with the `CachedMCState` and `CacheEditsBlock` types

**Feature flag:** `feature('CACHED_MICROCOMPACT')` — ant-only

**Claudex relevance:** Claudex's session memory operates at the DB level, not the prompt cache level. No conflict. Claudex's context injection (injected as system_reminder attachments) remains unaffected by microcompaction strategy.

---

### 23. EXPERIMENTAL_SKILL_SEARCH — Automatic Skill Discovery

**What it is:** A `DiscoverSkillsTool` that lets the model search for relevant skills mid-task. Complemented by automatic skill surfacing each turn.

**How it works:**
- `feature('EXPERIMENTAL_SKILL_SEARCH')` gates `DISCOVER_SKILLS_TOOL_NAME` in `tools/DiscoverSkillsTool/prompt.ts`
- Skills are auto-surfaced as "Skills relevant to your task:" system-reminder attachments each turn
- `DiscoverSkillsTool` for on-demand search when surfaced skills don't cover the next action
- `skillSearchFeatureCheck` module loaded conditionally — `isSkillSearchEnabled()`
- System prompt guidance: "If you're about to do something those don't cover — a mid-task pivot, an unusual workflow, a multi-step plan — call DiscoverSkills with a specific description of what you're doing."

**Feature flag:** `feature('EXPERIMENTAL_SKILL_SEARCH')` + `isSkillSearchEnabled()`

**Claudex relevance:** Claudex's experience patterns (injected as system_reminder) are a parallel mechanism to skill surfacing. The CC skill search operates on locally installed skill files; Claudex patterns come from the DB. No conflict — both can be injected simultaneously.

---

### 24. RemoteTriggerTool — Scheduled Remote Agent Management

**What it is:** A tool (not a CLI command) that lets the model itself manage scheduled remote CC agents via the claude.ai CCR triggers API.

**How it works:**
- Defined in `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts` — fully implemented
- Actions: `list`, `get`, `create`, `update`, `run`
- Enabled when: `tengu_surreal_dali` GB feature is true AND `isPolicyAllowed('allow_remote_sessions')`
- Uses claude.ai OAuth token automatically (no shell exposure)
- Beta header: `ccr-triggers-2026-01-30`
- API base: `/v1/code/triggers`
- `shouldDefer: true` — deferred execution (user approval required by default)
- The model can manage its own scheduled jobs: create cron-style triggers, check their status, manually run them

**Feature flag:** `tengu_surreal_dali` GB feature + policy

**Claudex relevance:** Claudex's schedule skill creates GitHub Actions-based triggers. The `RemoteTriggerTool` creates CCR-native triggers. These are parallel scheduling mechanisms. Claudex could potentially inspect CCR triggers via this tool if it had access to it.

---

## Summary: What Claudex Can Leverage

| Feature | Claudex Can Leverage? | How |
|---|---|---|
| KAIROS (Assistant Mode) | Yes | Hooks fire normally in assistant sessions; Brief tool PostToolUse captures model→user messages |
| SendUserMessage / Brief | Yes | PostToolUse hook captures `tool_response` from Brief calls (correct field per payload truth table) |
| COORDINATOR_MODE | Yes | PreToolUse injects context into each worker via Claudex's existing subagent injection hook |
| FORK_SUBAGENT | Yes | Fork children inherit parent system prompt including Claudex-injected context |
| VERIFICATION_AGENT | Yes | Verification agent's tool calls fire hooks; outcomes could be captured as Claudex learnings |
| EXTRACT_MEMORIES | Neutral | Parallel system (markdown files vs SQLite); no conflict, both run |
| TEAMMEM | Neutral | Filesystem-based shared memory vs Claudex's DB; parallel systems |
| BRIDGE_MODE | Yes | Bridge sessions receive hook injections; Brief tool attachment works normally |
| BUDDY | Neutral | Companion intro captured as attachment by PostToolUse extractor |
| AWAY_SUMMARY | No | Injected client-side, not from model; not capturable via hooks |
| UPSTREAMPROXY | Neutral | NO_PROXY includes localhost; Ollama calls unaffected |
| VOICE_MODE | Yes | Voice→text conversion happens before UserPromptSubmit hook fires |
| TRANSCRIPT_CLASSIFIER | Neutral | Classifier runs before Claudex gets the decision result |
| native-ts FileIndex | No | Internal UI performance; irrelevant to Claudex |
| ULTRAPLAN | No | Remote CCR session; hooks don't fire on remote side |
| VERIFICATION_AGENT | Yes | The mandatory verification gate creates structured PASS/FAIL outcomes Claudex could track as patterns |

**Key conflicts:** None identified. The feature flag system is designed for DCE — flags disabled in a build are effectively absent. Claudex hooks operate at the OS/process level and are unaffected by internal CC feature states.

**Key opportunity:** The `VERIFICATION_AGENT` feature, when active, creates structured verification outcomes (PASS/FAIL/PARTIAL with specific command output). Claudex's `solution_outcomes` table and pattern extraction could learn from these outcomes if the Stop hook extracts the verifier's verdict from the final `last_assistant_message`.
