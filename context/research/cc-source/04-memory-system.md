# CC Memory System — Source-Level Analysis

**Date:** 2026-04-01
**Source repo:** `claude-code-buildable/src/`
**Purpose:** Understand CC's built-in memory system to inform disabling/replacing it with Claudex.

---

## Architecture Overview

CC's memory system has three distinct, separately-gated subsystems that must be understood and disabled independently:

1. **`MEMORY.md` injection** — always-on static file loaded into system prompt via `userContext.claudeMd`
2. **`findRelevantMemories` prefetch** — per-turn AI-ranked topic file retrieval (feature-gated: `tengu_moth_copse`)
3. **`extractMemories` background agent** — end-of-turn AI that writes new memories (feature-gated: `EXTRACT_MEMORIES` + `tengu_passport_quail`)

Plus auxiliary: **autoDream** (background memory consolidation), **autoDream assistant mode** (KAIROS variant), and **team memory** (TEAMMEM feature).

---

## 1. Directory Structure and Paths

### Source files

```
src/memdir/
  memdir.ts              — core: truncation, buildMemoryLines/Prompt, loadMemoryPrompt
  memoryTypes.ts         — MEMORY_TYPES enum (user/feedback/project/reference), prompt text blocks
  paths.ts               — isAutoMemoryEnabled(), getAutoMemPath(), gate logic
  memoryScan.ts          — scanMemoryFiles(), formatMemoryManifest()
  findRelevantMemories.ts — AI-based relevance selector using sideQuery
  memoryAge.ts           — staleness text (e.g., "saved 47 days ago")
  memoryShapeTelemetry.ts — telemetry only (empty export)
  teamMemPaths.ts        — team memory path variants (TEAMMEM feature gate)
  teamMemPrompts.ts      — combined prompt for team mode
```

### Storage layout on disk

```
~/.claude/projects/<sanitized-git-root>/memory/
  MEMORY.md              — index file (always injected into system prompt when non-empty)
  <topic>.md             — individual topic files (injected on demand by findRelevantMemories)
  logs/YYYY/MM/YYYY-MM-DD.md  — assistant-mode daily log (KAIROS feature only)
```

**Path resolution** (`src/memdir/paths.ts:223–235`):
- Priority 1: `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var (full path override, used by Cowork)
- Priority 2: `autoMemoryDirectory` in settings.json (trusted sources: policy/local/user — NOT project-level, security)
- Priority 3: `<getMemoryBaseDir()>/projects/<sanitized-git-root>/memory/`
  - `getMemoryBaseDir()` returns `CLAUDE_CODE_REMOTE_MEMORY_DIR` or `~/.claude`
  - git root is canonicalized via `findCanonicalGitRoot` so worktrees share one directory

---

## 2. How `isAutoMemoryEnabled()` Works

**File:** `src/memdir/paths.ts:30–54`

Priority chain (first defined wins):

```
1. CLAUDE_CODE_DISABLE_AUTO_MEMORY=1  → false (disabled)
   CLAUDE_CODE_DISABLE_AUTO_MEMORY=0  → true (force-enabled)
2. CLAUDE_CODE_SIMPLE (--bare) → false
3. CLAUDE_CODE_REMOTE && !CLAUDE_CODE_REMOTE_MEMORY_DIR → false
4. settings.json autoMemoryEnabled field → its value
5. Default: true
```

Setting `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` disables ALL three subsystems (injection, retrieval, extraction) because every gate calls this function first.

---

## 3. MEMORY.md Injection into System Prompt

### The injection path

**`src/context.ts:155–189`** — `getUserContext()`:
```typescript
const claudeMd = shouldDisableClaudeMd
  ? null
  : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
return { ...(claudeMd && { claudeMd }), currentDate: ... }
```

`getMemoryFiles()` (`src/utils/claudemd.ts:790`) walks all CLAUDE.md files including auto-memory. At line 980–991 it reads the `MEMORY.md` entrypoint:
```typescript
if (isAutoMemoryEnabled()) {
  const { info: memdirEntry } = await safelyReadMemoryFileAsync(
    getAutoMemEntrypoint(), 'AutoMem',
  )
  if (memdirEntry) { result.push(memdirEntry) }
}
```

`getClaudeMds()` then formats it and includes it in `userContext.claudeMd`. This becomes part of the `user_context` injected into every API call.

**Note on `tengu_moth_copse` flag:** When this GrowthBook flag is on, `filterInjectedMemoryFiles()` (`claudemd.ts:1142–1151`) strips `AutoMem` and `TeamMem` from the system-prompt injection path. Instead, topic files are surfaced via `findRelevantMemories` attachments. The index MEMORY.md is then only an organizational tool, not injected.

### When is `loadMemoryPrompt()` used vs `getMemoryFiles()`?

**`loadMemoryPrompt()`** (`src/memdir/memdir.ts:419–507`) is used for the **memory behavioral instructions** section of the system prompt — it builds the prompt text explaining _how_ to use memory. It is placed in `getSystemPrompt()` (`src/constants/prompts.ts:495`) as `systemPromptSection('memory', ...)`.

**`getMemoryFiles()`** is used for the **content** of MEMORY.md — the actual memories themselves. These go into `userContext.claudeMd`.

So MEMORY.md content appears in `userContext`, while memory instructions appear in `systemPrompt`.

### `loadMemoryPrompt()` behavior

Returns null (no section injected) when `isAutoMemoryEnabled()` is false. Otherwise returns a multi-section prompt covering:
- Instructions for saving memories (two-step: topic file + MEMORY.md index update)
- Types taxonomy (user/feedback/project/reference)
- What NOT to save
- When to access memories
- Staleness caveats
- Optionally: "Searching past context" section (grep commands, gated on `tengu_coral_fern`)

---

## 4. Size Limits and Truncation

### MEMORY.md index limits (`src/memdir/memdir.ts:35–37`)
```typescript
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000
```

Truncation is applied in `truncateEntrypointContent()` (line 57–103):
- Lines truncated first (natural boundary at line 200)
- Then byte-truncated at last newline before 25KB
- A warning is appended explaining which cap fired and why

### Individual topic file limits (`src/utils/attachments.ts:269–277`)
```typescript
const MAX_MEMORY_LINES = 200
const MAX_MEMORY_BYTES = 4096   // 4KB per file
```
Up to 5 files per turn × 4KB = 20KB/turn maximum injection via `relevant_memories` attachments.

### Session-total cap for relevant memories (`src/utils/attachments.ts:279–288`)
```typescript
export const RELEVANT_MEMORIES_CONFIG = {
  MAX_SESSION_BYTES: 60 * 1024,  // 60KB total across session
}
```
Once 60KB of topic files have been surfaced in the session, `startRelevantMemoryPrefetch()` stops entirely (no more retrieval).

### Max memory files scanned (`src/memdir/memoryScan.ts:22`)
```typescript
const MAX_MEMORY_FILES = 200   // per directory, newest-first
```

---

## 5. Memory Entry Format

### MEMORY.md (index file)
Plain Markdown, no frontmatter. Each entry is one line:
```markdown
- [Title](file.md) — one-line hook description
```
Lines after 200 are truncated. Max ~25KB.

### Topic files (individual memory files)
```markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{user, feedback, project, reference}}
---

{{memory content}}
For feedback/project types, structure as:
rule/fact, then **Why:** and **How to apply:** lines
```

**Four memory types** (`src/memdir/memoryTypes.ts:14–19`):
- `user` — user role, goals, knowledge level
- `feedback` — corrections and confirmations from user
- `project` — ongoing work context not in code
- `reference` — pointers to external systems

Frontmatter `description` field drives the AI relevance selector. Vague descriptions → no recall. Specific descriptions → accurate recall.

---

## 6. How `findRelevantMemories` Works (Query-Time Retrieval)

**File:** `src/memdir/findRelevantMemories.ts`

This is a **Sonnet-based AI selector**, not grep-based. The process:

1. **Scan**: `scanMemoryFiles()` reads all `.md` files in memory dir (except MEMORY.md), extracts frontmatter headers (filename, description, type, mtime). Sorted newest-first, capped at 200 files.

2. **Format manifest**: Each file becomes one line: `- [type] filename (ISO timestamp): description`

3. **Sonnet call via `sideQuery()`**: sends the user's query + manifest to Sonnet with JSON schema output requesting `selected_memories: string[]`. Max 5 selections. System prompt:
   ```
   "You are selecting memories that will be useful to Claude Code as it processes a user's query...
   Only include memories that you are certain will be helpful..."
   ```

4. **Read selected files**: `readMemoriesForSurfacing()` reads each selected file up to 200 lines / 4KB.

5. **Inject as `relevant_memories` attachment**: Each file becomes a `<system-reminder>` message with format:
   ```
   Memory (saved 3 days ago): /path/to/file.md:
   
   <file content>
   ```
   Stale memories (>1 day) prepend a staleness warning before the path.

6. **De-duplication**: `alreadySurfaced` set prevents re-surfacing files that appeared in prior turns. Session total capped at 60KB (`MAX_SESSION_BYTES`).

### Trigger mechanism

**`startRelevantMemoryPrefetch()`** (`src/utils/attachments.ts:2361–2424`) is called once per user turn, fires before the model responds:
- Gated on `isAutoMemoryEnabled()` AND `tengu_moth_copse` feature flag
- Extracts the last non-meta user message as query
- Skips single-word queries
- Runs `getRelevantMemoryAttachments()` as async prefetch while the turn processes
- Consumed at attachment collection point — if not settled yet, skipped (no blocking)

**This is NOT grep-based.** The retrieval strategy is AI-ranked by Sonnet on description quality. Topic file `description` fields are the critical selection signal.

---

## 7. `extractMemories` Background Agent

**File:** `src/services/extractMemories/extractMemories.ts`

### What triggers it

Fires from `handleStopHooks()` (`src/query/stopHooks.ts:142–153`) at the end of every completed query loop (when model produces final response, no tool calls pending):
```typescript
if (feature('EXTRACT_MEMORIES') && !toolUseContext.agentId && isExtractModeActive()) {
  void extractMemoriesModule!.executeExtractMemories(stopHookContext, ...)
}
```

Requirements for execution:
- `feature('EXTRACT_MEMORIES')` build flag must be on
- `tengu_passport_quail` GrowthBook flag must be true
- `isAutoMemoryEnabled()` must return true
- Not in remote mode (`getIsRemoteMode()` false)
- Not a subagent (`agentId` must be null/undefined)
- Not `isBareMode()` (not `--bare`)

### Mutual exclusion

If the main conversation already wrote to auto-memory paths (`hasMemoryWritesSince()`), the extractor skips and just advances the cursor. The main agent and extractor are mutually exclusive per turn.

### What it does

Runs a **forked agent** (perfect fork of main conversation — shares prompt cache prefix):
- Provides all recent messages as context
- Pre-injects existing memory file manifest (so agent doesn't spend a turn on `ls`)
- System prompt: extraction instructions with type taxonomy and save format
- Tools allowed: Read, Grep, Glob, read-only Bash, Edit/Write within memory dir only
- `maxTurns: 5` hard cap
- `skipTranscript: true` (doesn't pollute main conversation)

Strategy guided by prompt (`src/services/extractMemories/prompts.ts:39`):
```
"turn 1 — issue all FileRead calls in parallel for every file you might update;
 turn 2 — issue all Write/Edit calls in parallel. Do not interleave reads and writes."
```

### Throttle

`tengu_bramble_lintel` GrowthBook feature value (default 1) controls how many eligible turns must pass between extractions. Trailing extractions (stashed when one is in-progress) skip the throttle.

### Output

When new memory files are written, a `memory_saved` system message is appended to the conversation — a notification that memories were stored.

---

## 8. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` — Exact Behavior

**File:** `src/memdir/paths.ts:30–54`

When `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`:

- `isAutoMemoryEnabled()` returns `false`
- `loadMemoryPrompt()` returns `null` → memory behavioral instructions section removed from system prompt
- `getMemoryFiles()` skips AutoMem entrypoint → MEMORY.md not injected into `userContext.claudeMd`
- `startRelevantMemoryPrefetch()` returns `undefined` → no Sonnet selector call, no topic file injection
- `executeExtractMemories()` returns early → no background memory writing agent
- `executeAutoDream()` calls `isAutoMemoryEnabled()` internally → no consolidation
- Analytics event `tengu_memdir_disabled` is logged with `disabled_by_env_var: true`

**What it does NOT disable:**
- CLAUDE.md loading (`getMemoryFiles` still processes User/Project/Local/Managed types)
- Any other system prompt sections
- The memory behavioral instructions text may still appear if the custom system prompt path bypasses the gate

**Setting via settings.json** (`autoMemoryEnabled: false`):
Same effect as the env var, but lower priority. Can be set at user, local, or policy settings level (not project-level for security reasons).

**`CLAUDE_CODE_SIMPLE` (--bare) flag:**
Also disables memory via a different code path. `isAutoMemoryEnabled()` returns false when `CLAUDE_CODE_SIMPLE=1`. Additionally `isBareMode()` in `handleStopHooks()` skips the entire background bookkeeping block (prompt suggestion, memory extraction, auto-dream).

---

## 9. Controls Summary

| Control | Type | Effect |
|---------|------|--------|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | env var | Disables all memory: no injection, no retrieval, no extraction |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` | env var | Force-enables (overrides settings.json) |
| `autoMemoryEnabled: false` in settings.json | setting | Same as env var, lower priority |
| `CLAUDE_CODE_SIMPLE=1` / `--bare` | env var | Disables memory + all background tasks |
| `tengu_moth_copse` GrowthBook flag | feature flag | Switches from system-prompt injection to per-turn attachment-based injection |
| `tengu_passport_quail` GrowthBook flag | feature flag | Controls `extractMemories` background agent activation |
| `feature('EXTRACT_MEMORIES')` | build flag | Tree-shakes extract subsystem entirely in external builds |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | env var | Redirects memory dir (used by Cowork for multi-tenant isolation) |
| `autoMemoryDirectory` in settings.json | setting | Custom memory dir path (user/local/policy only, not project) |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` | env var | Appends extra guidelines to memory behavioral instructions |
| `autoDreamEnabled: false` in settings.json | setting | Disables background consolidation independently of main memory |

---

## 10. Token Cost Estimates

### System prompt (behavioral instructions from `loadMemoryPrompt()`)

`buildMemoryLines()` generates roughly:
- Header + description: ~40 lines
- Types taxonomy (TYPES_SECTION_INDIVIDUAL): ~75 lines
- What NOT to save: ~10 lines
- How to save: ~12 lines
- When to access: ~5 lines
- Trusting recall section: ~12 lines
- Memory vs other persistence: ~6 lines

Total behavioral instructions: **~160 lines, ~4,000–5,000 tokens** per session (cached after first call).

### MEMORY.md content in userContext

Capped at 200 lines / 25KB. At p97 usage: ~197KB observed under 200 lines (hence the byte cap). Typical: a populated MEMORY.md index with 30–50 entries ≈ 50–150 lines ≈ **500–2,000 tokens**.

### Per-turn relevant memories attachments (`tengu_moth_copse` on)

Up to 5 files × 4KB each = 20KB/turn maximum. Each Sonnet selector call costs ~256 output tokens. Session cap: 60KB ≈ **~15,000 tokens** maximum across the session (15 × 4KB files × ~250 tokens/KB).

### extractMemories background agent

Per extraction run (fires every turn by default with `tengu_bramble_lintel=1`):
- Full conversation replay as input (shared cache hit for most tokens)
- 2–4 turns typical (read + write)
- Observed cache hit rates: ~80–90% input cache

Net new token cost per extraction: **~500–2,000 tokens** for uncached portion + output.

### `/context` tool observation (from `src/utils/contextSuggestions.ts:212`)

CC's own context visualizer tracks `totalMemoryTokens` separately and suggests pruning when usage is significant. A typical loaded session with several memory files: CC suggests action when memory is "using X tokens (Y%)".

---

## 11. Injection Position in Context

### System prompt order (`src/constants/prompts.ts`)

The `getSystemPrompt()` function uses `systemPromptSection` with named sections. Memory is one of these: `systemPromptSection('memory', () => loadMemoryPrompt())`. The memory section appears after `session_guidance` and before `env_info_simple`.

### User context (`getUserContext()` in `src/context.ts`)

Returns a dict with `claudeMd` key. This is prepended to every API call as part of the `user_context`. MEMORY.md content (AutoMem type) appears alongside Project/User/Local CLAUDE.md content as one merged string.

The format in `getClaudeMds()` (`src/utils/claudemd.ts:1153+`):
```
Contents of /path/to/MEMORY.md (user's auto-memory, persists across conversations):

<MEMORY.md content>
```

### Relevant memories attachments (`relevant_memories` type)

Injected as `<system-reminder>` wrapping each file separately. Each appears as a user message (isMeta=true) with format:
```
<system-reminder>
Memory (saved 3 days ago): /path/to/file.md:

<file content>
</system-reminder>
```

These appear immediately before the current user turn in the message array, giving them high recency weight.

---

## 12. Feature Flag Architecture

CC uses GrowthBook for A/B testing. Feature flags relevant to memory:

| Flag | Purpose |
|------|---------|
| `tengu_passport_quail` | Enable `extractMemories` background agent |
| `tengu_moth_copse` | Switch to prefetch-based injection (instead of system prompt for MEMORY.md) |
| `tengu_coral_fern` | Add "Searching past context" grep instructions to memory prompt |
| `tengu_herring_clock` | Whether user is in team-memory cohort |
| `tengu_bramble_lintel` | Extraction throttle (turns between extractions, default 1) |
| `tengu_slate_thimble` | Enable extraction in non-interactive sessions |

Build-time flags (tree-shaken in external builds):
- `feature('EXTRACT_MEMORIES')` — includes/excludes background extraction subsystem
- `feature('TEAMMEM')` — includes/excludes team memory subsystem
- `feature('KAIROS')` — includes/excludes assistant-mode daily log behavior

---

## 13. Claudex Displacement Strategy

To fully disable CC's memory system and replace with Claudex:

### Complete disable (recommended)
```bash
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
```
Disables all three subsystems. Claudex injects its own context via the PreToolUse hook and system-reminder mechanism, which is superior.

### What Claudex replaces

| CC Subsystem | Claudex Equivalent |
|---|---|
| MEMORY.md static index | Hybrid retrieval from SQLite+Qdrant (5-channel RRF) |
| `findRelevantMemories` (Sonnet selector) | Experience patterns (Q-value RL + exponential decay), semantic embeddings |
| `extractMemories` background agent | PostToolUse hook + session-end extraction with contradiction detection |
| Type taxonomy (user/feedback/project/reference) | observations table with classification |
| Memory behavioral instructions (~5K tokens) | Claudex awareness injected via PreToolUse hook |

### Token savings from disabling CC memory

- Behavioral instructions section: ~4,000–5,000 tokens (system prompt, cached)
- MEMORY.md content: ~500–2,000 tokens (userContext, per session)
- `findRelevantMemories` Sonnet calls: ~500 tokens × N turns
- `extractMemories` agent: ~500–2,000 tokens × N turns

**Conservative estimate: 5,000–10,000 tokens saved per session** for a typical dev session with an established memory directory. The behavioral instructions alone are a fixed 5K token overhead even when MEMORY.md is empty.

### Claudex already handles the PreToolUse injection

The `PreToolUse` hook in Claudex already injects context into every API call. The Claudex assembly pipeline handles what `loadMemoryPrompt()` + MEMORY.md injection do in CC, but with far richer retrieval (hybrid 5-channel RRF, embeddings, Q-value experience patterns) rather than flat file reading.

---

## Key Files Reference

```
src/memdir/memdir.ts                          — Core: truncation, prompt building, loadMemoryPrompt
src/memdir/paths.ts                           — isAutoMemoryEnabled(), path resolution
src/memdir/memoryTypes.ts                     — Type taxonomy, prompt text constants
src/memdir/memoryScan.ts                      — scanMemoryFiles(), formatMemoryManifest()
src/memdir/findRelevantMemories.ts            — Sonnet-based AI relevance selector
src/memdir/memoryAge.ts                       — Staleness text formatting
src/services/extractMemories/extractMemories.ts — Background extraction agent
src/services/extractMemories/prompts.ts       — Extraction agent prompt templates
src/services/autoDream/autoDream.ts           — Background memory consolidation
src/utils/claudemd.ts                         — getMemoryFiles(), MEMORY.md injection path
src/context.ts                                — getUserContext() — where claudeMd is assembled
src/constants/prompts.ts                      — getSystemPrompt(), memory section placement
src/utils/attachments.ts                      — relevant_memories attachment, startRelevantMemoryPrefetch
src/utils/messages.ts                         — wrapMessagesInSystemReminder for memory attachments
src/query/stopHooks.ts                        — Trigger point for extractMemories after each turn
src/utils/backgroundHousekeeping.ts           — initExtractMemories() called at startup
src/entrypoints/cli.tsx                       — ABLATION_BASELINE sets CLAUDE_CODE_DISABLE_AUTO_MEMORY
src/tools/ConfigTool/supportedSettings.ts     — autoMemoryEnabled config definition
```
