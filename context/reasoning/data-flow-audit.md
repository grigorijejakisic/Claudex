# Data Flow Mismatch Audit

**Date:** 2026-03-13
**Scope:** All data transformation boundaries in the Claudex v3 pipeline
**Trigger:** Bug class identified — `sanitizePath()` produces `<project>/...` format that downstream consumers (base64, entropy) didn't recognize, causing path mangling.

---

## Methodology

Traced every data transformation boundary in the pipeline:
1. Extraction (per-tool extractors -> redaction -> scoring -> storage)
2. Assembly (DB reads -> section formatters -> redaction -> injection)
3. Checkpoint (DB reads -> YAML serialization -> file write -> recovery -> parse)
4. Intelligence (decision capture -> dedup -> embedding comparison)
5. Pressure (raw path insert -> DB lookup -> assembly display)

For each boundary: verified producer output format, consumer expected format, and implicit assumptions.

---

### Finding 1: Pressure Scores Store Raw Paths, Observations Store Sanitized Paths

**Boundary:** `processToolAndPressure()` -> `pressure_scores` table vs `observations` table
**Risk:** Critical
**Issue:** In `lifecycle.ts:107-127`, `processToolAndPressure()` calls two functions with the same file path:
1. `processToolObservation()` — which sanitizes paths via `sanitizePath(f, projectRoot)` before storing in `observations.files_modified`
2. `updatePressureScore()` — which stores the **raw** `params.toolInput[key]` path directly

This means the `pressure_scores` table contains raw paths like `C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3\src\foo.ts`, while the `observations` table contains sanitized paths like `<project>/src/foo.ts`. Any query that tries to join or correlate these two tables by file path will silently fail.

**Evidence:**
- `src/adapters/shared/lifecycle.ts:119-126` — raw path inserted into pressure_scores
- `src/extraction/extractor.ts:86` — sanitized path stored in observations
- `src/decay/decay-engine.ts:77-81` — `getCoOccurrences()` does `LIKE %"file"%` search on `files_modified`, which uses sanitized paths. If someone queries co-occurrences against pressure file paths, they'll get zero matches.

**Fix:** Sanitize the file path before passing to `updatePressureScore()`, or normalize at query time. The simpler fix is to apply `sanitizePath(filePath, params.cwd)` before the `updatePressureScore()` call in `processToolAndPressure()`.

---

### Finding 2: Checkpoint `files.hot` Contains Raw Paths, `files.read` Contains Sanitized Paths

**Boundary:** `writeCheckpoint()` -> `CheckpointV3.files`
**Risk:** Medium
**Issue:** In `writer.ts:263-269`, the checkpoint builder gets hot files from `getHotFiles()` which reads from `pressure_scores` (raw paths per Finding 1), and read files from `json_each(observations.files_modified)` (sanitized paths per extraction pipeline). The resulting checkpoint YAML has mixed path formats in the same `files` section:

```yaml
files:
  hot:
    - path: "C:\\Users\\Grigorije\\Desktop\\Projects\\CLAUDEXv3\\src\\foo.ts"  # RAW
  read:
    - "<project>/src/foo.ts"  # SANITIZED
```

This inconsistency is visible to the LLM in the assembled context and could cause confusion. It also means the same file could appear in both `hot` and `read` lists without being detected as a duplicate.

**Evidence:**
- `src/checkpoint/writer.ts:264` — `hotFiles.map(f => ({ path: f.file_path }))` — raw from pressure_scores
- `src/checkpoint/writer.ts:192-203` — readFiles from `json_each(observations.files_modified)` — sanitized

**Fix:** Flows from fixing Finding 1 (sanitize pressure paths). Alternatively, sanitize hot file paths at checkpoint build time.

---

### Finding 3: Assembly Double-Redacts Content

**Boundary:** `assembleFullContext()` -> `redactContent()` on already-redacted data
**Risk:** Low
**Issue:** In `assembler.ts:194-195`, the full assembled content (which includes checkpoint data, learnings, observations, etc.) is passed through `redactContent()`. However, observations were already redacted at extraction time (`extractor.ts:84-85`). Learnings and decisions stored in the DB also originated from redacted observations or user text. This means the assembled content gets redacted twice.

While double-redaction is idempotent for `[REDACTED_SECRET]` and `[REDACTED_PII]` tokens (the regex patterns won't match them), the **entropy layer** could flag these tokens themselves. `[REDACTED_ENTROPY]` is 18 chars (under the 20-char minimum), but `[REDACTED_SECRET]` is 17 chars and `[REDACTED_PII]` is 14 chars — all under the 20-char `\S{20,}` threshold, so they're safe.

The real risk is that post-redaction **reclaim** (lines 198-210) compares pre/post redaction lengths. If assembly content contains no new secrets (everything was already redacted at extraction), the reclaim logic fires on essentially zero delta, wasting a tiny amount of CPU. More concerning: the Tier 2 fallback (`assembler.ts:229-230`) and Tier 3 (`assembler.ts:244`) also call `redactContent()` on checkpoint markdown and identity content respectively. Identity content (USER.md) is **never** pre-redacted since it's read from disk — this is correct and necessary. But the checkpoint path is double-redacted.

**Evidence:**
- `src/assembler.ts:194-195` — post-assembly redaction
- `src/extraction/extractor.ts:84-85` — extraction-time redaction
- `src/assembler.ts:341` — topic pivot redaction (also double-redacts learnings/decisions)

**Fix:** This is largely harmless but adds unnecessary latency. Consider skipping the assembly-level redaction for sections sourced from DB (already redacted) and only redacting sections read from disk (identity, project primer, GSD). Or accept the redundancy as defense-in-depth.

---

### Finding 4: Topic-Shift Compares Embedding of Raw Prompt Against Embedding of Stored Topic

**Boundary:** `TopicShiftDetector.detectTopicShift()` -> `cosineSimilarity(topicEmb, promptEmb)`
**Risk:** Medium
**Issue:** In `topic-shift.ts:84-86`, the detector embeds `thread.topic` (a stored, potentially-redacted string from `extractTopic()`) and compares it against the raw `prompt` (which has not been redacted). If the topic was extracted from text that contained secrets or PII, the extracted topic itself is unlikely to contain those (it's a short phrase from stop-word filtering). However, the prompt IS the full user message, which could contain `[REDACTED_*]` tokens from previously injected context (the LLM might echo them back), while the topic never would.

More concretely: the topic is extracted via `extractTopic()` which does stop-word removal and first-sentence extraction on raw text. The topic is never redacted. But the thread's `summary` field (used in checkpoint but not in topic-shift) IS never redacted either. Both are stored in `thread_state.topic` and `thread_state.summary` as raw text.

The actual risk here is minimal for topic-shift because both sides are effectively raw text. But there's a related issue: if `thread.topic` was set in a previous session and the current prompt references a redacted version of the same topic, embedding similarity would be lower than expected.

**Evidence:**
- `src/intelligence/topic-shift.ts:84-86` — prompt vs stored topic
- `src/intelligence/thread-tracker.ts:198-199` — topic extracted from raw userText (never redacted)
- `src/core/thread.ts:41-47` — topic stored as-is

**Fix:** Low priority. The topic extraction naturally strips most sensitive content via first-sentence extraction + stop-word removal. Document the assumption that topics are short phrases unlikely to contain secrets.

---

### Finding 5: Decision Capture Stores Raw Text, Dedup Compares Against Raw Text

**Boundary:** `captureDecisions()` -> `insertDecision()` -> `isDuplicate()` comparison
**Risk:** Low
**Issue:** Decisions are captured from `userText` and `assistantText` in `decision-capture.ts`. These texts are **not** redacted before storage. The `insertDecision()` call in `decision-capture.ts:194` stores `candidate.content` (raw text from the conversation). Meanwhile, during assembly, these decisions surface in the checkpoint markdown (`inject.ts:58-62`) which then gets `redactContent()` applied at the assembler level.

This means the DB contains raw decision text (potentially including secrets), and the assembled output contains redacted decision text. This is by design (redact at output boundary), but it means:
1. The DB itself contains unredacted decision content — a data-at-rest concern
2. Enrichment (`enrichment.ts:105`) sends raw decision content to the LLM, which is acceptable for local Ollama but would be a concern if a remote API were ever added

**Evidence:**
- `src/intelligence/decision-capture.ts:194` — raw content stored
- `src/intelligence/enrichment.ts:105` — `JSON.stringify(data.decisions ?? [])` sent to LLM
- `src/checkpoint/inject.ts:59` — decisions rendered to markdown (redacted later by assembler)

**Fix:** Consider redacting decision content before DB insertion. This would make the DB consistent with observations (redacted at ingestion). Currently, the only defense is assembly-level redaction.

---

### Finding 6: YAML Round-Trip May Alter Multiline Strings and Special Characters

**Boundary:** `yaml.dump()` -> file -> `yaml.load()` (checkpoint write/read cycle)
**Risk:** Medium
**Issue:** `js-yaml` by default uses block scalar style for multiline strings and may alter whitespace. The checkpoint writer (`writer.ts:326`) uses `yaml.dump(checkpoint, { lineWidth: 120, noRefs: true })`. The `lineWidth: 120` setting causes long strings to be wrapped, which introduces newlines that weren't in the original. On `yaml.load()`, these are reconstituted differently depending on the scalar style chosen.

Specific risks:
1. **Decision content** containing code fences or long lines will be wrapped at 120 chars. After round-trip, the line breaks may differ from the original. This affects fingerprint-based dedup if the round-tripped content is ever compared against the original.
2. **Key exchange gists** are capped at 120 chars — right at the lineWidth boundary. A 120-char gist could be wrapped or not depending on YAML indentation context.
3. **Strings containing special YAML characters** (`:`, `#`, `{`, `}`, `[`, `]`) will be quoted. This is safe for round-trip but could affect string comparisons.

The DB-first architecture mitigates this: the canonical data is in `checkpoint_meta.data` as JSON (via `JSON.stringify`), which round-trips perfectly. The YAML file is a mirror. But the file fallback path (`loadFromFile`) reads YAML directly, so this matters for recovery scenarios.

**Evidence:**
- `src/checkpoint/writer.ts:326` — `yaml.dump` with `lineWidth: 120`
- `src/checkpoint/loader.ts:111,140,180` — `yaml.load` for file fallback
- `src/checkpoint/writer.ts:284` — JSON canonical in DB (safe)

**Fix:** Consider `lineWidth: -1` (infinite) for `yaml.dump` to prevent line wrapping, or use `flowLevel: -1` (block style for all). The JSON canonical path in the DB is the main defense, but the YAML file fallback should preserve content faithfully.

---

### Finding 7: Enrichment LLM May Return Redacted Tokens as Literal Text

**Boundary:** `enrichCheckpoint()` -> `mergeEnrichment()` -> checkpoint data
**Risk:** Low
**Issue:** The enrichment prompt (`enrichment.ts:96-112`) sends checkpoint data to the LLM. If decisions or learnings contain `[REDACTED_SECRET]` or `[REDACTED_PII]` tokens (they currently don't per Finding 5 — decisions are raw), the LLM might:
1. Strip the tokens (data loss)
2. "Explain" the tokens ("there was a redacted secret here")
3. Pass them through as-is (correct behavior)

The safety-net merge (`mergeEnrichment()`) compares enriched arrays against heuristic arrays using `isDuplicate()`. If the LLM paraphrases a `[REDACTED_*]` token, the normalized comparison in `isDuplicate()` would strip the brackets and compare `redactedsecret` — which might not match the original content.

Currently this is theoretical: decisions and learnings in the enrichment payload are raw (not redacted). But if Finding 5's fix is applied (redact decisions at ingestion), this becomes a real concern.

**Evidence:**
- `src/intelligence/enrichment.ts:96-112` — enrichment prompt construction
- `src/intelligence/enrichment.ts:196-208` — safety-net merge with `isDuplicate()`
- `src/intelligence/semantic-dedup.ts:237-254` — `isDuplicate()` normalization

**Fix:** If decision redaction at ingestion is implemented, the enrichment prompt should note that `[REDACTED_*]` tokens should be preserved as-is. Add a line to the prompt: "Preserve any [REDACTED_*] tokens exactly as-is."

---

### Finding 8: FTS5 Indexes Redacted Content, Queries Use Raw Keywords

**Boundary:** `searchObservations()` query -> FTS5 index (built from redacted content)
**Risk:** Medium
**Issue:** The FTS5 index is synced with the `observations` table via triggers. Since observations are redacted at ingestion, the FTS5 index contains redacted text. When `searchObservations()` is called from assembly (`assembler.ts:156`), the query is either:
1. `params.searchQuery` (from the raw user prompt)
2. `checkpoint.thread.topic` (from stored topic, also raw)

If the original observation contained "deployed to staging server at 52.14.88.123" and that IP was redacted to "[REDACTED_PII]", a search for "staging server" will still match (those words are in the FTS5 index). But a search for the IP address "52.14.88.123" will NOT match — it was redacted. This is the desired behavior from a security standpoint but could cause confusion if a user asks about a specific value that was redacted.

More problematic: the FTS5 porter tokenizer will tokenize `[REDACTED_SECRET]` into stems of "redact" and "secret". This means a search for "redacted" or "secret" will match ALL observations that had redacted content, polluting search results.

**Evidence:**
- `src/core/observations.ts:136-146` — FTS5 MATCH query
- DDL triggers (ARCHITECTURE.md:555-568) — FTS5 synced from observations
- `src/extraction/extractor.ts:84-85` — content redacted before INSERT

**Fix:** Consider excluding `[REDACTED_*]` tokens from FTS5 indexing. This could be done with a custom FTS5 tokenizer, or by stripping redaction tokens before the FTS5 trigger fires (using a computed column or a modified trigger that replaces `[REDACTED_*]` with empty string before indexing).

---

### Finding 9: Co-Occurrence Queries Use LIKE With Sanitized Paths

**Boundary:** `getCoOccurrences()` -> `observations.files_modified` LIKE query
**Risk:** Low
**Issue:** In `decay-engine.ts:77-81`, co-occurrence counting does `files_modified LIKE %"file"%`. The `file` value comes from the candidate observation's own `files_modified` JSON, which is sanitized (e.g., `<project>/src/foo.ts`). The LIKE pattern `%"<project>/src/foo.ts"%` will match other observations with the same sanitized path. This is consistent since all observations use sanitized paths.

However, the `<` and `>` characters in `<project>` are literal in SQLite LIKE patterns (LIKE doesn't treat them specially), so this works correctly. No mismatch here.

**Evidence:**
- `src/decay/decay-engine.ts:77-81`
- Confirmed: both sides of the comparison use sanitized paths from `observations.files_modified`

**Fix:** None needed. This boundary is consistent.

---

### Finding 10: Thread State Summary and Gists Are Never Redacted

**Boundary:** `ThreadTracker.onAfterTurn()` -> `upsertThreadState()` -> `thread_state` table
**Risk:** Medium
**Issue:** The `ThreadTracker` stores `topic`, `summary`, and `key_exchanges` (with gists) directly from raw user/assistant text. Gists are extracted from raw text via `extractGist()` which does truncation but no redaction. The summary is built from topic + agent gists — also unredacted.

These values flow into:
1. `checkpoint.thread.topic/summary/key_exchanges` via `getThreadState()` in `writer.ts:184`
2. Assembly injection via `formatCheckpointSection()` -> `renderCheckpointMarkdown()` -> `inject.ts:38-53`
3. Topic-shift detection via `getThreadState()` in `topic-shift.ts:77`
4. Enrichment via `writer.ts:290-298` -> sent to LLM

The assembly path applies `redactContent()` at the assembler level, so injected content is safe. But the DB stores raw gists that could contain secrets or PII from the conversation. Example: user says "The API key is sk-abc123 and it's not working" -> gist becomes "The API key is sk-abc123 and it's not working" stored raw in `thread_state.key_exchanges`.

**Evidence:**
- `src/intelligence/thread-tracker.ts:187` — `extractGist(exchange.role, exchange.raw)` — no redaction
- `src/core/thread.ts:42-47` — stored as-is
- `src/checkpoint/writer.ts:271-274` — thread data flows to checkpoint unredacted

**Fix:** Apply `redactContent()` to gists before storage in the ThreadTracker, and to the topic/summary. This makes the DB consistent with the "redact at ingestion" principle used for observations.

---

### Finding 11: Enrichment Key Exchanges Replace Without Safety-Net

**Boundary:** `mergeEnrichment()` -> `key_exchanges` field
**Risk:** Low
**Issue:** In `enrichment.ts:222-224`, the `key_exchanges` field from the LLM enrichment response **replaces** the heuristic `key_exchanges` entirely (no safety-net merge like decisions/learnings). The safety-net merge logic (`ARRAY_FIELDS`) only covers `decisions`, `open_items`, and `learnings` — not `key_exchanges`.

If the LLM returns fewer key exchanges than the heuristic version (e.g., it decides some are "noise"), those exchanges are silently lost. This violates the architecture's principle that "LLM enrichment can improve but never silently drop heuristic data."

**Evidence:**
- `src/intelligence/enrichment.ts:166` — `ARRAY_FIELDS = ['decisions', 'open_items', 'learnings']` — key_exchanges excluded
- `src/intelligence/enrichment.ts:222-224` — direct replacement with no uncovered-entry check
- Architecture Section 6.4 — "Safety-net merge" should cover all array fields

**Fix:** Add `key_exchanges` to the safety-net merge logic, treating gists as the comparable content field. Or at minimum, validate that enriched key_exchanges length >= heuristic length before replacing.

---

## Summary

| # | Finding | Risk | Category |
|---|---------|------|----------|
| 1 | Pressure stores raw paths, observations store sanitized paths | Critical | Path format mismatch |
| 2 | Checkpoint hot files (raw) vs read files (sanitized) inconsistency | Medium | Path format mismatch |
| 3 | Assembly double-redacts already-redacted DB content | Low | Redundant processing |
| 4 | Topic-shift compares raw prompt against stored topic | Medium | Redaction asymmetry |
| 5 | Decisions stored unredacted in DB | Low | Data-at-rest |
| 6 | YAML round-trip may alter multiline strings at lineWidth boundary | Medium | Serialization fidelity |
| 7 | Enrichment LLM may alter redaction tokens | Low | LLM output safety |
| 8 | FTS5 indexes redaction tokens, polluting search results | Medium | Search quality |
| 9 | Co-occurrence LIKE query consistent (no issue) | N/A | Verified OK |
| 10 | Thread gists/summary stored unredacted | Medium | Data-at-rest |
| 11 | Enrichment key_exchanges bypass safety-net merge | Low | Data loss risk |

**Critical fixes needed:** Finding 1 (and cascading Finding 2)
**Medium-priority fixes:** Findings 6, 8, 10
**Low-priority/defense-in-depth:** Findings 3, 4, 5, 7, 11
