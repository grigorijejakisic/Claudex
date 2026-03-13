# Redaction Consumer Audit

Worker 1 — Data Flow Mismatch Audit
Date: 2026-03-13

---

## 1. Call Sites for `redactContent()`

### 1a. `src/extraction/extractor.ts:84-85` — Pipeline Redaction (PRIMARY)

```
const redactedContent = redactContent(result.content);
const redactedTitle = redactContent(result.title);
```

**What happens to the return value:**

- `redactedContent` is passed to `classifyCategory()` (line 89) — **NO RISK**. Classification uses regex keyword matching (`/error|exception|fail.../i`). Redaction tokens like `[REDACTED_SECRET]` would trigger the `security` category via the `secret|token` pattern. This is arguably correct behavior (observations containing secrets should be classified as security). No breakage.

- `redactedContent` is passed to `scoreImportance()` (line 92) — **LOW RISK**. Scoring checks for `BREAKING_SIGNALS` and `TEST_FAILURE_SIGNALS` patterns. The token `[REDACTED_SECRET]` could match `/secret/` in the category classification step, which could inflate importance to 5 (security category). This is a false-positive promotion but not a data integrity issue.

- `redactedContent` is used in dedup SQL query (line 119): `AND content = ?` — **NO RISK**. Exact string comparison. Redacted content matches against previously-redacted content. Deterministic redaction means identical inputs produce identical outputs. Works correctly.

- `redactedContent` is stored in DB via `insertObservation()` (line 131) — stored in `observations.content` column (TEXT NOT NULL). **NO RISK** for storage. The column has no constraints that would reject `[REDACTED_*]` tokens.

- `redactedTitle` is stored in `observations.title` column via `insertObservation()` (line 130) — same as content. **NO RISK**.

- Both are indexed in FTS5 via the `observations_ai` trigger — **MINOR QUIRK**. The FTS5 tokenizer is `porter unicode61`. Searching for "REDACTED" would match all redacted observations. This is not a bug but could produce noisy search results. If a user searches for "secret", they would NOT match `[REDACTED_SECRET]` because the brackets and underscore create separate tokens in unicode61 (`REDACTED`, `SECRET`). However, a search for "SECRET" WOULD match, which is unexpected.

- `sanitizedFiles` (from `sanitizePath()`) is stored in `observations.files_modified` as JSON via `JSON.stringify(sanitizedFiles)` (line 68 of observations.ts) — **SEE SECTION 2 BELOW**.

**Double-redaction risk: NO.** `redactContent()` is called exactly once on the raw extractor output. The extractor functions (e.g., `extractEdit`, `extractRead`) return raw tool input/output — they do not call `redactContent()` themselves.

### 1b. `src/assembly/assembler.ts:195` — Full Context Assembly (Post-redaction reclaim)

```
content = redactContent(content);
```

**What happens to the return value:**

- `content` is the concatenation of ALL formatted sections (identity, project, checkpoint, learnings, hot files, GSD, FTS5, recent). This applies redaction to the **assembled output**.

- **DOUBLE-REDACTION BUG (CONFIRMED).** The FTS5 and recent observation sections (`formatFts5Section`, `formatRecentSection`) render `observation.content` and `observation.title` — which are ALREADY redacted at extraction time (call site 1a). When `redactContent()` runs on the assembled string, it processes already-redacted tokens like `[REDACTED_SECRET]`. Analysis:
  - `[REDACTED_SECRET]` — 17 chars. The entropy layer checks `\S{20,}` tokens, so this token (which contains `[`, `]`, `_`) is a single non-whitespace run of 17 chars. It is UNDER the 20-char minimum. **SAFE — not re-redacted by entropy layer.**
  - `[REDACTED_ENTROPY]` — 18 chars. Also under 20 chars. **SAFE.**
  - `[REDACTED_PII]` — 14 chars. **SAFE.**
  - BUT: `[REDACTED_SECRET]` contains no patterns that match secrets (no `AKIA`, no `ghp_`, no base64 > 32 chars, no email). **SAFE — not re-redacted by pattern layers.**
  - However, if a section assembles content like `"[REDACTED_PII] contacted user@example.com"`, the email would be caught. But this scenario is impossible because the email was already redacted upstream.

- **Conclusion: No actual double-redaction damage**, but the second pass is wasted work and could theoretically break if token formats change.

### 1c. `src/assembly/assembler.ts:206` — Skipped Section Reclaim

```
content += '\n\n' + redactContent(section);
```

**What happens:** Reclaimed sections (GSD, FTS5, recent) are redacted before appending. These sections come from `formatGsdSection`, `formatFts5Section`, `formatRecentSection`.

- **DOUBLE-REDACTION RISK:** Same analysis as 1b. GSD content comes from file system (raw, not pre-redacted) — **safe, needed**. FTS5/recent content comes from DB (pre-redacted) — **redundant but safe** per analysis above.

### 1d. `src/assembly/assembler.ts:230` — Tier 2 Checkpoint-Only

```
content = redactContent(content);
```

**What happens:** Applied to `identity + checkpoint markdown`. Identity comes from `USER.md` (raw file, never pre-redacted). Checkpoint comes from `renderCheckpointMarkdown()` which renders checkpoint YAML fields.

- **DOUBLE-REDACTION RISK for checkpoint data:** Checkpoint's `files.read` array contains paths extracted from `observations.files_modified` via `json_each` query (writer.ts:193-200). These paths are already sanitized (via `sanitizePath()` at extraction time). The `<project>/...` paths are embedded in the checkpoint markdown as `- <project>/src/foo.ts`. Then `redactContent()` runs on this.
  - The `<project>/...` path tokens ARE allowlisted in the entropy layer (`isAllowlisted` checks `^<project>[/\\]`). **SAFE.**
  - The `<` character in `<project>` is not a secret pattern, not an email, not a phone number. **SAFE.**

- Identity from USER.md — raw file content, not pre-redacted. **Correct to redact.**

### 1e. `src/assembly/assembler.ts:244` — Tier 3 Identity-Only

```
let content = redactContent(identity);
```

**What happens:** Redacts raw USER.md content. **NO RISK.** This is first-pass redaction on raw text.

### 1f. `src/assembly/assembler.ts:341` — Topic Pivot

```
let content = redactContent(pivotSection);
```

**What happens:** The pivot section is built from `formatTopicPivotSection()`, which includes:
- `shift.previousTopic` / `shift.newTopic` — from thread state (DB, not pre-redacted, just topic strings)
- `learnings[].content` — from `learnings` table (NOT pre-redacted at insert time — decision capture and learnings promoter store raw content)
- `hotFiles[].file_path` — from `pressure_scores` table (raw file paths, NOT sanitized — see bug in Section 3)

**NO double-redaction risk.** Learnings and pressure data are not pre-redacted.

**BUT: Hot file paths in pivot sections are RAW absolute paths** (e.g., `C:\Users\Grigorije\Desktop\Projects\...`). `redactContent()` does NOT call `sanitizePath()` — it only does secret/PII/entropy redaction. The raw path may contain the username. `redactPII` does not match Windows paths. **This is a PRIVACY LEAK for file paths displayed in topic pivot sections** — unless `sanitizePath()` is called separately (it is not).

---

## 2. Call Sites for `sanitizePath()`

### 2a. `src/extraction/extractor.ts:86` — Pipeline Path Sanitization (ONLY CALL SITE)

```
const sanitizedFiles = result.files_modified.map((f) => sanitizePath(f, projectRoot));
```

**This is the ONLY production call to `sanitizePath()`.** It converts absolute paths to `<project>/relative` format when `projectRoot` is provided, or replaces usernames with `[USER]`.

**Downstream consumers of sanitized paths:**

#### 2a-i. DB Storage: `observations.files_modified` column

Stored as `JSON.stringify(sanitizedFiles)` — e.g., `["<project>/src/main.ts"]`.

The `files_modified` column has `CHECK (json_valid(files_modified))`. JSON.stringify produces valid JSON. The `<` and `>` characters are valid in JSON strings (they don't need escaping in JSON). **NO RISK.**

#### 2a-ii. Dedup Query: `AND files_modified = ?` (extractor.ts:107)

Exact JSON string comparison. Since both sides use `JSON.stringify(sanitizedFiles)`, the comparison is deterministic. **NO RISK.**

#### 2a-iii. Dedup SQL LIKE Query: `files_modified LIKE ?` (decay-engine.ts:80)

```sql
WHERE files_modified LIKE '%"<project>/src/foo.ts"%'
```

**BUG (CONFIRMED).** The `<` character has no special meaning in SQL LIKE patterns (only `%` and `_` are wildcards). However, the `getCoOccurrences()` function builds the pattern as:

```js
`%"${file}"%`
```

Where `file` is a string from `JSON.parse(filesModified)` — i.e., already sanitized. Example: `file = "<project>/src/main.ts"`. The LIKE pattern becomes `%"<project>/src/main.ts"%`. This is valid SQL and will match correctly. **Actually NO RISK** — `<` and `>` are literal characters in LIKE.

#### 2a-iv. Checkpoint Writer: `files.read` array (writer.ts:200)

```js
readFiles = rows.map((r) => r.file_path);
```

Where `r.file_path` comes from `json_each(observations.files_modified)` — these are sanitized paths. They end up in `checkpoint.files.read` and are serialized to YAML via `js-yaml`.

**YAML Serialization Risk:** The `<project>/src/main.ts` string contains `<` which is NOT a special YAML character. YAML special characters are `:`, `#`, `{`, `}`, `[`, `]`, `,`, `&`, `*`, `!`, `|`, `>`, `'`, `"`, `%`, `@`, `` ` ``. The `<` character is NOT in this list. However, `>` IS a special YAML character (folded scalar indicator). But `<project>/src/main.ts` starts with `<`, not `>`. And when it appears as a list item value, js-yaml will quote it if needed. **LOW RISK** — js-yaml handles this correctly by auto-quoting.

Wait — let me reconsider. The `>` in `<project>/src/main.ts` is in the middle of the string. YAML only treats `>` as special when it's the FIRST character of a scalar value. Since these paths start with `<`, not `>`, and js-yaml is being used for serialization (which auto-quotes), this is **SAFE**.

#### 2a-v. Checkpoint Inject: `renderCheckpointMarkdown()` (inject.ts:74-86)

Hot file paths rendered as:
```
- <project>/src/foo.ts
```

Read file paths rendered as:
```
- <project>/src/bar.ts
```

**Markdown Rendering Risk:** In Markdown, `<...>` is autolink syntax. `<project>/src/foo.ts` would be interpreted as an HTML tag `<project>` by a Markdown parser, since it starts with `<` and contains `/`. In strict Markdown, this would be treated as an unknown HTML element.

**RISK: MEDIUM.** If this Markdown is parsed by an LLM (injected into the system prompt), the LLM sees the raw text — no Markdown rendering occurs. The text `<project>/src/foo.ts` is unambiguous to an LLM. **For LLM injection: NO RISK.** For human-readable Markdown rendering (e.g., dashboard, debug output): the `<project>` tag would be swallowed as HTML. **LOW RISK** since primary consumer is LLM, not human.

#### 2a-vi. Assembly Sections: `formatHotFilesSection()` and `formatTopicPivotSection()`

`formatHotFilesSection()` (sections.ts:108) renders `f.file_path` from pressure_scores. **These are NOT sanitized** — pressure_scores stores raw paths (see Section 3 below).

`formatTopicPivotSection()` (sections.ts:238) also renders `f.file_path` from pressure_scores. **Same issue — NOT sanitized.**

---

## 3. Pressure Score Path Mismatch (BUG)

### The Problem

In `lifecycle.ts:119-126`:
```js
const filePathKeys = ['file_path', 'filePath', 'path'];
for (const key of filePathKeys) {
  const filePath = params.toolInput[key];
  if (typeof filePath === 'string' && filePath) {
    updatePressureScore(params.db, filePath, params.project, 0.1);
    break;
  }
}
```

This stores the **RAW, unsanitized** file path in `pressure_scores.file_path`. Example: `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\main.ts`.

Meanwhile, the same tool event stores the **sanitized** path in `observations.files_modified`: `<project>/src/main.ts`.

**Consequences:**

1. **Co-occurrence counting is broken** (decay-engine.ts:80). `getCoOccurrences()` uses `files_modified LIKE '%"<file>"%'` where `<file>` comes from the observation's sanitized path. But no observation will ever contain the raw path, and no observation path will match a `LIKE` query with the raw path from pressure_scores. Actually — `getCoOccurrences` receives `filesModified` from the observation itself, not from pressure_scores. So it uses sanitized paths to search other observations' sanitized `files_modified`. **This works correctly within observations.** The mismatch is between observations and pressure_scores, not within observations.

2. **Checkpoint `files.hot` uses raw paths** (writer.ts:264): `path: f.file_path` where `f` comes from `getHotFiles()` on pressure_scores. These raw paths go into the checkpoint YAML. Then `renderCheckpointMarkdown()` renders them as `- C:\Users\Grigorije\Desktop\Projects\...\src\auth.ts`. **PRIVACY LEAK: username in checkpoint files.**

3. **Assembly `formatHotFilesSection()` uses raw paths** (sections.ts:108): `- C:\Users\Grigorije\...\src\hot.ts (pressure: 0.95)`. This is injected into the LLM prompt. **PRIVACY LEAK: username in assembled context.**

4. **Assembly `formatTopicPivotSection()` uses raw paths** (sections.ts:238): Same issue.

### Rating: **HIGH RISK BUG** — Username leaks into checkpoints, YAML files, and LLM-injected context.

---

## 4. Double-Redaction Analysis

### Can `redactContent()` be called on already-redacted text?

**Yes, in the assembler** (call sites 1b, 1c, 1d). The assembled context includes observation content (pre-redacted at extraction) and then `redactContent()` is applied to the whole assembled string.

**Damage analysis:**
- `[REDACTED_SECRET]` — 17 chars, no whitespace, not >= 20 chars. Entropy layer skips it. Pattern layer: no AKIA, no ghp_, no Bearer, no base64 > 32 chars. PII layer: no email, no phone, no SSN, no CC, no IP. **SAFE.**
- `[REDACTED_PII]` — 14 chars. Same analysis. **SAFE.**
- `[REDACTED_ENTROPY]` — 18 chars. Same analysis. **SAFE.**
- Multiple adjacent tokens like `[REDACTED_PII] [REDACTED_PII]` — each is separate whitespace-delimited. **SAFE.**

**Conclusion: Double-redaction is present but causes no damage with current token formats.** If token format ever changes (e.g., longer tokens, tokens with `@` characters), this could break. **LOW RISK — recommend adding a guard.**

---

## 5. Enrichment Sends Redacted Content to LLM

In `writer.ts:289-298` and `enrichment.ts:96-111`:

```js
const cpData: CheckpointData = {
  topic: checkpoint.thread.topic ?? undefined,
  decisions: checkpoint.decisions.map((d) => d.content),
  open_items: checkpoint.open_items,
  learnings: checkpoint.learnings,
  ...
};
```

Then `buildEnrichmentPrompt(data)` sends this to Ollama. The `decisions` content is NOT pre-redacted (decisions are captured from user/assistant text directly, not through the redaction pipeline). The `learnings` content is also NOT pre-redacted.

**However**, `checkpoint.thread.summary` and `checkpoint.thread.key_exchanges` come from the thread tracker, which stores raw user/assistant text gists. These could contain PII or secrets.

**RISK: MEDIUM.** Enrichment sends potentially-unredacted content to a local LLM. Since the LLM is local (Ollama, validated via `isLocalOrPrivateUrl`), this is a data-at-rest concern rather than a data-in-transit concern. But it means the enrichment prompt could contain secrets that were in the original conversation.

---

## 6. FTS5 Search Token Pollution

Redacted content is indexed in FTS5 (`observations_fts`). The tokens `REDACTED`, `SECRET`, `PII`, `ENTROPY` are now part of the FTS5 index.

- Searching for "SECRET" matches all secret-redacted observations. This could produce noisy search results.
- Searching for "REDACTED" matches all redacted observations regardless of type.
- The FTS5 tokenizer (`porter unicode61`) strips `[` and `]` and `_`, so the indexed tokens are: `redact`, `secret`, `pii`, `entropi` (after Porter stemming).

**RISK: LOW.** Search quality degrades slightly when common English words collide with redaction tokens. "secret" is particularly problematic since it's both a redaction token AND a legitimate keyword users might search for.

---

## 7. Summary of Findings

### Confirmed Bugs

| # | Location | Severity | Description |
|---|----------|----------|-------------|
| B1 | `lifecycle.ts:122` | **HIGH** | `updatePressureScore()` stores raw unsanitized paths in `pressure_scores.file_path`. Username leaks into checkpoints, hot files sections, and topic pivot sections. |
| B2 | `assembler.ts:195,206,230` | **LOW** | Double-redaction of already-redacted content. Currently safe due to token format, but fragile. |
| B3 | `assembler.ts:341` + `sections.ts:238` | **MEDIUM** | Topic pivot renders `hotFiles[].file_path` (raw paths from pressure_scores) without sanitization. Username leak in LLM-injected context. |

### Potential Risks (Not Currently Bugs)

| # | Location | Risk | Description |
|---|----------|------|-------------|
| R1 | `scoring.ts:39` | LOW | `[REDACTED_SECRET]` in content triggers `security` category via `/secret|token/` match. False-positive category inflation. |
| R2 | FTS5 index | LOW | Redaction tokens pollute full-text search index. Searching for "secret" matches all secret-redacted rows. |
| R3 | `enrichment.ts:96-111` | MEDIUM | Enrichment prompt may contain unredacted secrets from thread state (key_exchanges, summary). Mitigated by local-only LLM validation. |
| R4 | Markdown rendering | LOW | `<project>/path` could be misinterpreted as HTML tag in Markdown renderers. No impact on primary LLM consumer. |
| R5 | `checkpoint/inject.ts:74-83` | LOW | Checkpoint hot file paths come from pressure_scores (raw paths, not sanitized). Written to YAML files on disk. Username in checkpoint YAML files. |

### Safe Call Sites (No Issues)

| Location | Why Safe |
|----------|----------|
| `extractor.ts:84-86` | First-pass redaction on raw extractor output. No double-redaction. |
| `extractor.ts:107,119` | Dedup uses exact string equality on consistently-redacted content. |
| `observations.ts:52-69` | DB storage: TEXT columns accept any string. JSON.stringify handles `<>` characters. |
| `observations.ts:136-144` | FTS5 MATCH: searches redacted content, which is consistent. |
| `decay-engine.ts:80` | LIKE query on files_modified: `<` and `>` are literal in SQL LIKE. |
| `assembler.ts:244` | Tier 3 identity-only: first-pass redaction on raw USER.md. |

### Recommended Fixes

1. **B1 (HIGH):** In `lifecycle.ts:processToolAndPressure()`, sanitize file paths before storing in pressure_scores:
   ```ts
   updatePressureScore(params.db, sanitizePath(filePath, params.cwd), params.project, 0.1);
   ```
   This aligns pressure_scores paths with observations.files_modified paths.

2. **B2 (LOW):** Add a guard at the top of `redactContent()` to skip already-redacted text:
   ```ts
   // Or: skip redaction in assembler when content is known to be pre-redacted
   ```
   Alternatively, track provenance and skip redaction for DB-sourced content.

3. **B3 (MEDIUM):** In `formatTopicPivotSection()` and `formatHotFilesSection()`, call `sanitizePath()` on `f.file_path` before rendering. Or fix B1 so pressure_scores stores sanitized paths.

4. **R3 (MEDIUM):** Apply `redactContent()` to enrichment prompt text before sending to LLM.
