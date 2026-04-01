# CC Skills, Background Features & Angel Overlap Analysis

**Date:** 2026-04-01
**Scope:** Survey of ALL CC built-in skills, background intelligence systems, and features that overlap with or complement Angel's responsibilities.
**Primary source:** `claude-code-buildable/src/`

---

## 1. Skills System Overview

### How CC Skills Work

CC has a two-tier skill system:

1. **Bundled skills** — shipped with the CLI binary. Defined in `src/skills/bundled/`. Registered at startup via `initBundledSkills()`. Each exports a `registerBundledSkill()` call with a prompt, description, allowed tools, and optional `isEnabled` predicate.

2. **User/project skills** — markdown files at `~/.claude/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md`. Loaded dynamically at runtime.

Skills are invoked via the `Skill` tool by the model when the `when_to_use` description matches the user's intent, or directly by the user as `/skill-name [args]`.

---

## 2. Bundled Skills — Complete Inventory

### 2.1 `/update-config` (updateConfig.ts)
**Always available**

**What it does:** Guides the model to read and merge-update `settings.json` files (user/project/local). Contains comprehensive documentation on all settings fields (permissions, env vars, model, hooks, MCP, plugins). Crucially, includes a HOOK VERIFICATION FLOW — a 7-step procedure to construct, test, and prove hooks fire correctly.

**Feature flag:** None. Always registered.

**Angel overlap:** None direct. The hooks CC can configure include the Claudex hooks (PreToolUse injection, Stop hook for session-end processing). This skill is what a user would invoke to configure Angel-adjacent hooks.

**Can Angel use this?** No — Angel does not interact with Claude's settings.json.
**Conflict?** No.
**Angel can learn from:** The hook verification flow is a rigorous pattern Angel could adopt when validating its own hook outputs.

---

### 2.2 `/keybindings-help` (keybindings.ts)
**Feature flag:** `isKeybindingCustomizationEnabled()` (settings-based gate)
**`userInvocable: false`** — auto-invoked only

**What it does:** Guides keybinding customization in `~/.claude/keybindings.json`. Pure UX configuration tool.

**Angel overlap:** None.

---

### 2.3 `/verify` (verify.ts)
**Feature flag:** `USER_TYPE === 'ant'` (ant-employees only)
**What it does:** Stub with a SKILL.md. Invokes a verification subagent. Content is mostly placeholder per the read (`# Stub`).

**Angel overlap:** CC has a full `VERIFICATION_AGENT` (see §4.1) that is separate and more developed. This skill wraps it for ant users.

---

### 2.4 `/debug` (debug.ts)
**Always available**

**What it does:** Enables debug logging for the current session, reads the last 20 lines of the debug log at `~/.claude/debug/<session-id>.txt`, and guides debugging of CC session issues. Uses `disableModelInvocation: true` so it only fires on explicit user request.

**Angel overlap:** Angel's session monitoring does health-checking. CC's `/debug` is reactive (user-triggered) while Angel is proactive. Angel could learn to surface debug log paths when it detects stuck sessions.

**Can Angel use this?** Not directly — Angel doesn't invoke skills. But Angel could read debug logs directly when monitoring sessions.

---

### 2.5 `/lorem-ipsum` (loremIpsum.ts)
**What it does:** Generates placeholder text. No Angel relevance.

---

### 2.6 `/skillify` (skillify.ts)
**Feature flag:** `USER_TYPE === 'ant'` (ant-employees only)

**What it does:** Captures the current session's repeatable process into a reusable skill. Uses `getSessionMemoryContent()` and `getMessagesAfterCompactBoundary()` to read the session. Conducts a multi-round interview with the user via `AskUserQuestion`, then writes a `SKILL.md` with frontmatter, steps, success criteria, and `when_to_use` descriptions.

**Angel overlap:** Angel extracts patterns from conversations. `/skillify` does structured pattern capture interactively. These are complementary — Angel extracts implicitly; `/skillify` extracts explicitly with user guidance.

**Can Angel use this?** Not directly. But Angel's pattern extraction (experience-patterns system) and `/skillify`'s interactive process could feed each other: Angel detects a repeatable pattern → suggests the user run `/skillify`.

**Can Angel improve from this approach?** Yes. The step-by-step interview pattern (`success_criteria` per step, `when_to_use` trigger phrases, explicit parallelism tagging) is highly structured. Angel's pattern extraction could adopt similar structured output.

---

### 2.7 `/remember` (remember.ts)
**Feature flag:** `USER_TYPE === 'ant'` AND `isAutoMemoryEnabled()`

**What it does:** Reviews the user's memory landscape across all layers (CLAUDE.md, CLAUDE.local.md, auto-memory). Classifies each auto-memory entry into: CLAUDE.md (project conventions), CLAUDE.local.md (personal prefs), team memory, or "stay in auto-memory." Also detects duplicates, outdated entries, and conflicts across layers. **Proposes all changes before making any.**

**Angel overlap:** This is the most direct overlap with Angel's proactive curation and retention sweep responsibilities.

- CC `/remember`: User-triggered, interactive, reviews file-based memdir entries, promotes to CLAUDE.md
- Angel retention sweep: Background, automated, prunes DB observations, no interaction

**Key differences:**
- CC operates on file-based markdown memories; Angel operates on SQLite observations
- CC promotes to CLAUDE.md; Angel has no equivalent (Angel promotes patterns to always-inject)
- CC is manual; Angel runs on schedule

**Can Angel use this?** Not directly — different storage backends. But the classification taxonomy (user/feedback/project/reference memories) directly maps to Claudex observation types.

**Can Angel improve from this?** The conflict detection logic (cross-layer contradiction checking, temporal ordering) is a strong pattern. Angel's retention sweep could adopt similar conflict resolution before pruning.

---

### 2.8 `/simplify` (simplify.ts)
**Always available**

**What it does:** Launches 3 parallel review subagents (code reuse, code quality, efficiency) on the current git diff. Aggregates findings and applies fixes. Uses the `Agent` tool for parallelism.

**Angel overlap:** None direct. This is a code quality workflow.

---

### 2.9 `/batch` (batch.ts)
**Always available** (git-repo check gates usage)

**What it does:** Orchestrates large-scale parallelizable changes. Phase 1: research + decompose into 5–30 independent worktree units. Phase 2: spawn all workers in parallel with `isolation: "worktree"`. Phase 3: track progress and aggregate PRs.

**Angel overlap:** None direct. This is a parallel execution coordination skill.

---

### 2.10 `/stuck` (stuck.ts)
**Feature flag:** `USER_TYPE === 'ant'`

**What it does:** Investigates frozen/slow CC sessions. Scans for other CC processes, checks CPU/RSS/state/zombie patterns, reads debug logs, and posts diagnostic reports to `#claude-code-feedback` Slack. Explicitly **does not kill processes** — diagnostic only.

**Angel overlap:** Angel's session monitoring and heartbeat system does similar health monitoring. Key differences:

| Aspect | CC `/stuck` | Angel |
|---|---|---|
| Trigger | User-invoked | Background heartbeat |
| Scope | All CC sessions on machine | Only Claudex-registered sessions |
| Detection | Process state, CPU, RSS | DB heartbeat timestamps |
| Action | Report to Slack (ant-only) | Idle warnings to user |
| Target | Ant-internal feedback | User alerts |

**Can Angel use this approach?** Yes. The process-state inspection approach (checking D/T/Z states, child processes, debug log tails) is more diagnostic than Angel's heartbeat-timeout approach. Angel could combine both: heartbeat timeout → trigger process inspection → better idle warning content.

---

### 2.11 `/dream` (dream.ts stub → bundled/dream.ts)
**Feature flag:** `feature('KAIROS') || feature('KAIROS_DREAM')`

**What it does:** The KAIROS-mode memory consolidation skill. In KAIROS mode (persistent assistant), instead of maintaining MEMORY.md live, the agent appends to daily log files. `/dream` consolidates those logs into organized topic files + MEMORY.md index. This is the user-invocable version; `autoDream` is the background version.

The consolidation prompt (in `consolidationPrompt.ts`) has 4 phases:
1. Orient — read current memory state
2. Gather recent signal — daily logs, drifted facts, transcript grep
3. Consolidate — merge new signal into topic files, fix dates, delete contradictions
4. Prune and index — keep MEMORY.md under 200 lines/25KB

**Angel overlap:** This is the CLOSEST CC feature to Angel's full responsibility set. Direct comparison:

| Aspect | CC autoDream/dream | Angel |
|---|---|---|
| Storage | File-based markdown (memdir) | SQLite DB |
| Trigger | 24h time gate + 5 session minimum | Session end + scheduled pattern extraction |
| Pattern extraction | Reads logs/transcripts | Reads full conversations |
| Output | MEMORY.md + topic files | observations, patterns, CARA opinions |
| Entity resolution | None | entity_aliases table |
| Cross-session | Via shared memdir directory | Via shared claudex.db |
| Classification | User/feedback/project/reference | Type field on observations |
| Retention | Manual (dream decides) | Automated sweep with scoring |

**Can Angel use this approach?** Partially. The 4-phase consolidation prompt structure is well-designed. Angel's pattern extraction could adopt the "orient → gather → consolidate → prune" structure explicitly.

**Can Angel improve from this?** The log-first/consolidate-later pattern (KAIROS daily logs → dream consolidation) is excellent for long-lived sessions. Claudex already does this with the SQLite append pattern, but the explicit consolidation phase is worth formalizing.

---

### 2.12 `/hunter` (hunter.ts stub)
**Feature flag:** `feature('REVIEW_ARTIFACT')`

**What it does:** Stub — content is `export default {}`. This skill exists behind `REVIEW_ARTIFACT` but has no shipped implementation accessible in external builds. Based on the feature name, it likely performs code review artifact collection/analysis.

**Angel overlap:** Unknown — stub provides no information.

---

### 2.13 `/loop` (loop.ts)
**Feature flag:** `feature('AGENT_TRIGGERS')`

**What it does:** Schedules a recurring prompt via `CRON_CREATE_TOOL_NAME`. Parses interval + prompt from args (`5m /babysit-prs`), converts to cron expression, creates a trigger, then immediately executes the prompt once. Auto-expires after 30 days.

**Angel overlap:** Angel has no built-in scheduling. The `/loop` skill provides exactly what would be needed for recurring Angel-like tasks (e.g., `/loop 1h /check-session-health`). Angel's idle detection is event-driven (heartbeat timeout), not scheduled.

**Can Angel use this?** Not directly (Angel is a separate process). But users could `/loop` Angel-related commands.

---

### 2.14 `/schedule` (scheduleRemoteAgents.ts)
**Feature flag:** `feature('AGENT_TRIGGERS_REMOTE')` + GrowthBook `tengu_surreal_dali` + OAuth auth

**What it does:** Creates/updates/lists/runs **remote** scheduled Claude agents (CCR — Claude Code Remote). Each trigger spawns an isolated cloud agent on a cron schedule (minimum 1 hour interval). Handles environment management, MCP connector wiring, git repo attachment.

**Angel overlap:** None — this is Anthropic cloud infrastructure, not local process management.

---

### 2.15 `/claude-api` (claudeApi.ts)
**Feature flag:** `feature('BUILDING_CLAUDE_APPS')`

**What it does:** Comprehensive reference for building apps with the Claude API / Agent SDK. Contains language-specific guides (Python, TypeScript, Go, Java, etc.) with patterns for streaming, tool use, batches, files API, prompt caching.

**Angel overlap:** None.

---

### 2.16 `/claude-in-chrome` (claudeInChrome.ts)
**Feature flag:** `shouldAutoEnableClaudeInChrome()`

**What it does:** Browser automation via Chrome extension MCP tools. Activates `mcp__claude-in-chrome__*` tools.

**Angel overlap:** None.

---

## 3. Background Intelligence Systems

### 3.1 Extract Memories (EXTRACT_MEMORIES feature)
**Files:** `src/services/extractMemories/extractMemories.ts`, `prompts.ts`
**Feature flag:** `feature('EXTRACT_MEMORIES')` + GrowthBook `tengu_passport_quail`

**What it does:** Fires at the end of each complete query loop (when the model produces a final response with no tool calls). Runs as a **forked agent** — perfect fork of the main conversation that shares the parent's prompt cache.

The extraction agent:
- Gets a manifest of existing memory files (pre-injected, no `ls` turn needed)
- Is given the last N new messages since the last extraction cursor
- Can read/grep/glob freely but can only Write/Edit within `~/.claude/projects/<path>/memory/`
- Must complete in ≤5 turns (read all → write all)
- Skips if the main agent already wrote to memory in this turn

Memory taxonomy: user / feedback / project / reference. Each memory is a markdown file with YAML frontmatter (`name`, `description`, `type`). `MEMORY.md` is an index (max 200 lines).

**Angel overlap:** This is the CC equivalent of Angel's pattern extraction, but for the file-based memdir system. Full comparison:

| Aspect | CC extractMemories | Angel pattern extraction |
|---|---|---|
| Trigger | Every conversation turn end (when gate open) | Session end, scheduled |
| Storage | File-based markdown | SQLite observations + Qdrant |
| Scope | Current session only | Cross-session |
| Classification | 4 types (user/feedback/project/reference) | Typed observations |
| Dedup | "check before writing" instruction | DB-level dedup |
| Turn budget | Hard 5-turn cap | No hard cap |
| Cache sharing | Yes — forked agent reuses parent cache | No cache sharing |
| Extraction signal | Recent N messages | Full conversation transcript |

**Key insight:** CC's forked-agent pattern for extraction is highly efficient because it shares the parent's prompt cache (avoiding cold-start token costs). Claudex hooks do not use this pattern — each hook is an ephemeral Node.js process with no cache sharing.

**Can Angel learn from this?** Yes. The "inject memory manifest pre-turn to avoid `ls` overhead" optimization and the "cursor-based incremental extraction" (only new messages since last run) are both excellent engineering patterns.

---

### 3.2 Auto Dream (autoDream.ts)
**Files:** `src/services/autoDream/autoDream.ts`, `consolidationPrompt.ts`, `config.ts`, `consolidationLock.ts`
**Feature flag:** GrowthBook `tengu_onyx_plover` (configuration) + `isAutoDreamEnabled()`

**What it does:** Background memory consolidation that fires automatically every 24h if ≥5 sessions have accumulated since last consolidation. Uses a file-based lock (`consolidationLock.ts`) to prevent concurrent runs across processes. Runs as a forked agent with read-only Bash + memory-dir write permissions.

Scheduling logic:
1. Check time gate (hours since `lastConsolidatedAt`)
2. Scan throttle (don't re-scan sessions if checked <10m ago)
3. Session count gate (≥minSessions since last consolidation)
4. Acquire lock
5. Fire forked consolidation agent
6. On failure: rollback lock mtime so time gate passes again next turn

**Angel overlap:** This is the closest CC equivalent to Angel's multi-session pattern consolidation. The lock-based coordination prevents concurrent runs — similar to Angel's singleton process model.

**Key difference:** CC autoDream operates on file-based memdir; Angel operates on SQLite. CC uses time+session gates; Angel uses event-driven scheduling.

**Can Angel learn from this?** The scan throttle pattern (don't re-scan within 10m even if time gate passes) is smart for high-frequency turn hooks. Angel's per-session heartbeat could use similar throttling.

---

### 3.3 Session Memory (SessionMemory)
**Files:** `src/services/SessionMemory/sessionMemory.ts`, `sessionMemoryUtils.ts`, `prompts.ts`
**Feature flag:** GrowthBook `tengu_session_memory` (must be true AND `isAutoCompactEnabled()`)

**What it does:** Automatically maintains a structured markdown file per session at a temp path. Extracts key information from the conversation periodically (threshold: context window token growth + tool call count). Used as the basis for **SM-Compact** (session memory compaction) — instead of running a full summarization API call on compaction, uses the pre-built session memory as the summary.

Update thresholds (configurable via GrowthBook `tengu_sm_config`):
- `minimumMessageTokensToInit`: tokens before first extraction
- `minimumTokensBetweenUpdate`: token growth between updates
- `toolCallsBetweenUpdates`: tool call count between updates

The extraction is serialized (`sequential` wrapper) — only one extraction runs at a time. Trailing extractions stash the latest context and run after the current one completes.

**Angel overlap:** Angel does not have a within-session accumulating summary. CC's Session Memory is a within-session running summary; Angel's observations are cross-session persistent knowledge. They are complementary rather than competing.

**Key insight for Angel:** Session Memory is used as the compaction summary — this means CC's compaction is no longer "compress the whole conversation" but "use the pre-built incremental summary." This is architecturally cleaner. Claudex's own compaction integration (if any) could adopt this.

---

### 3.4 Auto Dream Session Memory Compaction (SM_COMPACT)
**Files:** `src/services/compact/sessionMemoryCompact.ts`
**Feature flag:** GrowthBook `tengu_session_memory` + `tengu_sm_compact`

**What it does:** When compaction triggers, instead of calling the API to summarize, uses the Session Memory file as the summary. Calculates which messages to keep (config-controlled min/max token budget, preserving tool_use/tool_result pairs). Merges session memory content into the compact boundary marker.

**Angel overlap:** None direct. This is CC-internal compaction plumbing.

---

### 3.5 Away Summary (AWAY_SUMMARY feature)
**Files:** `src/hooks/useAwaySummary.ts`, `src/services/awaySummary.ts`
**Feature flag:** `feature('AWAY_SUMMARY')` + GrowthBook `tengu_sedge_lantern`

**What it does:** When the terminal is blurred for 5 minutes and a turn ends, generates a 1-3 sentence "while you were away" recap using a small fast model (no tool calls). The recap reads session memory for broader context, then summarizes the last 30 messages. Appended as a visible system message when the user returns.

**Angel overlap:** Angel's idle detection and messaging is the closest analog, but the mechanisms differ:

| Aspect | CC Away Summary | Angel idle detection |
|---|---|---|
| Trigger | Terminal blur for 5min | Heartbeat timeout |
| Content | 1-3 sentence recap | Idle warning message |
| Target | Same session UI | Cross-session notification |
| Context | Last 30 messages + session memory | Session metadata |

**Can Angel learn from this?** Yes. Using terminal focus state as a signal for "user is gone" is clever. If Claudex could detect terminal focus, Angel's idle warnings would be more precise (not firing when the user is actively watching).

---

### 3.6 Magic Docs (magicDocs.ts)
**Files:** `src/services/MagicDocs/magicDocs.ts`, `prompts.ts`
**Feature flag:** `USER_TYPE === 'ant'`

**What it does:** When a file is read that starts with `# MAGIC DOC: <title>`, registers it as a "magic doc." At the end of each assistant turn (when no tool calls are in progress), runs a background agent that re-reads the file and updates it with new learnings from the conversation. Only allows Edit on the specific magic doc file.

This is a **living documentation** pattern — files that auto-update themselves as the session progresses.

**Angel overlap:** This is highly relevant to Claudex. CC's MAGIC DOC pattern is essentially what Angel does for CLAUDE.md injection — but bidirectional. A MAGIC DOC file can be `context/checkpoints/latest.yaml` equivalent that updates itself.

**Can Angel use this?** Directly — if Claudex-managed files had `# MAGIC DOC:` headers, CC would auto-update them. This could be used to keep session primers and context files current without explicit hooks.

**Conflict?** Potential: if Angel writes to a file and CC's Magic Docs also writes to the same file, there could be conflicts. Need coordination.

---

### 3.7 Agent Summary (AgentSummary)
**Files:** `src/services/AgentSummary/agentSummary.ts`
**Always active when coordinator mode has running subagents**

**What it does:** Every 30 seconds, forks the sub-agent's conversation to generate a 3-5 word present-tense summary of what the agent is currently doing ("Reading runAgent.ts", "Fixing null check in validate.ts"). Displayed in the coordinator UI. Uses the same cache-safe params as the parent to share prompt cache.

**Angel overlap:** Angel's session monitoring tracks what sessions are doing, but at a coarser level (session status, not current action). The 30s interval and fork-for-cache pattern is similar to what Angel could use for real-time session status updates.

**Can Angel learn from this?** The "fork for cache sharing" pattern for monitoring is key. If Angel generated summaries of active sessions using a forked conversation with cache sharing, it would be dramatically cheaper than cold API calls.

---

### 3.8 Skill Improvement (skillImprovement.ts)
**Files:** `src/utils/hooks/skillImprovement.ts`
**Feature flag:** `feature('SKILL_IMPROVEMENT')` + GrowthBook `tengu_copper_panda`

**What it does:** A post-sampling hook that runs every 5 user messages when a project skill is active. Analyzes recent messages for user preferences and corrections that should be permanently added to the skill definition. Detects patterns like "can you also ask me X", "don't do Z", "always use Y". 

Outputs structured JSON: `[{section, change, reason}]`. When updates are detected, calls `applySkillImprovement()` (a side-channel LLM call) to rewrite the SKILL.md file.

**Angel overlap:** This is the CC equivalent of Angel's CARA reasoning (forming opinions from user feedback). Key differences:

| Aspect | CC Skill Improvement | Angel CARA |
|---|---|---|
| Scope | Corrections during skill execution | Cross-session opinion formation |
| Target | Specific SKILL.md file | angel_opinions DB table |
| Detection | Pattern matching on user messages | LLM reasoning over session patterns |
| Application | Rewrites SKILL.md immediately | Injects opinions into context |
| Feedback loop | User corrections → skill update | Corrections → opinion → injection |

**Can Angel learn from this?** Yes — the detection prompt is concise and well-structured. Angel's correction detection could use a similar approach (batch every N turns instead of real-time classification).

---

### 3.9 Prompt Suggestion (promptSuggestion.ts)
**Files:** `src/services/PromptSuggestion/promptSuggestion.ts`
**Feature flag:** GrowthBook `tengu_chomp_inflection` + setting `promptSuggestionEnabled`

**What it does:** After each assistant response, generates a short (2-12 word) prediction of what the user would naturally type next. Runs as a forked agent sharing the parent's prompt cache. Displays as a ghost/suggestion in the input field.

Filtering pipeline: removes evaluative text, Claude-voice text, meta-reasoning, too long/short suggestions, multiple sentences, markdown formatting.

Also triggers **speculation** (a pre-computation of the assistant's next response if the suggestion is accepted).

**Angel overlap:** None direct. This is a UI/UX feature. No Angel equivalent.

---

### 3.10 Memory Relevance System (findRelevantMemories.ts)
**Files:** `src/memdir/findRelevantMemories.ts`, `memoryScan.ts`
**Feature flag:** Part of `isAutoMemoryEnabled()`

**What it does:** When a user message arrives, scans memory file frontmatter (parallel `readFileInRange` on first 30 lines of each .md file), then calls Sonnet to select ≤5 most relevant memories for the current query. Filters already-surfaced memories to avoid redundancy. Also considers `recentTools` to avoid surfacing reference docs for tools already in use.

**Angel overlap:** This is the CC equivalent of Claudex's hybrid retrieval system, but file-based. Key comparison:

| Aspect | CC findRelevantMemories | Claudex hybrid retrieval |
|---|---|---|
| Storage | Markdown files with frontmatter | SQLite + Qdrant (5 collections) |
| Selection | LLM classifier (Sonnet) | 5-channel RRF (BM25, semantic, recency, etc.) |
| Limit | 5 memories | Configurable |
| Context | Query + recent tools | Query + session context |
| Freshness | mtime-sorted input | Recency channel |
| Dedup | alreadySurfaced set | No explicit dedup |

**Can Angel learn from this?** The "filter recently-surfaced to not repeat" pattern is good for multi-turn injections. The "exclude tool reference docs when tool is actively in use" heuristic is clever and reduces noise.

---

### 3.11 Session Memory Relevance (loadMemoryPrompt / buildMemoryLines)
**Files:** `src/memdir/memdir.ts`
**Feature flag:** `isAutoMemoryEnabled()`

**What it does:** The static memory system prompt section. Loads MEMORY.md (max 200 lines / 25KB) into the system prompt. Provides instructions for saving memories in a 4-type taxonomy with frontmatter. In KAIROS mode, switches to daily-log mode (append-only logs, no live MEMORY.md editing). Includes optional `buildSearchingPastContextSection` that teaches the model to grep memory files and session transcripts.

**Angel overlap:** The KAIROS daily-log prompt (`buildAssistantDailyLogPrompt`) is highly relevant — it describes an append-only log that gets nightly consolidation by a separate process. This is architecturally identical to how Claudex works (hooks append to DB → Angel consolidates).

---

## 4. Built-In Agent Types

### 4.1 Verification Agent (VERIFICATION_AGENT)
**Files:** `src/tools/AgentTool/built-in/verificationAgent.ts`
**Feature flag:** None (always available as a built-in agent type)

**What it does:** A dedicated subagent type for verifying implementation work. Key characteristics:
- System prompt explicitly warns against "verification avoidance" (reading code instead of running it)
- Cannot modify project files (temp directory only)
- Must include at least one adversarial probe before PASS
- Required output format: `VERDICT: PASS/FAIL/PARTIAL`
- Has type-specific strategies (frontend, backend, CLI, mobile, data/ML, migrations, refactoring)
- Recognizes and rejects its own rationalizations ("the code looks correct" is not verification)

**Angel overlap:** None direct. This is implementation verification; Angel is memory/pattern/monitoring.

**Can Angel learn from this?** Yes — the adversarial probe requirement before PASS is a strong quality gate. Angel's pattern verification (when promoting patterns to always-inject) could adopt a similar "must attempt to falsify before promoting" requirement.

---

### 4.2 Coordinator Mode Agent (coordinatorMode.ts)
**Files:** `src/coordinator/coordinatorMode.ts`, `workerAgent.ts`
**Feature flag:** `feature('COORDINATOR_MODE')`

**What it does:** A full coordinator+worker orchestration system. The coordinator receives task-notifications from workers via `<task-notification>` XML in user messages. Has detailed synthesis rules ("never delegate understanding to a worker"), continue vs. spawn guidance, and verification requirements.

**Angel overlap:** Angel's cross-session coordination and messaging is conceptually similar but operates at the cross-session level (Angel messages another session). CC's coordinator operates within a single session with subagents.

---

## 5. Classifier Systems (Permission Intelligence)

### 5.1 BASH_CLASSIFIER Feature
**Files:** `src/utils/permissions/bashClassifier.ts` (stub in external build)
**Feature flag:** `feature('BASH_CLASSIFIER')` — ant-internal only

**What it does:** Uses an LLM to semantically classify Bash commands against user-defined allow/deny/ask rules (described in natural language, not regex). Allows rules like "deny: commands that could delete files" instead of exact pattern matching. The full implementation is ant-only; the external build has a stub that always returns `matches: false`.

**Angel overlap:** None — this is permission enforcement, not memory or monitoring.

---

### 5.2 TRANSCRIPT_CLASSIFIER / Auto Mode (yoloClassifier.ts)
**Files:** `src/utils/permissions/autoModeState.ts`, `src/cli/handlers/autoMode.ts`
**Feature flag:** `feature('TRANSCRIPT_CLASSIFIER')` — ant-internal only

**What it does:** An LLM-based classifier that decides whether tool calls should be auto-approved in "auto mode" (unattended operation). The classifier reads the full conversation transcript plus configured allow/deny/environment rules. Users can configure rules via `settings.json`. The `claude auto-mode` CLI subcommand dumps/critiques rules.

`AFK_MODE_BETA_HEADER` is only included in API requests when this feature is active, enabling the beta API behavior.

**Angel overlap:** None direct — permission classification is orthogonal to memory/monitoring.

---

### 5.3 classifierShared.ts
**What it does:** Shared utilities for both classifier systems (tool-use block extraction, response parsing). Infrastructure only.

---

## 6. Job Classification System (TEMPLATES feature)

**Files:** `src/jobs/classifier.ts` (stub in external build)
**Feature flag:** `feature('TEMPLATES')` + `process.env.CLAUDE_JOB_DIR`

**What it does:** When CC runs as a "dispatched job" (via the TEMPLATES system), classifies the state after each turn and writes it to `state.json` in the job directory. This allows `claude list` to show current job status. The full implementation is ant-only.

**Angel overlap:** Angel's session monitoring and cross-agent indexer tracks session state. CC's job classifier writes state for external process consumption. Different levels of the stack.

---

## 7. Post-Sampling Hook Pipeline

**Files:** `src/query/stopHooks.ts`, `src/utils/hooks/postSamplingHooks.ts`

**What it does:** The central coordination point for all background processing after each assistant response. Execution order:

1. Save cache-safe params (for forked agents)
2. Job classification (if in TEMPLATES mode)
3. Prompt suggestion (fire-and-forget)
4. Extract memories (fire-and-forget, if feature enabled)
5. Auto dream (fire-and-forget)
6. Computer use cleanup (if CHICAGO_MCP)
7. Execute Stop hooks (user-configured)
8. TeammateIdle / TaskCompleted hooks (if in teammate mode)

**Angel overlap:** Claudex's Stop hook runs inside this pipeline at step 7 (user-configured Stop hooks). Steps 3-5 (prompt suggestion, extract memories, auto dream) run BEFORE the Stop hook. This means Angel receives a session context that has already had:
- Memories potentially extracted (extract memories may have written new files)
- Auto dream may have consolidated memories (if time/session gates passed)

**Critical implication for Angel:** Angel's Stop hook fires AFTER CC's memory extraction. If CC extracted memories in this turn, Angel should not re-extract the same content. The mutual exclusion logic in CC (checking if main agent wrote memory writes) could inform Angel's own skip logic.

---

## 8. Background Housekeeping (startBackgroundHousekeeping)

**Files:** `src/utils/backgroundHousekeeping.ts`

**What it does:** Called at startup. Initializes:
- `initMagicDocs()` — file read listener for MAGIC DOC headers
- `initSkillImprovement()` — post-sampling hook for skill updates
- `initExtractMemories()` — closes over state, registers post-sampling hook
- `initAutoDream()` — closes over timer state
- `autoUpdateMarketplacesAndPluginsInBackground()` — plugin updates
- `ensureDeepLinkProtocolRegistered()` — OS deep link registration (LODESTONE)
- `cleanupOldMessageFilesInBackground()` — removes transcripts >30 days old
- `cleanupOldVersions()` — old CC version cleanup
- Recurring 24h cleanup (npm cache, old versions) — ant-only

**Angel overlap:** This is where Angel's auto-spawn is triggered (from the CC session-start hook, not from here). The background housekeeping runs cleanup that Angel does not duplicate.

**Note:** `cleanupOldMessageFilesInBackground()` deletes transcripts older than `cleanupPeriodDays` (default 30). If Claudex reads CC transcripts, this creates a 30-day window. Angel's `canonical-session-ir` and cross-agent indexing should be aware of this retention limit.

---

## 9. Synthesis: Angel vs CC Feature Map

| CC Feature | Angel Equivalent | Relationship |
|---|---|---|
| extractMemories | Pattern extraction | Parallel (different storage) |
| autoDream | Session consolidation | Parallel (different storage) |
| Session Memory | Session state tracking | Complementary (within-session vs cross-session) |
| findRelevantMemories | Hybrid retrieval | Parallel (LLM vs BM25+semantic) |
| SM-Compact | Compaction integration | CC-internal, Angel not involved |
| Away Summary | Idle warning | Complementary (same-session vs cross-session) |
| Magic Docs | CLAUDE.md live update | Potentially conflicting (both write files) |
| Skill Improvement | CARA reasoning | Parallel (skill-specific vs general) |
| Agent Summary | Session monitoring | Parallel (subagent vs session level) |
| Prompt Suggestion | None | No Angel equivalent |
| /remember | Retention sweep | Complementary (manual vs automated) |
| /skillify | Pattern extraction | Complementary (interactive vs background) |
| /stuck | Session monitoring | Complementary (reactive vs proactive) |
| BASH_CLASSIFIER | None | No Angel equivalent |
| TRANSCRIPT_CLASSIFIER | None | No Angel equivalent |
| Verification Agent | None | No Angel equivalent |
| Coordinator Mode | Cross-session coordination | Parallel (in-session vs cross-session) |

---

## 10. Key Engineering Patterns CC Uses That Angel Could Adopt

### 10.1 Forked Agent with Cache Sharing
CC's extract memories, auto dream, agent summary, and prompt suggestion all use `runForkedAgent()` which creates a fork of the main conversation that **shares the prompt cache**. The fork adds only a short user message at the end, so nearly all tokens are cache hits. This makes background LLM calls extremely cheap (cache_read vs full input pricing).

**Implication for Angel:** Angel's pattern extraction runs as a separate Node.js process with no cache. If Angel ran its extraction as a CC forked agent instead of a standalone process, it would share the session's prompt cache and be dramatically cheaper.

### 10.2 Cursor-Based Incremental Processing
`extractMemories` tracks `lastMemoryMessageUuid` — only processes messages since last extraction. This is the same pattern Claudex uses with session turn tracking in the DB. The CC implementation also handles the edge case where the cursor message was deleted by compaction (falls back to counting all messages).

### 10.3 Scan Throttling
`autoDream` has a `SESSION_SCAN_INTERVAL_MS = 10 minutes` throttle: even if the time gate passes on every turn, it only re-scans session files every 10 minutes. This prevents excessive I/O in long sessions.

### 10.4 Pre-Injecting Manifests
`extractMemories` pre-scans memory files and injects the manifest into the extraction prompt, so the agent doesn't spend a turn on `ls`. Angel's pattern extraction could pre-inject the DB observation manifest similarly.

### 10.5 Mutual Exclusion via Skip Logic
`extractMemories` checks if the main agent already wrote to memory in the current turn (`hasMemoryWritesSince`). If yes, it advances the cursor but skips extraction. This prevents double-work without locks. Angel's hooks could adopt similar skip logic for turns where Claudex hooks already captured the relevant information.

### 10.6 Turn Budget Hard Cap
The extraction agent has `maxTurns: 5` — "read all → write all" in ≤5 turns. Without this, verification rabbit-holes can burn unlimited turns. Angel's extraction should have similar hard caps.

### 10.7 Memory File Frontmatter Standard
CC uses consistent YAML frontmatter (`name`, `description`, `type`) on all memory files. This is why `scanMemoryFiles` can extract metadata without reading full file content — just the first 30 lines. Angel's observation schema in SQLite is the equivalent but more queryable.

---

## 11. Potential Conflicts Between Angel and CC Systems

### 11.1 Memory File Races
Both CC's `extractMemories`/`autoDream` and Angel (if it writes to files) could write to the same memdir files concurrently. CC has a `hasMemoryWritesSince` check to skip if the main agent already wrote, but Angel's Stop hook runs AFTER CC's extraction (which is fire-and-forget before the Stop hook). This could mean:
- CC extraction fires (async) 
- Angel's Stop hook fires (sync, within Stop hook pipeline)
- Both write to the same file concurrently

**Angel should not write to CC's memdir.** Keep Claudex DB and CC memdir as separate stores.

### 11.2 Magic Docs + Angel File Writes
If Angel writes to files that have `# MAGIC DOC:` headers, CC's Magic Docs system would also try to update those files. Claudex should not use the `# MAGIC DOC:` pattern on files it manages.

### 11.3 Transcript Cleanup Window
CC's `cleanupOldMessageFilesInBackground()` deletes transcripts older than 30 days. Angel's cross-agent indexer reads CC transcripts. Any transcript older than 30 days will be gone. Angel should index within the 30-day window.

### 11.4 Session Memory + Angel Compaction
CC's SM-Compact uses Session Memory as the compaction summary. If Claudex's PreCompact hook modifies the session memory content or the compaction parameters, it could interfere with SM-Compact. The Claudex PreCompact hook should be read-only with respect to Session Memory files.

---

## 12. Opportunities for Angel to Leverage CC Features

### 12.1 KAIROS Daily Log Pattern
If users are in KAIROS mode, Angel should read the daily logs (`logs/YYYY/MM/YYYY-MM-DD.md`) as a signal source, not just DB observations. These logs contain real-time captures that haven't been consolidated yet.

### 12.2 Session Memory as Angel Input
Angel could read the Session Memory file (at `getSessionMemoryPath()`) as additional context for its pattern extraction. Session Memory is continuously updated and represents the live running summary of the current session.

### 12.3 Memory Relevance for Angel Context Assembly
Angel's context injection could adopt CC's `findRelevantMemories` approach — use a fast LLM call to select which observations are most relevant to the current query rather than injecting all patterns. This would reduce context bloat at high observation counts.

### 12.4 Skill Improvement Trigger for Angel Patterns
When CC's Skill Improvement detects user corrections, it fires `tengu_skill_improvement_detected`. Angel could subscribe to this signal (via Claudex hooks) and capture the correction as an observation/CARA input, giving Angel richer feedback signal.

---

## File Reference

All files are in `claude-code-buildable/src/`:

- Skills: `skills/bundled/{batch,claudeApi,claudeInChrome,debug,dream,hunter,keybindings,loop,loremIpsum,remember,runSkillGenerator,scheduleRemoteAgents,simplify,skillify,stuck,updateConfig,verify}.ts`
- Background: `services/autoDream/autoDream.ts`, `services/extractMemories/extractMemories.ts`
- Session Memory: `services/SessionMemory/sessionMemory.ts`
- SM Compact: `services/compact/sessionMemoryCompact.ts`
- Away Summary: `services/awaySummary.ts`, `hooks/useAwaySummary.ts`
- Magic Docs: `services/MagicDocs/magicDocs.ts`
- Agent Summary: `services/AgentSummary/agentSummary.ts`
- Skill Improvement: `utils/hooks/skillImprovement.ts`
- Prompt Suggestion: `services/PromptSuggestion/promptSuggestion.ts`
- Memory Relevance: `memdir/findRelevantMemories.ts`, `memdir/memoryScan.ts`
- Classifiers: `utils/permissions/bashClassifier.ts`, `utils/permissions/classifierShared.ts`
- Post-sampling hub: `query/stopHooks.ts`
- Housekeeping: `utils/backgroundHousekeeping.ts`
- Verification Agent: `tools/AgentTool/built-in/verificationAgent.ts`
- Coordinator Mode: `coordinator/coordinatorMode.ts`
