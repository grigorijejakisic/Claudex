# CC Source Research: Session Lifecycle, Storage, and Resume

**Date:** 2026-04-01
**Source:** `C:/Users/Grigorije/Desktop/Projects/claude-code-buildable/src/`
**Primary files researched:**
- `src/utils/sessionStorage.ts` (~4500 lines — the core)
- `src/utils/sessionStoragePortable.ts`
- `src/utils/sessionRestore.ts`
- `src/utils/conversationRecovery.ts`
- `src/utils/crossProjectResume.ts`
- `src/utils/toolResultStorage.ts` (ContentReplacement for cache stability)
- `src/history.ts` (prompt history — separate from session transcripts)
- `src/hooks/useLogMessages.ts`
- `src/assistant/sessionHistory.ts`
- `src/types/logs.ts`
- `src/commands/resume/resume.tsx`
- `src/bootstrap/state.ts`

---

## 1. How Sessions Are Stored

### File Format and Location

Sessions are stored as **JSONL files** (newline-delimited JSON) at:
```
~/.claude/projects/{sanitizedProjectPath}/{sessionId}.jsonl
```

**Path sanitization** (`sessionStoragePortable.ts:311`):
```typescript
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) { // 200 chars
    return sanitized
  }
  const hash = Bun.hash(name).toString(36) // or djb2Hash for non-Bun
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}
```

Example: project at `/Users/foo/my-project` → stored under `~/.claude/projects/-Users-foo-my-project/`.

**Long paths (>200 chars):** Hash suffix for uniqueness. **IMPORTANT:** Bun uses `Bun.hash`, Node.js uses `djb2Hash` — these produce different suffixes for the same path. This causes cross-runtime hash mismatches. `findProjectDir()` has workaround prefix-scanning fallback (`sessionStoragePortable.ts:354`).

**Session file path** (`sessionStorage.ts:202`):
```typescript
export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}
```

**Subagent transcripts** are stored in a subdirectory:
```
~/.claude/projects/{sanitizedProjectPath}/{sessionId}/subagents/agent-{agentId}.jsonl
```
Remote agent metadata goes to:
```
~/.claude/projects/{sanitizedProjectPath}/{sessionId}/remote-agents/remote-agent-{taskId}.meta.json
```

### JSONL Entry Types

The `Entry` union type (`types/logs.ts:297`):

| Entry type | Purpose |
|---|---|
| `user` / `assistant` / `attachment` / `system` | Conversation transcript messages |
| `summary` | Compact boundary leaf summary |
| `custom-title` | User-set session name |
| `ai-title` | AI-generated session title (never re-appended; ephemeral) |
| `last-prompt` | Most recent user prompt (for /resume picker display) |
| `task-summary` | Periodic auto-generated summary of what the agent is doing |
| `tag` | Session tag (searchable in /resume) |
| `agent-name` | Agent display name |
| `agent-color` | Agent color |
| `agent-setting` | Agent definition used (--agent flag) |
| `pr-link` | Linked GitHub PR (number, URL, repo) |
| `file-history-snapshot` | File history state snapshot |
| `attribution-snapshot` | Claude contribution tracking for commit attribution |
| `content-replacement` | Tool result content replacement decisions (for prompt cache stability) |
| `mode` | Session mode: `'coordinator'` or `'normal'` |
| `worktree-state` | Worktree session state (null = exited, undefined = never entered) |
| `marble-origami-commit` | Context-collapse commit entry (ordered) |
| `marble-origami-snapshot` | Context-collapse staged queue state (last-wins) |

### TranscriptMessage Schema

Every `user`/`assistant`/`attachment`/`system` message is stamped at write time (`sessionStorage.ts:1057`):
```typescript
const transcriptMessage: TranscriptMessage = {
  parentUuid: isCompactBoundary ? null : effectiveParentUuid,
  logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
  isSidechain,
  teamName, agentName,
  promptId,    // correlates with OTel prompt.id
  agentId,
  ...message,
  // Session-stamp fields MUST come after the spread:
  userType,        // 'ant' or 'external'
  entrypoint,      // CLAUDE_CODE_ENTRYPOINT env var
  cwd,
  sessionId,
  version,
  gitBranch,
  slug,            // session plan slug
}
```

### Append-Only Write Architecture

The `Project` class manages writes (`sessionStorage.ts:532`):
- **Buffered writes** via `enqueueWrite()` — entries go to a per-file queue
- **Batched drain** every 100ms (10ms for CCR/remote sessions) via `drainWriteQueue()`
- **Chunk limit** of 100MB per write batch
- **Lazy file creation**: `materializeSessionFile()` runs on first `user`/`assistant` message — prevents metadata-only orphan files
- **Pending buffer**: entries before first real message are held in `pendingEntries[]` and flushed on materialization
- **Cleanup handler** registered via `registerCleanup()` to flush on process exit and re-append session metadata

### When Sessions Are NOT Persisted

`shouldSkipPersistence()` (`sessionStorage.ts:960`):
```typescript
private shouldSkipPersistence(): boolean {
  return (
    (getNodeEnv() === 'test' && !allowTestPersistence) ||
    getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
    isSessionPersistenceDisabled() ||
    isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)  // set by Tungsten tmux sessions
  )
}
```

### Remote Persistence (CCR)

Two remote paths:
1. **v1 Session Ingress**: `ENABLE_SESSION_PERSISTENCE=true` + `remoteIngressUrl` → `sessionIngress.appendSessionLog()`. On failure: `gracefulShutdownSync(1)`.
2. **CCR v2 internal events**: `internalEventWriter` callback registered via `setInternalEventWriter()`. Flush interval drops to 10ms.

---

## 2. How Session Resume Works

### Entry Point: `loadConversationForResume()`
**File:** `src/utils/conversationRecovery.ts:456`

The centralized function for all resume paths:

```typescript
export async function loadConversationForResume(
  source: string | LogOption | undefined,  // undefined=--continue, string=sessionId, LogOption=pre-loaded
  sourceJsonlFile: string | undefined,     // .jsonl path for cross-directory resume
): Promise<{
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  agentName?, agentColor?, agentSetting?,
  customTitle?, tag?, mode?,
  worktreeSession?, prNumber?, prUrl?, prRepository?
  fullPath?  // for cross-directory resume
} | null>
```

**Resume flow** (`conversationRecovery.ts:487`):
1. **Load source**: Most recent (`loadMessageLogs()`), by session ID (`getLastSessionLog()`), or from pre-loaded LogOption
2. **Hydrate lite logs**: `loadFullLog()` if needed (lite logs have `messages:[]`)
3. **Copy plan files**: `copyPlanForResume()` — associates plan slug with resumed session
4. **Copy file history**: `copyFileHistoryForResume()`
5. **Restore skill state**: `restoreSkillStateFromMessages()` — scans `invoked_skills` attachments, re-registers them in bootstrap state
6. **Deserialize**: `deserializeMessagesWithInterruptDetection()` — filters, transforms, adds sentinel
7. **Process session start hooks**: `processSessionStartHooks('resume', { sessionId })`
8. **Return** complete resume data

### Transcript Loading: `loadTranscriptFile()`
**File:** `src/utils/sessionStorage.ts` (~line 3480)

**Two-phase read for large files (>5MB):**
1. **Phase 1** — `readTranscriptForLoad()`: Single forward chunked read. Skips `attribution-snapshot` lines at fd level. On compact boundary, clears accumulator (discards pre-boundary content). Returns post-boundary buffer + `boundaryStartOffset`.
2. **Phase 2** — `scanPreBoundaryMetadata()`: Cheap byte-level scan of `[0, boundaryStartOffset)` to recover session-scoped metadata entries (custom-title, tag, mode, agent-setting, pr-link, worktree-state) that appear before the boundary.

**Dead branch pruning** (`walkChainBeforeParse()` — for files >5MB):
Before `parseJSONL`, walks backward from EOF to identify which UUIDs are in the live chain, discards orphaned fork branches. Measured improvement: 56ms → 3.9ms on a 41MB session with 99% dead branches.

**`loadTranscriptFile()` builds:**
- `messages: Map<UUID, TranscriptMessage>` — all post-boundary transcript messages
- `summaries`, `customTitles`, `tags`, `agentNames`, `agentColors`, `agentSettings` — keyed by sessionId
- `prNumbers`, `prUrls`, `prRepositories`, `modes`, `worktreeStates` — keyed by sessionId
- `fileHistorySnapshots`, `attributionSnapshots` — keyed by messageId
- `contentReplacements` — keyed by sessionId (main-thread) or agentId (sidechain)
- `contextCollapseCommits[]` — ordered array
- `contextCollapseSnapshot` — last-wins singleton
- `leafUuids: Set<UUID>` — pre-computed

**Leaf computation**: Terminal messages (no children) → walk up to nearest user/assistant ancestor → those are the leaves. Feature-gated variant (`tengu_pebble_leaf_prune`) skips ancestors that already have user/assistant children to avoid tool-progress dead ends.

**Chain reconstruction** (`buildConversationChain()`):
Walks `parentUuid` from leaf to root, reverses, then runs `recoverOrphanedParallelToolResults()` — a post-pass that recovers sibling assistant blocks and tool_results orphaned by parallel tool_use streaming.

**Legacy progress bridge**: `progress` entries were removed from `isTranscriptMessage()` in PR #24099 but old transcripts have them in `parentUuid` chains. A `progressBridge: Map<UUID, UUID | null>` translates progress→parent for messages that chain through them.

### Message Deserialization: `deserializeMessagesWithInterruptDetection()`
**File:** `src/utils/conversationRecovery.ts:164`

Steps applied in order:
1. `migrateLegacyAttachmentTypes()` — `new_file`→`file`, `new_directory`→`directory`, backfill `displayPath`
2. Strip invalid `permissionMode` values (disk is unvalidated, may contain stale modes)
3. `filterUnresolvedToolUses()` — remove tool_use blocks with no matching tool_result
4. `filterOrphanedThinkingOnlyMessages()` — remove thinking-only assistant messages (cause API errors on resume)
5. `filterWhitespaceOnlyAssistantMessages()` — remove "\n\n"-only outputs from mid-stream cancellation
6. `detectTurnInterruption()` — determines if session ended mid-turn
7. If `interrupted_turn`: append synthetic `"Continue from where you left off."` user message
8. If last message is user: append synthetic `NO_RESPONSE_REQUESTED` assistant sentinel (makes conversation API-valid)

**Turn interruption detection**: Last non-system/non-progress message is checked:
- `assistant` → completed turn (`none`)
- `user` isMeta or isCompactSummary → `none`
- `user` with tool_result that is terminal (SendUserMessage/BriefTool) → `none`
- `user` with tool_result (non-terminal) → `interrupted_turn`
- plain `user` → `interrupted_prompt`

### Session State Restoration: `processResumedConversation()`
**File:** `src/utils/sessionRestore.ts:409`

Called by `main.tsx` for CLI `--continue`/`--resume` paths:

1. **Coordinator mode matching**: `modeApi?.matchSessionMode(result.mode)` — warns if resuming a coordinator session in normal mode
2. **Session ID reuse**: `switchSession(sid, transcriptPath)` — reuses the resumed session's UUID (not a new one)
3. **Rename asciicast**: `renameRecordingForSession()` — recording file matches resumed session ID
4. **Reset session file pointer**: `resetSessionFilePointer()` — clears stale fresh-session path
5. **Cost state restore**: `restoreCostStateForSession(sid)`
6. **Content replacements seed** (fork path): `recordContentReplacement()` — seeds replacement records into fresh session so prompt cache stability is maintained on `claude -r {newSessionId}`
7. **Session metadata restore**: `restoreSessionMetadata()` — populates in-memory cache with customTitle, tag, agentName, agentColor, agentSetting, mode, worktreeSession, PR info
8. **Worktree restore**: `restoreWorktreeForResume()` — `process.chdir()` into resumed worktree if directory still exists
9. **Adopt session file**: `adoptResumedSessionFile()` — points `Project.sessionFile` at the resumed file, calls `reAppendSessionMetadata(skipTitleRefresh=true)`
10. **Context-collapse restore**: `restoreFromEntries()` — rebuilds commit log + staged snapshot
11. **Agent restore**: `restoreAgentFromSession()` — re-applies agent type and model override
12. **Mode persistence**: `saveMode()` — so future resumes know what mode this session was in
13. **Compute initial AppState**: Including restored attribution, standaloneAgentContext, refreshed agent definitions

### `/resume` Slash Command (Mid-Session)
**File:** `src/commands/resume/resume.tsx`

Interactive picker. Calls `loadSameRepoMessageLogs()` (or `loadAllProjectsMessageLogs()` for --all-projects). After selection, calls `onResume(sessionId, log, entrypoint)` which triggers `restoreSessionStateFromLog()` in REPL.tsx.

### `restoreSessionStateFromLog()`
**File:** `src/utils/sessionRestore.ts:99`

Used by both SDK and interactive resume paths to hydrate `AppState`:
1. Restore `fileHistory` state from snapshots
2. Restore `attribution` state from snapshots (ant-only feature)
3. Restore context-collapse commits + snapshot (`CONTEXT_COLLAPSE` feature gate)
4. Restore TodoWrite state from transcript (SDK/non-interactive only — scans backward for last `TodoWrite` tool_use block)

---

## 3. `isLoggableMessage()` — The Transcript Filter

**File:** `src/utils/sessionStorage.ts:4351`

```typescript
export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  // IMPORTANT: We deliberately filter out most attachments for non-ants because
  // they have sensitive info for training that we don't want exposed to the public.
  // When enabled, we allow hook_additional_context through since it contains
  // user-configured hook output that is useful for session context on resume.
  if (m.type === 'attachment' && getUserType() !== 'ant') {
    if (
      m.attachment.type === 'hook_additional_context' &&
      isEnvTruthy(process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT)
    ) {
      return true
    }
    return false
  }
  return true
}
```

**What gets filtered out:**
- `progress` messages — always, for all users
- `attachment` messages — for external users (`getUserType() !== 'ant'`), EXCEPT `hook_additional_context` when `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=true`

**Why:** Attachments contain sensitive training-unfriendly info (IDE context, file content previews, MCP output, skill listings, etc.). Anthropic internal users ("ants") keep all attachments for training data.

**Consequence for Claudex:** Hook output injected as attachments with type `hook_additional_context` does NOT survive to the transcript by default. Users must set `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1` to persist it. This means Claudex-injected context in `PreToolUse` hooks is **ephemeral by default**.

### `cleanMessagesForLogging()` — The Full Filter Pipeline

**File:** `src/utils/sessionStorage.ts:4450`

```typescript
export function cleanMessagesForLogging(
  messages: Message[],
  allMessages: readonly Message[] = messages,
): Transcript {
  const filtered = messages.filter(isLoggableMessage) as Transcript
  return getUserType() !== 'ant'
    ? transformMessagesForExternalTranscript(filtered, collectReplIds(allMessages))
    : filtered
}
```

For external users, additionally applies `transformMessagesForExternalTranscript()` which:
- **Strips REPL tool_use/tool_result pairs** — the REPL tool is a wrapper; external transcripts see native tool calls (Bash, Read, etc.) without the REPL wrapper
- **Promotes `isVirtual` messages to real** — virtual messages (created by the REPL tool) become first-class messages in the external transcript

**Why this matters for resume:** On `--resume`, the model sees a coherent native-tool-call history without REPL plumbing. Ant transcripts keep the REPL wrapper for training data accuracy.

---

## 4. Attachments and Resume — The Known Bug Area

### The Problem

Attachments are filtered by `isLoggableMessage()` for external users. This means:
- File attachment messages (`type: 'file'`, `type: 'directory'`)
- Skill listings (`type: 'skill_listing'`)
- Invoked skills records (`type: 'invoked_skills'`)
- IDE context (`type: 'ide_context'`)
- MCP output, hook output, etc.

**None of these survive to the JSONL** for external users. On resume, the model's context is reconstructed WITHOUT these attachments.

### Skill State — Special Handling

`restoreSkillStateFromMessages()` (`conversationRecovery.ts:382`) specifically handles the invoked_skills case:

```typescript
export function restoreSkillStateFromMessages(messages: Message[]): void {
  for (const message of messages) {
    if (message.type !== 'attachment') continue
    if (message.attachment.type === 'invoked_skills') {
      for (const skill of message.attachment.skills) {
        if (skill.name && skill.path && skill.content) {
          addInvokedSkill(skill.name, skill.path, skill.content, null)
        }
      }
    }
    if (message.attachment.type === 'skill_listing') {
      suppressNextSkillListing()
    }
  }
}
```

BUT: `invoked_skills` and `skill_listing` attachments are filtered by `isLoggableMessage()` for external users, so they never reach the JSONL in the first place. This means `restoreSkillStateFromMessages()` only works for ant users.

**The db8 regression** (referenced in research brief): This likely refers to a bug where attachments that were previously saved (perhaps when the filter was less aggressive, or for ants) now fail to load on resume because the filter was tightened. Investigating exactly what "db8" refers to would require access to git blame/PR history.

### Prompt History vs. Session Transcript

There are **two separate storage systems** — commonly confused:

| System | File | Purpose |
|---|---|---|
| Prompt history | `~/.claude/history.jsonl` | Up-arrow / Ctrl+R recall of user text inputs. Shared across all projects. |
| Session transcript | `~/.claude/projects/{project}/{sessionId}.jsonl` | Full conversation for resume. Per-project, per-session. |

The prompt history system (`src/history.ts`) stores only the display text and pasted content references, NOT the full messages. It uses file locking (`lock()`) and has a 100-item cap per project.

---

## 5. Session Metadata Tracked

The `Project` class caches in memory (`sessionStorage.ts:532`):

```typescript
class Project {
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined           // custom title
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined      // for /resume picker display
  currentSessionAgentSetting: string | undefined    // agent definition type
  currentSessionMode: 'coordinator' | 'normal' | undefined
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined
}
```

**Persistence timing:**
- `currentSessionTitle`, `currentSessionMode`, `currentSessionAgentSetting`: cache-only until `materializeSessionFile()` on first user/assistant message
- `currentSessionLastPrompt`: overwritten every turn (last-wins)
- `currentSessionWorktree`: written eagerly mid-session when `sessionFile` exists; buffered to `reAppendSessionMetadata()` if not

**`reAppendSessionMetadata()`** (`sessionStorage.ts:721`): Sync-appends all cached metadata to the end of the JSONL. Called:
- During compaction — ensures metadata stays in the 64KB tail window
- On session exit (cleanup handler) — ensures it's at EOF

**Tail window**: `LITE_READ_BUF_SIZE = 65536` bytes (64KB). The `readLiteMetadata` path reads only head + tail for fast session listing. Metadata entries must be in the tail to be found without full file scan.

**`LogOption`** is the complete session metadata structure returned from loading (`types/logs.ts:19`):
- `firstPrompt`, `messageCount`, `date`, `created`, `modified`, `fileSize`
- `customTitle`, `tag`, `agentName`, `agentColor`, `agentSetting`
- `gitBranch`, `projectPath`, `prNumber`, `prUrl`, `prRepository`
- `mode`, `worktreeSession`, `isSidechain`, `isTeammate`
- `fileHistorySnapshots`, `attributionSnapshots`, `contentReplacements`
- `contextCollapseCommits`, `contextCollapseSnapshot`

---

## 6. Session Resume and Prompt Caching

### Content Replacement for Cache Stability

**File:** `src/utils/toolResultStorage.ts`

Feature gate: `tengu_hawthorn_steeple`. When enabled, large tool results are replaced with stubs in the context window to fit the budget. The replacement decisions are persisted to the transcript as `content-replacement` entries.

**Why this matters for prompt caching:** The model sees a specific string for a replaced tool result. On resume, the exact same replacement string must be re-applied — otherwise the prefix changes and the cache misses permanently.

```typescript
export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string  // stored verbatim — NOT re-derived from templates
}
```

**Resume reconstruction** (`toolResultStorage.ts:960`):
```typescript
export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState
```

- `seenIds` is populated from all candidate tool_use IDs in messages (marks them as FROZEN — budget will never re-replace, preserving the wire prefix)
- `replacements` map is populated from `records` (for IDs still in messages)
- FROZEN = never replace; ensures cache hit on next API call

**Fork-session cache stability** (`sessionRestore.ts:452`):
```typescript
} else if (result.contentReplacements?.length) {
  // --fork-session keeps the fresh startup session ID. Without this seed,
  // claude -r {newSessionId} finds source tool_use_ids in messages but no
  // matching replacement records → classified as FROZEN → full content sent
  // (cache miss, permanent overage).
  await recordContentReplacement(result.contentReplacements)
}
```

### Token Usage on Resume

On resume from a compact boundary, preserved messages have their `usage` fields zeroed (`sessionStorage.ts:1920`):
```typescript
messages.set(uuid, {
  ...msg,
  message: {
    ...msg.message,
    usage: {
      ...msg.message.usage,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
})
```

This prevents resume from immediately triggering auto-compact (on-disk `input_tokens` reflect the pre-compact ~190K context; without zeroing, the usage counters would spiral).

### Remote Session History (CCR/Teleport)

**File:** `src/assistant/sessionHistory.ts`

For cloud-backed sessions, history is fetched from the Sessions API:
```
GET {BASE_API_URL}/v1/sessions/{sessionId}/events
```
With `anthropic-beta: ccr-byoc-2025-07-29`. Returns `SDKMessage[]` paginated via `anchor_to_latest` / `before_id` cursors. Page size: 100.

`hydrateFromCCRv2InternalEvents()` (`sessionStorage.ts:1632`): Fetches foreground + subagent events from registered readers, writes them to local JSONL files, then the normal local load path runs.

---

## 7. Session Events and Lifecycle Hooks

### Session Start Hooks

`processSessionStartHooks('resume', { sessionId })` (`conversationRecovery.ts:565`):
Called at the end of `loadConversationForResume()`. Returns additional messages to append to the conversation. This is where CC's hook system can inject context on resume.

### Session Lifecycle Events (in `bootstrap/state.ts`)

The bootstrap `State` object tracks:
- `sessionId: SessionId` — UUID, switches on `switchSession()`
- `parentSessionId` — tracks session lineage (e.g., plan mode → implementation)
- `startTime`, `lastInteractionTime`
- `totalCostUSD`, `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`
- `totalLinesAdded`, `totalLinesRemoved`
- `modelUsage: { [modelName: string]: ModelUsage }`
- `isInteractive`, `kairosActive`, `sdkAgentProgressSummariesEnabled`
- `invokedSkills: Map<string, {...}>` — survives compaction, lost on resume for external users
- `inlinePlugins`, `chromeFlagOverride`, `useCoworkPlugins`
- `sessionBypassPermissionsMode`, `scheduledTasksEnabled`
- `sessionCreatedTeams: Set<string>` — cleaned up on graceful shutdown
- `teleportedSessionInfo` — tracks Teleport session reliability logging
- `slowOperations[]` — ant-only dev bar display

### Cleanup Handler

Registered via `registerCleanup()` (`sessionStorage.ts:444`):
```typescript
registerCleanup(async () => {
  await project?.flush()
  try {
    project?.reAppendSessionMetadata()
  } catch {
    // Best-effort
  }
})
```

Ensures all buffered writes are flushed and metadata is at EOF on process exit.

### `useLogMessages` — The React Hook

**File:** `src/hooks/useLogMessages.ts`

The bridge between the in-memory message array and the JSONL transcript. Key optimizations:
- Incremental recording: tracks `lastRecordedLengthRef` and slices only new messages per render
- First-uuid change detection: distinguishes compaction (first UUID changes) from incremental growth
- Same-head shrink detection: tombstone/rewind/snip scenarios
- `callSeqRef`: guards against stale async `.then()` overwrites
- Sync-walk for parent UUID tracking: avoids awaiting `recordTranscript` for the parentUuid hint

---

## 8. What Gets Lost on Resume

### Definitive Losses (external users)

1. **All `attachment` messages** (except `hook_additional_context` with env var set):
   - File/directory attachments
   - Skill listings (`skill_listing`)
   - Invoked skills records (`invoked_skills`) — skill state is NOT restored
   - IDE context (`ide_context`)
   - MCP output
   - Hook output (unless `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1`)

2. **`progress` messages** — filtered for all users. These are UI-only ephemeral ticks (bash progress, MCP progress, sleep progress). Never persisted.

3. **In-memory bootstrap state:**
   - `STATE.invokedSkills` — cleared on process restart
   - `STATE.sessionCreatedTeams` — cleaned up on shutdown
   - `STATE.slowOperations`
   - All session-only flags (`sessionBypassPermissionsMode`, etc.)

4. **Tool result files** in `{sessionId}/tool-results/` — the files exist on disk but are referenced by path in the transcript. If the filesystem changes (files moved, cleaned up), the persisted output references break.

5. **REPL tool pairs** (for external users): `transformMessagesForExternalTranscript()` strips REPL tool_use/tool_result pairs. On resume, the model sees native tool calls but REPL execution history is gone.

### Losses for Cross-Session Forks (`--fork-session`)

- `worktreeSession` is stripped (fork doesn't take ownership of original session's worktree)
- Session ID is new (fresh UUID), so all UUID-keyed state from the source session is inaccessible

### Known Gotcha: Session Switching with `switchSession()`

`switchSession(newId, projectDir)` (`bootstrap/state.ts`) atomically updates:
- `STATE.sessionId`
- `STATE.sessionProjectDir` (if `projectDir` provided)

After `switchSession()`, `getTranscriptPath()` returns the new session's path. This is why `resetSessionFilePointer()` must be called after switching — the old `Project.sessionFile` points to the wrong path.

### Transcript Consistency Check

`checkResumeConsistency()` (`sessionStorage.ts:2224`): Called once per resume (not on /share or log listing). Finds the last `turn_duration` system message, checks if its recorded `messageCount` matches its actual position in the reconstructed chain. Emits `tengu_resume_consistency_delta` to BigQuery.

- `delta > 0`: resume loaded MORE than in-session (typical failure from snip/compact/parallel-TR bugs)
- `delta < 0`: chain truncation
- `delta = 0`: round-trip consistent

---

## 9. Cross-Project Resume

**File:** `src/utils/crossProjectResume.ts`

```typescript
export function checkCrossProjectResume(
  log: LogOption,
  showAllProjects: boolean,
  worktreePaths: string[],
): CrossProjectResumeResult
```

Three outcomes:
- `isCrossProject: false` — same project, resume normally
- `isCrossProject: true, isSameRepoWorktree: true` — same git repo (different worktree), can resume directly without cd
- `isCrossProject: true, isSameRepoWorktree: false` — different project, generates `cd {projectPath} && claude --resume {sessionId}` command for display

**Windows note** (`sessionStorage.ts:4128`): Drive letter case can differ between git worktree list output and stored project directory paths. Case-insensitive comparison on `process.platform === 'win32'`.

---

## 10. Lite Logs and Progressive Loading

**Lite logs** (`isLiteLog()`): `messages: []`, `sessionId` set. No full parse — only stat + head/tail read.

`enrichLogs()` runs in batches, converting lite logs to full logs for the /resume picker. Initial batch: `INITIAL_ENRICH_COUNT` sessions. Remaining loaded progressively.

`readHeadAndTail()` (`sessionStoragePortable.ts:215`): Opens file once, reads first 64KB (head) + last 64KB (tail). For small files, head IS tail. Used for:
- `extractFirstPromptFromHead()` — scans head for first meaningful user message
- `extractLastJsonStringField()` / `extractJsonStringField()` — extracts metadata fields without full parse

`extractFirstPromptFromHead()` skips:
- `tool_result` blocks
- `isMeta: true` messages
- `isCompactSummary: true` messages
- XML-like auto-generated content (`<[a-z][\w-]*[\s>]` pattern)
- Interrupt markers (`[Request interrupted by user...]`)
- Slash commands (unless they have args and aren't built-in)

---

## Implications for Claudex

1. **Hook context is ephemeral** — `hook_additional_context` attachments are filtered for external users unless `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1`. Claudex's PreToolUse context injection does NOT persist to transcripts by default.

2. **Session ID is stable on resume** — `switchSession()` reuses the original session UUID on `--continue`/`--resume`. Claudex can safely use `sessionId` as a stable key for cross-session correlation.

3. **Metadata in tail window** — Custom titles, tags, agent names, worktree state are re-appended to EOF on exit/compaction. Reading only the last 64KB is sufficient to get current metadata. Claudex should match this pattern for its own session-scoped metadata.

4. **Lite log session IDs** — The `sessionId` field on `LogOption` (for lite logs) comes directly from the JSONL filename (UUID). For full logs it comes from `log.messages[0]?.sessionId`. Claudex's session discovery should handle both.

5. **Subagent transcript paths** — `{projectDir}/{sessionId}/subagents/agent-{agentId}.jsonl`. Claudex's cross-agent indexer should scan this pattern.

6. **Content replacement records** — Written as `content-replacement` JSONL entries. On resume, they're loaded and used to reconstruct `ContentReplacementState` for prompt cache stability. Claudex should NOT interfere with these entries or attempt to rewrite them.

7. **`progress` messages are never in transcripts** — Any Claudex analysis of transcripts will never see progress messages. They're filtered before write for all users.

8. **The attachment filter is the primary limitation** — If Claudex needs context to survive resume, it must use `user` or `system` message types, not `attachment`. Or require users to set `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1` (but even then, only `hook_additional_context` attachment type passes through).
