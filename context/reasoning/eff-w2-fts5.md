# W2: FTS5 Token Cost Investigation

**Date:** 2026-03-13
**Scope:** Assembly pipeline FTS5 section — token costs, mode selection, budget-awareness
**Files examined:**
- `src/assembly/sections.ts` (lines 154–175)
- `src/assembly/assembler.ts` (lines 68–253)
- `src/core/observations.ts` (lines 134–171)
- `src/core/migrations.ts` (FTS5 schema DDL)
- `src/intelligence/topic-shift.ts` (FTS5 query context)
- `src/shared/constants.ts`

---

## 1. Full Mode vs Reference Mode: Decision Path

**Trigger location:** `assembler.ts:136`

```typescript
// Check reference mode trigger
if (budget < 500) referenceMode = true;
```

This is the ONLY place `referenceMode` is set to `true`. It is a single boolean flag initialized to `false` at line 75. It becomes `true` only after priorities 1–5 have consumed budget and less than 500 tokens remain.

**Call site:** `assembler.ts:157`

```typescript
const fts5Section = formatFts5Section(fts5Results, referenceMode);
```

`referenceMode` is passed directly to `formatFts5Section`. There is no other mechanism that can set it.

**Summary of decision path:**

1. Budget starts at `config.injection.budget_tokens` = 4000 tokens (`constants.ts:38`).
2. Priorities 1–5 (identity, project, checkpoint, learnings, hot files) are processed first, each deducting from the running `budget` variable.
3. After priority 5, if `budget < 500`, `referenceMode = true`.
4. FTS5 (priority 7) is then called with that flag.

**Critical observation:** `referenceMode` is set BEFORE GSD (priority 6) is even processed. If priorities 1–5 consume 3500+ tokens, FTS5 will be in reference mode. If they consume less than 3500 tokens, FTS5 will be in full mode — regardless of how many observations were found or how large they are.

---

## 2. What Each Mode Produces

**Full mode** (`sections.ts:165–168`):

```typescript
const entries = observations.map(o =>
  `### ${o.title}\n*${o.category} | ${formatRelativeTime(o.timestamp_epoch)}*\n${o.content}`
);
body = entries.join('\n\n');
```

Per observation: heading line (`### {title}`), metadata line (`*{category} | {relative time}*`), then the full `o.content` field.

**Reference mode** (`sections.ts:160–163`):

```typescript
const bullets = observations.map(o =>
  `- [{o.category}] ${o.title} (${formatRelativeTime(o.timestamp_epoch)})`
);
body = bullets.join('\n');
```

Per observation: a single bullet line — category, title, relative time. No content field.

Both modes prepend `## Relevant Observations\n` to the body.

---

## 3. How Many Results Are Fetched

**Call site:** `assembler.ts:156`

```typescript
const fts5Results = searchObservations(params.db, query, params.project, { limit: 10 });
```

Exactly 10 results are requested.

**Query function:** `observations.ts:142–153`

The `searchObservations` function passes `limit` directly to SQL `LIMIT ?`. No other cap exists. There is NO content truncation inside `searchObservations` — it returns full `ObservationRow` objects with the raw `content` field from the database.

---

## 4. Observation Content Size

Observations are captured by per-tool extractors, all of which call `truncateText(content, 2000)` before storage:

- `extractBash` — `truncateText(content, 2000)` (`bash.ts:32`)
- `extractRead` — `truncateText(String(output?.content ?? ''), 2000)` (`read.ts:25`)
- `extractEdit` — `truncateText(diff, 2000)` (`edit.ts:29`)

**Maximum stored content per observation: 2000 characters.**

The `estimateTokens` function uses `chars / 4` (`text-utils.ts:39`).

Maximum tokens per observation content: `2000 / 4 = 500 tokens`.

In practice, observations that hit the 2000-char limit (e.g., bash output, file diffs, file contents) are common because the quality gate requires minimum signal thresholds (e.g., Read requires `content.length >= 100` and structural patterns).

---

## 5. Token Cost Calculations

### Full Mode Worst Case

Per observation:
- Title line: `### Read: some-very-long-filename.ts\n` ≈ 40 chars / 4 = **10 tokens**
- Metadata line: `*code | 5m ago*\n` ≈ 20 chars / 4 = **5 tokens**
- Content: up to 2000 chars / 4 = **500 tokens**
- Separator (`\n\n`): 2 chars = negligible

Per observation (worst case): ~515 tokens

10 observations × 515 tokens = **~5,150 tokens**

Section header (`## Relevant Observations\n`): ~5 tokens

**Full mode worst case: ~5,155 tokens**

### Full Mode Realistic Case

Typical observations have content of 400–800 chars (enough to pass quality gates, not maxed out). Using 600 chars average:

Per observation: title (~10) + metadata (~5) + content (600/4 = 150) = 165 tokens
10 observations × 165 = **~1,650 tokens**

### Reference Mode

Per observation: `- [code] Read: some-filename.ts (5m ago)\n` ≈ 50 chars / 4 = 12.5 tokens → **~13 tokens**

10 observations × 13 = **~130 tokens**

Section header: ~5 tokens

**Reference mode: ~135 tokens**

### Budget Context

Total assembly budget: **4,000 tokens** (`constants.ts:38`).

| Mode | Worst case | Realistic | Fraction of 4000-token budget |
|------|-----------|-----------|-------------------------------|
| Full (worst) | ~5,155 tokens | — | 129% — **exceeds budget** |
| Full (realistic) | — | ~1,650 tokens | ~41% |
| Reference | ~135 tokens | ~135 tokens | ~3% |

---

## 6. Budget-Awareness Analysis

### At the Mode Selection Level

The only budget check is the `budget < 500` threshold at `assembler.ts:136`. This is:

- A binary threshold with no graduations
- Set BEFORE FTS5 is evaluated
- Based on remaining budget after priorities 1–5, not on FTS5's actual cost

**There is no check of FTS5's actual token cost before choosing the mode.** The mode is chosen based on leftover budget from earlier sections — a proxy, not a direct measurement.

### At the Section Inclusion Level

After the FTS5 section is formatted, there IS a budget check at `assembler.ts:159–165`:

```typescript
if (cost <= budget) {
  sections.push(fts5Section);
  budget -= cost;
  sources.push('fts5');
} else {
  skipped.push({ priority: 7, section: fts5Section, name: 'fts5' });
}
```

If the formatted section exceeds remaining budget, it is skipped (added to `skipped` array). However, this happens AFTER the content is already generated in full mode — wasted work. More importantly, the `skipped` array is only processed in the post-redaction reclaim phase (`assembler.ts:198–211`), which only reclaims ONE skipped section. A full-mode FTS5 section that was skipped could be reclaimed here if redaction freed enough budget, still in its full-mode form.

### The Scenario Where FTS5 Alone Blows the Budget

If priorities 1–5 consume modest budget (say, only 1,000 tokens — small identity, no active handoff, small checkpoint, few learnings, few hot files), then:

- `budget` after priority 5 = 3,000 tokens
- `referenceMode = false` (3,000 > 500)
- FTS5 full mode is attempted with up to 5,155 tokens cost
- Budget check at line 159: 5,155 > 3,000 → FTS5 is skipped entirely
- 10 high-quality FTS5 results are discarded

In this scenario FTS5 doesn't "blow the budget" — it gets blocked — but it wastes the fetch + format work and contributes zero to the final context despite being the most relevant section.

**The reverse scenario (FTS5 staying within budget but taking most of it):** If priorities 1–5 consume ~2,000 tokens, remaining budget = 2,000. FTS5 in full mode costs ~1,650 tokens (realistic). 1,650 ≤ 2,000 → FTS5 is included. Remaining budget: 350 tokens. Priority 8 (recent observations) cannot fit. In this case, FTS5 did not blow the budget but consumed ~41% of the TOTAL budget.

---

## 7. The Core Problem

The mode-selection threshold (`budget < 500`) is calibrated for the wrong question. The correct question is: "Will full mode fit in the remaining budget?" The current logic answers: "Did priorities 1–5 leave very little budget?"

These are correlated but not equivalent. Specifically:

- If priorities 1–5 consume 2,500 tokens, budget = 1,500. `referenceMode = false`. Full mode costs up to 5,155. Section gets skipped (no value). Reference mode would cost 135 tokens and be included (high value).
- If priorities 1–5 consume 3,600 tokens, budget = 400. `referenceMode = true`. Reference mode costs 135. Section is included. This is the correct behavior — but triggered for the wrong reason.

There is a "sweet spot" of roughly budget 135–1,000 tokens remaining where reference mode would always succeed but is not selected because the threshold is 500.

---

## 8. Secondary Issue: No Content Cap on Observations

The `searchObservations` function returns full `content` fields. There is no per-observation content cap applied at retrieval time. Truncation happened at insertion (2,000 chars max), but that stored value is returned as-is. Full mode renders every character of every observation's content into the injection payload.

For large observations (e.g., bash output from a build, file reads near 2,000 chars), 10 results can accumulate 15,000–20,000 characters, which the `estimateTokens` function will score as 3,750–5,000 tokens — well above what any section should consume from a 4,000-token total budget.

---

## 9. Recommendations (Research Only — No Implementation)

1. **Budget-proportional mode selection:** Replace the fixed `budget < 500` threshold with a direct check: estimate full-mode cost first, and use reference mode if full-mode cost exceeds remaining budget. This ensures reference mode is chosen whenever full mode would overflow, not just when budget is already nearly gone.

2. **Per-observation content truncation at render time:** In `formatFts5Section`, truncate `o.content` to a configurable limit (e.g., 400 chars) before rendering in full mode. This caps each observation's contribution to ~115 tokens rather than up to 500. Total full-mode cost becomes ~1,150 tokens maximum.

3. **Result count scaling:** Consider fetching fewer results when budget is limited. The current hardcoded `limit: 10` at `assembler.ts:156` is not budget-aware. Reducing to 5 results in tighter budgets halves the cost.

4. **Importance filtering at the FTS5 query level:** The `searchObservations` function does not filter by `importance`. Low-importance observations that happen to match the query can displace high-importance ones in the token budget.

5. **Move mode selection downstream:** The `referenceMode` flag is set between priorities 5 and 6 (before GSD). If GSD is small, priority 6 might not exhaust budget at all, making the mode decision premature. Mode selection should happen immediately before the FTS5 call with a fresh budget snapshot.

---

## 10. Summary Table

| Property | Value | Location |
|----------|-------|----------|
| Default budget | 4,000 tokens | `constants.ts:38` |
| FTS5 result limit | 10 | `assembler.ts:156` |
| Max stored content per obs | 2,000 chars = 500 tokens | `bash.ts:32`, `read.ts:25`, `edit.ts:29` |
| Full mode worst case (10 obs) | ~5,155 tokens | Calculated |
| Full mode realistic (10 obs) | ~1,650 tokens | Calculated |
| Reference mode (10 obs) | ~135 tokens | Calculated |
| `referenceMode` trigger | `budget < 500` after priorities 1–5 | `assembler.ts:136` |
| Budget check after format | Yes — skips if cost > budget | `assembler.ts:159` |
| Content truncation at retrieval | None | `observations.ts:134–171` |
| Budget-aware mode selection | No — threshold is a proxy | `assembler.ts:136` |
| Can FTS5 alone exceed total budget? | Yes in full mode worst case (5,155 > 4,000) | — |
