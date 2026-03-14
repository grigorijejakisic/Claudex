# Observation Content Storage: Boundedness Audit

**Date:** 2026-03-13
**Scope:** Extraction pipeline → quality gate → storage → retrieval
**Question:** Is observation `content` storage unbounded? Which extractors produce the longest content?

---

## 1. Schema Definition

**File:** `src/core/migrations.ts` lines 20–38

```sql
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (...)),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)),
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at_epoch INTEGER,
  deleted_at_epoch INTEGER DEFAULT NULL
);
```

**Finding:** The `content TEXT NOT NULL` column has NO length constraint, no CHECK constraint, and no application-level maximum enforced at the schema level. SQLite TEXT columns are effectively unlimited (max ~1 GB per value). The schema alone imposes zero upper bound on content size.

---

## 2. Content Length Enforcement in the Pipeline

The pipeline has **four stages** where truncation could theoretically occur. Here is what each does:

### Stage 1: Per-tool Extractors (`src/extraction/extractors/`)

Every single extractor calls `truncateText(content, 2000)` (defined in `src/shared/text-utils.ts` line 9–17):

```typescript
export function truncateText(text: string, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
```

All 10 extractors cap content at exactly **2000 characters** before returning `ExtractionResult`. This is also documented in `src/extraction/extractors/types.ts` line 11: `/** Meaningful extracted output, max 2000 chars */`.

### Stage 2: Quality Gate (`src/extraction/quality-gate.ts`)

The quality gate does **NOT** check content length at all. It checks:
- Read: output content `>= 100` chars AND has structural pattern (lines 44–51) — a LOWER bound only
- Bash: output `>= 20` chars (line 69) — a LOWER bound only
- Edit/Write/WebFetch/WebSearch/Task/NotebookEdit: always pass (lines 54–96)

No upper bound check anywhere in the quality gate.

### Stage 3: Redaction (`src/extraction/redaction.ts`)

`redactContent()` (line 169) runs three passes over the content string but does NOT truncate. It can only replace substrings with shorter placeholders (`[REDACTED_SECRET]`, `[REDACTED_PII]`, `[REDACTED_ENTROPY]`), never increasing content length. No length cap applied.

### Stage 4: Storage (`src/core/observations.ts`, `insertObservation` lines 52–78)

`insertObservation` does a minor substitution — replacing `[REDACTED_\w+]` markers with `[REDACTED]` for FTS cleanliness (lines 59–60) — but does NOT truncate. The content passes directly into the SQL INSERT.

**Conclusion:** The only content length enforcement is the 2000-character cap applied inside each extractor via `truncateText`. There is no secondary cap at the quality gate, redaction, or storage stages. If a future extractor is added that omits `truncateText`, the full content (unlimited size) would flow to the database.

---

## 3. Per-Extractor Analysis

| Extractor | Source for content | Cap | Max stored chars | ~Max tokens |
|-----------|-------------------|-----|-----------------|-------------|
| `extractRead` | `output.content` | `truncateText(..., 2000)` | 2003 (2000 + "...") | ~501 |
| `extractBash` | `output.output ?? output.stdout` + stderr | `truncateText(..., 2000)` | 2003 | ~501 |
| `extractEdit` | `"--- old\n{old_string}\n+++ new\n{new_string}"` | `truncateText(..., 2000)` | 2003 | ~501 |
| `extractWrite` | `input.content` | `truncateText(..., 2000)` | 2003 | ~501 |
| `extractWebFetch` | `output.content ?? output.body` | `truncateText(..., 2000)` | 2003 | ~501 |
| `extractGrep` | `output.matches` (string or joined array) | `truncateText(..., 2000)` | 2003 | ~501 |
| `extractGlob` | `files.join('\n')` | `truncateText(..., 2000)` | 2003 | ~501 |
| `extractWebSearch` | built summary string | `truncateText(..., 2000)` | 2003 | ~501 |
| `extractTask` | `output.result ?? output.output` | `truncateText(..., 2000)` | 2003 | ~501 |
| `extractNotebookEdit` | `input.content ?? input.new_content ?? output.content` | `truncateText(..., 2000)` | 2003 | ~501 |

All extractors are **uniformly capped at 2000 characters**. Token ceiling per observation is ~501 tokens (chars/4 per `estimateTokens` in `src/shared/text-utils.ts` line 36).

### Which extractors produce the longest content in practice?

Even though the hard cap is equal across all extractors, certain extractors are systematically likely to hit the cap:

**Rank 1 — Read** (`src/extraction/extractors/read.ts` line 25)
Captures raw file content verbatim from `output.content`. Any file longer than 2000 chars (common — a 50-line source file easily exceeds this) will always produce a max-length observation. The quality gate requires `>= 100` chars AND structural keywords, meaning trivially-short files are filtered but all substantial source files will hit the cap.

**Rank 2 — Write** (`src/extraction/extractors/write.ts` line 25)
Captures `input.content` verbatim. When Claude writes a new file (common for boilerplate, configs, test files), the full file content is the input. Files written by Claude tend to be complete, meaning content is often 500–2000+ chars.

**Rank 3 — Edit** (`src/extraction/extractors/edit.ts` lines 26–29)
Captures `old_string + new_string` as a diff. Large edits (refactoring blocks, multi-line changes) produce diff content that fills 2000 chars. `old_string` and `new_string` are from the tool input, which can each be hundreds of lines for large refactors.

**Rank 4 — Bash** (`src/extraction/extractors/bash.ts` lines 24–32)
Captures stdout/stderr. Long-running commands (npm install, cargo build, test suites, git log) produce hundreds of lines. Quality gate requires `>= 20` chars, meaning any non-trivial output qualifies. Content is capped at 2000 but many commands routinely produce far more.

**Rank 5 — WebFetch** (`src/extraction/extractors/web-fetch.ts` lines 24–27)
Captures HTTP response body. Web pages routinely contain thousands of characters; the 2000-char cap is almost always hit when fetching real URLs.

**Rank 6 — Grep** (`src/extraction/extractors/grep.ts` lines 28–37)
When `output.matches` is a multi-line string or large array of match lines, can hit the cap. Large codebases with hundreds of matches produce verbose output.

---

## 4. Scenario Analysis

### Scenario A: Reading a 1000-line file

1. Hook fires `PostToolUse` for `Read` tool.
2. `output.content` contains the full 1000-line file — estimated ~50,000 characters.
3. `quality-gate.ts` line 44: `content.length >= 100` → passes. Line 46: `hasStructure` → passes (source code has `function`, `const`, `export`, etc.).
4. `extractRead` line 25: `truncateText(content, 2000)` → truncated to exactly 2000 chars + "..." = **2003 chars stored**.
5. The observation captures only the FIRST 2000 characters of the file. Lines beyond that are silently discarded.

**Answer:** Full content does NOT end up in the observation. Only the first 2000 chars (approx. first 40–50 lines) are stored. This means FTS5 search can only index the start of the file, not the full content.

### Scenario B: Large bash output (npm install, 500 lines)

1. `npm install` with 500 lines of output ≈ 15,000 chars.
2. Quality gate: command is `npm` — not in `TRIVIAL_BASH_COMMANDS` set. Exit code 0. Output `>= 20` chars → passes.
3. `extractBash` line 32: `truncateText(content, 2000)` → **2003 chars stored**.
4. Only the first 2000 chars of npm output are captured (version numbers, package names at the top of output).

**Answer:** Same conclusion — hard cap at 2003 chars. The full 500-line output is NOT stored.

### Scenario C: Large Edit (100-line old_string + 100-line new_string)

1. `old_string` = 100 lines ≈ 3000 chars. `new_string` = 100 lines ≈ 3000 chars.
2. `diff = "--- old\n" + old_string + "\n+++ new\n" + new_string` ≈ 6012 chars.
3. `truncateText(diff, 2000)` → **2003 chars stored** (captures only the start of old_string portion).

**Answer:** Large edits lose both the complete old and new versions in the observation.

### Scenario D: Multi-observation session (100 file reads)

100 Read observations × 2003 chars each = **200,300 chars stored in DB** for observations alone.

When retrieved by FTS5 search (`searchObservations`, limit=10) and formatted via `formatFts5Section` (non-referenceMode), each observation is output as:
```
### {title}
*{category} | {time}*
{content}
```
That's approximately: 50 (heading) + 30 (meta) + 2003 (content) = ~2083 chars per observation.

For 10 FTS5 results: 10 × 2083 = **~20,830 chars ≈ 5208 tokens** just for the FTS5 section.

The total injection budget is 4000 tokens (default, `src/shared/constants.ts` line 38). The FTS5 section alone (10 results × max-content observations) at ~5208 tokens **exceeds the entire budget**. The assembler would skip it via the budget check at `src/assembly/assembler.ts` lines 162–165.

---

## 5. Token Waste Analysis at Retrieval

### Non-referenceMode FTS5 injection (default in `assembleFullContext`)

`formatFts5Section` at `src/assembly/sections.ts` lines 154–175 has two render modes:

- **referenceMode=false** (default): outputs full content per observation:
  ```
  ### {title}\n*{category} | {time}*\n{content}
  ```
  = ~2083 chars = **~521 tokens per observation**

- **referenceMode=true** (triggered when `budget < 500`): outputs title-only:
  ```
  - [{category}] {title} ({time})
  ```
  = ~60 chars = **~15 tokens per observation**

The assembler triggers `referenceMode = true` at line 136 only when `budget < 500` tokens remain. In practice, prior sections (identity, project, checkpoint, learnings, hot files) can consume 1000–3000 tokens, leaving 1000–3000 tokens. At that remaining budget, `referenceMode` stays `false`, and FTS5 results inject full content.

10 observations × 521 tokens = **5210 tokens** — but budget check at lines 162–165 prevents injection if this exceeds remaining budget. So the waste doesn't escape, but the section is skipped entirely rather than partially injected.

**The real waste:** Even with budget enforcement, the system performs FTS5 search (DB I/O), formats all 10 observations into a potentially huge string, THEN checks if it fits. If it doesn't fit, it was wasted work. The assembler does not attempt a smaller FTS5 fetch when the full-content format is over budget.

### Recent observations section

`formatRecentSection` (`src/assembly/sections.ts` lines 180–190) always uses compact bullet format (title-only). This is fine — no content waste here. The assembler fetches up to 20 observations, filters to importance ≥ 3 and within 24h, then formats as bullets at ~60 chars each. Max waste: 20 × 60 = 1200 chars ≈ 300 tokens.

---

## 6. Is There a Content Truncation Mechanism Anywhere?

**Yes — one place only:** The `truncateText(content, 2000)` call inside each extractor.

**Not present:**
- No secondary cap in the quality gate
- No cap in `redactContent` (redaction-only)
- No cap in `insertObservation`
- No cap in `searchObservations` or `getObservationsByProject`
- No per-observation trim in `formatFts5Section` before formatting
- No per-observation trim in `formatRecentSection`

The 2000-char cap is the sole guardrail. It is consistently applied in all 10 current extractors. The risk is:

1. A future extractor that forgets `truncateText` would store unbounded content.
2. The 2000-char cap is itself generous for the assembly use-case. At 4000-token total budget, 10 FTS5 results at 501 tokens each consume the entire budget just from the observations section.

---

## 7. Specific Recommendations

### R1 — Halve the per-observation content cap (2000 → 600–800 chars)

**Rationale:** 2000 chars / 4 ≈ 501 tokens per observation. At the default 4000-token budget, 10 FTS5 results × 501 tokens = 5010 tokens — the entire budget, with nothing left for identity, checkpoint, learnings. Reducing to 600 chars (150 tokens) keeps 10 FTS5 observations at 1500 tokens, leaving 2500 tokens for higher-priority sections.

**Files to change:**
- `src/extraction/extractors/read.ts` line 25
- `src/extraction/extractors/bash.ts` line 32
- `src/extraction/extractors/edit.ts` line 29
- `src/extraction/extractors/write.ts` line 25
- `src/extraction/extractors/web-fetch.ts` line 27
- `src/extraction/extractors/grep.ts` line 38
- `src/extraction/extractors/glob.ts` line 26
- `src/extraction/extractors/web-search.ts` line 40
- `src/extraction/extractors/task.ts` line 27
- `src/extraction/extractors/notebook-edit.ts` line 29
- Update `src/extraction/extractors/types.ts` line 11 doc comment

Alternatively, define a single `CONTENT_MAX_CHARS = 600` constant in `src/shared/constants.ts` and reference it from all extractors.

### R2 — Add a secondary defense-in-depth cap at storage

`insertObservation` in `src/core/observations.ts` line 52 should truncate content defensively before the INSERT, catching any extractor that omits `truncateText`:

```typescript
const STORAGE_CONTENT_MAX = 1000; // final backstop
const ftsCleanContent = obs.content
  .replace(/\[REDACTED_\w+\]/g, '[REDACTED]')
  .slice(0, STORAGE_CONTENT_MAX);
```

### R3 — Add per-observation trim in formatFts5Section before budget check

Rather than computing the full formatted string and then rejecting the whole block, `formatFts5Section` should cap each observation's content to ~300 chars in the non-referenceMode path, then let the budget gate decide how many observations fit:

```typescript
const MAX_CONTENT_DISPLAY = 300;
const entries = observations.map(o =>
  `### ${o.title}\n*${o.category} | ...*\n${o.content.slice(0, MAX_CONTENT_DISPLAY)}`
);
```

This allows partial injection of many observations rather than all-or-nothing.

### R4 — Expose CONTENT_MAX_CHARS as a config field

To allow project-level tuning without code changes, add `observations.content_max_chars` (default 600) to `ClaudexConfig` and `DEFAULT_CONFIG`. Pass it into extractors via a shared constant or the extraction pipeline input.

### R5 — Consider extracting structural summary for Read rather than raw verbatim

For the `Read` extractor specifically, storing verbatim file content (even capped at 2000 chars) provides low information density for FTS purposes. An alternative: extract only the structural skeleton — function signatures, class names, export declarations — which would fit in ~200 chars and be far more useful for search.

---

## 8. Summary of Findings

| Question | Answer |
|----------|--------|
| Is content storage unbounded at schema level? | Yes — `content TEXT NOT NULL` with no length constraint |
| Is there application-level truncation? | Yes — exactly one: `truncateText(content, 2000)` in each extractor |
| Is there a secondary cap at quality-gate, redaction, or storage? | No |
| Which extractors produce the longest content? | Read > Write > Edit > Bash > WebFetch (all hit 2000-char cap routinely) |
| What happens reading a 1000-line file? | First 2000 chars (≈40 lines) stored; rest discarded |
| What happens with 500-line bash output? | First 2000 chars stored; rest discarded |
| Token cost of 10 FTS5 results at max content? | ~5210 tokens — exceeds default 4000-token budget |
| Is there a content trim in the assembly layer? | No — only budget gating (all-or-nothing for entire FTS section) |
| Risk of future extractor without truncation? | High — unbounded content would reach DB; no backstop exists |
