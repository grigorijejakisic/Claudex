# Phase 3: Intelligence Core - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Heuristic intelligence layer: decision capture (Stage 1 regex only), semantic deduplication, thread tracking, and cross-session learnings promotion. All without embeddings -- Phase 4 adds embedding-based Stage 2 classification, topic-shift detection, and LLM enrichment. Does NOT include enrichment.ts or topic-shift.ts (both Phase 4).

Target modules: `src/intelligence/decision-capture.ts`, `semantic-dedup.ts`, `thread-tracker.ts`, `learnings-promoter.ts`

</domain>

<decisions>
## Implementation Decisions

### Porter Stemmer
- Inline implementation (~50 lines) in semantic-dedup.ts, no external dependency
- Architecture says "same as FTS5 tokenizer for consistency" -- this means behavior-match, not code-sharing
- FTS5's built-in porter is C; we implement a JS equivalent
- Standard Porter stemmer algorithm is well-known and sufficient for dedup keyword extraction

### Normalize for Dedup
- Separate `normalizeForDedup()` function in semantic-dedup.ts
- Architecture 6.3 defines: `toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()` (strips punctuation)
- Existing `normalize()` in text-utils.ts only does `toLowerCase().trim().replace(/\s+/g, ' ')` -- no punctuation stripping
- Do NOT modify text-utils.ts normalize -- it's used by Phase 2 extractors and changing it could break them
- Dedup normalization is dedup-specific behavior, belongs in the dedup module

### Decision Capture Scope (Stage 1 Only)
- Phase 3 implements Stage 1 (structural heuristics / regex) only
- Stage 2 (embedding classification via nomic-embed-text, 0.15 confidence threshold) is Phase 4
- When Stage 2 is absent, Stage 1 alone is fully functional (Architecture 6.1: "When embeddings aren't available, Stage 1 alone is still functional")
- Tier 1-4 regex patterns from Architecture 6.1, filler rejection, code fence skip

### Decision Capture Triggers
- Primary: `after_turn` (full turn text available -- best signal)
- Supplemental: `after_tool` for Tier 1 (user confirmations) and Tier 4 (explicit markers) only
- `before_prompt` does NOT capture decisions -- it consumes them for assembly

### Thread Tracker Event Model
- `after_tool`: Accumulate user prompt + tool action into pending exchange buffer (fires multiple times per turn)
- `after_turn`: Flush buffer -- extract gists, append to key_exchanges, update topic if shifted, update summary (fires once at turn end)
- This split avoids partial-turn updates that would produce incoherent summaries

### Gist Extraction Rules
- User message < 120 chars: use as-is
- User message > 120 chars: sentence-boundary truncation, keep first complete sentence
- Agent message with prose: first sentence extraction, max 120 chars
- Agent message tool-calls only: tool name list format `[called Read, Edit, Write on src/auth.ts]`
- Agent message mixed: first prose sentence, ignore tool calls

### Thread Summary Construction
- Mechanical concatenation, not LLM-generated (LLM refinement is Phase 4 enrichment)
- Format: `"{topic}. {last 2-3 agent gists joined}. {open items if any}."`
- Updated at checkpoint write, not every turn

### Learnings Promotion Flow
- fingerprint = normalizeForDedup(content)
- Check existing via semantic-dedup 3-tier match (reuses dedup from 03-01)
- If match: upsert increments promotion_count via `upsertLearning()`
- If new: insert with promotion_count = 1
- Enforce 50-per-project cap: DELETE lowest promotion_count + oldest last_promoted_epoch
- Called during `before_compact` (PreCompact hook)

### Dedup Behavior per Entity Type
- Decisions: if duplicate detected, newer entry is SKIPPED (not stored)
- Learnings: if duplicate detected, existing entry is PROMOTED (increment promotion_count)
- Architecture 6.3: "the newer entry is a duplicate and is skipped (for decisions) or promotes the existing entry (for learnings)"

### Claude's Discretion
- Exact Jaccard threshold tuning within the 0.5 range specified by Architecture 6.3
- Stop word list composition (Architecture provides a base list, implementation can adjust)
- Porter stemmer edge case handling (suffixes like -ies, -ied, etc.)
- Thread topic extraction heuristic when embeddings unavailable (first sentence with stop-word removal)

</decisions>

<specifics>
## Specific Ideas

- Dedup is foundational -- decision capture and learnings promoter both depend on it, so it's built first in 03-01
- Decision capture only implements Stage 1 regex. The function signature should allow Stage 2 to be plugged in later (Phase 4) without changing the public API
- Thread tracker maintains in-memory pending buffer between after_tool calls, flushed at after_turn. The buffer is ephemeral -- if process crashes between tool calls, partial buffer is lost (acceptable for CC's ephemeral hook model)
- key_exchanges rolling window of 8 entries -- when 9th arrives, oldest is evicted (FIFO)
- Learnings cap of 50 per project is enforced at write time, not read time

</specifics>

<deferred>
## Deferred Ideas

- **Stage 2 embedding classification** -- Phase 4 (INTL-02, EMBD-03)
- **Topic-shift detection** -- Phase 4 (EMBD-04), thread-tracker.ts will have a hook point for it
- **LLM enrichment of thread summaries** -- Phase 4 (INTL-08)
- **Enrichment provider auto-detection** -- Phase 4 (INTL-10, INTL-11)

</deferred>

---

*Phase: 03-intelligence-core*
*Context gathered: 2026-03-12*
