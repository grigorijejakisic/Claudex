# CC Source: Dream and KAIROS Systems

**Date:** 2026-04-01
**Source repo:** `claude-code-buildable/src/`
**Purpose:** Understand CC's Dream (memory consolidation) and KAIROS (assistant mode) systems to assess conflicts with Claudex Angel.

---

## 1. What Is Dream?

Dream is CC's **memory consolidation system**. It is a reflective pass that synthesizes recent session activity into durable memory files. It operates as a **forked subagent** (using `runForkedAgent`) running the `buildConsolidationPrompt` against the auto-memory directory.

There are two forms:

### 1a. Manual `/dream` Skill
- Slash command registered via `registerDreamSkill()` from `src/skills/bundled/dream.ts`
- Gated behind `feature('KAIROS') || feature('KAIROS_DREAM')`
- Currently the file `src/skills/bundled/dream.ts` is a stub: `export default {}`
- The actual skill implementation is behind the feature flag and not shipped to the research build

### 1b. Auto-Dream (Background Consolidation)
- Entry: `src/services/autoDream/autoDream.ts`
- Initialized at session startup via `initAutoDream()` (called from `startBackgroundHousekeeping()` in `src/utils/backgroundHousekeeping.ts`, line 37)
- Executed after every assistant turn via `executeAutoDream()` called from `handleStopHooks()` in `src/query/stopHooks.ts`, line 154-155
- **NOT behind the KAIROS feature flag** — auto-dream ships independently and runs for all users with auto-memory enabled

---

## 2. What Is KAIROS Mode?

KAIROS is CC's **assistant mode** — a long-running, perpetual session architecture. Key characteristics:

- **Flag:** `feature('KAIROS')` (build-time Bun dead-code elimination flag)
- **Runtime state:** `getKairosActive()` / `setKairosActive()` in `src/bootstrap/state.ts`, lines 1085–1091
- **Default:** `STATE.kairosActive = false` (line 301)
- **Not shipped to external builds** — in the research build's `src/stubs/bun-bundle-runtime.ts`, KAIROS is explicitly commented out of `ENABLED_FEATURES` (line 6)

### KAIROS Activation Paths

There are three activation paths, all in `src/main.tsx`:

**Path 1: `--assistant` flag (Agent SDK daemon mode)**
```typescript
// main.tsx line 1063-1069
if (feature('KAIROS') && (options as { assistant?: boolean }).assistant && assistantModule) {
  assistantModule.markAssistantForced()  // force latch before isAssistantMode() runs
}
```
Then on line 1094: `setKairosActive(true)` when entitlement passes the `isKairosEnabled()` GrowthBook gate.

**Path 2: `assistant: true` in `.claude/settings.json` (daemon self-start)**
```typescript
// main.tsx line 1071-1079
if (feature('KAIROS') && assistantModule?.isAssistantMode() && !options.agentId && kairosGate) {
  // checks trust dialog, then kairosGate.isKairosEnabled() via tengu_kairos GB flag
}
```

**Path 3: Viewer mode (`claude assistant [sessionId]`)** — attaches REPL to remote assistant session
```typescript
// main.tsx line 3337-3341
setKairosActive(true)   // Brief mode activation for viewer
setUserMsgOptIn(true)
setIsRemoteMode(true)
```

### KAIROS Entitlement Gate
- GrowthBook flag: `tengu_kairos` (checked in `src/assistant/gate.ts`, which is stubbed to `export {}` in the research build)
- `isKairosEnabled()` is the function — wraps the GB check
- `--assistant` flag bypasses this gate (daemon is "pre-entitled")

### What KAIROS Mode Changes
- Activates `--brief` (forces BriefTool / SendUserMessage tool)
- Sets `kairosEnabled: true` in REPL initial state (gates async subagent paths)
- Pre-seeds an in-process team via `initializeAssistantTeam()`
- Changes memory prompt to KAIROS daily-log format (see section 3)
- Installs permanent cron tasks: `catch-up`, `morning-checkin`, `dream` (referenced in `src/assistant/install.ts`, not present in stub build)
- Enables `KAIROS_CHANNELS` for inbound MCP push notifications
- Blocks auto-dream from running (`isGateOpen()` returns false when KAIROS active — see section 4)

---

## 3. Daily Logs — KAIROS Memory Format

### How It Differs from Normal Memory

Normal CC memory (non-KAIROS):
- Agent maintains `MEMORY.md` as a live index
- Writes new memories as individual topic files
- `MEMORY.md` is constantly read + written as the source of truth

KAIROS assistant mode replaces this with an **append-only daily log**:

```
src/memdir/memdir.ts, line 327: buildAssistantDailyLogPrompt()
```

**Prompt excerpt:**
> "This session is long-lived. As you work, record anything worth remembering by **appending** to today's daily log file."

### Daily Log File Format

```
<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
```

- Defined in `src/memdir/paths.ts`, line 246: `getAutoMemDailyLogPath()`
- Pattern: `{getAutoMemPath()}/logs/{YYYY}/{MM}/{YYYY-MM-DD}.md`
- **Append-only** — each entry is a short timestamped bullet
- Agent creates the file (and parent dirs) on first write if it doesn't exist
- Midnight rollover: agent must start appending to the new day's file

### Why Append-Only?
Because KAIROS sessions are perpetual. Maintaining MEMORY.md as a live index during a long-running session would cause constant read-write contention and make the index drift. Instead:
- **During session:** append to daily log
- **Nightly:** /dream skill distills logs into topic files + MEMORY.md
- **MEMORY.md:** still loaded into context (via `claudemd.ts`) as the distilled index, but agent does NOT edit it directly during a KAIROS session

### Cache Stability Note
The log prompt uses a path pattern (`YYYY/MM/YYYY-MM-DD.md`) rather than today's literal date, so the system-prompt cache prefix stays valid across midnight. The agent derives the current date from the `date_change` attachment, not the prompt.

### What to Log (from prompt)
- User corrections and preferences
- Facts about the user, role, or goals
- Project context not derivable from code (deadlines, incidents, decisions + rationale)
- Pointers to external systems (dashboards, Linear, Slack)
- Anything user explicitly asks to remember

### Incompatibility with Team Memory
```typescript
// memdir.ts line 427-431
// KAIROS daily-log mode takes precedence over TEAMMEM: the append-only
// log paradigm does not compose with team sync (which expects a shared
// MEMORY.md that both sides read + write).
if (feature('KAIROS') && autoEnabled && getKairosActive()) {
  return buildAssistantDailyLogPrompt(skipIndex)
}
```

---

## 4. Dream Consolidation — Trigger Mechanism

### Gate Chain (cheapest first)

```typescript
// autoDream.ts lines 95-100
function isGateOpen(): boolean {
  if (getKairosActive()) return false  // KAIROS mode uses disk-skill dream
  if (getIsRemoteMode()) return false
  if (!isAutoMemoryEnabled()) return false
  return isAutoDreamEnabled()
}
```

The four gates:
1. **KAIROS gate:** if KAIROS is active, auto-dream is suppressed. KAIROS uses the nightly `/dream` cron skill instead
2. **Remote mode gate:** CCR without memory dir → disabled
3. **Auto-memory gate:** `isAutoMemoryEnabled()` — checks env vars + settings
4. **Dream enabled gate:** `isAutoDreamEnabled()` — GrowthBook `tengu_onyx_plover` or `settings.autoDreamEnabled`

### Time + Session Gate

After the above gates pass, the scheduler checks (in order):
1. **Time gate:** `hours since lastConsolidatedAt >= minHours` (default 24h via `tengu_onyx_plover`)
2. **Scan throttle:** last session scan was > 10 minutes ago
3. **Session gate:** count of session transcripts touched since last consolidation >= `minSessions` (default 5)
4. **Current session excluded** from the session count
5. **Process lock:** `.consolidate-lock` file in memory dir, prevents concurrent consolidation

### Lock File
- Path: `<autoMemPath>/.consolidate-lock`
- Body: holder's PID
- mtime = `lastConsolidatedAt` timestamp
- Stale threshold: 1 hour (PID reuse guard)
- Rollback on failure: rewinds mtime to pre-acquire so time gate re-opens on next session

### Scheduling Knobs (GrowthBook `tengu_onyx_plover`)
```typescript
const DEFAULTS: AutoDreamConfig = {
  minHours: 24,    // minimum hours between consolidations
  minSessions: 5,  // minimum sessions accumulated since last run
}
```

---

## 5. Dream Execution — What It Does

When all gates pass, auto-dream:

1. Spawns a `runForkedAgent` subagent (`querySource: 'auto_dream'`, `forkLabel: 'auto_dream'`, `skipTranscript: true`)
2. Gives the subagent the **consolidation prompt** (`buildConsolidationPrompt()` from `src/services/autoDream/consolidationPrompt.ts`)
3. Restricts Bash to read-only commands (`ls`, `find`, `grep`, `cat`, `stat`, `wc`, `head`, `tail`)
4. Registers a DreamTask (visible in footer + Shift+Down dialog)
5. Injects the completed files list as a "Improved N memories" system message

### Consolidation Prompt — Four Phases

**Phase 1 — Orient**
- `ls` the memory directory
- Read `MEMORY.md` to understand current index
- Skim existing topic files to avoid duplicates
- If `logs/` or `sessions/` subdirectories exist (KAIROS layout), review recent entries

**Phase 2 — Gather Recent Signal**
Priority order:
1. Daily logs (`logs/YYYY/MM/YYYY-MM-DD.md`) — the append-only stream
2. Existing memories that drifted (contradicted by current codebase)
3. Transcript search (last resort — JSONL grep, narrow terms only)

**Phase 3 — Consolidate**
- Merge new signal into existing topic files
- Convert relative dates to absolute dates
- Delete contradicted facts

**Phase 4 — Prune and Index**
- Keep `MEMORY.md` under **200 lines** and **25KB**
- Each index line: one line under ~150 chars: `- [Title](file.md) — one-line hook`
- Remove stale pointers
- Demote verbose entries to topic files
- Resolve contradictions

### Tool Permissions
The consolidation subagent uses `createAutoMemCanUseTool(memoryRoot)` — a restricted canUseTool that only allows writing within the memory directory.

---

## 6. How Dream Interacts with MEMORY.md and Auto-Memory

### Normal Mode (non-KAIROS)
- System prompt includes full `buildMemoryLines()` instructions
- Agent can write topic files + update MEMORY.md at any time
- Auto-dream runs in background after every turn, checking time+session gates
- Auto-dream consolidates: merges topic files, prunes MEMORY.md index

### KAIROS Mode
- System prompt includes `buildAssistantDailyLogPrompt()` instead
- MEMORY.md is read-only for the agent during session (loaded from `claudemd.ts` as the distilled index)
- Agent appends only to daily log files
- Auto-dream is suppressed (`isGateOpen()` returns false)
- Nightly `/dream` cron skill (via `src/assistant/install.ts`) distills logs → topic files → MEMORY.md

### MEMORY.md Truncation
- Max 200 lines (`MAX_ENTRYPOINT_LINES` in `memdir.ts`)
- Max 25KB (`MAX_ENTRYPOINT_BYTES`)
- `truncateEntrypointContent()` applies both limits with a warning appended

---

## 7. Feature Flags Controlling Dream/KAIROS

### Build-Time Flags (`feature()` from `bun:bundle`)

| Flag | Controls | Ships to External? |
|------|----------|-------------------|
| `KAIROS` | All assistant mode code | No (stub) |
| `KAIROS_BRIEF` | BriefTool / SendUserMessage independently | No |
| `KAIROS_DREAM` | Dream skill registration independently | No |
| `KAIROS_CHANNELS` | MCP inbound push channels | No |
| `EXTRACT_MEMORIES` | Background memory extraction | Conditionally |

Auto-dream (`autoDream.ts`) is **NOT behind a feature flag** — it's always imported and initialized.

### Runtime GrowthBook Flags

| Flag | Controls | Default |
|------|----------|---------|
| `tengu_kairos` | KAIROS entitlement gate | `false` |
| `tengu_onyx_plover` | Auto-dream enabled + thresholds (`minHours`, `minSessions`) | `null` (disabled) |
| `tengu_kairos_brief` | BriefTool availability (5-min refresh, kill-switch) | `false` |
| `tengu_kairos_cron` | Cron scheduler availability | `true` |
| `tengu_kairos_cron_config` | Cron jitter knobs (incident lever) | defaults |
| `tengu_kairos_cron_durable` | Durable cron tasks | `true` |
| `tengu_kairos_brief_config` | Brief behavior config | defaults |
| `tengu_passport_quail` | Extract-memories background agent | `false` |
| `tengu_slate_thimble` | Extract-memories in non-interactive sessions | `false` |
| `tengu_coral_fern` | "Searching past context" section in memory prompt | `false` |
| `tengu_moth_copse` | Skip MEMORY.md index from system prompt (prefetch via attachments) | `false` |
| `tengu_herring_clock` | Team memory | `false` |

### User-Controllable Settings (`settings.json`)

| Setting | Controls | Default |
|---------|----------|---------|
| `autoDreamEnabled` | Enable/disable background consolidation | Falls through to `tengu_onyx_plover` |
| `assistant` | Activate KAIROS mode (requires `tengu_kairos` GB gate) | `false` |
| `autoMemoryEnabled` | Enable/disable entire auto-memory system | `true` |
| `autoMemoryDirectory` | Custom memory storage path | `~/.claude/projects/<git-root>/memory/` |

### Environment Variables

| Var | Effect |
|-----|--------|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 1/true → disable auto-memory entirely |
| `CLAUDE_CODE_SIMPLE` (`--bare`) | Disables auto-memory + auto-dream |
| `CLAUDE_CODE_REMOTE` | CCR mode; without `CLAUDE_CODE_REMOTE_MEMORY_DIR`, disables auto-memory |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | CCR memory path override |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | Cowork space-scoped memory redirect |
| `CLAUDE_CODE_DISABLE_CRON` | Disables cron scheduler |

---

## 8. Is KAIROS Shipped or Behind a Flag?

**KAIROS is NOT shipped to external/consumer builds.** Evidence:

1. `src/stubs/bun-bundle-runtime.ts` line 6: `'KAIROS'` is commented out of `ENABLED_FEATURES` with the comment "// Assistant mode"
2. `src/assistant/gate.ts`: stub file, `export {}`
3. `src/assistant/index.ts`: stub file, `export default {}`
4. `src/assistant/sessionDiscovery.ts`: only exports a type stub
5. The build system uses `feature('KAIROS')` for dead-code elimination — all KAIROS code is tree-shaken out of external builds

**Auto-Dream IS partially shipped** — it's imported unconditionally in `backgroundHousekeeping.ts` and `stopHooks.ts`. However, it only fires when `isAutoDreamEnabled()` returns true, which requires `tengu_onyx_plover.enabled === true` from GrowthBook or `autoDreamEnabled: true` in settings. By default, GrowthBook returns `null`, so auto-dream is disabled for most users.

---

## 9. Conflict Analysis: What Would Conflict with Claudex Angel

### Direct Conflicts

**1. Memory File Ownership (Critical)**
- Auto-dream writes to the same memory directory that Claudex's hooks write to (`~/.claude/projects/<slug>/memory/`)
- Both systems can write, modify, and delete files in this directory
- Auto-dream runs `buildConsolidationPrompt()` which explicitly says: *"Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source"*
- **Angel does the same thing** — retention sweep, observation pruning, contradiction detection
- Risk: CC's auto-dream subagent could delete or rewrite Claudex memory files, and vice versa

**2. MEMORY.md Index Contention**
- CC's auto-dream maintains `MEMORY.md` as an index (max 200 lines / 25KB)
- CC's `claudemd.ts` reads `MEMORY.md` and injects it into every system prompt
- Claudex writes `MEMORY.md` (auto-memory from private CLAUDE.md: `~/.claude/projects/...memory/MEMORY.md`)
- If both run, CC's auto-dream will periodically rewrite MEMORY.md according to its own format/taxonomy, overwriting Claudex's carefully maintained index

**3. Lock File Race**
- CC's auto-dream uses `.consolidate-lock` inside the memory directory as a mutex
- Claudex has no awareness of this lock
- If Angel writes to memory files while CC's consolidation lock is held, and CC rolls back, Angel's writes may be partially overwritten

**4. System Prompt Injection of Auto-Memory**
- CC's `loadMemoryPrompt()` injects the entire memory system prompt into Claude's context
- This prompt instructs CC to manage memories using CC's taxonomy (user/feedback/project/reference)
- Claudex's hooks inject Claudex-specific context via separate mechanisms
- When running together, Claude receives two competing memory management instruction sets

**5. Extract-Memories Background Agent**
- Separate from dream: `src/services/extractMemories/extractMemories.ts`
- Also runs as a forked subagent after every turn (when `tengu_passport_quail` is enabled)
- Also writes to the same memory directory
- Creates a three-way conflict: CC extract-memories + CC auto-dream + Claudex Angel all potentially writing to the same files

### Behavioral Divergences (Not Crashes, But Semantic Conflicts)

**6. Memory Taxonomy Clash**
- CC enforces a closed four-type taxonomy: user / feedback / project / reference
- CC's prompt explicitly instructs: content derivable from code (architecture, git history, code patterns) should NOT be saved
- Claudex stores observations, decisions, learnings, experience patterns — many of which CC would classify as "derivable from project state" and delete

**7. Pruning Aggression**
- CC's dream prompt: "Remove pointers to memories that are now stale, wrong, or superseded"
- CC has a 200-line / 25KB hard cap on MEMORY.md
- Claudex's accumulated context in MEMORY.md (project memory, user feedback, session history pointers) could be pruned by CC auto-dream because it exceeds CC's size limits or doesn't match CC's taxonomy

**8. Session Transcript Reading**
- CC's dream scans JSONL session transcripts at `~/.claude/projects/<slug>/*.jsonl`
- Claudex's Angel also reads transcripts for pattern extraction
- Not a conflict per se, but both processes may grep the same large files concurrently

### Low-Risk / Non-Conflicting Behaviors

**9. KAIROS Cron Tasks**
- KAIROS cron tasks (`catch-up`, `morning-checkin`, `dream`) are written to `.claude/scheduled_tasks.json`
- Only relevant when `feature('KAIROS')` is active — not in external builds
- **Not a current conflict** since KAIROS is behind a build flag

**10. Process Lock Prevents Concurrent Auto-Dream**
- The `.consolidate-lock` PID check prevents two CC processes from running consolidation simultaneously
- This protects against inter-CC conflicts but does NOT protect against Claudex writes during consolidation

### Summary Table

| Conflict | Severity | Condition |
|----------|----------|-----------|
| Both write to same memory directory | Critical | Auto-dream enabled (`autoDreamEnabled: true` or `tengu_onyx_plover`) |
| Dream rewrites MEMORY.md index | Critical | Same as above |
| CC taxonomy prunes Claudex observations | High | Same as above |
| Extract-memories + Angel triple-write | High | `tengu_passport_quail` enabled |
| System prompt dual memory instructions | Medium | Always (CC injects memory prompt by default) |
| Lock file race | Medium | Auto-dream enabled |
| Session transcript concurrent reads | Low | Both systems active |
| KAIROS daily-log format collision | None currently | KAIROS not shipped to external builds |

---

## 10. Key File Paths

```
src/services/autoDream/
  autoDream.ts          — init/execute, gate chain, forked agent launch
  config.ts             — isAutoDreamEnabled() gate
  consolidationLock.ts  — .consolidate-lock (mtime = lastConsolidatedAt)
  consolidationPrompt.ts — buildConsolidationPrompt() — the 4-phase prompt

src/memdir/
  memdir.ts             — buildAssistantDailyLogPrompt(), loadMemoryPrompt(),
                          ENTRYPOINT_NAME='MEMORY.md', MAX_ENTRYPOINT_LINES=200
  paths.ts              — getAutoMemPath(), getAutoMemDailyLogPath(), isAutoMemoryEnabled()

src/utils/
  backgroundHousekeeping.ts  — initAutoDream() at startup
  cronTasks.ts               — permanent cron task type (catch-up/morning-checkin/dream)

src/query/
  stopHooks.ts          — executeAutoDream() called after every assistant turn

src/bootstrap/
  state.ts              — getKairosActive()/setKairosActive() (lines 1085-1091)

src/main.tsx            — KAIROS activation paths (lines 1063-1100, 3337-3341)

src/assistant/
  gate.ts               — stub: isKairosEnabled() (not shipped)
  index.ts              — stub: isAssistantMode(), markAssistantForced() (not shipped)

src/skills/bundled/
  dream.ts              — stub: registerDreamSkill() (not shipped)
  index.ts              — dream skill registration (lines 35-40)

src/stubs/
  bun-bundle-runtime.ts — ENABLED_FEATURES (KAIROS commented out, line 6)
```

---

## 11. Claudex Integration Recommendations

1. **Disable CC auto-dream when Claudex is active.** Set `autoDreamEnabled: false` in `.claude/settings.json` for Claudex-managed projects. Claudex's Angel handles the equivalent consolidation via retention sweep and pattern extraction.

2. **Use a separate memory directory.** Configure `autoMemoryDirectory` in settings.json to a path CC doesn't manage (e.g., Claudex's own `~/.claudex/` path space). This prevents CC's auto-dream from touching Claudex's files entirely. However, CC will then not inject memory into its own system prompt — which is acceptable if Claudex injects context via hooks instead.

3. **Watch the `.consolidate-lock` file.** If you can't separate memory directories, Claudex's Angel should respect CC's lock file before writing to memory. Check `<autoMemPath>/.consolidate-lock` PID and mtime before any write.

4. **KAIROS is not a current threat.** It's gated behind a build-time feature flag not present in external builds. No need to worry about KAIROS daily-log mode for Claudex users today. Monitor if CC ships KAIROS broadly.

5. **Extract-memories is similarly gated** (`tengu_passport_quail` GrowthBook flag, default false). Low-risk currently but monitor as CC rolls it out.
