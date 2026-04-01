# CC Source Research: CLAUDE.md Config Loading

> Research date: 2026-04-01  
> Source repo: `C:/Users/Grigorije/Desktop/Projects/claude-code-buildable/src/`  
> Methodology: Direct source reading. All line numbers and file paths verified.

---

## 1. When Is CLAUDE.md Read?

**Answer: Once per session (memoized), re-read only on explicit cache invalidation.**

The entire CLAUDE.md loading pipeline is memoized via lodash `memoize()` at two layers:

### Layer 1 — `getUserContext()` (outer cache)
```ts
// src/context.ts:155
export const getUserContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    // ...
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    // ...
    return { ...(claudeMd && { claudeMd }), currentDate: ... }
  },
)
```
`getUserContext` is called every time a query fires (`query.ts:660`, `REPL.tsx:2535`, `REPL.tsx:2772`). Because it is memoized, the second and all subsequent calls return the cached result immediately — **no file I/O on subsequent turns**.

### Layer 2 — `getMemoryFiles()` (inner cache)
```ts
// src/utils/claudemd.ts:790
export const getMemoryFiles = memoize(
  async (forceIncludeExternal: boolean = false): Promise<MemoryFileInfo[]> => {
    // ... walks cwd up to root, reads all CLAUDE.md files
  },
)
```

**Sequence on first turn:**
1. `getUserContext()` called → cache miss → calls `getMemoryFiles()`
2. `getMemoryFiles()` called → cache miss → does full filesystem walk + all `readFile()` calls
3. Results stored in both caches
4. `getClaudeMds()` formats all files into a single string

**On every subsequent turn:**
1. `getUserContext()` called → cache hit → returns immediately, no I/O
2. `getMemoryFiles()` is never reached

**Conclusion:** CLAUDE.md is read from disk **once per session** unless the cache is explicitly cleared (see Section 6).

---

## 2. How Many CLAUDE.md Files Are Loaded?

**Answer: Up to 5 tiers, potentially many files.**

The discovery order in `getMemoryFiles()` (`src/utils/claudemd.ts:790–1074`):

| Priority (lowest→highest) | Path | Type |
|---|---|---|
| 1 | `/etc/claude-code/CLAUDE.md` (Linux) / `C:\Program Files\ClaudeCode\CLAUDE.md` (Win) | `Managed` |
| 2 | `/etc/claude-code/.claude/rules/*.md` | `Managed` |
| 3 | `~/.claude/CLAUDE.md` | `User` |
| 4 | `~/.claude/rules/*.md` | `User` |
| 5–N | `CLAUDE.md` at each directory from filesystem root down to CWD | `Project` |
| 5–N | `.claude/CLAUDE.md` at each directory from root down to CWD | `Project` |
| 5–N | `.claude/rules/*.md` at each directory from root down to CWD | `Project` |
| N+1 | `CLAUDE.local.md` at each directory from root down to CWD | `Local` |
| N+2 | `CLAUDE.md` from `--add-dir` directories (env-gated) | `Project` |
| N+3 | `~/.claude/memory/MEMORY.md` (AutoMem, if feature on) | `AutoMem` |
| N+4 | Team memory entrypoint (if feature on) | `TeamMem` |

**Priority is determined by load order: last loaded = highest priority** (model pays more attention to later content).

**Directory walk algorithm** (`src/utils/claudemd.ts:850–934`):
```ts
let currentDir = originalCwd
while (currentDir !== parse(currentDir).root) {
  dirs.push(currentDir)
  currentDir = dirname(currentDir)
}
// Then process dirs.reverse() (root → CWD)
```
Files closer to CWD are loaded later → higher priority.

**`@include` directive:** Files can reference other files with `@path` syntax (up to `MAX_INCLUDE_DEPTH = 5` levels deep). Included files are inserted before the including file. Supported in leaf text nodes, not in code blocks.

**Conditional rules** (`.claude/rules/` with frontmatter `paths:` field): Not loaded eagerly. Loaded per-tool-call via `getMemoryFilesForNestedDirectory()` for glob-matched paths.

**`claudeMdExcludes` setting:** Patterns in `settings.json` can block specific files from loading (glob-matched, symlink-aware).

---

## 3. Where Does CLAUDE.md Content Appear in Context?

**Answer: As a synthetic user message prepended to every API call, NOT in the system prompt.**

### The injection mechanism

```ts
// src/utils/api.ts:449–474
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  return [
    createUserMessage({
      content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${Object.entries(context)
        .map(([key, value]) => `# ${key}\n${value}`)
        .join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

This creates a **user-role message** with an `isMeta: true` flag. It is the **first message** in every API call.

### The system prompt boundary

The `systemContext` (which contains `gitStatus` and optional `cacheBreaker`) is appended to the **system prompt** via `appendSystemContext()`:

```ts
// src/query.ts:449–451
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

```ts
// src/utils/api.ts:437–447
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

**Summary:**
- `claudeMd` → **user message** (first in conversation, `isMeta: true`)
- `gitStatus`, `currentDate` → **system prompt** (appended to base system prompt)
- `currentDate` → **user message** via `getUserContext()` return object

### The formatted output

`getClaudeMds()` (`src/utils/claudemd.ts:1153–1195`) formats the concatenated content as:

```
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

Contents of /path/to/file (user's private global instructions for all projects):

<file content>

Contents of /project/CLAUDE.md (project instructions, checked into the codebase):

<file content>
```

Each file's description suffix:
- `Managed`: (no suffix, loaded first, lowest priority)
- `User`: `(user's private global instructions for all projects)`
- `Project`: `(project instructions, checked into the codebase)`
- `Local`: `(user's private project instructions, not checked in)`
- `AutoMem`: `(user's auto-memory, persists across conversations)`
- `TeamMem`: `(shared team memory, synced across the organization)` — wrapped in `<team-memory-content source="shared">` tags

---

## 4. Token Budget for CLAUDE.md

**Measured reference point:** `src/utils/api.ts:496` logs `claudeMdSize` as `userContext.claudeMd?.length` (character count). The ratio to tokens is approximately 4 chars/token for typical markdown.

**Recommended max:** `MAX_MEMORY_CHARACTER_COUNT = 40000` chars (`src/utils/claudemd.ts:92`). This is a soft limit — files above this are flagged by `getLargeMemoryFiles()` but not truncated (except AutoMem/TeamMem which go through `truncateEntrypointContent()`).

**Analytics:** CC logs `tengu_context_size` event:
```ts
logEvent('tengu_context_size', {
  git_status_size: gitStatusSize,
  claude_md_size: claudeMdSize,   // character count of all CLAUDE.md content
  total_context_size: totalContextSize,
  ...
})
```

**Practical estimate:** The Claudex global `~/.claude/CLAUDE.md` plus the project `CLAUDE.md` together would be ~3,000–8,000 tokens depending on content. Injected as a user message, this consumes from the context window budget on every turn.

**Feature gate `tengu_paper_halyard`:** When this GrowthBook flag is on, `Project` and `Local` typed files are entirely skipped from injection (`src/utils/claudemd.ts:1158–1165`). Allows Anthropic to disable project-level instructions via kill switch.

---

## 5. Is CLAUDE.md Cached Between Turns?

**Yes, aggressively cached via two-layer memoization.**

Both `getUserContext` and `getMemoryFiles` use lodash `memoize()` with no TTL — the cache is permanent until explicitly cleared. On a long session, the CLAUDE.md content read at session start persists in memory for the entire session.

**Key implication:** If you edit `CLAUDE.md` mid-session, the change is **not picked up automatically**. The cached content is used until:
- A compaction event fires (`/compact`, auto-compact)
- `/clear` is used
- A worktree enter/exit occurs
- Settings sync writes a new version

---

## 6. What Triggers a CLAUDE.md Re-Read?

All invalidation paths go through one of two functions:

### `clearMemoryFileCaches()` — cache-only clear, no hook fire
```ts
// src/utils/claudemd.ts:1119–1122
export function clearMemoryFileCaches(): void {
  getMemoryFiles.cache?.clear?.()
}
```
Called by:
- `EnterWorktreeTool.ts:101` — worktree enter
- `ExitWorktreeTool.ts:144` — worktree exit
- `setup.ts:280` — worktree setup when originalCwd changes
- `settingsSync/index.ts:575` — settings sync pulls new memory files
- `teamMemorySync/index.ts:854` — team memory sync pulls new files
- `commands/memory/memory.tsx:9` — imported but cache clear happens via `resetGetMemoryFilesCache` call path

### `resetGetMemoryFilesCache(reason)` — full reset + arms InstructionsLoaded hook
```ts
// src/utils/claudemd.ts:1124–1130
export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}
```
Called by:
- `postCompactCleanup.ts:60` — after compaction (also clears `getUserContext.cache`)
- `commands/clear/caches.ts:84` — after `/clear` or `--resume`/`--continue`

### `getUserContext.cache.clear?.()` — outer cache only
Called by:
- `context.ts:32` — when `setSystemPromptInjection()` changes (cache-breaker)
- `postCompactCleanup.ts:59` — after compaction
- `commands/clear/caches.ts:52` — on `/clear`

### Full invalidation map

| Trigger | Function called | getUserContext cleared | getMemoryFiles cleared | Hook fired |
|---|---|---|---|---|
| Compaction (auto, `/compact`) | `runPostCompactCleanup()` | Yes | Yes | Yes (`'compact'`) |
| `/clear` | `clearSessionCaches()` | Yes | Yes | Yes (`'session_start'`) |
| `--resume`/`--continue` | `clearSessionCaches()` | Yes | Yes | Yes (`'session_start'`) |
| Worktree enter | `clearMemoryFileCaches()` | No | Yes | No |
| Worktree exit | `clearMemoryFileCaches()` | No | Yes | No |
| Settings sync | `clearMemoryFileCaches()` | No | Yes | No |
| Team memory sync | `clearMemoryFileCaches()` | No | Yes | No |
| System prompt injection change | `getUserContext.cache.clear?.()` | Yes | No | No |

**Important:** `clearMemoryFileCaches()` only clears `getMemoryFiles.cache`. If `getUserContext` is still cached and that outer cache is not cleared, the next `getUserContext()` call hits the outer cache hit and **never reaches `getMemoryFiles()`**. This is why compaction and `/clear` always clear both layers.

---

## 7. watchPaths Mechanism for CLAUDE.md Changes

**CLAUDE.md is NOT watched by the built-in file watcher by default.** The `fileChangedWatcher.ts` watches only paths specified in hook `matcher` fields or dynamically via hook output.

### How watchPaths works

1. `fileChangedWatcher.ts` uses **chokidar** (`src/utils/hooks/fileChangedWatcher.ts:67–78`):
```ts
watcher = chokidar.watch(paths, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
  ignorePermissionErrors: true,
})
watcher.on('change', p => handleFileEvent(p, 'change'))
watcher.on('add', p => handleFileEvent(p, 'add'))
watcher.on('unlink', p => handleFileEvent(p, 'unlink'))
```

2. On a file event, it calls `executeFileChangedHooks()` which runs the `FileChanged` hook matchers.

3. Hook output can return `watchPaths` to dynamically update the watched set:
```ts
// src/entrypoints/sdk/coreSchemas.ts:900–905
export const FileChangedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('FileChanged'),
    watchPaths: z.array(z.string()).optional(),
  }),
)
```

4. `SessionStart` and `CwdChanged` hooks can also emit `watchPaths` to seed the watched set.

### To watch CLAUDE.md for live reload

The Claudex `src/adapters/cc-hooks/` PreToolUse hook or SessionStart hook would need to emit `watchPaths: ['/path/to/CLAUDE.md']` and a `FileChanged` hook handler would need to call `clearMemoryFileCaches()`. 

**The CC source does not natively watch CLAUDE.md** — it only re-reads after compaction, `/clear`, or worktree switches. Mid-session edits to CLAUDE.md go undetected until one of those events fires.

### Relationship to `updateWatchPaths`

```ts
// src/utils/hooks/fileChangedWatcher.ts:108–120
export function updateWatchPaths(paths: string[]): void {
  if (!initialized) return
  const sorted = paths.slice().sort()
  // ... dedup check ...
  dynamicWatchPaths = paths
  dynamicWatchPathsSorted = sorted
  restartWatching()
}
```

Merge: static paths (from `matcher` field in `FileChanged` hook config) + dynamic paths (from hook output). The watcher restarts with the combined set.

---

## 8. Can CLAUDE.md Injection Be Controlled or Reduced?

Yes. Multiple control surfaces exist:

### 8.1 Hard disable
```
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1
```
Set in environment → `getUserContext()` skips all CLAUDE.md loading entirely (`src/context.ts:165–167`). Also suppressed in `--bare` mode when no `--add-dir` is specified.

### 8.2 Per-file exclusions (settings.json)
```json
{
  "claudeMdExcludes": ["/path/to/project/CLAUDE.md", "**/secret/**"]
}
```
Glob patterns. Checked by `isClaudeMdExcluded()` per file (`src/utils/claudemd.ts:547–573`). Only applies to `User`, `Project`, `Local` types — `Managed`, `AutoMem`, `TeamMem` are never excluded.

### 8.3 Setting sources (granular disable)
```json
{
  "settingSources": ["userSettings"]  // omit "projectSettings", "localSettings"
}
```
Controls which setting sources are enabled (`isSettingSourceEnabled()`). When `projectSettings` is off, all project-level CLAUDE.md files are skipped. When `userSettings` is off, `~/.claude/CLAUDE.md` is skipped.

### 8.4 Feature gate `tengu_paper_halyard`
Server-side GrowthBook flag. When on, `getClaudeMds()` skips `Project` and `Local` typed files from the rendered string (files are still loaded but not injected into context).

### 8.5 File size limit
`MAX_MEMORY_CHARACTER_COUNT = 40000` chars. Files above this threshold are flagged via `getLargeMemoryFiles()` and surfaced in the `/doctor` output and status warnings. They are not automatically truncated.

### 8.6 HTML comment stripping
Block-level HTML comments (`<!-- ... -->`) are stripped by `stripHtmlComments()` before injection. This allows invisible (to model) metadata in CLAUDE.md files.

### 8.7 Frontmatter `paths:` field (conditional rules)
Files in `.claude/rules/` can have a YAML frontmatter `paths:` field with glob patterns. These files are **not loaded at session start** — they are loaded on-demand only when a tool operates on a matching file path. This is the primary mechanism for reducing session-start token cost.

---

## Architecture Summary

```
getUserContext() [memoized, lodash]
└── getMemoryFiles() [memoized, lodash]
    ├── Managed CLAUDE.md  (/etc/claude-code/ or C:\Program Files\ClaudeCode\)
    ├── Managed .claude/rules/*.md
    ├── User CLAUDE.md     (~/.claude/CLAUDE.md)
    ├── User ~/.claude/rules/*.md
    ├── Walk CWD→root, for each dir:
    │   ├── CLAUDE.md (Project)
    │   ├── .claude/CLAUDE.md (Project)
    │   ├── .claude/rules/*.md (Project, unconditional)
    │   └── CLAUDE.local.md (Local)
    ├── --add-dir dirs (if CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1)
    ├── MEMORY.md (AutoMem, if feature on)
    └── Team memory (TeamMem, if feature on)
    
└── filterInjectedMemoryFiles() [may strip AutoMem/TeamMem if tengu_moth_copse]
└── getClaudeMds() [formats to string, skips if tengu_paper_halyard]

→ Injected as: prependUserContext(messages, { claudeMd: ... })
   → synthetic user message with <system-reminder> wrapper, isMeta: true
   → prepended to messages on EVERY API call (not re-read from disk)
```

### Key files

| File | Role |
|---|---|
| `src/utils/claudemd.ts` | Core: `getMemoryFiles`, `processMemoryFile`, `getClaudeMds`, cache management |
| `src/context.ts` | `getUserContext()` (outer memoized wrapper), `getSystemContext()` |
| `src/utils/api.ts` | `prependUserContext()`, `appendSystemContext()` |
| `src/utils/queryContext.ts` | `fetchSystemPromptParts()` — assembles all three context pieces |
| `src/query.ts:449–660` | Applies contexts to API calls |
| `src/services/compact/postCompactCleanup.ts` | Clears both cache layers after compaction |
| `src/commands/clear/caches.ts` | Clears all caches on `/clear` |
| `src/utils/hooks/fileChangedWatcher.ts` | watchPaths + chokidar file watcher |
| `src/utils/sessionStart.ts` | `processSessionStartHooks()` — collects initial watchPaths from hooks |
| `src/utils/settings/managedPath.ts` | Platform paths for managed CLAUDE.md |
| `src/utils/config.ts:1779` | `getMemoryPath()` — path resolution per memory type |

---

## Implications for Claudex

1. **No re-read cost per turn.** CLAUDE.md is read once, cached, and re-injected from memory. The injection itself (user message prepend) happens every turn but costs no I/O.

2. **Mid-session edits require cache invalidation.** If Claudex updates a CLAUDE.md file mid-session (e.g., via the handoff hook), the change is not visible to the current session until compaction or `/clear`. Using `watchPaths` + `FileChanged` hook to call `clearMemoryFileCaches()` would enable live reload.

3. **User message position is permanent.** The `prependUserContext` call always places CLAUDE.md as the **first user message** in the conversation. It is never in the system prompt. This means it participates in turn counting and is subject to prompt caching rules differently than system prompt content.

4. **Token budget is per-session-start.** Since the content is cached, the token cost is fixed at session start. Compaction re-reads and re-injects, so post-compact CLAUDE.md injection reflects any edits made during the session.

5. **Conditional rules (.claude/rules/ with paths:) are the correct mechanism for reducing session-start token cost.** They are only loaded when tools operate on matching paths.

6. **The `CLAUDE_CODE_DISABLE_CLAUDE_MDS` env var is the only hard kill switch.** `claudeMdExcludes` in settings can selectively suppress individual files.
