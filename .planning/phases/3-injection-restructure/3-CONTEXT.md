# Phase 3 Context: Injection Architecture Restructure

**Phase:** 3 of 12
**Items:** T3, T5, T6, T7, I3
**Status:** CONTEXT GATHERED
**Sources:** SYNTHESIS.md, 01-query-engine-context-assembly.md, 08-cache-system.md, 15-attachments-system.md, 16-claudemd-config-loading.md
**Dependencies:** Phase 1 (env flags done), Phase 2 (Critical Reminders at 300 tokens)

---

## Item Analysis

### T3 — Minimize UserPromptSubmit injection size

**Problem:** CC has NO deduplication of `hook_additional_context` attachments. UPS fires every turn, each injection accumulates in the context window. Over 50 turns at 2KB/turn = 100KB of redundant repeated content. SessionStart fires once per boundary (startup/resume/compact) with no truncation limit. UPS is truncated at 10,000 chars.

**Current architecture:**
- `session-start.ts` calls `assembleFullContext()` — identity, project, checkpoint, reference layer, proven principles, materialized artifacts, experience warnings, flow, learnings, GSD state, predicted context, last session summary
- `user-prompt-submit.ts` calls `assembleRegularPrompt()` — proven principles, critical reminders, experience warnings, gauge, topic pivot, pressure, materialized artifacts. Plus extra content: angel messages, signals, cross-session awareness, domain advisory, thread linking

**CC mechanism (from source):** `processSessionStartHooks('compact')` and `processSessionStartHooks('resume')` auto-re-execute SessionStart hooks after compaction and resume. SessionStart context survives these boundaries natively.

**What stays in UPS (truly per-turn dynamic):**
- Experience pattern matches — matched against THIS prompt, different every turn
- Critical reminders — decay-based TTL requires per-turn evaluation (decision: keep in UPS)
- Angel messages / session messages — consumed from queue, exactly-once delivery
- Stigmergic signals — change between turns
- Domain advisory — topic-specific, may change on topic shift
- Cross-session thread linking — first prompt only
- Correction flag setting — detection only, not injected text
- Intent classification — drives retrieval config, not injected text

**What moves to SessionStart (stable across turns):**
- Identity section, project section, checkpoint — already there
- Proven principles — already there (full assembly)
- Reference layer (packed artifact summaries) — stable metadata
- Materialized artifact rendering — stable until next materialization event
- Flow section — changes only on topic shift / compaction
- Learnings — changes only on new learning creation
- GSD state — changes only on task updates

**UPS target budget after restructure:**
- Experience patterns: ~200-500 tokens (0-3 patterns)
- Critical reminders: ~300 tokens (Phase 2 budget cap)
- Angel/session messages: variable (0-2KB, bursty)
- Signals: ~50-100 tokens
- Domain advisory: ~50-100 tokens
- Cross-session awareness: ~100-200 tokens (first prompt only)
- Baseline per-turn: ~700-1200 tokens. Bursty: up to ~2.5KB.

**Post-compact UPS behavior:** With bulk content in SessionStart, UPS post-compact branch simplifies to: clear flag + normal light injection. Skip experience pattern matching and materialization (SessionStart just did both).

**Key files:**
- `src/adapters/cc-hooks/session-start.ts` — full assembly entry point
- `src/adapters/cc-hooks/user-prompt-submit.ts` — regular prompt entry point
- `src/assembly/assembler.ts` — `assembleFullContext()` and `assembleRegularPrompt()`
- `src/assembly/sections.ts` — all `format*Section()` renderers

**Key decision:** Eliminate `isPostCompaction` full-rebuild branch from UPS. CC calls `processSessionStartHooks('compact')` after compaction, which triggers `assembleFullContext`. UPS post-compact should only clear the flag and do normal light injection.

---

### T5 — Cache-stable hook content

**Cache mechanism (from 08-cache-system.md):**
- System prompt split at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` — static content before gets `scope: 'global'`, dynamic content after gets no cache marker
- Hook `additionalContext` lands as user-role `<system-reminder>` messages AFTER the system prompt
- CC places one `cache_control` marker on the LAST message per request
- Claudex injected content from turn N is part of the prefix for turn N+1's cache key
- Cache reads are 10x cheaper than fresh input ($0.30 vs $3.00/Mtok for Sonnet 4.6)

**Variable content to remove from injected sections:**
1. Timestamps — `new Date()`, `Date.now()` in session summaries, flow entries
2. Session IDs — ULIDs in cross-session awareness text (use stable names instead)
3. Token counts / budget remaining in rendered text
4. Turn counters / sequence numbers
5. Gauge readings with specific numeric values

**Stable content (already fine):**
- Experience pattern text (lesson + trigger_context are DB-stable strings)
- Identity section (static text file)
- Proven principles (static DB rows)
- Checkpoint content (changes only on writes)

**Critical Reminders tension — RESOLVED:** CR uses varied phrasing by design (prevents habituation). Varied phrasing = cache miss on the CR portion. But CR is capped at 300 tokens. At Opus pricing: 300-token miss costs ~$0.0015/turn vs $0.00015 for cache read. Delta = $0.00135/turn. Over 100 turns = $0.135. Negligible. **Keep CR phrasing variation.**

**Implementation approach:** Audit all `format*Section()` functions in `src/assembly/sections.ts`. Replace variable identifiers with stable alternatives. Remove date/time/counter values from rendered text.

**Key files:**
- `src/assembly/sections.ts` — all section renderers
- `src/intelligence/critical-reminders.ts` — CR phrasing renderer (leave varied)
- `src/assembly/assembler.ts` — payload assembly (check for injected metadata)

---

### T6 — Reduce CLAUDE.md token footprint

**Current state:**
- Global `~/.claude/CLAUDE.md`: 9,385 bytes (~2,350 tokens)
- Project `CLAUDEXv3/CLAUDE.md`: 6,048 bytes (~1,500 tokens)
- Total: ~3,850 tokens injected as first user message on EVERY API call
- No `.claude/rules/` directory exists yet (global or project)

**CLAUDE.md injection mechanism (from 16-claudemd-config-loading.md):**
- `getUserContext()` is memoized — read once per session, cached until compaction/clear
- Content injected via `prependUserContext()` as synthetic `<system-reminder>` user message
- Always the FIRST message in every API call
- Not in system prompt — in user message array with `isMeta: true`

**Content audit — Project CLAUDE.md (6,048 bytes):**

Must stay (needed every turn):
- What This Is (2 sentences — project identity)
- Build & Test commands (4 lines)
- Benchmarks (2 lines — motivation)
- Critical Safety Rules subset: MAX subscription, cross-encoder warning (2 bullets)

Can move to conditional `.claude/rules/`:
- Hook/Angel Responsibility Split table — only when editing hooks or angel
- CC Hook Payload Truth table — only when editing hooks
- V12 Tables listing — only when editing schema/migrations
- File Structure tree — only when exploring unfamiliar code
- Reference Documents section — only when editing referenced areas

**Content audit — Global `~/.claude/CLAUDE.md` (9,385 bytes):**

Must stay (needed every session, every project):
- Claudex identity block (MCP tools table, navigation rule) — ~1,500 tokens
- Rules section (stop-and-verify, scope lock, etc.) — ~800 tokens
- Key Preferences — ~200 tokens

Can move to conditional `.claude/rules/` or trim aggressively:
- "How Context Reaches You" — informational, can be shortened to 1 sentence
- Cross-Session Communication protocol — can be compressed
- Angel-Promoted Rules — move to conditional rule
- Platform Guards — move to conditional rule for Codex-related files
- Reference Docs section — move to conditional rule
- Working Identity / Engineering Method / Quality Standard — compress to bullet points

**Estimated savings:** ~1,840 tokens/turn (~48% reduction). Conditional rules load on-demand only when matching file paths are touched.

**Key decision:** Trim CLAUDE.md aggressively now. Defer MCP `instructions` migration to Phase 8 (T4). Global Claudex instructions stay in CLAUDE.md but prose is compressed.

**Key files:**
- `~/.claude/CLAUDE.md` — global instructions
- `CLAUDEXv3/CLAUDE.md` — project instructions
- `CLAUDEXv3/.claude/rules/` — to be created (conditional rules)

---

### T7 — Post-compact duplication avoidance

**Problem:** After compaction, CC fires `processSessionStartHooks('compact')` which re-injects Claudex context via SessionStart. Then on the very next user prompt, UPS fires and injects again. Model sees duplicate content on first post-compact turn.

**Current mitigation:** `checkpoint-tracking.ts` has `post_compact_pending` flag. UPS reads it via `getCheckpointTracking()`. When true, UPS runs `assembleRegularPrompt()` with `isPostCompaction: true` (full rebuild), then `clearPostCompactPending()`.

**Flag write path:** `setPostCompactPending()` in `checkpoint-tracking.ts` is called from the checkpoint writer and lifecycle code. Works without H4 (PostCompact hook). No Phase 4 dependency.

**With T3 applied, duplication shrinks dramatically:**
1. SessionStart injects bulk (identity, project, checkpoint, reference layer, proven principles)
2. UPS injects only dynamic per-turn content (patterns, CR, messages, signals)
3. Overlap is minimal — only experience patterns could overlap if same patterns match both queries

**Solution — simplified post-compact UPS:**
When `post_compact_pending` is true in UPS:
1. Skip experience pattern matching (SessionStart just did it via `assembleFullContext`)
2. Skip materialization (SessionStart just did it)
3. Only inject truly new per-turn content: messages, signals, correction detection
4. Clear the flag

**Key files:**
- `src/core/checkpoint-tracking.ts` — `getCheckpointTracking()`, `setPostCompactPending()`, `clearPostCompactPending()`
- `src/adapters/cc-hooks/user-prompt-submit.ts` — `isPostCompaction` branch
- `src/assembly/assembler.ts` — `assembleRegularPrompt()` `isPostCompaction` parameter

---

### I3 — Conditional rules via `.claude/rules/`

**Mechanism (from 16-claudemd-config-loading.md):**
- Files in `.claude/rules/*.md` with YAML frontmatter `paths:` field
- Loaded on-demand when CC tools operate on matching file paths
- NOT loaded at session start — zero token cost unless paths match
- Glob patterns supported in `paths:` field
- CC discovers them via `getMemoryFiles()` → `getMemoryFilesForNestedDirectory()`

**Proposed project-level rules (`CLAUDEXv3/.claude/rules/`):**

```
hooks-safety.md          paths: ["src/adapters/cc-hooks/**"]
  - Hook deadlock rule (never call CC CLIProxyAPI from hook)
  - Fire-and-forget dies (always await in hooks)
  - CC Hook Payload Truth table
  - Hook/Angel responsibility split

angel-architecture.md    paths: ["src/angel/**"]
  - Angel system design (heartbeat, CARA, monitoring)
  - Angel engineering patterns (debounce, turn budget)

schema-migration.md      paths: ["src/core/schema.ts", "src/core/migrations/**"]
  - V12 tables listing
  - Migration rules and conventions

embeddings-safety.md     paths: ["src/embeddings/**"]
  - Cross-encoder is actually bi-encoder (snowflake-arctic-embed2)
  - Matryoshka dimensions (768->384)
  - Ollama nomic-embed-text model

assembly-budget.md       paths: ["src/assembly/**"]
  - Budget cascade priorities
  - Section priority order
  - Token estimation conventions
```

**Key decision:** Project-level `.claude/rules/` (not global) — all content is Claudex-specific.

---

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Keep Critical Reminders in UPS | TTL accuracy matters — decay-aware timing is the whole point. 300 tokens cache miss = $0.135/100 turns, negligible. |
| D2 | Trim CLAUDE.md now, defer MCP instructions to Phase 8 (T4) | T4 belongs to Phase 8 per roadmap. Trim prose, compress tables, remove informational sections. |
| D3 | PostCompact flag works without H4 | `checkpoint-tracking.ts` handles it. `setPostCompactPending()` called from writer/lifecycle. No Phase 4 dependency. |
| D4 | Project-level `.claude/rules/` | All conditional content is Claudex-specific. Global rules would pollute other projects. |
| D5 | Eliminate `isPostCompaction` full-rebuild from UPS | CC calls `processSessionStartHooks('compact')` → SessionStart → `assembleFullContext()`. UPS post-compact only needs to clear flag + light injection. |
| D6 | Keep CR phrasing variation despite cache cost | 300 tokens * $0.00135/turn delta = $0.135/100 turns. Habituation prevention outweighs negligible cache cost. |
| D7 | T4 (MCP instructions) is Phase 8, not Phase 3 | Roadmap places T4 in Phase 8. Phase 3 scope is T3, T5, T6, T7, I3 only. |

---

## Implementation Order

1. **I3** — Create `.claude/rules/` with conditional content. Pure addition, no behavior changes.
2. **T6** — Trim CLAUDE.md files, moving content to rules from step 1. Verify essentials remain.
3. **T3** — Restructure injection: bulk to SessionStart, slim UPS to dynamic-only. Biggest change.
4. **T7** — Simplify post-compact UPS branch. Flag-based skip of redundant content.
5. **T5** — Audit all rendered sections for variable content. Sweep across `sections.ts`.

---

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| T3 | HIGH — restructuring hook responsibilities. Post-compact recovery could lose context if SessionStart assembly insufficient. | Verify `processSessionStartHooks('compact')` fires reliably (confirmed in CC source: `compact.ts:592`). Test post-compact context completeness. |
| T6 | MEDIUM — trimming CLAUDE.md could remove content needed every turn. | Careful audit of per-turn vs conditional content. Test with fresh sessions. |
| T5 | LOW — content audit, no structural change. | Grep for `Date`, `Date.now`, counter patterns in sections.ts. |
| T7 | LOW — simplification of existing logic. T3 does the heavy lifting. | T7 is applied after T3 is verified. |
| I3 | LOW — pure addition of new files. | Verify CC loads `.claude/rules/` with `paths:` frontmatter correctly. |

---

## CC Source References

| File | Relevant Finding |
|------|-----------------|
| `01-query-engine-context-assembly.md` | System prompt order, `prependUserContext()`, `hook_additional_context` position, MCP `instructions` as `DANGEROUS_uncachedSystemPromptSection` |
| `08-cache-system.md` | Cache breakpoint placement, TTL tiers, 10x read discount, beta header latches, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` split |
| `15-attachments-system.md` | No dedup of hook attachments, truncation at 10K chars (UPS only), SessionStart re-executes post-compact, per-turn accumulation problem |
| `16-claudemd-config-loading.md` | Memoized loading, conditional rules via `paths:` frontmatter, `claudeMdExcludes` setting, cache invalidation triggers |
