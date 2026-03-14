# Deferred Items Research -- Findings

**Date:** 2026-03-13
**Scope:** All 5 deferred items from handoff section 3
**Files examined:** 25+ source files across assembly, extraction, observability, intelligence, and adapter layers

---

## Executive Summary

- Items 4 (content cap) and 5 (FTS5 reference mode forcing) are **ACTIONABLE NOW** with specific, low-risk code changes.
- Items 1-3 (budget tuning, topic shift tuning, error telemetry review) **NEED USAGE DATA** -- but the telemetry infrastructure to collect that data has a critical wiring gap: injection events are never emitted.
- The telemetry type system (`InjectionDetail`) and emit function (`emitTelemetry`) exist and are ready. The gap is purely wiring: neither `session-start.ts` nor `user-prompt-submit.ts` calls `emitTelemetry` with injection details after assembly completes.
- Fixing the telemetry wiring gap is itself actionable now and should be done alongside items 4 and 5.

---

## ACTIONABLE NOW

### Item 4: Observation Content Length Cap

**Current state:** All 10 extractors call `truncateText(content, 2000)`. The handoff proposed a 500-char cap. The efficiency audit (eff-w3-obscontent.md) recommends 600-800 chars.

**Problem:** 2000 chars = ~500 tokens per observation. In FTS5 full mode with 10 results, that is ~5,150 tokens -- exceeds the entire 4,000-token budget. The section gets skipped entirely (all-or-nothing), wasting the DB query and format work.

**Recommended cap: 500 chars (matching handoff recommendation)**

This produces ~125 tokens per observation. 10 FTS5 results in full mode = ~1,400 tokens -- fits comfortably within typical remaining budget (1,500-2,500 tokens after priorities 1-5).

**Implementation plan -- two layers:**

**Layer 1: Reduce extractor caps (extraction-time)**

File: `src/shared/constants.ts`
Add to DEFAULT_CONFIG.observations:
```
content_max_chars: 500,
```

Then update all 10 extractors to use the constant instead of hardcoded 2000. Each extractor file has exactly one `truncateText(content, 2000)` call:

| File | Line | Change |
|------|------|--------|
| `src/extraction/extractors/read.ts` | 25 | `truncateText(..., 2000)` -> `truncateText(..., 500)` |
| `src/extraction/extractors/bash.ts` | 32 | Same |
| `src/extraction/extractors/edit.ts` | 29 | Same |
| `src/extraction/extractors/write.ts` | 25 | Same |
| `src/extraction/extractors/web-fetch.ts` | 27 | Same |
| `src/extraction/extractors/grep.ts` | ~38 | Same |
| `src/extraction/extractors/glob.ts` | ~26 | Same |
| `src/extraction/extractors/web-search.ts` | ~40 | Same |
| `src/extraction/extractors/task.ts` | ~27 | Same |
| `src/extraction/extractors/notebook-edit.ts` | ~29 | Same |

Also update the doc comment in `src/extraction/extractors/types.ts` line 11 from `max 2000 chars` to `max 500 chars`.

**Alternative (cleaner):** Define `CONTENT_MAX_CHARS = 500` in `src/shared/constants.ts` and import in all extractors. This avoids magic numbers and enables config-driven tuning later.

**Layer 2: Defense-in-depth at storage (backstop)**

File: `src/core/observations.ts`, in `insertObservation` function (~line 52).
Before the INSERT statement, add:
```typescript
const cappedContent = obs.content.length > 500 ? obs.content.slice(0, 500) + '...' : obs.content;
```
Then use `cappedContent` in the INSERT. This catches any future extractor that forgets truncation.

**Impact on existing data:** Existing observations with content > 500 chars remain in the DB. They will be rendered in FTS5 full mode at their full stored length. This is acceptable -- they will naturally age out. No retroactive migration needed.

**Risk:** Low. Shorter content means less context per observation in FTS5 full mode. However, the first 500 chars of most observations contain the essential information (function signatures, error messages, key commands). The current 2000-char cap mostly stores noise (middle-of-file content, verbose build output).

---

### Item 5: Force FTS5 Reference Mode When Budget < 1500

**Current state:** `referenceMode` is set at `assembler.ts:136`:
```typescript
if (budget < 500) referenceMode = true;
```

The threshold of 500 is too low. The efficiency audit (eff-w2-fts5.md) identified this precisely: at budget 500-1500, full mode is attempted but often exceeds remaining budget, causing the entire FTS5 section to be skipped. Reference mode at ~135 tokens would always fit.

**Recommended threshold: 1500 tokens**

At budget < 1500, reference mode is forced. Reference mode costs ~135 tokens for 10 results, always fitting. At budget >= 1500, full mode is attempted -- with the content cap (item 4), full mode costs ~1,400 tokens for 10 results, which fits when budget >= 1500.

**Implementation plan:**

File: `src/assembly/assembler.ts`, line 136.

Change:
```typescript
if (budget < 500) referenceMode = true;
```
To:
```typescript
if (budget < 1500) referenceMode = true;
```

**Optional improvement -- budget-proportional mode selection:**

Instead of a fixed threshold, compute full-mode cost first and fall back:
```typescript
// At line 156-168, replace the current FTS5 block:
const fts5Results = searchObservations(params.db, query, params.project, { limit: 10 });
// Try full mode first
let fts5Section = formatFts5Section(fts5Results, false);
let fts5Cost = fts5Section ? estimateTokens(fts5Section) : 0;
if (fts5Cost > budget && fts5Section) {
  // Fall back to reference mode
  fts5Section = formatFts5Section(fts5Results, true);
  fts5Cost = fts5Section ? estimateTokens(fts5Section) : 0;
}
if (fts5Section && fts5Cost <= budget) {
  sections.push(fts5Section);
  budget -= fts5Cost;
  sources.push('fts5');
}
```

This eliminates the proxy threshold entirely and makes the decision based on actual content. The `referenceMode` variable at line 75 and the threshold at line 136 can be removed.

**Risk:** Low. The only behavioral change is that FTS5 sections are more often included (in reference mode) rather than skipped entirely. This is strictly better -- some context is always better than no context.

---

### Bonus Actionable: Telemetry Wiring (Infrastructure Gap Fix)

This is not one of the 5 deferred items, but is a prerequisite for items 1-3 and should be done alongside items 4-5.

**Problem:** The `InjectionDetail` type at `src/observability/types.ts:12-18` is fully defined:
```typescript
export interface InjectionDetail {
  trigger: 'session_start' | 'post_compaction' | 'topic_shift' | 'gauge';
  sections_included: string[];
  sections_skipped: string[];
  total_tokens: number;
  budget_remaining: number;
}
```

But `emitTelemetry(db, sessionId, 'injection', ...)` is **never called** in production code. It only appears in a test (`src/tests/integration/cross-cutting.test.ts:300`). The handoff section 1.6 explicitly identified this gap.

**Implementation plan:**

**Change 1:** `src/adapters/cc-hooks/session-start.ts`

After `assembleFullContext` returns (after line 37), add:
```typescript
if (ctx.config.observability.enabled) {
  emitTelemetry(ctx.db, input.session_id, 'injection', {
    trigger: 'session_start',
    sections_included: payload.sources,
    sections_skipped: [],
    total_tokens: payload.tokenEstimate,
    budget_remaining: ctx.config.injection.budget_tokens - payload.tokenEstimate,
  });
}
```

Requires adding import: `import { emitTelemetry } from '../../observability/telemetry.js';`

**Change 2:** `src/adapters/cc-hooks/user-prompt-submit.ts`

After `assembleRegularPrompt` returns (after line 62), add:
```typescript
if (ctx.config.observability.enabled && payload.content) {
  const trigger = isPostCompaction ? 'post_compaction' as const
    : topicShift?.shifted ? 'topic_shift' as const
    : 'gauge' as const;
  emitTelemetry(ctx.db, input.session_id, 'injection', {
    trigger,
    sections_included: payload.sources,
    sections_skipped: [],
    total_tokens: payload.tokenEstimate,
    budget_remaining: 0, // not tracked for regular prompt path
  });
}
```

Requires adding import: `import { emitTelemetry } from '../../observability/telemetry.js';`

**Change 3 (optional but valuable):** Track skipped sections and budget remaining in the assembler.

Currently `assembleFullContext` returns `InjectPayload` with `{ content, tokenEstimate, sources }`. To expose skipped sections and budget remaining, the function would need to return additional metadata. Options:
- Extend `InjectPayload` with optional `skippedSources?: string[]` and `budgetRemaining?: number`
- Or track these in the telemetry call site by comparing `config.budget_tokens - payload.tokenEstimate`

The simpler approach (no return type change) is sufficient for initial data collection.

---

## NEEDS USAGE DATA

### Item 1: Budget Tuning

**Current budget constants:**

| Constant | Value | Location | Used In |
|----------|-------|----------|---------|
| `injection.budget_tokens` | 4000 | `constants.ts:38` | `assembler.ts:71` -- total cascade budget |
| `injection.topic_shift_budget` | 800 | `constants.ts:41` | `assembler.ts:281,310` -- topic pivot cap |
| `injection.gauge_threshold` | 0.70 | `constants.ts:40` | `assembler.ts:287`, `sections.ts:199` -- gauge display threshold |
| `injection.boundary_only` | true | `constants.ts:39` | Not enforced in code (architectural constraint) |
| `observations.retention_days` | 90 | `constants.ts:45` | Observation pruning |
| `observations.prune_threshold` | 1000 | `constants.ts:46` | Prune trigger count |
| `observations.prune_count` | 50 | `constants.ts:47` | Prune batch size |
| `learnings.surface_count` | 10 | `constants.ts:55` | `assembler.ts:112` -- top N learnings |
| `learnings.max_per_project` | 50 | `constants.ts:54` | Learning cap per project |
| `checkpoint.debounce_seconds` | 60 | `constants.ts:50` | Checkpoint frequency |
| `observability.retention_days` | 7 | `constants.ts:76` | Telemetry prune age |
| `observability.retain_error_count` | 1000 | `constants.ts:77` | Error telemetry cap |

**Implicit thresholds in code:**

| Threshold | Value | Location | Purpose |
|-----------|-------|----------|---------|
| referenceMode trigger | budget < 500 | `assembler.ts:136` | FTS5 mode selection |
| Hot files pressure | >= 0.851 | `sections.ts:106` | Filter for hot files section |
| Recent obs importance | >= 3 | `assembler.ts:175` | Filter for recent section |
| Recent obs age | < 86400s (24h) | `assembler.ts:176` | Filter for recent section |
| FTS5 result limit | 10 | `assembler.ts:156` | Max FTS5 observations |
| Recent obs fetch limit | 20 | `assembler.ts:173` | Max recent observations to scan |

**What data is needed to tune:**

Once telemetry wiring (above) is in place, run these queries after 1 week of usage:

```sql
-- Average injection size by trigger type
SELECT json_extract(detail, '$.trigger') as trigger,
       AVG(json_extract(detail, '$.total_tokens')) as avg_tokens,
       MAX(json_extract(detail, '$.total_tokens')) as max_tokens,
       COUNT(*) as count
FROM telemetry WHERE event_kind = 'injection'
GROUP BY trigger;

-- Budget overflow frequency (injections near or at budget limit)
SELECT json_extract(detail, '$.trigger') as trigger,
       SUM(CASE WHEN json_extract(detail, '$.budget_remaining') < 100 THEN 1 ELSE 0 END) as near_overflow,
       COUNT(*) as total
FROM telemetry WHERE event_kind = 'injection'
GROUP BY trigger;

-- Section inclusion rates
SELECT json_extract(detail, '$.trigger') as trigger,
       json_extract(detail, '$.sections_included') as sections
FROM telemetry WHERE event_kind = 'injection'
ORDER BY timestamp_epoch DESC LIMIT 50;

-- Injection frequency per session
SELECT session_id,
       COUNT(*) as injection_count,
       SUM(json_extract(detail, '$.total_tokens')) as total_tokens
FROM telemetry WHERE event_kind = 'injection'
GROUP BY session_id;
```

**Decision criteria:**
- If avg `session_start` injection > 3000 tokens: reduce `budget_tokens` or skip lower-priority sections
- If avg `post_compaction` injection > 2000 tokens: implement split assembly mode (handoff section 1.4)
- If `topic_shift` injections average < 200 tokens: reduce `topic_shift_budget` to 400
- If gauge triggers frequently (> 5x per session): raise `gauge_threshold` to 0.80
- If FTS5 is often skipped (not in `sections_included`): lower the reference mode threshold further

**Verdict:** NOT actionable until 1 week of telemetry data exists. Wire telemetry first, collect data, then tune.

---

### Item 2: Topic Shift Threshold Tuning

**Current thresholds:**

| Threshold | Value | Location | Purpose |
|-----------|-------|----------|---------|
| `embeddings.topic_shift_threshold` | 0.35 | `constants.ts:70` | Embedding cosine similarity below which = topic shift |
| `embeddings.topic_shift_window` | 3 | `constants.ts:71` | Sliding window size for noise smoothing |
| `embeddings.decision_confidence_threshold` | 0.15 | `constants.ts:72` | (Used in decision capture, not topic shift) |
| Jaccard fallback threshold | 0.15 | `topic-shift.ts:118` (hardcoded) | Keyword overlap below which = topic shift |
| avgRecent threshold | 0.40 | `topic-shift.ts:97` (hardcoded) | Average similarity to recent prompts |

**3-layer detection logic (`topic-shift.ts`):**

1. **Layer 1 -- Explicit pivot regex** (`topic-shift.ts:24`): Matches phrases like "now let's", "switch to", "moving on", "different topic", "actually, let's". Confidence: 1.0. Always checked first.

2. **Layer 2 -- Embedding cosine** (`topic-shift.ts:81-113`): Requires Ollama nomic-embed-text running locally. Computes cosine similarity between current prompt embedding and topic embedding. Shift detected when BOTH:
   - `similarity < 0.35` (prompt vs topic)
   - `avgRecent < 0.40` (prompt vs recent prompt window)
   The dual-threshold prevents single outlier prompts from triggering false positives.

3. **Layer 3 -- Jaccard keyword fallback** (`topic-shift.ts:117-127`): Used when embeddings unavailable. Computes stemmed keyword Jaccard similarity between topic text and prompt. Shift when `overlap < 0.15`. No sliding window -- single comparison.

**False positive scenarios (shifts detected incorrectly):**

- "Can you help me with the migration?" -- If current topic is "assembly pipeline", Jaccard overlap on "help migration" vs "assembly pipeline" = 0 (no shared keywords). Jaccard would trigger false positive. Embedding layer would likely NOT trigger (both are code-related topics, cosine > 0.35).
- "Actually, can we look at this error first?" -- Explicit pivot regex matches "actually" pattern. Fires regardless of whether it is truly a topic change. This is a known false positive risk in the regex.
- Short follow-up questions like "what about tests?" -- Low Jaccard overlap with any topic, could trigger. Embedding layer handles this better via the sliding window (recent prompts about the same topic keep avgRecent high).

**False negative scenarios (shifts missed):**

- Gradual topic drift: User slowly moves from "bug fix" to "feature design" over 5 prompts. No single prompt triggers the threshold. The sliding window smooths away the shift.
- Same-domain shifts: Moving from "unit tests for extractor" to "unit tests for assembler" -- keyword overlap is high ("unit", "tests"), embedding similarity is high (both are testing contexts). Shift goes undetected.

**What data is needed to tune:**

The `TopicShiftDetail` telemetry type already exists (`src/observability/types.ts:47-54`):
```typescript
export interface TopicShiftDetail {
  method: 'embedding' | 'jaccard' | 'explicit';
  similarity: number;
  shifted: boolean;
  old_topic?: string;
  new_topic?: string;
  pivot_tokens?: number;
}
```

But topic shift events are not emitted. Add to `user-prompt-submit.ts` after topic shift detection (after line 49):
```typescript
if (topicShift && ctx.config.observability.enabled) {
  emitTelemetry(ctx.db, input.session_id, 'topic_shift', {
    method: topicShift.method ?? 'unknown',
    similarity: topicShift.confidence ?? 0,
    shifted: topicShift.shifted,
    old_topic: topicShift.previousTopic,
    new_topic: topicShift.newTopic,
  });
}
```

**Queries for tuning:**

```sql
-- Topic shift trigger rate per session
SELECT session_id,
       SUM(CASE WHEN json_extract(detail, '$.shifted') THEN 1 ELSE 0 END) as shifts,
       COUNT(*) as checks
FROM telemetry WHERE event_kind = 'topic_shift'
GROUP BY session_id;

-- Detection method distribution
SELECT json_extract(detail, '$.method') as method,
       COUNT(*) as count
FROM telemetry WHERE event_kind = 'topic_shift'
  AND json_extract(detail, '$.shifted') = 1
GROUP BY method;

-- Similarity scores for shifts (to find threshold sweet spot)
SELECT json_extract(detail, '$.similarity') as similarity,
       json_extract(detail, '$.method') as method
FROM telemetry WHERE event_kind = 'topic_shift'
  AND json_extract(detail, '$.shifted') = 1
ORDER BY similarity;
```

**Improvements possible WITHOUT usage data:**

1. **Harden explicit pivot regex** (`topic-shift.ts:24`): Add negative lookaheads for common non-pivot patterns:
   - "actually" followed by agreement words should not trigger: `actually[,:]?\s*(?:yes|that|right|good)` should be excluded
   - "can we" preceded by "actually" is already covered, but "can you help me with" is not an explicit pivot and should not match

2. **Expose Jaccard threshold as config** (`topic-shift.ts:118`): The 0.15 threshold is hardcoded. Move to `embeddings.jaccard_shift_threshold` in DEFAULT_CONFIG for tuneability.

3. **Expose avgRecent threshold as config** (`topic-shift.ts:97`): The 0.40 threshold is hardcoded. Move to config.

**Verdict:** Mostly needs data. Minor regex and config externalization improvements are actionable now but low priority.

---

### Item 3: Error Telemetry Review

**Current state:** Error telemetry IS being emitted in production:
- `infrastructure.ts:162-170`: On hook handler failure, emits `error` event with `{ subsystem: 'cc-hooks/{hookName}', error: message }`.
- Retention: 1000 most recent error events kept (pruned at session start via `pruneTelemetry`).

**What exists:**
- Schema supports error events (`event_kind = 'error'` in telemetry table)
- `ErrorDetail` type: `{ subsystem: string; error: string; fallback?: string }`
- `pruneTelemetry` preserves up to 1000 error events regardless of age
- `queryTelemetry` can filter by `eventKind: 'error'`

**What is missing:**
- Only hook-level errors are captured (entire handler throws). Subsystem-level errors (FTS5 query failure, embedding timeout, checkpoint write failure) are caught by inner try/catch blocks and silently swallowed. These "soft failures" are invisible.
- No error categorization (is it transient? configuration? data corruption?)
- No error aggregation query (what are the top 5 recurring errors?)

**Specific subsystem error gaps:**

| Subsystem | Current Error Handling | Telemetry Emitted? |
|-----------|----------------------|-------------------|
| FTS5 search | `assembler.ts:168` catch block -- silently skips | No |
| Recent obs query | `assembler.ts:188` catch block -- silently skips | No |
| Embedding provider | `embedding-provider.ts:89,120` catch blocks | No |
| Topic shift detection | `topic-shift.ts:130` catch block | No |
| Checkpoint load | `loader.ts` various catch blocks | No |
| Observation extraction | `extractor.ts:140` catch block | No |

**Query to review existing errors (run when DB has data):**

```sql
-- Top recurring errors
SELECT json_extract(detail, '$.subsystem') as subsystem,
       json_extract(detail, '$.error') as error,
       COUNT(*) as occurrences
FROM telemetry WHERE event_kind = 'error'
GROUP BY subsystem, error
ORDER BY occurrences DESC LIMIT 20;

-- Error rate per session
SELECT session_id, COUNT(*) as error_count
FROM telemetry WHERE event_kind = 'error'
GROUP BY session_id
ORDER BY error_count DESC LIMIT 10;

-- Error timeline (last 24h)
SELECT datetime(timestamp_epoch, 'unixepoch') as time,
       json_extract(detail, '$.subsystem') as subsystem,
       json_extract(detail, '$.error') as error
FROM telemetry WHERE event_kind = 'error'
  AND timestamp_epoch > unixepoch() - 86400
ORDER BY timestamp_epoch DESC;
```

**Verdict:** Partially actionable now (add subsystem error telemetry to catch blocks), but the actual review needs data. Running the queries above on the current DB would show if any hook-level errors are already accumulating.

---

## INFRASTRUCTURE GAPS

### Telemetry Wiring Plan

**Gap 1: Injection events not emitted (CRITICAL)**
- Types exist: `InjectionDetail` at `src/observability/types.ts:12-18`
- Emit function exists: `emitTelemetry` at `src/observability/telemetry.ts:35`
- Query function exists: `queryTelemetry` at `src/observability/telemetry.ts:57`
- Missing: actual calls in `session-start.ts` and `user-prompt-submit.ts`
- Fix: See "Bonus Actionable" section above

**Gap 2: Topic shift events not emitted**
- Type exists: `TopicShiftDetail` at `src/observability/types.ts:47-54`
- Missing: call in `user-prompt-submit.ts` after topic shift detection
- Fix: See Item 2 section above

**Gap 3: Subsystem error events not emitted**
- Only hook-level crashes are captured
- Missing: soft failures in assembly, FTS5, embedding, checkpoint subsystems
- Fix: Add `emitTelemetry(db, sessionId, 'error', { subsystem: '...', error: message })` in ~6 catch blocks listed in Item 3

**Gap 4: No section-level cost tracking**
- The assembler computes per-section token costs (`estimateTokens(section)`) but does not record them
- To know which sections consume the most budget, need per-section cost data
- Fix: Include section costs in InjectionDetail or as a separate `assembly_cost` event kind
- Lower priority than gaps 1-3

**Gap 5: No observation-level content length tracking**
- Cannot query "what is the average observation content length" without scanning all rows
- Useful for validating content cap effectiveness
- Fix: Add `content_length INTEGER` column to observations table (or compute from existing data)
- Lowest priority

### Summary of Infrastructure Changes Needed

| Gap | Priority | Files to Change | Effort |
|-----|----------|----------------|--------|
| Injection telemetry wiring | HIGH | `session-start.ts`, `user-prompt-submit.ts` | ~10 lines each |
| Topic shift telemetry wiring | HIGH | `user-prompt-submit.ts` | ~8 lines |
| Subsystem error telemetry | MEDIUM | `assembler.ts`, `topic-shift.ts`, `embedding-provider.ts`, `loader.ts`, `extractor.ts` | ~3 lines each |
| Section cost tracking | LOW | `assembler.ts`, possibly extend `InjectPayload` | ~20 lines |
| Content length column | LOW | `migrations.ts`, `observations.ts` | Schema change |

---

## Priority Ranking

Ordered by impact and implementation readiness:

1. **Item 5: FTS5 reference mode threshold** -- Single line change in `assembler.ts:136`. Immediate impact: FTS5 section included more often instead of being skipped entirely. Risk: near-zero.

2. **Item 4: Content cap reduction** -- 10 extractor files + 1 constant. Immediate impact: FTS5 full mode fits within budget. Risk: low (shorter stored content).

3. **Telemetry wiring (injection + topic shift)** -- 2 hook files. Enables all future tuning. Risk: zero (additive, non-throwing).

4. **Item 3: Subsystem error telemetry** -- 5-6 files, ~3 lines each. Enables error pattern analysis. Risk: zero (additive, non-throwing).

5. **Item 2: Topic shift hardening** -- Regex refinement, config externalization. Low impact until usage data shows false positive rates.

6. **Item 1: Budget tuning** -- Blocked on telemetry data. No code changes until queries run against 1+ week of injection telemetry.

---

## Implementation Dependency Graph

```
[FTS5 threshold change] -----> immediate value
[Content cap reduction] -----> immediate value
[Telemetry wiring] ----------> enables future tuning
                     |
                     v
              [1 week of data]
                     |
                     v
         [Budget tuning queries]
         [Topic shift analysis]
         [Error pattern review]
```

Items 1-3 in the top row can be done in parallel. Items in the bottom row are sequentially dependent on data collection.
