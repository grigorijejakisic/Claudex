---
paths:
  - "src/embeddings/**"
---

# Embeddings Safety Rules

## Reranker Architecture
**The primary reranker is a real cross-encoder. The bi-encoder is only the fallback.**

- **Primary (cross-encoder):** `BAAI/bge-reranker-v2-m3` (~568M params) via the Python service at `services/reranker.py` on port 7439. This is a true neural cross-encoder — it scores (query, document) pairs jointly rather than independently. Supervised by Angel's `RerankerSupervisor` (`src/angel/reranker-supervisor.ts`) with bounded restart and log capture to `context/logs/reranker.log`.
- **Fallback (bi-encoder):** `snowflake-arctic-embed2` via Ollama's `/api/embed` endpoint. Used only when the cross-encoder service is unavailable (3s timeout on the primary path). This is cosine similarity between independently-encoded query and document embeddings — measurably lower quality than the cross-encoder, but far better than no reranking.
- **Ultimate fallback:** RRF scores stand unchanged if both reranking paths fail.

## Model Dimensions
- **snowflake-arctic-embed2**: 1024d native, used as the **primary** embedding model for all vector storage (vec0 virtual tables and the legacy Qdrant collections both used 1024d cosine).
- **nomic-embed-text**: historically referenced in some stale code comments as the primary; this is **no longer accurate** — the code defaults to snowflake-arctic-embed2.
- **BAAI/bge-reranker-v2-m3**: 568M-parameter cross-encoder, runs on CUDA, scores (query, doc) pairs jointly.

## Vector Storage Backend
Claudex uses **sqlite-vec** (vec0 virtual tables) as the default vector store as of V15. The `CLAUDEX_VECTOR_BACKEND` env var is reserved for future alternative backends; at present only `sqlite-vec` is supported. Qdrant was removed in session 47 (see `context/specs/SQLITE_VEC_MIGRATION.md`).

## Ollama Endpoint
- Localhost only (11434), non-throwing by design
- Provides both embeddings (snowflake-arctic-embed2) and local LLM (deepseek-coder-v2:16b) for Angel's reflective passes
- Graceful degradation to FTS5-only search when Ollama is unavailable
- Never block assembly or hook execution on embedding availability
