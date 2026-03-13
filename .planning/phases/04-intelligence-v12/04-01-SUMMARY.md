# 04-01 Summary: Embedding Foundation

**Status:** Complete
**Duration:** ~3min
**Tasks:** 2 (cosine + provider, templates + classification)
**Files created:** 6

## What was built

1. **src/embeddings/cosine.ts** — Pure cosine similarity: `dot(a,b) / (|a| * |b|)`. Returns 0 for zero vectors, mismatched lengths. Non-throwing.

2. **src/embeddings/embedding-provider.ts** — `EmbeddingProvider` class wrapping Ollama nomic-embed-text API:
   - `isAvailable()`: health check against `/api/tags` with 3s timeout, cached result
   - `embed(text)`: returns `number[] | null` via `/api/embed` with 5s timeout
   - `resetAvailability()`: clears cache for re-check
   - Lazy availability: first `embed()` call triggers `isAvailable()` if not yet checked

3. **src/embeddings/templates.ts** — Decision template embeddings:
   - `initTemplates(provider)`: precomputes 5 positive + 4 negative template embeddings from Architecture 6.1
   - `classifyDecision(candidateEmb, templates)`: returns `maxPositive - maxNegative` confidence
   - Returns null if provider unavailable or any template embed fails

## Tests

- `cosine.test.ts`: 8 tests (identical, orthogonal, opposite, similar, zero, mismatch, empty, non-throwing)
- `embedding-provider.test.ts`: 12 tests (availability, embed, reset, edge cases)
- `templates.test.ts`: 10 tests (init, classify, integration)

All 30 tests pass.

## Key decisions

- EmbeddingProvider caches availability to avoid repeated health checks
- Model name matching allows prefix (e.g., `nomic-embed-text:latest` matches `nomic-embed-text`)
- Template init is all-or-nothing: if any single template embed fails, returns null
- classifyDecision handles empty maps by defaulting maxPositive/maxNegative to 0
