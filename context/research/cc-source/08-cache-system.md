# CC Prompt Cache System — Source Analysis

**Research date:** 2026-04-01
**CC source:** `C:/Users/Grigorije/Desktop/Projects/claude-code-buildable/src/`
**Primary files analyzed:**
- `services/api/claude.ts` — core query builder, cache breakpoint placement
- `services/api/promptCacheBreakDetection.ts` — client-side break detection system
- `utils/api.ts` — system prompt splitting (`splitSysPromptPrefix`), `CacheScope`, `toolToAPISchema`
- `utils/fingerprint.ts` — fingerprint bug
- `utils/forkedAgent.ts` — `CacheSafeParams`, forked agent cache sharing
- `utils/modelCost.ts` — cache pricing tiers
- `services/claudeAiLimits.ts` — rate limit / weekly limit interaction
- `services/api/emptyUsage.ts` — `NonNullableUsage` shape
- `constants/betas.ts` — `PROMPT_CACHING_SCOPE_BETA_HEADER`
- `constants/prompts.ts` — `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
- `utils/betas.ts` — `shouldUseGlobalCacheScope()`

---

## 1. How CC's Prompt Caching Works — Strategy Overview

CC uses Anthropic's server-side prompt caching. Every API call is built with `cache_control` markers. The server caches everything up to the last marker and reuses the KV cache on subsequent calls where the prefix is identical.

### Three-layer strategy

CC has three distinct cache strategies, selected per call:

**Strategy A: `system_prompt` (default for 1P without MCP tools)**
- Cache marker placed on system prompt blocks using `scope: 'global'`
- Static system prompt content is cached across orgs (cross-org, not just per-session)
- Dynamic content after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` gets no cache marker
- Uses beta header `prompt-caching-scope-2026-01-05`

**Strategy B: `none` (when MCP tools are present and non-deferred)**
- MCP tools are per-user, so they cannot be globally cached
- Falls back to org-level (`scope: 'org'`) cache markers on system prompt blocks only
- No global scope is used for the system prompt either
- Comment in code: "MCP tools are per-user → dynamic tool section → can't globally cache"

**Strategy C: Tool-based (`tool_based` — referenced in logging but not a live strategy)**
- `GlobalCacheStrategy` type in `logging.ts` is `'tool_based' | 'system_prompt' | 'none'`
- In practice the code currently logs `'none'` when MCP tools are present (not `'tool_based'`)
- The name `tool_based` refers to a historical design where the cache marker was placed on the last tool schema instead of the system prompt

### Key variable: `needsToolBasedCacheMarker`

```typescript
// src/services/api/claude.ts:1212-1214
const needsToolBasedCacheMarker =
  useGlobalCacheFeature &&
  filteredTools.some(t => t.isMcp === true && !willDefer(t))
```

When `needsToolBasedCacheMarker` is true: `skipGlobalCacheForSystemPrompt` is passed to `buildSystemPromptBlocks`, which causes all system blocks to use `scope: 'org'` instead of `scope: 'global'`.

---

## 2. Cache Breakpoint Placement — Exactly What Gets Marked

### System prompt blocks (`buildSystemPromptBlocks`)

`src/services/api/claude.ts:3213-3237` calls `splitSysPromptPrefix()` which returns `SystemPromptBlock[]` with `cacheScope` set per block.

`splitSysPromptPrefix()` in `src/utils/api.ts:321-434` has three modes:

**Mode 1 — MCP tools present (skipGlobalCacheForSystemPrompt=true):**
```
Attribution header → cacheScope: null   (NOT cached)
System prompt prefix → cacheScope: 'org'
Everything else joined → cacheScope: 'org'
```

**Mode 2 — Global cache + DYNAMIC_BOUNDARY found (1P, no MCP):**
```
Attribution header → cacheScope: null
System prompt prefix → cacheScope: null
Static content before boundary → cacheScope: 'global'
Dynamic content after boundary → cacheScope: null (NOT cached at all)
```

**Mode 3 — Default (3P providers, or boundary missing):**
```
Attribution header → cacheScope: null
System prompt prefix → cacheScope: 'org'
Everything else joined → cacheScope: 'org'
```

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'` is the sentinel string that separates cross-org-cacheable static content from session-specific dynamic content (`src/constants/prompts.ts:114`).

Each `SystemPromptBlock` with a non-null `cacheScope` gets `cache_control` injected:
```typescript
// src/services/api/claude.ts:3226-3234
{
  type: 'text' as const,
  text: block.text,
  ...(enablePromptCaching && block.cacheScope !== null && {
    cache_control: getCacheControl({
      scope: block.cacheScope,
      querySource: options?.querySource,
    }),
  }),
}
```

**Warning at line 3221:** "Do not add any more blocks for caching or you will get a 400" — only one cache marker is allowed per system prompt section boundary.

### Message-level breakpoints (`addCacheBreakpoints`)

`src/services/api/claude.ts:3063-3211`

**Exactly one message-level `cache_control` marker per request.** The placement:

```typescript
// src/services/api/claude.ts:3089
const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
```

- Normal calls: marker placed on the **last message** (always the most recent user/assistant turn)
- `skipCacheWrite` (fire-and-forget forks): marker placed on **second-to-last** message — this is the last shared-prefix point, so the write is a no-op merge on Mycro (no new KV cache entry created for the fork's unique tail)

**Why only one marker:**
```
// Mycro's turn-to-turn eviction (page_manager/index.rs: Index::insert) frees
// local-attention KV pages at any cached prefix position NOT in
// cache_store_int_token_boundaries. With two markers the second-to-last
// position is protected and its locals survive an extra turn even though
// nothing will ever resume from there
```
One marker = Mycro can free local-attention KV pages at the penultimate position immediately.

**Which block in each message gets the marker:**
- String content: converted to array with `cache_control` on the single block
- Array content (user): `cache_control` on the **last block** of the array
- Array content (assistant): `cache_control` on the last non-thinking, non-redacted-thinking, non-connector-text block

### Tool schema cache markers

`src/utils/api.ts:228-230` — tool schemas accept a `cacheControl` option passed by the caller. However, from `src/services/api/claude.ts:1235-1246`, tools are built **without** a `cacheControl` in the `toolToAPISchema` call — tools do not get individual `cache_control` markers in current code. The comment at line 1388 confirms: "toolSchemas (which carries the cache_control marker)" refers to the tool list being placed after the system prompt in the API request, not individual tool markers.

### `cache_reference` on tool_result blocks

When `CACHED_MICROCOMPACT` is enabled, `cache_reference` is added to `tool_result` blocks that appear strictly before the last `cache_control` marker:
```typescript
// src/services/api/claude.ts:3196-3205
msg.content[j] = Object.assign({}, block, {
  cache_reference: block.tool_use_id,
})
```
This links tool results to the cached prefix for the cache editing (microcompact) feature.

---

## 3. Cache Prefix Construction — How the Key is Built

The Anthropic server-side cache key is composed of:
```
system prompt + tools + model + messages (prefix) + thinking config
```

This is documented explicitly in `src/utils/forkedAgent.ts:46-55`:
```typescript
/**
 * Parameters that must be identical between the fork and parent API requests
 * to share the parent's prompt cache. The Anthropic API cache key is composed of:
 * system prompt, tools, model, messages (prefix), and thinking config.
 */
export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext  // contains tools, model, thinkingConfig
  forkContextMessages: Message[]
}
```

**Note on thinking config:** The comment at line 96-101 warns: "setting maxOutputTokens changes both max_tokens AND budget_tokens (via clamping in claude.ts). If the fork uses cacheSafeParams to share the parent's prompt cache, a different budget_tokens will invalidate the cache — thinking config is part of the cache key."

### Everything that CC tracks as part of the cache key

From `promptCacheBreakDetection.ts:28-68`, the `PreviousState` object tracks:
- `systemHash` — hash of system prompt content (without `cache_control`)
- `toolsHash` — hash of all tool schemas (without `cache_control`)
- `cacheControlHash` — hash of system prompt WITH `cache_control` (catches scope/TTL flips)
- `toolNames` — ordered list of tool names
- `perToolHashes` — per-tool schema hashes (to identify which specific tool changed)
- `systemCharCount`
- `model`
- `fastMode` (whether fast mode header is latched)
- `globalCacheStrategy`
- `betas` — sorted list of beta headers
- `autoModeActive` — AFK mode header latched
- `isUsingOverage` — overage state
- `cachedMCEnabled` — cache editing header latched
- `effortValue`
- `extraBodyHash` — hash of `getExtraBodyParams()` (catches `CLAUDE_CODE_EXTRA_BODY`)

### The beta header latch system (cache-stability mechanism)

This is a critical cache stability design. Beta headers that toggle mid-session bust the server cache key. CC solves this with "sticky-on latches":

```typescript
// src/services/api/claude.ts:1405-1441
// Sticky-on latches for dynamic beta headers. Each header, once first
// sent, keeps being sent for the rest of the session so mid-session
// toggles don't change the server-side cache key and bust ~50-70K tokens.
// Latches are cleared on /clear and /compact via clearBetaHeaderLatches().
```

Four headers are latched:
- `afkModeHeaderLatched` — AFK/auto mode (`afk-mode-2026-01-31`)
- `fastModeHeaderLatched` — fast mode (`fast-mode-2026-02-01`)
- `cacheEditingHeaderLatched` — cached microcompact (`CACHE_EDITING_BETA_HEADER`)
- `thinkingClearLatched` — context management thinking clear

Once any of these headers is first sent, it continues to be sent for the rest of the session. Latches are reset on `/clear` and `/compact` (`clearBetaHeaderLatches()` via `clearSystemPromptSections()`).

### Overage state TTL latch

```typescript
// src/services/api/claude.ts:403-412
// Latch eligibility in bootstrap state for session stability — prevents
// mid-session overage flips from changing the cache_control TTL, which
// would bust the server-side prompt cache (~20K tokens per flip).
let userEligible = getPromptCache1hEligible()
if (userEligible === null) {
  userEligible =
    process.env.USER_TYPE === 'ant' ||
    (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
  setPromptCache1hEligible(userEligible)
}
```

The 1h TTL eligibility is computed once and latched in bootstrap state. If overage status flips mid-session (which would change TTL from `1h` to `5m`), the latch prevents the flip and preserves the cache key.

---

## 4. TTL (Time-to-Live) for Cached Content

Two TTLs exist, controlled by `getCacheControl()` in `src/services/api/claude.ts:358-374`:

```typescript
export function getCacheControl({ scope, querySource } = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

- **Default (no `ttl` field): 5 minutes** — server default for `type: 'ephemeral'`
- **`ttl: '1h'`: 1 hour** — for eligible users

TTL constants in `promptCacheBreakDetection.ts`:
```typescript
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000
```

### 1h TTL eligibility (`should1hCacheTTL`)

`src/services/api/claude.ts:393-434`

Requirements:
1. Bedrock with `ENABLE_PROMPT_CACHING_1H_BEDROCK=true` env var — unconditional
2. 1P first-party users: must be either `USER_TYPE === 'ant'` (Anthropic employee) OR a Claude.ai subscriber NOT currently using overage
3. The `querySource` must match patterns in the GrowthBook `tengu_prompt_cache_1h_config.allowlist`
4. Allowlist patterns support trailing `*` for prefix matching (e.g., `"repl_main_thread*"` matches all repl main thread sources)

If eligibility is true but the querySource is not in the allowlist, `ttl: '1h'` is not sent (5-minute TTL applies).

Both the eligibility and the allowlist are cached in bootstrap state for session stability (preventing mid-request GrowthBook flips from creating mixed TTLs).

---

## 5. The "Fingerprint" — What It Is and the Bug

The fingerprint is **not related to the prompt cache key** at all. It is a 3-character attribution mechanism for billing/tracking.

`src/utils/fingerprint.ts`:

```typescript
export const FINGERPRINT_SALT = '59cf53e54c78'

export function computeFingerprint(messageText: string, version: string): string {
  // Extract chars at indices [4, 7, 20], use "0" if index not found
  const indices = [4, 7, 20]
  const chars = indices.map(i => messageText[i] || '0').join('')
  const fingerprintInput = `${FINGERPRINT_SALT}${chars}${version}`
  const hash = createHash('sha256').update(fingerprintInput).digest('hex')
  return hash.slice(0, 3)
}
```

Algorithm:
1. Take characters at indices 4, 7, 20 from the first user message text
2. Prepend hardcoded salt `59cf53e54c78`
3. Append `MACRO.VERSION` (the build version)
4. SHA256 → first 3 hex chars

The fingerprint is sent as part of the attribution header (prepended to the system prompt, in the block marked `cacheScope: null` — not cached):
```
x-anthropic-billing-header: {fingerprint}
```

The fingerprint is computed BEFORE any synthetic messages are injected:
```typescript
// src/services/api/claude.ts:1322-1325
// Must run BEFORE injecting synthetic messages (e.g. deferred tool names)
// so the fingerprint reflects the actual user input.
const fingerprint = computeFingerprintFromMessages(messagesForAPI)
```

**The "fingerprint bug" the community reported** relates to the deferred tools prepend that existed BEFORE the delta attachment system. The code comment at line 1327-1329 explains:
```
// When the delta attachment is enabled, deferred tools are announced
// via persisted deferred_tools_delta attachments instead of this
// ephemeral prepend (which busts cache whenever the tool pool changes).
```
The historical bug: when tool search was enabled and new MCP tools were discovered, CC would prepend an `<available-deferred-tools>` synthetic message before the real messages. This changed the message array, which changed the fingerprint (since the first user message shifted position), AND busted the prompt cache on every reconnection/discovery. The fix was the delta attachment system, which persists the deferred tools list as an attachment rather than prepending it ephemeral per-call.

**The fingerprint does not affect the server-side prompt cache key.** It only appears in the attribution header text, which is placed in `cacheScope: null` (not cached). If the fingerprint changed, it would change the text of the attribution header, which would be different from the cached version — but since the attribution header is not marked with `cache_control`, it does not affect what the server caches.

---

## 6. Cache Interaction with Compaction

### Standard compaction (`/compact`)

After compaction, the message history is replaced by a summary. The previous cached prefix is now invalid (completely different messages), so:

1. `notifyCompaction()` is called in `services/compact/compact.ts` → `promptCacheBreakDetection.ts`:
```typescript
export function notifyCompaction(querySource, agentId) {
  const state = previousStateBySource.get(key)
  if (state) {
    state.prevCacheReadTokens = null  // Reset baseline
  }
}
```
This prevents false-positive "cache break detected" warnings on the first post-compact API call.

2. Beta header latches are **cleared** on compact via `clearBetaHeaderLatches()` so the next session starts fresh.

3. The compact call itself shares `querySource: 'compact'` which maps to the same tracking key as `repl_main_thread` (they share the same server-side cache):
```typescript
// promptCacheBreakDetection.ts:153
if (querySource === 'compact') return 'repl_main_thread'
```
This is because compact uses identical `cacheSafeParams` as the main thread — same system prompt, tools, model. The compact summary replaces messages but the system prompt prefix remains cached.

### Cached MicroCompact (`CACHED_MICROCOMPACT` feature)

This is the advanced cache editing feature (ant-only, first-party only). Instead of replacing the entire conversation, it sends `cache_edits` blocks that delete specific tool results from the KV cache without invalidating the whole prefix:

```typescript
// src/services/api/claude.ts:2965
// cache_deleted_input_tokens: returned by the API when cache editing
// deletes KV cache content
```

When cache deletions are sent, `notifyCacheDeletion()` is called to suppress the false-positive break warning that would otherwise fire when `cache_read_input_tokens` drops.

The `cache_edits` blocks are pinned and re-sent on subsequent calls (via `pinnedEdits` in `addCacheBreakpoints`). The `cache_reference` field on `tool_result` blocks tells the server which KV cache entries correspond to those results.

---

## 7. Resumed Session Caching vs Fresh Session

### Fresh session
- All latches are `null` (afk, fast mode, cache editing, thinking clear)
- TTL eligibility latched on first API call
- Cache prefix starts fresh — first call always has `cache_creation_input_tokens > 0`

### Resumed session (`--resume`)
- Session transcript is loaded from disk (`sessionStorage.ts`)
- Messages are restored including tool results
- **The server-side cache key is fully reconstructed** if the system prompt, tools, and model are identical to the previous session
- If the user resumes within the TTL window (5 min or 1h), the server's cached KV still exists and cache reads happen immediately
- If resumed after TTL expiry, `cache_creation_input_tokens > 0` again (recaching cost)

The latch values are NOT persisted — they are recomputed fresh on the next API call:
- This means a resumed session re-evaluates auto mode, fast mode etc. from scratch
- The `should1hCacheTTL` eligibility is latched fresh from bootstrap state

### What "sharing cache with parent" means (forked agents)

`CacheSafeParams` is passed to forked agents to ensure cache hits:
```typescript
// src/utils/forkedAgent.ts:56-68
export type CacheSafeParams = {
  systemPrompt: SystemPrompt      // must match parent
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext   // contains tools, model, thinkingConfig
  forkContextMessages: Message[]  // parent's messages = shared prefix
}
```

`lastCacheSafeParams` is written after each main loop turn and read by post-turn forks (promptSuggestion, postTurnSummary, `/btw`). These forks get cache hits on the main thread's prefix because they use the same system prompt, tools, and messages.

`skipCacheWrite` flag: fire-and-forget forks set this so their unique tail (the prompt message appended after `forkContextMessages`) doesn't create a new cache entry that nobody will read:
```typescript
const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
```

---

## 8. Cache Hit vs Cache Miss — What Determines It

### Hit conditions (server side)

The server returns `cache_read_input_tokens > 0` when:
1. The exact prefix (system + tools + model + messages up to the cache marker + thinking config) matches an existing cached entry
2. The TTL has not expired
3. No server-side routing caused a miss (different inference node, eviction under pressure)

### Miss detection (client side, `checkResponseForCacheBreak`)

CC detects a cache miss when:
```typescript
const tokenDrop = prevCacheRead - cacheReadTokens
if (
  cacheReadTokens >= prevCacheRead * 0.95 ||  // < 5% drop = not a miss
  tokenDrop < MIN_CACHE_MISS_TOKENS             // < 2000 tokens = noise
) {
  // Not a break
}
```

A break is detected when `cache_read_input_tokens` drops by more than 5% AND more than 2000 tokens from the previous call.

### Root causes tracked by `PendingChanges`

The system tracks which field changed to explain why the cache broke:
- `systemPromptChanged` — system prompt text changed
- `toolSchemasChanged` — tool schemas changed (per-tool hashes identify which one)
- `modelChanged` — model changed
- `fastModeChanged` — fast mode header toggled (historical, now latched)
- `cacheControlChanged` — scope or TTL flip
- `globalCacheStrategyChanged` — MCP tools added/removed
- `betasChanged` — beta header set changed
- `autoModeChanged` — auto mode header toggled (historical, now latched)
- `overageChanged` — overage state changed (historical, now latched via TTL latch)
- `cachedMCChanged` — cache editing header toggled (historical, now latched)
- `effortChanged` — effort value changed
- `extraBodyChanged` — `CLAUDE_CODE_EXTRA_BODY` env var content changed

**BQ analysis comment** (line 573-578): After PR #19823, when all client-side flags are false and the gap is under TTL, ~90% of breaks are server-side routing/eviction. The code labels these as "likely server-side (prompt unchanged, <5min gap)" rather than prompting investigation of a CC bug.

### Common cache-busting patterns identified in source

1. **MCP tool discovery** — new MCP tools cause `globalCacheStrategyChanged` from `'system_prompt'` to `'none'`
2. **Tool schema drift** — AgentTool and SkillTool embed dynamic agent/command lists. 77% of tool breaks are schema changes with the same tool count.
3. **Chrome tool connect late** — injecting Chrome tool search instructions per-request bust cache when Chrome connects mid-session (fixed by `isMcpInstructionsDeltaEnabled()`)
4. **Deferred tool pool change** — before delta attachment, new MCP tool discovery would prepend synthetic message (now fixed)

---

## 9. Cache Token Cost Toward Weekly Limit

### Pricing (from `src/utils/modelCost.ts`)

| Model | Input | Output | Cache Write | Cache Read |
|-------|-------|--------|-------------|------------|
| Sonnet 4.6 | $3/Mtok | $15/Mtok | **$3.75/Mtok** | **$0.3/Mtok** |
| Opus 4.6 | $5/Mtok | $25/Mtok | **$6.25/Mtok** | **$0.5/Mtok** |
| Haiku 4.5 | $1/Mtok | $5/Mtok | **$1.25/Mtok** | **$0.1/Mtok** |
| Opus 4/4.1 | $15/Mtok | $75/Mtok | **$18.75/Mtok** | **$1.5/Mtok** |

Cache write costs **1.25x** the base input token price. Cache reads cost **0.1x** the base input token price (90% discount vs regular input).

### How they count toward the weekly limit

CC tracks `cache_read_input_tokens` and `cache_creation_input_tokens` separately from `input_tokens` in `NonNullableUsage`. All three counts are tracked in `modelUsage` per model in `bootstrap/state.ts`.

The rate limiting headers from Anthropic are:
```
anthropic-ratelimit-unified-5h-utilization
anthropic-ratelimit-unified-7d-utilization
anthropic-ratelimit-unified-5h-reset
anthropic-ratelimit-unified-7d-reset
```

The weekly utilization (`seven_day`) is the relevant limit for the Claudex token budget concern. CC does NOT internally calculate whether cache tokens count toward this limit — it reads the server-sent utilization header. The server determines what counts.

**From the source, context window size is calculated as:**
```typescript
// src/utils/analyzeContext.ts:1166-1170
const totalFromAPI = apiUsage
  ? apiUsage.input_tokens +
    apiUsage.cache_creation_input_tokens +
    apiUsage.cache_read_input_tokens
  : null
```
Cache tokens ARE included in context window size calculations. Whether they count toward the weekly token *limit* is a server-side billing decision not visible in CC source.

**Cache read tokens are far cheaper than fresh input tokens.** For Sonnet 4.6: $0.30 vs $3.00 per million — 10x cheaper. For the weekly limit, cache reads represent significantly less utilization per token than fresh input.

---

## 10. Can Claudex Hooks Influence Caching?

### What hooks can affect

Hooks in CC are shell commands (or function hooks) that run in response to events (PreToolUse, PostToolUse, UserPromptSubmit, Stop). They cannot directly modify the API request parameters or inject `cache_control` markers.

However, hooks CAN influence caching **indirectly** through these mechanisms:

**a) System prompt modification via hook output**
Hooks can append content to user messages or add `<system-reminder>` tags. Content added via `UserPromptSubmit` appears in the next user message. This content will be included in the next API request's message array. Since the cache marker is placed on the last message, this affects what gets cached on that turn — but the previous prefix remains intact.

**Important:** `prependUserContext()` in `src/utils/api.ts:449-473` creates a synthetic user message with context wrapped in `<system-reminder>`. This is prepended to messages but marked `isMeta: true`. The Claudex `system-reminder` injection pattern (from the project's existing hook) works this way.

**b) What Claudex's PreToolUse hook currently does**
The project uses a PreToolUse hook that injects Claudex awareness into Agent subagent prompts. This modifies the subagent's system prompt, which means the subagent's cache key is different from the parent's. Since subagents use separate `agentId`-based tracking, this does not affect the main thread's cache.

**c) What hooks CANNOT do**
- Hooks cannot add `cache_control` markers to messages
- Hooks cannot change the TTL
- Hooks cannot force a cache hit or miss
- Hooks cannot change the system prompt for the current turn (system prompt is built before hook execution in the query pipeline)

**d) The most impactful thing hooks can do for caching**
Keeping the system prompt stable. If a hook's output causes the system prompt content to change (via `CLAUDE.md` hot reload detection — which CC watches via `watchPaths`), this would cause a `systemPromptChanged` break. The Claudex project already tracks `watchPaths` for CLAUDE.md and handoff files.

**e) Subagent context injection (Claudex's current approach)**
The Claudex PreToolUse hook injects Claudex awareness into subagent prompts. This modifies the subagent's `system` prompt, giving each Agent tool call a different cache prefix. For Claudex's use case this is correct (each subagent needs its own context), but it means Claudex-injected subagents don't share cache with non-injected ones.

---

## 11. Key Constants and Configuration

| Constant | Value | Location |
|----------|-------|----------|
| `CACHE_TTL_5MIN_MS` | 5 minutes | `promptCacheBreakDetection.ts:125` |
| `CACHE_TTL_1HOUR_MS` | 60 minutes | `promptCacheBreakDetection.ts:126` |
| `MIN_CACHE_MISS_TOKENS` | 2,000 | `promptCacheBreakDetection.ts:120` |
| `MAX_TRACKED_SOURCES` | 10 | `promptCacheBreakDetection.ts:107` |
| `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | `'__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'` | `constants/prompts.ts:114` |
| `PROMPT_CACHING_SCOPE_BETA_HEADER` | `'prompt-caching-scope-2026-01-05'` | `constants/betas.ts:17-18` |
| `FINGERPRINT_SALT` | `'59cf53e54c78'` | `utils/fingerprint.ts:8` |

### Environment variables controlling caching

| Variable | Effect |
|----------|--------|
| `DISABLE_PROMPT_CACHING` | Disable all prompt caching globally |
| `DISABLE_PROMPT_CACHING_HAIKU` | Disable for small/fast model |
| `DISABLE_PROMPT_CACHING_SONNET` | Disable for default Sonnet |
| `DISABLE_PROMPT_CACHING_OPUS` | Disable for default Opus |
| `ENABLE_PROMPT_CACHING_1H_BEDROCK` | Enable 1h TTL for Bedrock users |

---

## 12. `usage.cache_creation` Breakdown (1h vs 5m)

The usage response includes a breakdown of which TTL tier the cache was written to:

```typescript
// src/services/api/emptyUsage.ts:15-18
cache_creation: {
  ephemeral_1h_input_tokens: 0,
  ephemeral_5m_input_tokens: 0,
}
```

This is tracked in the streaming merge logic:
```typescript
// src/services/api/claude.ts:2956-2963
cache_creation: {
  ephemeral_1h_input_tokens:
    (partUsage as BetaUsage).cache_creation?.ephemeral_1h_input_tokens ??
    usage.cache_creation.ephemeral_1h_input_tokens,
  ephemeral_5m_input_tokens:
    (partUsage as BetaUsage).cache_creation?.ephemeral_5m_input_tokens ??
    usage.cache_creation.ephemeral_5m_input_tokens,
},
```

Note: `BetaMessageDeltaUsage` SDK type is missing `cache_creation` but the API sends it — CC handles this by casting to `BetaUsage`.

---

## 13. Implications for Claudex

### High-value optimizations enabled by this research

1. **Cache read tokens cost 10x less than input tokens.** Claudex's injected context (materialized artifacts, experience patterns) that goes into user messages is NOT cached (it appears after the last `cache_control` marker). Claudex cannot change this without modifying CC's core, but understanding this means the cost of Claudex's per-turn injections is measured in cheap `input_tokens`, not `cache_creation`.

2. **System prompt stability is the highest-leverage cache optimization.** The `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` separates static from dynamic content. Claudex has no way to add content before this boundary without modifying CC source. Content injected by Claudex's hooks goes into message text (after the boundary in effect).

3. **MCP tools bust global caching.** When Claudex MCP tools are connected, CC falls back from `scope: 'global'` to `scope: 'org'` for the system prompt. This is a fundamental limitation — MCP tools prevent cross-org caching.

4. **The fingerprint does not affect cache.** The fingerprint is in the attribution header (`cacheScope: null`) which is explicitly NOT cached. Claudex does not need to worry about fingerprint stability for cache purposes.

5. **Hooks cannot inject `cache_control`.** The only way for Claudex to influence caching is by keeping its injected content stable (same content = same cache key = cache hit on the message prefix). Variable injections (timestamps, random IDs, changing counts) bust cache.

6. **Forked agents can share cache if CacheSafeParams match.** Claudex's Angel or any subagent could share the main thread's cache if it uses identical system prompt, tools, and messages. The Claudex PreToolUse hook that modifies subagent prompts intentionally breaks this sharing.

7. **Session resumption hits cache if within TTL.** When a user resumes a CC session within 5 minutes (or 1h for eligible users), the server's KV cache is still warm. Claudex's context injection at session start should be stable text to not bust this warm cache on resume.

8. **Beta header latches prevent mid-session cache busts.** This is transparent to Claudex — CC handles this internally. Claudex does not need to worry about feature flags causing cache breaks mid-session.

9. **`notifyCacheDeletion` + `notifyCompaction` exist.** If Claudex ever needed to integrate with CC's cache break detection system (e.g., as a hook), these are the extension points. But they are internal CC functions with no hook interface.

10. **The weekly rate limit is server-controlled.** CC does not know the exact token→utilization ratio. It only reads the server's utilization header. Cache reads contribute far less to utilization than fresh input tokens (10x cheaper at minimum), making cache hits the primary lever for extending weekly token budget.
