# Phase 4: Intelligence v1.2 - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Embedding-powered intelligence additions: Ollama nomic-embed-text client, cosine similarity, decision classification Stage 2, topic-shift detection, and LLM enrichment with safety-net merge. All features gracefully degrade when Ollama is unavailable -- Phase 3's heuristic intelligence remains fully functional as the fallback path.

Target modules:
- New: `src/embeddings/embedding-provider.ts`, `cosine.ts`, `templates.ts`
- New: `src/intelligence/topic-shift.ts`, `src/intelligence/enrichment.ts`
- Modified: `src/intelligence/decision-capture.ts` (Stage 2 wiring)

</domain>

<decisions>
## Implementation Decisions

### Embedding Provider as Shared Service
- Single `EmbeddingProvider` initialized once at core startup, passed to consumers
- Both topic-shift detection and decision classification use the same provider instance
- `embed(text)` returns `number[] | null` -- null means Ollama unavailable
- `isAvailable()` health check against `http://localhost:11434/api/tags`
- Model: `nomic-embed-text` (768-dim embeddings, ~5ms per call via local Ollama)

### Decision Capture Stage 2 Wiring
- Option (a): Add optional `classifier` param to `captureDecisions` function
- Consistent with Phase 3 pattern of plain functions with explicit params (no singletons, no classes)
- Caller passes classifier when embeddings available, null/undefined when not
- When classifier present: Stage 1 candidates filtered via `classifyDecision` (confidence > 0.15)
- When classifier absent: Stage 1 candidates pass through unchanged (existing behavior preserved)
- Function signature becomes async (was sync) due to embedding calls

### Cosine Similarity
- Pure math function, no dependencies: `cosineSimilarity(a: number[], b: number[]): number`
- Sliding window helper: compare current embedding against last N embeddings for smoothing
- Used by both topic-shift (prompt vs topic similarity) and decision classification (candidate vs templates)

### Template Embeddings for Decision Classification
- 5 positive templates (decision-like) + 4 negative templates (filler-like) from Architecture 6.1
- Precomputed at init via `initTemplates(provider)`, cached in memory
- `classifyDecision(candidateEmb, templateEmbs)` returns `maxPositive - maxNegative` confidence
- Threshold: 0.15 (configurable via `embeddings.decision_confidence_threshold`)

### Topic-Shift Detection Three-Layer Design
- Layer 1: Explicit pivot regex (cheapest, highest precision) -- always checked first
  - Pattern: `^(now let's|next[,:]|switch to|moving on|let's work on|different topic|new task|back to|forget that|actually[,:]? (?:let's|can we|I need))`
- Layer 2: Embedding cosine similarity (preferred when available)
  - Compare prompt embedding against cached topic embedding
  - Sliding window: also compare against last 3 user prompts (smooths noise)
  - Shift fires when: `similarity < 0.35 AND avgRecent < 0.40`
- Layer 3: Keyword Jaccard fallback (when no embeddings)
  - Reuses `keywordJaccard` from semantic-dedup.ts
  - Shift fires when: `overlap < 0.15`
- Returns `TopicShiftResult { shifted, newTopic, previousTopic, confidence, method }`
- Phase 4 detects shifts only; Phase 5 (Assembly) acts on them via micro-injection

### Embedding Cache Strategy
- Topic embedding: computed once per topic change, cached in memory (invalidated on shift)
- Template embeddings: computed once at init, cached for lifetime
- Prompt embeddings: computed per call (~5ms each), not cached (transient)
- Recent prompt embeddings: stored in sliding window buffer (last 3) for avgRecent calculation

### LLM Enrichment Design
- Operates on a checkpoint-shaped interface (not the actual checkpoint system, which is Phase 6)
- `detectEnrichmentProvider()`: try Ollama first, then OpenClaw native (`hasFullMessageHistory` check)
- Ollama model selection: `"auto"` picks smallest available model (enrichment is data refinement, not code gen)
- Enrichment prompt: ~2.7k tokens input, 800 max output, structured JSON response
- Safety-net merge per Architecture 6.4:
  - Array fields (decisions, open_items, learnings): accept enriched, append uncovered heuristic entries
  - Uncovered detection: lowercase set-diff + semantic duplicate check (reuses `isDuplicate`)
  - String fields (topic, summary, task): prefer enriched if non-empty
- If provider null or enrichment fails: heuristic data is canonical, no error propagated

### Enrichment Timing (Deferred Wiring)
- enrichment.ts defines the interface it consumes and implements merge logic
- Actual "call enrichment during beforeCompact" wiring deferred to Phase 6 (checkpoint writer) or Phase 8/9 (adapter hooks)
- Clean separation: enrichment module doesn't know about checkpoint lifecycle

### Test Strategy
- All Ollama interactions go through embedding-provider.ts
- Mock embedding-provider.ts at the module level to cover all downstream consumers
- Test both paths: embeddings available (mock returns vectors) and unavailable (mock returns null)
- No separate CI flag needed -- just mock the provider
- Enrichment merge logic tested with pure data (no HTTP mocking needed for merge tests)

### Claude's Discretion
- Exact embedding vector dimensions and normalization handling
- HTTP client implementation details for Ollama API (fetch vs custom)
- Cache eviction strategy for sliding window buffer
- Error message formatting when Ollama is unavailable
- Enrichment JSON parsing robustness (malformed LLM responses)

</decisions>

<specifics>
## Specific Ideas

- embedding-provider.ts is the single point of contact with Ollama -- all other modules call it, never the HTTP API directly
- `captureDecisions` function signature change: add optional `classifier?: { classifyDecision: (candidate: string) => Promise<number> }` param. When present and returns confidence <= 0.15, candidate is filtered out before storage
- Topic-shift detection needs access to thread state (for current topic) and recent prompt history. It reads from DB via existing `getThreadState`, not by maintaining its own state
- Enrichment provider detection is a one-time operation at core init, not per-call
- The `mergeEnrichment` function is a pure function (no side effects) -- takes heuristic + enriched, returns merged. Easy to test in isolation

</specifics>

<deferred>
## Deferred Ideas

- **Topic-shift micro-injection content** -- Phase 5 (Assembly Pipeline) builds the 800-token pivot block
- **Checkpoint writer integration** -- Phase 6 calls enrichment during beforeCompact lifecycle
- **Enrichment via OpenClaw native API** -- Phase 9 (OpenClaw Bridge) provides the `completeSimple` callback
- **Token gauge integration with topic-shift** -- Phase 7 (Supporting Subsystems)

</deferred>

---

*Phase: 04-intelligence-v12*
*Context gathered: 2026-03-12*
