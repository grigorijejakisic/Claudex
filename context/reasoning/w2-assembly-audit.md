# W2: Assembly Pipeline Data Flow Audit

**Auditor:** Worker 2 (Data Flow Mismatch Audit team)
**Date:** 2026-03-13
**Scope:** `src/assembly/`, `src/checkpoint/inject.ts`, and upstream data sources

---

## 1. Data Flow Overview

`assembleFullContext()` is the main entry point. It pulls data from 8 sources in priority order, formats each into markdown sections, joins them with `\n\n`, applies `redactContent()` on the joined string, then returns an `InjectPayload`.

### Data sources (in priority order):
| # | Source | Function | Origin |
|---|--------|----------|--------|
| 1 | Identity | `formatIdentitySection()` | Filesystem: `~/.claudex/identity/USER.md` |
| 2 | Project | `formatProjectSection()` | Filesystem: `PROJECT_PRIMER.md` + `ACTIVE.md` |
| 3 | Checkpoint | `loadCheckpoint()` -> `formatCheckpointSection()` | DB (checkpoint_meta.data JSON) -> file fallback (YAML) |
| 4 | Learnings | `getTopLearnings()` -> `formatLearningsSection()` | DB: `learnings` table |
| 5 | Hot Files | `getHotFiles()` -> `formatHotFilesSection()` | DB: `pressure_scores` table |
| 6 | GSD | `readGsdState()` -> `formatGsdSection()` | Filesystem: `.planning/STATE.md` + `ROADMAP.md` |
| 7 | FTS5 | `searchObservations()` -> `formatFts5Section()` | DB: `observations` + `observations_fts` |
| 8 | Recent | `getObservationsByProject()` -> `formatRecentSection()` | DB: `observations` table |

---

## 2. Redaction Timing Analysis

### Where redaction happens:

**Extraction pipeline (before DB storage):**
- `processToolObservation()` in `src/extraction/extractor.ts` applies `redactContent()` to both `title` and `content`, and `sanitizePath()` to `files_modified`, BEFORE calling `insertObservation()`.
- Therefore: **observations stored in DB are already redacted** (title, content contain `[REDACTED_*]` tokens; files contain `<project>/` paths).

**Assembly pipeline (at output):**
- `assembleFullContext()` applies `redactContent()` to the fully joined output string (line 195).
- `assembleTopicPivot()` applies `redactContent()` to the pivot section (line 341).
- All three tiers in the fallback cascade apply `redactContent()`.

**Checkpoint data (NOT redacted before DB storage):**
- `writeCheckpoint()` in `src/checkpoint/writer.ts` builds a `CheckpointV3` from raw DB data (decisions, thread_state, learnings, hot files, open_items) and stores it as JSON in `checkpoint_meta.data`.
- **Decisions content is NOT redacted** before storage. `insertDecision()` stores raw content.
- **Thread state** (topic, summary, key_exchanges gist) is NOT redacted before storage.
- **Open items** are extracted from raw assistant text via regex -- NOT redacted.
- **Learnings content** is NOT redacted at insert time (in `upsertLearning()`).

### FINDING F1: Double Redaction on Observations
**Severity: Low (benign but wasteful)**

Observation content is redacted at extraction time (before DB insert), then redacted AGAIN by assembly's `redactContent()` call on line 195 of assembler.ts. The second pass is a no-op for already-redacted data (the `[REDACTED_*]` tokens pass through cleanly), but it is wasted CPU. More importantly, the second pass's entropy check could theoretically flag a long sequence of `[REDACTED_ENTROPY]` tokens concatenated together, though in practice each token is only 18 chars and the entropy threshold is set at 20+ chars with >= 4.5 bits.

### FINDING F2: Checkpoint Data Enters Assembly Unredacted From DB
**Severity: Medium**

Checkpoint data stored in `checkpoint_meta.data` JSON is built from:
- `decisions.content` -- raw, unredacted
- `thread_state.topic`, `thread_state.summary`, `thread_state.key_exchanges[].gist` -- raw, unredacted
- `learnings.content` -- raw, unredacted
- `extractOpenItems(lastAssistantText)` -- regex-extracted from raw assistant text, unredacted

This data flows into `formatCheckpointSection()` -> `renderCheckpointMarkdown()` which does NO redaction. The assembly-level `redactContent()` on line 195 catches this, so secrets DO get redacted in the final output. However, the raw secrets persist in:
1. The `checkpoint_meta.data` JSON column in the DB
2. The mirrored `.yaml` files on disk

This is a data-at-rest concern, not an injection concern.

### FINDING F3: Learnings and Decisions Are Not Redacted at Storage
**Severity: Medium (data-at-rest)**

`upsertLearning()` and `insertDecision()` store raw content. If a learning or decision contains a secret (e.g., "We decided to use API key sk-abc123..."), it persists unredacted in the DB. Assembly catches it on output, but the DB is a leak vector.

---

## 3. Token Budget Skew Analysis

### FINDING F4: Token Budget Calculated Pre-Redaction, Reclaim Calculated Post-Redaction
**Severity: Medium-High (budget correctness)**

In `assembleFullContext()`:

1. Each section's token cost is estimated BEFORE redaction (lines 80-186). `estimateTokens()` counts `Math.ceil(text.length / 4)`.
2. Sections are joined, then `redactContent()` is applied (line 195).
3. If redaction shortened the content, a `reclaimBudget` is calculated (line 199):
   ```
   reclaimBudget = budget + Math.floor((preRedactionLength - postRedactionLength) / 4)
   ```

The problem: **initial budget decisions are made on unredacted text**. Observation content from the DB is already redacted (per F1), so for priorities 7 and 8 the budget is accurate. But for priorities 1-6 (filesystem sources + checkpoint + learnings), the text may contain secrets that will shrink after redaction. This means:
- A section estimated at 500 tokens pre-redaction might only cost 400 tokens post-redaction.
- A lower-priority section that could have fit might get skipped.
- The reclaim mechanism partially compensates but only adds back ONE skipped section.

Conversely, for DB observations that are already redacted, `[REDACTED_SECRET]` (17 chars = ~4 tokens) replaced a potentially 100+ char secret (~25+ tokens). The budget was charged at the already-redacted rate, which is correct for those sources.

### FINDING F5: Reclaim Budget Uses Char-to-Token Ratio But Compares Against Pre-Redaction Estimates
**Severity: Low**

The reclaim logic on line 199 converts the character savings to tokens via `/4`, then adds to remaining budget. But it compares `cost <= reclaimBudget` where `cost` was computed on the UNREDACTED skipped section. If the skipped section also has secrets, its real post-redaction cost would be lower, but the check is conservative (it will sometimes fail to reclaim when it could).

This is conservative-fail-safe behavior, not a bug.

---

## 4. Special Character and Formatting Analysis

### FINDING F6: `<project>/` Paths Not Escaped in Markdown Output
**Severity: Medium (injection risk)**

`sanitizePath()` replaces absolute paths with `<project>/relative/path`. This is an angle-bracket token. In the assembled output:

```markdown
## Hot Files
- <project>/src/main.ts (pressure: 0.92)
```

If the injection target interprets `<project>` as an XML/HTML tag (as Claude's system prompt format does use XML-like tags), this could cause parsing ambiguity. Specifically, if `<project>` appears at the start of a line in the injected system content, it could be mistaken for a tag boundary by the LLM.

Current mitigation: None. The `<project>` prefix is used in:
- `pressure_scores.file_path` (stored pre-sanitized? No -- file_path in pressure_scores is stored as-is from `updatePressureScore()`; sanitization only happens in the extraction pipeline for observations)
- `observations.files_modified` (stored post-sanitization)
- `checkpoint.files.hot[].path` (from pressure_scores, NOT sanitized)
- `checkpoint.files.read[]` (from observations.files_modified, already sanitized)

Wait -- checking `writer.ts` line 264: `hot: hotFiles.map(f => ({ path: f.file_path, ... }))`. The `file_path` comes directly from `pressure_scores` table. `updatePressureScore()` receives `filePath` from callers. Let me check if that path is sanitized...

Looking at the extraction pipeline: `sanitizedFiles = result.files_modified.map(f => sanitizePath(f, projectRoot))`. These sanitized paths are stored in `observations.files_modified`. But `updatePressureScore()` is called separately and may receive the raw path.

**Conclusion:** Hot file paths in checkpoints may contain raw absolute paths (e.g., `C:\Users\Grigorije\...`) rather than `<project>/` paths, depending on whether the caller sanitizes. This is inconsistent: observations have sanitized paths, pressure_scores may not.

### FINDING F7: Newlines in Observation Content Can Break Section Formatting
**Severity: Low**

In `formatFts5Section()` (non-reference mode, line 165-167):
```typescript
const entries = observations.map(o =>
  `### ${o.title}\n*${o.category} | ${formatRelativeTime(o.timestamp_epoch)}*\n${o.content}`
);
body = entries.join('\n\n');
```

If `o.content` contains markdown headings (e.g., `### Some heading`), it would create nested heading ambiguity. If content contains `---`, it could create an unintended horizontal rule. Since content is pre-redacted and comes from tool output summaries, this is unlikely but possible for Bash tool extractions that capture command output.

### FINDING F8: `[REDACTED_*]` Tokens in Markdown Bullet Lists
**Severity: Negligible**

Redaction tokens like `[REDACTED_SECRET]` use square brackets, which is also markdown link syntax. In a bullet list context:
```markdown
- Set API key to [REDACTED_SECRET] in config
```
This is valid markdown. The `[REDACTED_SECRET]` won't be interpreted as a link because there's no following `(url)`. No issue here.

---

## 5. FTS5 Search on Redacted Data

### FINDING F9: FTS5 Indexes Redacted Content -- Search Quality Degradation
**Severity: Medium (functional, not security)**

The FTS5 virtual table (`observations_fts`) is synced via triggers on the `observations` table. Since observations are stored post-redaction, the FTS5 index contains redacted content. This means:

1. Searching for a secret value will never match (good for security).
2. Searching for terms that were part of a redacted string will also miss. For example, if a Bash output contained `export API_KEY=sk-abc123def456...` and was redacted to `export API_KEY=[REDACTED_SECRET]`, a search for "API_KEY" would still match, but a search for a specific key value would not. This is correct behavior.
3. The token `[REDACTED_SECRET]` itself is indexed. A MATCH query for `REDACTED_SECRET` would find all redacted observations. This is minor information leakage (reveals which observations had secrets) but not a security issue since the secrets themselves are gone.
4. The `porter unicode61` tokenizer will split `[REDACTED_SECRET]` into tokens: `redact`, `secret`. This means a search for "secret" will spuriously match any observation that had a redacted secret. This is a minor search quality issue.

### FINDING F10: FTS5 MATCH Query Doesn't Escape Special Characters
**Severity: Medium (crash risk)**

In `searchObservations()`, the `query` parameter is passed directly to `WHERE observations_fts MATCH ?`. FTS5 MATCH syntax has special characters: `*`, `"`, `AND`, `OR`, `NOT`, `NEAR`, `(`, `)`, `+`, `-`, `^`. If the search query (which comes from `params.searchQuery ?? checkpoint?.thread?.topic`) contains these, the FTS5 query could:
1. Fail with a syntax error (caught by the `try/catch` on line 168 of assembler.ts -- non-fatal).
2. Match unexpectedly (e.g., topic "NOT working" would exclude "working" matches).

The assembly pipeline handles this gracefully (catch block returns nothing, section is skipped), but it means FTS5 results may be silently missing for queries containing FTS5 operators.

---

## 6. Injection Payload Validity

### FINDING F11: Final InjectPayload Content Is Valid But Lacks Structural Escaping
**Severity: Low-Medium**

The final `content` string in `InjectPayload` is raw markdown. It's injected into the system prompt. Potential issues:

1. **No wrapping/delimiting:** The content is not wrapped in any delimiter (e.g., `<claudex-context>...</claudex-context>`). If the content itself contains text that looks like system prompt directives, the LLM could follow them. This is a prompt injection surface if observation content contains adversarial text (e.g., from a Bash command that outputs "Ignore all previous instructions...").

2. **`<project>` tag ambiguity:** As noted in F6, `<project>/` paths could be parsed as XML-like tags by the LLM.

3. **Redaction tokens are semantically meaningful:** `[REDACTED_SECRET]` tells the LLM "there was a secret here." This is intentional information (telling the LLM not to reproduce it), but if an attacker can control what gets redacted, they could inject chosen text around redaction boundaries.

---

## 7. Checkpoint Injection Path

`src/checkpoint/inject.ts` -> `renderCheckpointMarkdown()`:
- Receives a `CheckpointV3` object and renders it to markdown.
- Does NOT apply any redaction or escaping.
- String interpolation is direct: `${working.task}`, `${thread.topic}`, `${d.content}`, etc.
- If any of these fields contain markdown special chars, unbalanced backticks, or XML-like tags, they pass through unmodified.
- This is caught by the assembly-level `redactContent()` call, which handles secrets/PII but NOT markdown structural issues or XML-like tag injection.

---

## Summary of Findings

| ID | Severity | Category | Description |
|----|----------|----------|-------------|
| F1 | Low | Waste | Double redaction on observation data (DB already redacted, assembly redacts again) |
| F2 | Medium | Data-at-rest | Checkpoint DB/YAML stores unredacted decision, thread, learning, open_item data |
| F3 | Medium | Data-at-rest | Learnings and decisions tables store raw unredacted content |
| F4 | Medium-High | Budget | Token budget calculated pre-redaction for filesystem/checkpoint sources, causing conservative over-estimation |
| F5 | Low | Budget | Reclaim logic is conservative but not buggy |
| F6 | Medium | Injection | `<project>/` paths could cause XML-tag ambiguity in LLM prompt parsing |
| F7 | Low | Formatting | Newlines/headings in observation content could break markdown section structure |
| F8 | Negligible | Formatting | `[REDACTED_*]` tokens are valid in markdown context |
| F9 | Medium | Search quality | FTS5 indexes redacted tokens, causing spurious matches on "secret"/"redact" |
| F10 | Medium | Robustness | FTS5 MATCH query doesn't escape special characters (mitigated by try/catch) |
| F11 | Low-Medium | Injection | No structural delimiter around injected content; `<project>` tag ambiguity |

### Recommended Fixes (prioritized):
1. **F4**: Redact each section individually BEFORE budget estimation, or estimate budget post-redaction.
2. **F2/F3**: Apply `redactContent()` in `writeCheckpoint()` before storing to `checkpoint_meta.data`, and in `upsertLearning()`/`insertDecision()` before DB insert.
3. **F6/F11**: Wrap injected content in a delimiter (e.g., `<claudex-context>`) and escape `<project>` to a non-ambiguous format (e.g., `[PROJECT]/`).
4. **F10**: Sanitize FTS5 query input by escaping special characters or wrapping terms in double quotes.
5. **F9**: Consider excluding common redaction tokens from FTS5 indexing via a custom tokenizer or stopword list.
