# W5: Extraction-to-Storage Boundary Audit

**Worker**: W5 — Data Flow Mismatch Audit
**Date**: 2026-03-13
**Scope**: Extraction pipeline → Storage → Query (redaction/sanitization coherence)

---

## 1. Pipeline Order (confirmed from extractor.ts)

```
dispatch → quality gate → extract → redact → classify → score → dedup → store
```

Key observation: **quality gates operate on RAW input/output** (step 2), but **classify and score operate on REDACTED content** (steps 5-6). This is the root of several mismatches.

---

## 2. Quality Gates — Operate on Raw Content

**File**: `src/extraction/quality-gate.ts`

- `passesQualityGate()` receives raw `toolInput` and `toolOutput` directly from the host.
- Read gate checks `content.length < 100` and `STRUCTURAL_PATTERNS` on raw output content.
- Bash gate checks `output.length < 20` on raw output.
- Grep gate checks `matchCount`.
- Glob gate checks `fileCount`.

**Verdict: CORRECT.** Quality gates run before redaction (step 2 vs step 4). This is the right order — filtering on raw signal strength before redacting. No mismatch here.

---

## 3. Classification — Operates on Redacted Content

**File**: `src/extraction/scoring.ts`

`classifyCategory(toolName, redactedTitle, redactedContent)` scans for keyword patterns:

```ts
const CATEGORY_KEYWORDS = [
  [/error|exception|fail|crash|bug/i, 'error'],
  [/test|spec|assert|expect/i, 'test'],
  [/config|env|setting|option/i, 'config'],
  [/auth|secret|token|credential|vulnerability/i, 'security'],
  ...
];
```

### BUG: Redaction tokens can trigger false classification

- `[REDACTED_SECRET]` contains the word **"SECRET"** — does NOT match any keyword pattern (patterns look for `secret` lowercase but regex has `/i` flag). Actually, `secret` IS in the security pattern: `/auth|secret|token|credential|vulnerability/i`. So `[REDACTED_SECRET]` **will always match the security category**.
- `[REDACTED_PII]` — no keyword match, safe.
- `[REDACTED_ENTROPY]` — no keyword match, safe.

**FINDING [MEDIUM]: Any observation containing `[REDACTED_SECRET]` will be classified as `security` category regardless of actual content.** If an AWS key appears in a test file, that observation gets miscategorized from `test` → `security`. This inflates security importance (score 5) for what might be test fixture data.

**Impact**: False security category → importance score 5 → never pruned by decay → permanent storage bloat of redacted test fixtures.

---

## 4. Importance Scoring — Operates on Redacted Content

**File**: `src/extraction/scoring.ts`

`scoreImportance(toolName, category, redactedContent)` checks:
- `BREAKING_SIGNALS = /breaking|BREAKING|deprecated/` on redacted content
- `TEST_FAILURE_SIGNALS = /FAIL|failed|error/` on redacted content

**Verdict: LOW RISK.** The `[REDACTED_*]` tokens don't contain "breaking", "BREAKING", "deprecated", "FAIL", or "failed". The word "error" does NOT appear in any redaction token. No false triggers here.

However, redaction could **mask** real signals: if the word "BREAKING" appeared inside a long high-entropy string that got redacted, the breaking change signal would be lost. This is a theoretical edge case.

---

## 5. Storage — Fields and Sanitization

**File**: `src/core/observations.ts`, `src/core/migrations.ts`

Stored fields:
| Field | Content | Redacted? |
|-------|---------|-----------|
| `title` | Redacted via `redactContent()` | Yes |
| `content` | Redacted via `redactContent()` | Yes |
| `files_modified` | Sanitized via `sanitizePath()` → JSON array | Sanitized (not redacted) |
| `tool_name` | Raw | No |
| `category` | Derived from redacted content | Indirect |
| `importance` | Derived from redacted content | Indirect |

`files_modified` stores **sanitized** paths: `<project>/src/foo.ts` or `C:\Users\[USER]\...`.

### Pressure scores table — MISMATCH

**File**: `src/adapters/shared/lifecycle.ts` line 123:
```ts
updatePressureScore(params.db, filePath, params.project, 0.1);
```

This uses the **raw `filePath`** from `params.toolInput[key]` — NOT sanitized.

Meanwhile, `files_modified` in observations stores **sanitized** paths via `sanitizePath()`.

**FINDING [HIGH]: Pressure scores store RAW file paths while observations store SANITIZED file paths.** The `pressure_scores.file_path` contains `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\foo.ts` while `observations.files_modified` contains `<project>/src/foo.ts`. These can never be cross-referenced by path equality.

**Impact**: The checkpoint writer's `json_each(observations.files_modified)` query extracts sanitized paths like `<project>/src/foo.ts`, while `getHotFiles()` returns raw paths from `pressure_scores`. Any downstream consumer comparing these two sets will get zero overlap.

---

## 6. FTS5 Search — Indexes Redacted Content

**File**: `src/core/migrations.ts` lines 41-46, 49-66

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, content,
  content=observations,
  content_rowid=id,
  tokenize='porter unicode61'
);
```

FTS5 triggers sync `title` and `content` from the observations table — which are **already redacted** at insert time.

### FINDING [HIGH]: FTS5 indexes redacted tokens, breaking search for original content

The FTS5 index contains:
- `[REDACTED_SECRET]`, `[REDACTED_PII]`, `[REDACTED_ENTROPY]` as indexed tokens
- Sanitized path references like `<project>/src/foo.ts` in content (if the extractor included paths in content text)
- File paths in `files_modified` are NOT indexed (not part of FTS5 schema)

**Consequences**:
1. **Searching for a redacted email address** (e.g., `user@example.com`) returns zero results — it was stored as `[REDACTED_PII]`.
2. **Searching for "REDACTED"** returns ALL observations that had any redaction applied — a useless, noisy result set.
3. **Porter stemmer on redaction tokens**: `[REDACTED_SECRET]` gets stemmed to `redact` + `secret`. This means FTS5 queries for "secret" will match ANY observation that had secret redaction, not just actual security observations.

**Impact on assembler**: `assembleContext()` at line 153-154 uses `searchObservations()` with FTS5 MATCH. If the search query is a file path like `src/auth.ts`, it won't find observations where that path was only in `files_modified` (not indexed) or was sanitized to `<project>/src/auth.ts` in content.

---

## 7. Deduplication — Mixed Redacted/Sanitized Comparison

**File**: `src/extraction/extractor.ts` lines 94-120

Two dedup paths:

### Path A: File-based dedup (line 98-107)
```sql
WHERE tool_name = ? AND category = ? AND project = ? AND session_id = ?
  AND timestamp_epoch > ? AND files_modified = ?
```
Compares `JSON.stringify(sanitizedFiles)` — an exact JSON string match.

**Verdict: CORRECT for self-consistency.** Both the stored value and the comparison value go through `sanitizePath()` in the same pipeline run. Same input → same sanitization → same JSON string. Dedup works.

### Path B: Content-based dedup for no-file tools (line 108-119)
```sql
WHERE tool_name = ? AND category = ? AND project = ? AND session_id = ?
  AND timestamp_epoch > ? AND files_modified = '[]'
  AND content = ?
```
Compares `redactedContent` — exact string match on redacted content.

**FINDING [LOW]: Redaction is deterministic, so content dedup is self-consistent.** The same raw content will always produce the same redacted output (regex patterns are deterministic, entropy threshold is fixed). No mismatch.

**However**: If the same logical observation contains slightly different raw content between two tool calls (e.g., a Bash command that includes a timestamp in output), redaction won't help — these are already different strings. This is a general dedup limitation, not a redaction bug.

---

## 8. Co-occurrence Queries — LIKE on Sanitized Paths

**File**: `src/decay/decay-engine.ts` lines 67-81

```sql
SELECT COUNT(DISTINCT id) as cnt FROM observations
WHERE id != ? AND deleted_at_epoch IS NULL AND project = ? AND files_modified LIKE ?
```
With parameter: `%"${file}"%` where `file` comes from `JSON.parse(filesModified)`.

**Verdict: SELF-CONSISTENT.** The `files_modified` column stores sanitized paths, and the LIKE query searches within that same column using values parsed from it. The `file` variable is already a sanitized path like `<project>/src/foo.ts`, so the LIKE pattern `%"<project>/src/foo.ts"%` matches correctly within the JSON array string.

**Edge case warning**: If a sanitized path contains SQL LIKE wildcards (`%` or `_`), the LIKE query could over-match. File paths typically don't contain `%`, but `_` is common in filenames. Example: `<project>/src/my_file.ts` — the `_` in LIKE matches any character, so it could match `<project>/src/my-file.ts` too. This is a minor correctness issue.

---

## 9. Checkpoint Writer — json_each on Sanitized Paths

**File**: `src/checkpoint/writer.ts` lines 192-200

```sql
SELECT DISTINCT json_each.value AS file_path
FROM observations, json_each(observations.files_modified)
WHERE observations.session_id = ? AND observations.deleted_at_epoch IS NULL
```

This extracts individual sanitized paths from the JSON array. The returned `readFiles` array contains sanitized paths like `<project>/src/foo.ts`.

**Cross-reference with hot files**: The checkpoint also calls `getHotFiles(db, project, 20)` which returns `pressure_scores` rows with RAW `file_path` values.

**FINDING [HIGH, same as #5]: Checkpoint YAML will contain a mix of sanitized observation file paths and raw pressure file paths.** Any consumer (like the assembler reading checkpoint state) comparing these two sets will never find overlaps.

---

## 10. Assembler — Double Redaction Risk

**File**: `src/assembly/assembler.ts`

The assembler calls `redactContent()` on its own output in several places:
- Line 195: `content = redactContent(content)` on assembled sections
- Line 206: `redactContent(section)` on overflow sections
- Line 230: `content = redactContent(content)` on enrichment payload
- Line 244: `content = redactContent(identity)` on identity
- Line 341: `content = redactContent(pivotSection)` on topic pivot

Since the observation `content` and `title` fields are ALREADY redacted when stored, and then get formatted into sections, the assembler is applying redaction a second time.

**Verdict: LOW RISK but wasteful.** `redactContent()` is idempotent for pattern-based redaction (tokens like `[REDACTED_SECRET]` don't re-match secret patterns). However, the entropy check (Layer 3) re-evaluates all 20+ char tokens. The token `[REDACTED_ENTROPY]` is 18 chars — just under the 20-char threshold — so it won't be re-redacted. But `[REDACTED_SECRET]` is 17 chars, also safe. **No double-redaction bug, but unnecessary CPU work.**

---

## Summary of Findings

| # | Severity | Description | File(s) |
|---|----------|-------------|---------|
| 1 | **HIGH** | Pressure scores store raw paths; observations store sanitized paths. Cross-referencing impossible. | `lifecycle.ts:123`, `extractor.ts:86` |
| 2 | **HIGH** | FTS5 indexes redacted content. Searching for original terms (file paths, identifiers) silently misses. Searching for "secret" matches all secret-redacted observations. | `migrations.ts:41-66`, `observations.ts:136-144` |
| 3 | **MEDIUM** | `[REDACTED_SECRET]` triggers security category classification, inflating importance to 5 and preventing decay pruning. | `scoring.ts:13-23`, `extractor.ts:84` |
| 4 | **LOW** | `_` in sanitized file paths acts as LIKE wildcard in co-occurrence queries, causing potential over-matching. | `decay-engine.ts:80-81` |
| 5 | **LOW** | Assembler applies redundant `redactContent()` on already-redacted observation text. No correctness issue, minor perf waste. | `assembler.ts:195,206,230,244,341` |

### Recommended Fixes (priority order)

1. **[HIGH] Pressure path sanitization**: Apply `sanitizePath(filePath, projectRoot)` in `lifecycle.ts:123` before calling `updatePressureScore()`, or store both raw and sanitized paths.

2. **[HIGH] FTS5 indexing**: Either (a) add `files_modified` to the FTS5 schema so file paths are searchable, or (b) store a separate `raw_content_for_fts` column that indexes pre-redaction content (with only PII/secrets removed, keeping structural tokens), or (c) accept the limitation and document that FTS5 search only works on non-redacted terms.

3. **[MEDIUM] Category classification**: Strip `[REDACTED_*]` tokens before keyword matching in `classifyCategory()`, or run classification on pre-redaction content (reorder pipeline to: extract → classify → score → redact → dedup → store).

4. **[LOW] LIKE escaping**: Escape `_` and `%` in file path strings before using in LIKE patterns in `getCoOccurrences()`.
