# W4: Intelligence Subsystem Data Flow Audit

## Scope
Traced redacted vs. raw text through the intelligence pipeline: topic-shift detection, decision capture, learnings promoter, enrichment, and embeddings.

---

## 1. Topic-Shift Detection (`src/intelligence/topic-shift.ts`)

### Data Flow
- **Current prompt**: arrives RAW from `input.user_prompt` (CC hooks: `user-prompt-submit.ts:18`) or `lastUserMsg.content` (bridge: `bridge-adapter.ts:246`). No redaction applied before passing to `detectTopicShift`.
- **Stored topic**: extracted by `ThreadTracker.onAfterTurn` via `extractTopic(userText)` where `userText` is also RAW (from `input.user_prompt` or `ctx.lastUserText`). Stored in `thread_state.topic` as raw text.
- **Embedding comparison**: `provider.embed(prompt)` vs `provider.embed(thread.topic)` -- both RAW. **No mismatch.**
- **Jaccard fallback**: `keywordJaccard(thread.topic, prompt)` -- both RAW. **No mismatch.**

### BUG: False negative on topic shift if thread topic is never refreshed
- `extractTopic` is only called when `!this.topic` (line 198 of `thread-tracker.ts`), meaning the topic is "set once" per session. If the user changes topic via a non-explicit-pivot phrase and it's not detected by embedding/Jaccard, the stored topic never updates. Subsequent prompts about the NEW topic would compare against the stale original topic and could trigger false topic-shift detections. This is a design choice (topic-shift detection is meant to catch these), but it means the topic field can be stale for the entire session.

### BUG: Raw text sent to Ollama for embedding
- `prompt` is sent to Ollama's `/api/embed` endpoint without redaction. If the prompt contains secrets/PII, those are transmitted to the local Ollama instance. **Severity: LOW** -- Ollama is validated to be `localhost`/private-network only (see `isLocalOrPrivateUrl` check). Secrets stay local but are processed by the embedding model.

### Verdict: NO raw-vs-redacted mismatch. Both sides are raw.

---

## 2. Decision Capture (`src/intelligence/decision-capture.ts`)

### Data Flow
- **userText / assistantText**: arrive RAW from the adapter layer. CC hooks `stop.ts:18-19` passes `input.stop_assistant_turn` / `input.user_prompt`. Bridge `bridge-adapter.ts:366-367` passes `ctx.lastAssistantText` / `ctx.lastUserText`. Neither applies redaction.
- **Regex extraction**: All 4 tiers match against RAW text. `[REDACTED_*]` tokens will never appear in the text being matched.
- **Stored content**: `insertDecision` stores `candidate.content` which is the raw extracted text. **Decisions in the DB are RAW (unredacted).**
- **Fingerprint**: `normalizeForDedup(candidate.content)` operates on raw text. Dedup comparison via `isDuplicate` compares raw-to-raw against existing DB decisions (also raw). **No mismatch.**

### BUG: Decisions stored with raw text, but read back into checkpoint/assembly without redaction
- `getDecisionsBySession` returns raw `content`. The checkpoint writer (`writer.ts:183`) stores decisions verbatim: `decisions.map(d => ({ content: d.content, ... }))`. The checkpoint is then serialized as YAML and written to disk. Only the *assembled* output goes through `redactContent` in `assembler.ts:195`, but the checkpoint YAML file contains raw decision text.
- **Severity: MEDIUM** -- Checkpoint files on disk (`context/checkpoints/*.yaml`) contain unredacted decision text that may include secrets/PII embedded in natural language decisions.

### BUG: Regex patterns are not designed to handle `[REDACTED_*]` tokens
- Not currently a problem because input is raw. However, if upstream ever applies redaction before decision capture, patterns like `TIER2_IMPERATIVE` (`/^(use|implement|...)/i`) would still work (redaction doesn't affect sentence-initial keywords), but `TIER4_MARKER` patterns could break if the matched sentence content is partially redacted, yielding garbled stored decisions.
- **Severity: LATENT** -- not triggered today, but fragile if pipeline order changes.

### BUG: Embedding classification sends raw decision text to Ollama
- `classifier.provider.embed(candidate.content)` on line 163 sends raw candidate text to Ollama. Same local-only mitigation as topic-shift.

### Verdict: NO mismatch today. Decisions are consistently raw throughout. Risk: checkpoint files on disk contain raw text.

---

## 3. Learnings Promoter (`src/intelligence/learnings-promoter.ts`)

### Data Flow
- **sessionLearnings input**: Currently hardcoded as `[]` in `lifecycle.ts:257` (`runCompactionSequence`). The promoter is wired but receives NO learnings to promote during compaction. Test cases use raw strings.
- **Dedup comparison**: `findDuplicate(learning, existing)` uses 3-tier semantic-dedup (`isDuplicate`): normalized exact match, keyword Jaccard >= 0.5, substring containment.
- **Storage**: `upsertLearning` stores `learning` (raw) as `content`, with `normalizeForDedup(learning)` as `fingerprint`.

### BUG: Dedup would fail on redacted-vs-raw if learnings come from mixed sources
- `normalizeForDedup` strips punctuation and lowercases, so `[REDACTED_SECRET]` becomes `redactedsecret`. If the same learning appears once as `"Use sk-abc123 for auth"` and later as `"Use [REDACTED_SECRET] for auth"`, their fingerprints would be `"use skabc123 auth"` vs `"use redactedsecret auth"`. Tier 1 exact match: MISS. Tier 2 Jaccard: 2/4 = 0.5, borderline MATCH. Tier 3 substring: neither contains the other, MISS. So dedup MIGHT catch it (Jaccard boundary) but is unreliable.
- **Severity: LATENT** -- `sessionLearnings` is currently `[]` so no learnings flow through this path.

### BUG: `sessionLearnings: []` means learnings promotion is a no-op
- `runCompactionSequence` passes an empty array. The enrichment pathway (checkpoint writer) does read `topLearnings` from DB for checkpoints, but the promotion pathway never receives new learnings. This appears to be an incomplete implementation rather than a data-flow mismatch, but it means the dedup code is never exercised in production.
- **Severity: LOW** (functional gap, not a data mismatch).

### Verdict: No mismatch possible today because no data flows through. Dedup is fragile against redacted-vs-raw if learnings eventually come from mixed sources.

---

## 4. Enrichment (`src/intelligence/enrichment.ts`)

### Data Flow
- **Input**: `enrichCheckpoint(cpData, provider)` where `cpData` is built from:
  - `checkpoint.thread.topic` -- RAW (from thread_state, unredacted)
  - `checkpoint.decisions[].content` -- RAW (from decisions table, unredacted)
  - `checkpoint.open_items` -- RAW (extracted from `lastAssistantText` via regex, unredacted)
  - `checkpoint.learnings` -- RAW (from learnings table, unredacted)
  - `checkpoint.thread.summary` -- RAW (from thread_state, unredacted)
  - `checkpoint.thread.key_exchanges` -- RAW (gists from thread tracker, unredacted)
- **LLM call**: `buildEnrichmentPrompt(data)` interpolates all the above into a prompt string, sent to Ollama's `/v1/chat/completions`.

### BUG: Raw secrets/PII sent to Ollama for enrichment
- All checkpoint data is unredacted when sent to Ollama. The prompt includes decisions, learnings, open items, summaries -- all raw.
- **Severity: LOW** -- Ollama is validated to be `localhost`/private-network via `isLocalOrPrivateUrl` check. Secrets stay local.

### BUG: If data WERE redacted, enrichment would produce garbage
- An LLM receiving `"Use [REDACTED_SECRET] for authentication with [REDACTED_PII]"` cannot meaningfully "refine" that checkpoint data. The prompt says "keep what's accurate, fix what's imprecise, remove what's noise" -- the LLM might remove redacted tokens as "noise" or hallucinate replacements.
- **Severity: LATENT** -- not triggered because data is raw. If redaction is ever applied before enrichment, the enrichment step becomes useless or harmful.

### Safety-net merge correctness
- `mergeEnrichment` uses `normalizeForDedup` and `isDuplicate` to detect uncovered heuristic entries. If heuristic data is raw and enriched data is LLM-produced (slightly rephrased), the Jaccard dedup with threshold 0.5 should catch most legitimate rephrasings. **This is sound** as long as both sides are in the same form (raw or redacted).

### Verdict: Consistently raw. No mismatch. Local Ollama mitigates secret transmission. If redaction were applied pre-enrichment, enrichment would break.

---

## 5. Embeddings (`src/embeddings/embedding-provider.ts`, `src/embeddings/templates.ts`)

### Data Flow
- **Template embeddings**: Computed on hardcoded template strings in `templates.ts:17-31` (e.g., `"We decided to use X instead of Y"`). These are synthetic, contain no secrets/PII. Computed once via `initTemplates` and cached.
- **Candidate embeddings**: Computed on raw decision text (`candidate.content`) in `decision-capture.ts:163`. Also raw text.
- **Topic-shift embeddings**: Computed on raw `prompt` and raw `thread.topic`. Both raw.

### Cosine similarity drift analysis (redacted vs raw)
- Example: `"Fix auth bug in sk-abc123def456"` vs `"Fix auth bug in [REDACTED_SECRET]"`
  - The embedding model (nomic-embed-text) would produce different vectors because the token sequences differ. The semantic content is similar ("fix auth bug in [something]") but the specific tokens are different.
  - Expected cosine similarity: ~0.75-0.85 (high but not identical). For topic-shift detection with threshold 0.35, this would NOT trigger a false shift. For decision classification, the classification margin (positive-negative similarity difference) would be similar since both express decision-like intent.
- Example: `"Use 192.168.1.100 for the database"` vs `"Use [REDACTED_PII] for the database"`
  - IP addresses are not semantically loaded in embedding space. Drift would be minimal (~0.90+ similarity).
- **Worst case**: Long base64/JWT tokens redacted to `[REDACTED_SECRET]`. The token carries no semantic weight, so redaction impact is negligible for embeddings.

### Verdict: No mismatch today (all raw). If redaction were applied, embedding drift would be minor for topic-shift (well above 0.35 threshold) and negligible for decision classification. **Not a practical risk.**

---

## Summary of Findings

| # | Component | Mismatch? | Severity | Description |
|---|-----------|-----------|----------|-------------|
| 1 | Topic-shift | NO | -- | Both prompt and stored topic are raw. Embeddings sent to local Ollama unredacted. |
| 2 | Decision capture | NO | MEDIUM | Decisions stored raw. Checkpoint YAML files on disk contain unredacted text. |
| 3 | Learnings promoter | NO | LATENT | `sessionLearnings: []` -- promoter is a no-op. Dedup fragile if mixed redaction. |
| 4 | Enrichment | NO | LOW | All checkpoint data sent raw to local Ollama. Would break if redacted pre-enrichment. |
| 5 | Embeddings | NO | -- | Templates hardcoded. All runtime embeddings computed on raw text. Drift minor if ever redacted. |

### Cross-cutting finding: The intelligence pipeline is consistently unredacted

The entire intelligence subsystem operates on raw text. Redaction only happens in two places:
1. **Extraction pipeline** (`extractor.ts:84-86`): observations are redacted before DB storage.
2. **Assembly** (`assembler.ts:195`): assembled output is redacted before injection into the conversation.

The intelligence pipeline (topic-shift, decisions, thread tracking, learnings, enrichment) sits BETWEEN extraction and assembly, operating on raw text from the adapter layer. This is **consistent** -- there is no raw-vs-redacted mismatch within the intelligence layer. However:

### Real risks:
1. **Checkpoint YAML files on disk contain raw decisions, learnings, and thread state** -- not redacted. If these files are committed to version control or shared, secrets/PII leak.
2. **If redaction is ever moved earlier in the pipeline** (e.g., redacting adapter inputs), the intelligence layer would break: topic-shift embeddings would drift, decision regex patterns would work but produce garbled content, learnings dedup would be unreliable, and enrichment would produce garbage.
3. **The `sessionLearnings: []` in compaction means learnings promotion is dead code in production.** This isn't a data-flow mismatch but is a gap that makes the dedup path untested.
