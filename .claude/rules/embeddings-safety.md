---
paths:
  - "src/embeddings/**"
---

# Embeddings Safety Rules

## Cross-Encoder is Actually Bi-Encoder
The "cross-encoder" reranking uses **snowflake-arctic-embed2** via Ollama's `/api/embed` endpoint. This is a bi-encoder producing cosine similarity scores, NOT a true neural cross-encoder. Do not claim otherwise in code comments or documentation.

## Model Dimensions
- **nomic-embed-text**: 768d native, truncated to 384d via Matryoshka for storage (Qdrant collections use 384d)
- **snowflake-arctic-embed2**: 1024d, used for reranking (higher fidelity similarity)

## Ollama Endpoint
- Localhost only, non-throwing by design
- Graceful degradation to FTS5-only search when Ollama is unavailable
- Never block assembly or hook execution on embedding availability
