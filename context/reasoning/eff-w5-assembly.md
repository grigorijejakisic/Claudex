# Assembly Pipeline Efficiency Audit
Date: 2026-03-13

## Files Examined
- `src/assembly/assembler.ts` (364 lines)
- `src/assembly/sections.ts` (255 lines)
- `src/assembly/token-estimator.ts` (re-export only)
- `src/shared/text-utils.ts` — `estimateTokens()` implementation
- `src/shared/constants.ts` — default config values
- `src/checkpoint/inject.ts` — `renderCheckpointMarkdown()`
- `src/extraction/redaction.ts` — `redactContent()`

---

## 1. Token Estimator: Fundamental Accuracy Problem

**File:** `src/shared/text-utils.ts:36-43`

```ts
return Math.ceil(text.length / 4);
```

The estimator uses raw character count divided by 4. This is a known underestimate for markdown-heavy text because:

- Markdown control characters (`##`, `**`, `###`, `-`, `*`) are measured as characters but tokenize 1:1 (no compression). Some tokenizers treat `**bold**` as 4 tokens (asterisks are separate tokens), not 3 chars.
- The `##` header prefix alone in sections like `## Relevant Observations` is 24 chars → 6 tokens estimated, but actual BPE token count is closer to 6-8 (the space after `##` is a separate token).
- **Concrete impact:** The `/4` rule underestimates markdown-dense content by roughly 10-20%. A 400-character section estimated at 100 tokens may actually consume 110-120 tokens. Across 8 sections this compounds.

**Verdict:** The estimator has no awareness of markdown overhead. It treats `**Related Files:**` (18 chars = 4.5 estimated tokens) identically to 18 chars of prose. In practice markdown punctuation tokenizes less efficiently.

---

## 2. Hidden Token Costs: Header and Separator Overhead

Every formatter prepends a `## Header\n` or `### Subheader\n` that is counted inside the section's cost estimate (so not strictly "hidden") — but the **section join in `assembleFullContext`** adds separators that are NOT pre-estimated.

### Section Join Gap

**File:** `src/assembly/assembler.ts:191`

```ts
let content = sections.join('\n\n');
```

Each join inserts `\n\n` (2 characters = 0.5 tokens each). With 8 sections maximum, that is 7 joins = 14 characters = ~3-4 tokens. Minor but unaccounted.

### Reclaim Append Gap (More Significant)

**File:** `src/assembly/assembler.ts:206`

```ts
content += '\n\n' + redactContent(section);
```

When a section is reclaimed after post-redaction, it is appended with `'\n\n'` separator. The `reclaimBudget` check on line 205 checks whether `cost <= reclaimBudget`, where `reclaimBudget` is the remaining budget plus a character-delta-based reclaim. The 2 chars of `'\n\n'` separator are not included in `cost`, so the final content is always 0.5 tokens over the reclaim budget check.

### Per-Section Header Overhead (all formatters)

All headers are included in the string passed to `estimateTokens()`, so they are estimated but the `/4` rounding underestimates them:

| Section | Header string | Chars | `/4` estimate | Likely actual tokens |
|---|---|---|---|---|
| Identity | `## Identity\n` | 13 | 3.25 → 4 | 5 |
| Project | `## Project\n` or `## Active Handoff\n` | 12 / 19 | 3 / 4.75 | 4-6 |
| Checkpoint | `## Checkpoint\n` | 15 | 3.75 → 4 | 5 |
| Learnings | `## Learnings\n` | 14 | 3.5 → 4 | 5 |
| Hot Files | `## Hot Files\n` | 14 | 3.5 → 4 | 5 |
| GSD State | `## GSD State\n` | 14 | 3.5 → 4 | 5 |
| Relevant Obs | `## Relevant Observations\n` | 26 | 6.5 → 7 | 8 |
| Recent Obs | `## Recent Observations\n` | 24 | 6 | 7 |
| Token Gauge | `# Token Gauge\n` | 15 | 3.75 → 4 | 5 |
| Context Pivot | `## Context Pivot\n` | 18 | 4.5 → 5 | 6 |

These are minor in isolation. The larger problem is **nested sub-headers** inside `renderCheckpointMarkdown`.

---

## 3. Checkpoint Section: Double-Layer Header Overhead

**Files:** `src/assembly/sections.ts:81`, `src/checkpoint/inject.ts:28-130`

`formatCheckpointSection` wraps `renderCheckpointMarkdown` output with an outer `## Checkpoint\n` header (sections.ts:81). `renderCheckpointMarkdown` itself produces up to 7 sub-sections, each with a `### SubHeader\n` header:

```
## Checkpoint
### Current Work         ← 20 chars
### Thread               ← 10 chars
### Decisions            ← 15 chars
### Active Files         ← 17 chars
### Open Items           ← 14 chars
### Learnings            ← 14 chars
### GSD State            ← 14 chars
```

Plus `renderCheckpointMarkdown` joins its sections with `'\n\n'` (inject.ts:127), adding up to 12 chars / ~3 tokens in join overhead, none of which is separately flagged.

**Full checkpoint header overhead:** ~104 chars in headers + 12 chars in joins = 116 chars = ~29 `/4`-estimated tokens. Actual tokenizer overhead: ~35-40 tokens.

Inside checkpoint sections, the `**bold:**` field labels add further overhead:
- `- **Task:**`, `- **Status:**`, `- **Next:**`, `- **Branch:**` — each bold pair costs 4 extra `*` characters = 1 extra estimated token per field, but actual tokenization of `**` is 2 tokens (both asterisk pairs are separate tokens in BPE), so each `**label:**` is underestimated by roughly 0.5-1 token.

With a full checkpoint (all 7 subsections, each with several fields), total markdown decoration overhead: approximately **50-70 tokens underestimated** relative to `/4`.

---

## 4. FTS5 vs. Recent Observations: Structural Redundancy

**Files:** `src/assembly/sections.ts:154-174` (FTS5), `src/assembly/sections.ts:180-190` (Recent)

Both sections can include the same `ObservationRow` records:

- **FTS5** (Priority 7): `searchObservations(db, query, project, { limit: 10 })` — returns observations matching the current topic query.
- **Recent** (Priority 8): `getObservationsByProject(db, project, { limit: 20 })` filtered to `importance >= 3` and age < 24 hours.

**The overlap condition:** An observation that is (a) recent (< 24h), (b) importance >= 3, and (c) topically relevant to the current query will appear in **both** sections. There is no deduplication between them.

**Format comparison:**
- FTS5 non-reference mode: `### title\n*category | time*\ncontent` — includes full content body
- FTS5 reference mode (when `budget < 500`): `- [category] title (time)` — compact
- Recent: always `- [category] title (time)` — always compact

When `referenceMode=false` (budget >= 500, meaning priorities 1-5 left room), FTS5 is verbose (includes `o.content`) while Recent is compact. A single observation appearing in both sections costs:
- FTS5: `### title\n*category | time*\ncontent` ≈ title+time+content chars
- Recent: `- [category] title (time)` ≈ compact

This is a real redundancy. Observations observed in the last 24h with importance >= 3 that also match the topic query will be injected twice, once verbose and once compact.

---

## 5. Learnings Redundancy: Checkpoint vs. Learnings Section

**Files:** `src/checkpoint/inject.ts:110-116`, `src/assembly/assembler.ts:112-121`

`renderCheckpointMarkdown` (RESUME preset) includes a `### Learnings` subsection from `checkpoint.learnings` (inject.ts:110-116). Separately, Priority 4 injects `formatLearningsSection` from `getTopLearnings(db, project, 10)` (assembler.ts:112-121).

`checkpoint.learnings` is a `string[]` field on CheckpointV3 — these are learnings snapshotted at the time of the last checkpoint. `getTopLearnings` returns the live DB rows. If learnings were promoted between checkpoints, the checkpoint copy and the live copy will differ, but for recently promoted learnings (within the same session), they will be identical strings.

**Risk:** Not a guaranteed duplicate, but a likely partial duplicate when the session is fresh. The checkpoint's learnings list and the live learnings list can share 3-8 entries, injecting the same insight twice with slightly different surrounding formatting.

No deduplication exists between these two sources.

---

## 6. Budget Bypass: Priorities 1-5 Never Skip

**File:** `src/assembly/assembler.ts:77-133`

Priorities 1 through 5 (Identity, Project, Checkpoint, Learnings, Hot Files) use:

```ts
if (cost <= budget) {
  sections.push(...);
  budget -= cost;
}
```

There is **no `else` branch** — skipped sections at priorities 1-5 are silently dropped with no record in `skipped[]`. Only priorities 6, 7, 8 push to `skipped` on budget overflow (assembler.ts:148, 165, 185).

**Consequence:** If Identity + Project + Checkpoint together cost 3,800 tokens of the 4,000 default budget, Learnings (priority 4) and Hot Files (priority 5) are silently dropped. The `skipped[]` array, which drives post-redaction reclaim, will be empty. Budget enforcement is correct (they are dropped), but there is no reclaim opportunity for priorities 1-5 even if redaction later frees space. This is asymmetric: priorities 6-8 get a second chance via reclaim; priorities 1-5 do not.

---

## 7. Reference Mode Trigger: Off-by-One Budget Check

**File:** `src/assembly/assembler.ts:136`

```ts
if (budget < 500) referenceMode = true;
```

This check fires after priorities 1-5 have been consumed but before priority 6 (GSD). If budget < 500 after the first five priorities, `referenceMode=true` is set. This flag is passed to `formatFts5Section` (priority 7) to use compact format.

**Problem:** `referenceMode` is set after priority 5 but FTS5 (priority 7) is the only section that consumes it. Priority 6 (GSD) runs between the trigger and the first consumer of the flag. GSD's format is not affected by `referenceMode` — it always outputs full `**field:** value` format regardless of remaining budget. There is no compact fallback for GSD.

Additionally, if budget is 499 after priority 5, GSD at priority 6 may still consume the remaining budget and cause FTS5 to be skipped entirely (cost > budget), making `referenceMode` on FTS5 irrelevant. The flag only matters when budget is between 500 and (500 + FTS5 compact cost), a narrow window.

---

## 8. assembleTopicPivot: Truncation Destroys Structure

**File:** `src/assembly/assembler.ts:346-352`

```ts
if (tokenEst > budget) {
  const lines = content.split('\n');
  const truncated = lines.slice(0, 3).join('\n');
  return {
    content: truncated,
    tokenEstimate: estimateTokens(truncated),
    sources: ['topic_pivot'],
  };
}
```

When the topic pivot exceeds `topic_shift_budget` (default 800 tokens), it truncates to the first 3 lines. The `formatTopicPivotSection` output structure is:

```
Line 0: ## Context Pivot
Line 1: Switching context: X -> Y
Line 2: (empty string from parts.push(''))
Line 3: **Relevant Learnings:**
Line 4: - learning 1
...
```

Slicing to 3 lines keeps `## Context Pivot`, the context-switch statement, and a blank line — discarding all learnings, files, and decisions that were the actual value of the injection. The result is a 2-line injection of pure overhead (header + topic names) with zero payload.

This truncation is also not applied against `topic_shift_budget` in `assembleRegularPrompt`. The budget check there reads:

**File:** `src/assembly/assembler.ts:281`

```ts
if (pivot.tokenEstimate > 0 && pivot.tokenEstimate <= params.config.injection.topic_shift_budget) {
  return pivot;
}
```

`assembleTopicPivot` already truncated the content before returning, so `pivot.tokenEstimate` will always be small. The check at line 281 passes the truncated version through — meaning the 3-line useless injection gets injected without question.

---

## 9. Gauge Section: H1 vs H2 Inconsistency

**File:** `src/assembly/sections.ts:202`

```ts
return `# Token Gauge\nUtilization: ${pct}% (...)`;
```

Every other section uses `## H2` headers. The gauge uses `# H1`. This is a cosmetic inconsistency but also means the gauge header tokenizes as a slightly different markdown element. More importantly, the gauge fires as a standalone injection (not bundled with other sections), so the H1 vs H2 distinction has no practical effect on budget calculations. It is, however, the only section that fires outside the full assembly pipeline (via `assembleRegularPrompt` path 3), bypassing all budget checks entirely:

**File:** `src/assembly/assembler.ts:287-293`

```ts
const gaugeSection = formatGaugeSection(params.gauge, params.config.injection.gauge_threshold);
if (gaugeSection) {
  return {
    content: gaugeSection,
    tokenEstimate: estimateTokens(gaugeSection),
    sources: ['gauge'],
  };
}
```

The gauge is returned unconditionally once it fires (utilization >= threshold). There is no budget check. For a single-line gauge section this is ~15-20 tokens — negligible. But this is formally a budget bypass path.

---

## 10. Post-Redaction Reclaim: reclaimBudget Calculation Error

**File:** `src/assembly/assembler.ts:199`

```ts
const reclaimBudget = budget + Math.floor((preRedactionLength - postRedactionLength) / 4);
```

`budget` here is the **remaining** budget after all sections were processed (i.e., the unused portion after priorities 1-8). The reclaim adds `floor(delta_chars / 4)` — this is the token estimate of how much content was removed by redaction.

**Problem 1:** The reclaim budget mixes two things: leftover budget (unused tokens from the initial 4000) and recovered tokens from redaction. These are conceptually different. Leftover budget existed because some sections didn't fit; redaction recovery means already-committed sections shrank. The combined `reclaimBudget` can be larger than intended.

**Problem 2:** Only one skipped section is reclaimed (`break` on line 208). But the reclaimed section is appended to `content` after `redactContent()` has already run on `content`. The reclaimed section itself is also redacted inline (`redactContent(section)` on line 206), which is correct. But the separator `'\n\n'` prepended on line 206 is not counted in the budget check.

**Problem 3:** If `budget` after all 8 priorities was, say, 3800 (only identity was injected and it was cheap), and redaction removed 200 chars from identity, `reclaimBudget = 3800 + 50 = 3850`. This is fine. But if `budget` was 0 (all sections consumed the full budget), and redaction removes 400 chars (100 tokens), `reclaimBudget = 0 + 100 = 100`. A skipped section costing 95 tokens gets reclaimed, potentially pushing total content over the original 4000-token budget by up to ~95 tokens.

The intent is correct — reclaim freed space. The implementation is subtly wrong because sections budgeted before redaction used the full pre-redaction estimate. After redaction, the committed sections are cheaper than estimated, leaving real headroom. The reclaim should add `(preRedactionLength - postRedactionLength) / 4` to the original budget (4000), not to the remaining leftover. As written, the reclaim amount is correct but the base (`budget`) may be zero when it should reflect actual consumed-vs-estimated delta.

---

## 11. Tier 2 Fallback: Hardcoded `## Checkpoint` Header

**File:** `src/assembly/assembler.ts:228`

```ts
const parts = [identity, checkpointMd ? `## Checkpoint\n${checkpointMd}` : null].filter(Boolean) as string[];
```

In Tier 2, the assembler constructs the checkpoint string manually with `## Checkpoint\n` prefix rather than calling `formatCheckpointSection`. This duplicates the header logic from `sections.ts:81`. If the header wording ever changes in `formatCheckpointSection`, Tier 2 will silently diverge. Minor but a maintenance hazard.

---

## 12. GSD Section: Inconsistent Separator Style

**File:** `src/assembly/sections.ts:121-134`

`formatGsdSection` uses `lines.join('\n')` (single newline between fields). Every other multi-line section uses either `bullets.join('\n')` (single) or `entries.join('\n\n')` (double for FTS5 non-reference). The GSD section does NOT push a blank line between the header and the first field:

```
## GSD State
**Phase 1:** goal text
**Status:** active
**Completion:** 60%
**Success Criteria:**
- criterion 1
```

The absence of a blank line after `## GSD State` is visually inconsistent with sections like Checkpoint (which have `\n\n` between sub-sections) but is not wrong per se. Token cost difference: 0 (no blank line = 1 fewer `\n` character).

---

## 13. formatTopicPivotSection: Empty String Pushed to parts

**File:** `src/assembly/sections.ts:227, 233, 241`

```ts
parts.push('');  // blank line separator before each subsection
```

These empty strings become `\n` characters in the final output (via `parts.join('\n')`). Each blank separator adds 1 char / 0.25 estimated tokens. With 3 subsections (learnings + hotFiles + decisions), that is 3 extra `\n` characters. Trivial in absolute terms but the `\n` chars ARE included in the content that gets token-estimated and budget-checked.

---

## Summary of Findings by Impact

### High Impact

1. **FTS5 + Recent observation double-injection** (`sections.ts:154-190`): Any observation that is recent (<24h), high-importance (>=3), and topic-relevant appears in both sections. In verbose FTS5 mode this can duplicate 50-200 tokens of observation content. No deduplication exists. **Recommendation:** In `assembleFullContext`, pass already-included FTS5 result IDs to `formatRecentSection` and filter them out, or skip Recent entirely when FTS5 returned results.

2. **Checkpoint + Learnings section duplication** (`inject.ts:110-116`, `assembler.ts:112-121`): `checkpoint.learnings` and `getTopLearnings` can share 3-8 identical strings. **Recommendation:** After rendering the checkpoint section, extract its learnings strings and filter them from the learnings passed to `formatLearningsSection`.

3. **`estimateTokens` underestimates markdown** (`text-utils.ts:39`): The `/4` rule underestimates token cost for markdown-heavy sections by 10-20%. With a 4000-token budget, actual injection can exceed budget by 400-800 tokens. **Recommendation:** Apply a 1.15x markup factor for content containing markdown control chars, or switch to a proper tokenizer.

### Medium Impact

4. **`assembleTopicPivot` truncation produces zero-payload output** (`assembler.ts:346-352`): 3-line truncation retains only the header and topic names, discarding all substantive content. **Recommendation:** Either truncate at the section level (drop hotFiles first, then learnings) rather than by raw line count, or raise the budget threshold before injecting.

5. **Priorities 1-5 excluded from reclaim** (`assembler.ts:74`, comparison with `148,165,185`): If a high-priority section was dropped due to budget exhaustion, it never gets a second chance even if redaction frees space. **Recommendation:** Extend `skipped[]` to include priorities 1-5 overflows, or document the asymmetry explicitly.

6. **Post-redaction reclaim base calculation** (`assembler.ts:199`): `reclaimBudget = remaining_budget + reclaimed_chars/4` can allow a skipped section to push total content slightly over the original budget. **Recommendation:** Cap `reclaimBudget` at `estimateTokens(content_before_reclaim) + reclaimed_amount` to prevent over-budget injection.

### Low Impact

7. **`sections.join('\n\n')` separator not pre-estimated** (`assembler.ts:191`): 7 joins = ~3 tokens unaccounted. Negligible.

8. **Gauge injection bypasses budget check** (`assembler.ts:287-293`): ~15-20 tokens, unconditional. Negligible but formally a bypass.

9. **Tier 2 hardcodes `## Checkpoint\n`** (`assembler.ts:228`): Maintenance divergence risk from `sections.ts:81`.

10. **`referenceMode` flag has narrow effective window** (`assembler.ts:136`): Flag fires at budget < 500 after priority 5, but GSD (priority 6) may consume remaining budget making FTS5 unreachable anyway. The compact-vs-verbose FTS5 distinction only matters in a narrow budget range.

11. **`# Token Gauge` uses H1 instead of H2** (`sections.ts:202`): Cosmetic inconsistency.

12. **`formatTopicPivotSection` empty-string separators** (`sections.ts:227,233,241`): 3 chars / <1 token overhead.

---

## Token Overhead Accounting (Full Assembly, Worst Case)

With all 8 sections included and `estimateTokens()` in use:

| Section | Header chars | Sub-headers | Join `\n\n` | Total overhead chars | `/4` estimate | Actual (est.) |
|---|---|---|---|---|---|---|
| Identity | 13 | 0 | 2 | 15 | ~4 | ~5 |
| Project | 12+19 | 0 | 2 | 33 | ~8 | ~10 |
| Checkpoint | 15 | 7×~15=105 | 6×2=12 | 132 | ~33 | ~40 |
| Learnings | 14 | 0 | 2 | 16 | ~4 | ~5 |
| Hot Files | 14 | 0 | 2 | 16 | ~4 | ~5 |
| GSD | 14 | 0 | 2 | 16 | ~4 | ~5 |
| FTS5 (verbose) | 26 | N×~10 | N×2 | 26+12N | ~7+3N | ~8+4N |
| Recent | 24 | 0 | 2 | 26 | ~7 | ~8 |
| **Totals (N=10 FTS5)** | | | | ~400 | ~100 | ~120 |

The formatting skeleton alone costs ~100-120 tokens against the 4000-token budget — about 2.5-3%. Acceptable on its own, but compounded with the 10-20% underestimate on content, total actual injection can run 150-600 tokens over estimates depending on content density.
