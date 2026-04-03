# Phase 3 Plan: Injection Architecture Restructure

**Phase:** 3 of 12
**Items:** I3, T6, T3, T7, T5
**Status:** PLANNED
**Dependencies:** Phase 1 (env flags), Phase 2 (Critical Reminders tier at 300 tokens)
**Requirements:** T3, T5, T6, T7, I3

---

## Wave 1 — Conditional Rules + CLAUDE.md Trim (I3, T6)

Two independent file-creation tasks with no code changes. Can be done in parallel.

### Plan 01: I3 — Create `.claude/rules/` conditional rules

**Files created:** `CLAUDEXv3/.claude/rules/hooks-safety.md`, `angel-architecture.md`, `schema-migration.md`, `embeddings-safety.md`, `assembly-budget.md`
**Files modified:** None
**Autonomous:** true
**must_haves:** Each rule file has valid YAML frontmatter with `paths:` glob, content extracted from project CLAUDE.md

#### Tasks

<task id="I3-1" type="create" file=".claude/rules/hooks-safety.md">
Create conditional rule for hook safety. YAML frontmatter:

```yaml
---
paths:
  - "src/adapters/cc-hooks/**"
  - "src/adapters/shared/**"
---
```

Content extracted from project CLAUDE.md:
- Hook deadlock rule: "Never call CC's CLIProxyAPI from a hook. Use Ollama instead."
- Fire-and-forget rule: "CC hooks are ephemeral — always await. Only Angel/OpenClaw can fire-and-forget."
- CC Hook Payload Truth table (PostToolUse uses `tool_response`, UserPromptSubmit uses `prompt`, Stop uses `last_assistant_message`)
- Hook/Angel Responsibility Split (hooks = fast/mechanical/ephemeral, Angel = reflective/holistic/persistent) with the full list from current CLAUDE.md
</task>

<task id="I3-2" type="create" file=".claude/rules/angel-architecture.md">
Create conditional rule for Angel development. YAML frontmatter:

```yaml
---
paths:
  - "src/angel/**"
---
```

Content:
- Angel system design: persistent guardian, heartbeat, CARA opinions, session monitoring, message sending, entity summarization, retention sweep
- Angel engineering patterns: 10-min debounce on monitoring, 5-turn hard budget, cursor-based extraction, mutual exclusion skip logic
- Reference to ANGEL_SYSTEM.md spec for full design
</task>

<task id="I3-3" type="create" file=".claude/rules/schema-migration.md">
Create conditional rule for schema/migration work. YAML frontmatter:

```yaml
---
paths:
  - "src/core/schema.ts"
  - "src/core/migrations/**"
---
```

Content:
- V12 tables listing (session_signals, angel_opinions, solution_outcomes, entity_aliases, sessions.name, sessions.transferred_to, session_messages.sender_type, session_messages.request_id)
- Migration conventions: always add new tables/columns, never drop, use `IF NOT EXISTS`, test with fresh DB
</task>

<task id="I3-4" type="create" file=".claude/rules/embeddings-safety.md">
Create conditional rule for embeddings work. YAML frontmatter:

```yaml
---
paths:
  - "src/embeddings/**"
---
```

Content:
- Cross-encoder is actually bi-encoder: snowflake-arctic-embed2 via /api/embed (bi-encoder cosine similarity), NOT a true neural cross-encoder
- Matryoshka dimensions: nomic-embed-text generates 768d, truncated to 384d for storage
- snowflake-arctic-embed2: 1024d for reranking
- Ollama endpoint: localhost, non-throwing (graceful degradation to FTS5)
</task>

<task id="I3-5" type="create" file=".claude/rules/assembly-budget.md">
Create conditional rule for assembly work. YAML frontmatter:

```yaml
---
paths:
  - "src/assembly/**"
---
```

Content:
- Budget cascade: identity (P1) → claudex_ready (P1.1) → experience_warnings (P1.5) → project (P2) → session_continuity (P2.5) → checkpoint (P3) → learnings (P4) → entity_summaries (P4.05) → angel_opinions (P4.07) → proven_principles (P4.1) → project_overview (P4.25) → rules_reminder (P4.5, post-compact only) → flow → reference_layer → materialization → codebase_index → predicted_context → GSD
- Regular prompt cascade: proven_principles (500 cap) → critical_reminders (300 cap) → intent_patterns → experience_warnings → trigger_materialized
- Token estimation: `estimateTokens()` from shared/text-utils.js
</task>

#### Verification

```bash
# Verify all rule files exist with valid frontmatter
for f in .claude/rules/*.md; do head -5 "$f"; echo "---"; done
# Verify CC recognizes paths: frontmatter (manual: open a hook file, check if rule loads)
```

- [ ] All 5 rule files created in `.claude/rules/`
- [ ] Each file has valid YAML frontmatter with `paths:` array
- [ ] Content matches what was extracted from CLAUDE.md
- [ ] No behavioral code changes — pure file addition

---

### Plan 02: T6 — Trim CLAUDE.md files

**Files modified:** `CLAUDEXv3/CLAUDE.md`, `~/.claude/CLAUDE.md`
**Autonomous:** true
**Depends on:** Plan 01 (I3 — rules must exist before removing content from CLAUDE.md)
**must_haves:** Project CLAUDE.md under 4KB, Global CLAUDE.md under 7KB, all essential content preserved

#### Tasks

<task id="T6-1" type="edit" file="CLAUDEXv3/CLAUDE.md">
Trim project CLAUDE.md. Remove content that moved to `.claude/rules/`:

**Remove entirely (now in conditional rules):**
- Hook/Angel Responsibility Split table → hooks-safety.md
- CC Hook Payload Truth table → hooks-safety.md
- V12 Tables listing → schema-migration.md
- File Structure tree → assembly-budget.md covers the assembly structure; other paths discoverable via codebase
- Reference Documents section → each rule file references its own spec

**Keep (needed every turn):**
- "What This Is" paragraph (project identity, 3 components)
- Benchmarks (2 lines)
- Build & Test commands
- Critical Safety Rules: MAX subscription, cross-encoder warning, hook deadlock (1-line each — full detail in rules)
- "Do NOT use `bun test`" note

**Target:** ~2,800 bytes (~700 tokens), down from 6,048 bytes (~1,500 tokens). Savings: ~800 tokens/turn.
</task>

<task id="T6-2" type="edit" file="~/.claude/CLAUDE.md">
Trim global CLAUDE.md. Compress verbose sections:

**Compress aggressively:**
- "How Context Reaches You" — reduce from 4 lines to 1 sentence: "Claudex injects context at session start and every user turn via `<system-reminder>` tags. Trust injected context."
- Cross-Session Communication — compress from 20 lines to 8 lines. Remove the "Sending messages" subsection (duplicates MCP tool descriptions). Keep Signals/Messages/Session identity as 1-2 lines each.
- Quality Standard + Engineering Method + Working Identity — merge into single "Engineering Standards" section of ~6 bullet points (currently 12 bullets across 3 sections)
- Angel-Promoted Rules — move to conditional rule (already copied to hooks-safety.md and general rules)
- Platform Guards — compress to 1 line: "Codex CLI on Windows: no `-o` flag, no `run_in_background`, no `/tmp/`. See `docs/codex.md`."
- Reference Docs — compress: remove "READ WHEN" comments, make a compact list

**Keep unchanged:**
- Claudex identity block (first section + MCP tools table + Navigation Rule) — ~1,500 tokens, essential
- Rules 1-7 — ~800 tokens, essential behavioral rules
- Key Preferences — ~200 tokens, essential

**Target:** ~6,500 bytes (~1,625 tokens), down from 9,385 bytes (~2,350 tokens). Savings: ~725 tokens/turn.
</task>

#### Verification

```bash
wc -c CLAUDEXv3/CLAUDE.md  # Target: < 4000 bytes
wc -c ~/.claude/CLAUDE.md   # Target: < 7000 bytes
```

- [ ] Project CLAUDE.md under 4KB
- [ ] Global CLAUDE.md under 7KB
- [ ] All 7 Rules preserved verbatim
- [ ] MCP tools table preserved
- [ ] Build & Test commands preserved
- [ ] No essential information lost (verify with fresh session test)

**Combined T6 savings: ~1,525 tokens/turn (~40% reduction).**

---

## Wave 2 — Injection Restructure (T3)

The biggest change. Restructures what goes in SessionStart vs UserPromptSubmit.

### Plan 03: T3 — Minimize UserPromptSubmit injection size

**Files modified:** `src/assembly/assembler.ts`, `src/adapters/cc-hooks/user-prompt-submit.ts`
**Autonomous:** false (high risk — verify post-compact recovery)
**must_haves:** UPS baseline under 1.2KB/turn, bulk content in SessionStart, post-compact UPS does NOT call assembleFullContext

#### Tasks

<task id="T3-1" type="edit" file="src/assembly/assembler.ts">
**Eliminate `isPostCompaction` full-rebuild from `assembleRegularPrompt()`.**

Current code (lines 771-783):
```typescript
if (params.isPostCompaction) {
  return assembleFullContext({
    db: params.db,
    project: params.project,
    projectDir: params.projectDir,
    config: params.config,
    searchQuery: params.prompt,
    identityDir: params.identityDir,
    sessionId: params.sessionId,
    isPostCompaction: true,
    contextWindowTokens: params.gauge?.contextWindowTokens,
  });
}
```

**Replace with simplified post-compact path:**
```typescript
if (params.isPostCompaction) {
  // CC fires processSessionStartHooks('compact') after compaction,
  // which triggers assembleFullContext via SessionStart hook.
  // UPS post-compact only needs truly new per-turn content.
  // Skip experience pattern matching (SessionStart just did it).
  // Skip materialization (SessionStart just did it).
  const parts: string[] = [];
  const srcs: string[] = [];

  // Critical reminders still fire (decay-based TTL is per-turn)
  if (params.sessionId) {
    try {
      const crFlags = getExperienceFlags(params.db, params.sessionId);
      const turnCount = getTurnCount(params.db, params.sessionId);
      const reminders = assembleCriticalReminders(
        params.db, params.sessionId, turnCount, params.project,
        crFlags.critical_activity_gate, crFlags.seen_rule_domains,
        params.gauge?.contextWindowTokens,
      );
      if (reminders && reminders.tokenCost <= scaleBudget(300, params.gauge?.contextWindowTokens)) {
        parts.push(reminders.section);
        srcs.push('critical_reminders');
        reminders.applyEffects();
      }
    } catch { /* non-fatal */ }
  }

  if (parts.length > 0) {
    return {
      content: parts.join('\n\n'),
      tokenEstimate: estimateTokens(parts.join('\n\n')),
      sources: srcs,
    };
  }
  return { ...EMPTY_PAYLOAD };
}
```

**Rationale (Decision D5):** CC calls `processSessionStartHooks('compact')` after compaction, which re-runs SessionStart → `assembleFullContext()`. UPS post-compact only needs CR + messages/signals (handled by the hook's extra content path).
</task>

<task id="T3-2" type="edit" file="src/assembly/assembler.ts">
**Ensure `assembleFullContext` already covers all bulk content for SessionStart.**

Verify these sections are in `assembleFullContext` (they already are — this is a verification task, not a code change):
- Identity (P1) — yes, line ~268
- Claudex Ready (P1.1) — yes, line ~282
- Experience warnings (P1.5) — yes, line ~296
- Project (P2) — yes, line ~307
- Session continuity (P2.5) — yes, line ~321
- Checkpoint (P3) — yes, line ~336
- Learnings (P4) — yes, line ~348
- Entity summaries (P4.05) — yes, line ~367
- Angel opinions (P4.07) — yes, line ~387
- Proven principles (P4.1) — yes, line ~411
- Project overview (P4.25) — yes, line ~428
- Rules reminder (P4.5, post-compact) — yes, line ~460
- Flow — yes, line ~476
- Reference layer — yes, line ~491
- Materialization — yes, line ~504
- Codebase context — yes, line ~588
- Predicted context — yes, line ~644
- GSD — yes, line ~665

**No code changes needed.** SessionStart already assembles everything. This task is verification only.
</task>

<task id="T3-3" type="edit" file="src/adapters/cc-hooks/user-prompt-submit.ts">
**Verify UPS dynamic-only content is truly per-turn.**

After T3-1, `assembleRegularPrompt()` in the non-post-compact path handles:
- Experience patterns (matched to THIS prompt) — per-turn, correct
- Critical reminders (decay TTL) — per-turn, correct
- Gauge + pressure (token utilization) — per-turn, correct
- Topic pivot — per-turn, correct
- Trigger-materialized artifacts — per-turn, correct

The UPS hook itself adds via `extraContent`:
- Angel messages — per-turn queue consumer, correct
- Stigmergic signals — per-turn, correct
- Cross-session context — first-prompt only, correct
- Domain advisory — per-turn, correct

**No code changes needed in UPS hook.** The existing `extraContent` concatenation path is already dynamic-only.

**UPS budget after restructure:**
- Experience patterns: ~200-500 tokens (0-3 patterns)
- Critical reminders: ~300 tokens (Phase 2 budget cap)
- Angel/session messages: variable (0-2KB, bursty)
- Signals: ~50-100 tokens
- Domain advisory: ~50-100 tokens
- Cross-session awareness: ~100-200 tokens (first prompt only)
- **Baseline per-turn: ~700-1,200 tokens. Bursty: up to ~2.5KB.**
</task>

#### Verification

```bash
# Build and run tests
bun run build && bun run test
```

- [ ] `assembleRegularPrompt()` no longer calls `assembleFullContext()` on `isPostCompaction`
- [ ] Post-compact UPS returns only CR + empty payload
- [ ] All existing tests pass (experience pattern, assembly, checkpoint tests)
- [ ] Manual test: trigger compaction → verify SessionStart fires → verify UPS next turn is light
- [ ] UPS baseline token cost < 1,200 tokens on normal turns

---

## Wave 3 — Post-compact Dedup + Cache Stability (T7, T5)

Two independent cleanup tasks. Can be done in parallel.

### Plan 04: T7 — Simplify post-compact UPS branch

**Files modified:** `src/adapters/cc-hooks/user-prompt-submit.ts`
**Autonomous:** true
**Depends on:** Plan 03 (T3 — post-compact path must be simplified first)
**must_haves:** Post-compact flag cleared after light injection, no duplicate content between SessionStart and UPS

#### Tasks

<task id="T7-1" type="edit" file="src/adapters/cc-hooks/user-prompt-submit.ts">
**Simplify the post-compact branch in the UPS hook.**

Current code (lines 64-66 + 447-449):
```typescript
const isPostCompaction = tracking?.post_compact_pending === 1;
// ... (line 447)
if (isPostCompaction) {
  clearPostCompactPending(ctx.db, input.session_id);
}
```

With T3 applied, the assembler's post-compact path is already simplified. The UPS hook change is:

1. When `isPostCompaction` is true, skip these expensive operations that SessionStart just did:
   - Skip topic shift detection (lines 74-107) — SessionStart context already has flow
   - Skip artifact materialization (lines 189-217) — SessionStart materialized everything
   - Skip cross-session thread linking (lines 271-316) — SessionStart has session continuity
   - Skip batch reflection (lines 332-336)

2. Keep these (truly per-turn even post-compact):
   - Correction detection (lines 237-265) — user's first post-compact prompt may contain correction
   - Angel messages consumer (lines 341-383) — messages may have arrived during compaction
   - Signals (lines 386-389) — may have changed during compaction
   - Domain advisory (lines 400-430) — lightweight, topic-specific

3. After `assembleRegularPrompt()` returns (now light), clear the flag.

**Implementation:** Add early-skip guards around the expensive sections when `isPostCompaction` is true. The existing code structure supports this — wrap the three blocks in `if (!isPostCompaction) { ... }`.

```typescript
// Skip expensive operations post-compaction — SessionStart just did full assembly
if (!isPostCompaction && prompt) {
  // topic shift detection block (existing lines 74-107)
}

// ... (keep correction detection, messages, signals, domain advisory as-is)

if (!isPostCompaction) {
  // artifact materialization block (existing lines 189-217)
  // cross-session thread linking (existing lines 271-316)
  // batch reflection (existing lines 332-336)
}
```
</task>

<task id="T7-2" type="verify">
**Verify no duplicate content between SessionStart and UPS post-compact.**

After T3 + T7:
- SessionStart fires `assembleFullContext()` → identity, project, checkpoint, reference, materialization, flow, GSD, etc.
- UPS fires `assembleRegularPrompt()` → only CR (if TTL expired), no patterns, no materialization
- UPS hook adds: messages, signals, domain advisory (none of which are in SessionStart)
- **Overlap: zero.** Only experience patterns COULD overlap if same patterns match both queries, but T3-1 skips pattern matching in post-compact UPS path.

Decision D3 confirmed: `checkpoint-tracking.ts` handles the flag without H4 (PostCompact hook).
</task>

#### Verification

- [ ] Post-compact UPS skips topic shift detection, materialization, cross-session linking, batch reflection
- [ ] Post-compact UPS keeps correction detection, messages, signals, domain advisory
- [ ] `clearPostCompactPending` still called after assembly
- [ ] All tests pass
- [ ] No duplicate content between SessionStart and UPS on first post-compact turn

---

### Plan 05: T5 — Make all injected content cache-stable

**Files modified:** `src/assembly/sections.ts`
**Autonomous:** true
**must_haves:** No timestamps, session IDs, counters, or turn numbers in rendered sections. CR phrasing variation preserved (Decision D6).

#### Tasks

<task id="T5-1" type="audit" file="src/assembly/sections.ts">
**Audit all `format*Section()` functions for variable content.**

Known variable content that breaks cache prefix:

1. **`formatGaugeSection()`** (line ~434): Contains `Time: HH:MM UTC`, `Session: Xh Ym`, `Last compaction: Xm ago`, specific `inputK/windowK` numbers, zone string. **This is EXPECTED to be variable** — gauge changes every turn. No fix needed (it's in UPS, not SessionStart).

2. **`formatRelativeTime()`** (line ~244): Used by `formatFlowSection()` for flow entries. Produces strings like "2h ago", "3d ago". **Fix: Remove relative timestamps from flow entries.** Replace with stable date-only strings or remove time entirely.

3. **`renderSessionContinuity()`** (line ~257): Reads file content — stable unless files change. No variable injection. OK.

4. **`formatMaterializationLayer()`**: Check for any timestamp injection in artifact rendering. Artifact `timestamp_epoch` may be rendered.

5. **`formatFlowSection()`**: Check for `formatRelativeTime()` calls on flow entries.

6. **`formatLearningsSection()`**: Check for timestamp or count rendering.

7. **`formatReferenceLayer()`**: Check for variable metadata (importance scores are DB-stable, OK).
</task>

<task id="T5-2" type="edit" file="src/assembly/sections.ts">
**Remove variable content from SessionStart-injected sections.**

Target functions (only those in SessionStart's `assembleFullContext` path):

1. **`formatFlowSection()`** — Remove `formatRelativeTime()` timestamps from flow entries. Flow entries should show topic + summary only, not "2h ago". The temporal ordering is implicit in the list order.

2. **`formatMaterializationLayer()`** — If artifact rendering includes `timestamp_epoch` as human-readable time, replace with stable artifact ID or remove. Importance scores are DB-stable integers — keep.

3. **`formatLearningsSection()`** — If rendering includes creation timestamps, remove them.

4. **`formatProjectsOverview()`** — If `last_active` epoch is rendered as relative time, remove or replace with stable date string.

**Do NOT touch:**
- `formatGaugeSection()` — lives in UPS path only, expected to vary
- `assembleCriticalReminders()` — intentionally varied (Decision D6: keep phrasing variation)
- `renderExperienceWarnings()` — pattern text is DB-stable, framing text is static
</task>

<task id="T5-3" type="audit">
**Verify no session IDs or ULIDs leak into SessionStart content.**

Grep for patterns in sections.ts and assembler.ts:
- `session_id` rendered into output strings (vs used as DB query param — query params are fine)
- ULID patterns (26-char alphanumeric) in template literals
- `Date.now()` or `new Date()` in rendered output (vs internal logic — internal is fine)
- `Math.floor(Date.now()` in rendered strings

**Expected findings:** `formatGaugeSection` uses `Date.now()` — this is UPS-only, acceptable. Any others in SessionStart-path sections must be removed.
</task>

#### Verification

```bash
# Search for variable content in section renderers
grep -n "Date.now\|new Date\|formatRelativeTime\|timestamp_epoch" src/assembly/sections.ts
grep -n "session_id" src/assembly/sections.ts | grep -v "param\|query\|WHERE\|select"
bun run build && bun run test
```

- [ ] No `Date.now()` or `new Date()` in SessionStart-path section renderers
- [ ] No `formatRelativeTime()` in flow section (or replaced with stable alternative)
- [ ] No session IDs in rendered output strings
- [ ] CR phrasing variation preserved (Decision D6)
- [ ] All tests pass
- [ ] Gauge section still varies (expected — UPS path)

---

## Success Criteria (from ROADMAP.md Phase 3 Deliverables)

| Deliverable | Plan | Status |
|-------------|------|--------|
| UserPromptSubmit payload under 1KB (dynamic content only) | Plan 03 (T3) | |
| SessionStart carries bulk context (no truncation limit) | Plan 03 (T3) — verified already true | |
| All timestamps/counts/IDs removed from injected text (cache-stable) | Plan 05 (T5) | |
| CLAUDE.md trimmed, conditional content in `.claude/rules/` | Plan 01 (I3) + Plan 02 (T6) | |
| Post-compact flag prevents double-injection on next UPS turn | Plan 04 (T7) | |
| Cache hit rate measurement before/after | Manual: compare token costs in telemetry before/after deploy | |

## Decisions Honored

| # | Decision | Honored In |
|---|----------|------------|
| D1 | Keep Critical Reminders in UPS | T3-1: post-compact UPS still fires CR |
| D2 | Trim CLAUDE.md now, defer MCP instructions to Phase 8 | T6: trims prose, no MCP changes |
| D3 | PostCompact flag works without H4 | T7: uses checkpoint-tracking.ts |
| D4 | Project-level `.claude/rules/` | I3: all rules in CLAUDEXv3/.claude/rules/ |
| D5 | Eliminate isPostCompaction full-rebuild from UPS | T3-1: simplified post-compact path |
| D6 | Keep CR phrasing variation despite cache cost | T5: explicitly preserves CR variation |
| D7 | T4 (MCP instructions) is Phase 8, not Phase 3 | Not touched |
