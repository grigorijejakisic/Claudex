# 04-02 Summary: Topic-Shift, Decision Stage 2, Enrichment

**Status:** Complete
**Duration:** ~4min
**Tasks:** 3 (topic-shift, decision Stage 2, enrichment)
**Files created:** 4 (topic-shift.ts, enrichment.ts, 2 test files)
**Files modified:** 2 (decision-capture.ts, decision-capture.test.ts)

## What was built

1. **src/intelligence/topic-shift.ts** — `TopicShiftDetector` class with 3-layer detection:
   - Layer 1: Explicit pivot regex (highest precision) — `now let's`, `switch to`, `back to`, `actually, let's`, etc.
   - Layer 2: Embedding cosine similarity < 0.35 AND avgRecent < 0.40 (sliding window of last 3 prompts)
   - Layer 3: Keyword Jaccard fallback < 0.15 (when no embeddings)
   - Topic embedding cached per session (invalidated on shift)
   - Returns `TopicShiftResult { shifted, newTopic, previousTopic, confidence, method }`

2. **src/intelligence/decision-capture.ts** — Modified for Stage 2:
   - `captureDecisions` is now `async` (was sync)
   - Added optional `classifier?: { provider, templates }` param
   - Stage 2 filters candidates with confidence <= 0.15 (configurable)
   - Fail-open: embed failure does not filter candidate
   - When classifier absent: all Stage 1 candidates pass through (backward compatible)

3. **src/intelligence/enrichment.ts** — LLM enrichment module:
   - `detectEnrichmentProvider(config, capabilities)`: tries Ollama > OpenClaw native > null
   - `enrichCheckpoint(data, provider)`: calls Ollama `/v1/chat/completions` with structured prompt
   - `mergeEnrichment(heuristic, enriched)`: safety-net merge preserving uncovered heuristic entries
   - Array fields: accept enriched, append uncovered (normalized set-diff + semantic dedup check)
   - String fields: prefer enriched if non-empty
   - OpenClaw native wiring deferred to Phase 9

## Tests

- `topic-shift.test.ts`: 19 tests (Layer 1: 5, Layer 2: 6, Layer 3: 4, graceful degradation: 3, clearCache: 1)
- `decision-capture.test.ts`: 35 tests (28 existing + 7 new Stage 2 tests, all async)
- `enrichment.test.ts`: 25 tests (provider detection: 10, enrichCheckpoint: 5, mergeEnrichment: 10)

All 79 tests pass. Zero regressions (407 total suite).

## Key decisions

- Topic-shift Layer 1 always runs first (cheapest, highest precision)
- Sliding window avgRecent uses 0 when empty (conservative, allows shift on first dissimilar prompt)
- Decision capture fail-open on embed failure (candidate kept, not filtered)
- Enrichment safety-net: LLM can never silently drop heuristic data
- `detectEnrichmentProvider` auto mode: Ollama first (works for both adapters), then OpenClaw native
