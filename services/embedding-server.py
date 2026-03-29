"""
GPU Embedding Server — BGE-large-en-v1.5 on CUDA (RTX 5090)

Local Intelligence Amplifier Phase 1: Sub-millisecond embeddings for all Claudex operations.
Replaces CPU-bound Ollama nomic-embed-text with GPU-accelerated 1024-dim embeddings.

Usage: python services/embedding-server.py
Endpoint: POST http://127.0.0.1:7441/embed  { "texts": ["..."], "prefix": "search_query: " }
Health:   GET  http://127.0.0.1:7441/health
"""

import logging
import time
from contextlib import asynccontextmanager

import torch
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MODEL_NAME = "BAAI/bge-large-en-v1.5"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
HOST = "127.0.0.1"
PORT = 7441
MAX_BATCH = 64
EMBED_DIM = 1024

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

model = None
tokenizer = None


def load_model():
    global model, tokenizer
    from transformers import AutoModel, AutoTokenizer

    log.info(f"Loading {MODEL_NAME} on {DEVICE}")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModel.from_pretrained(MODEL_NAME).to(DEVICE)
    model.eval()
    log.info(f"Model loaded. Device: {DEVICE}")


# ---------------------------------------------------------------------------
# Embedding logic
# ---------------------------------------------------------------------------

@torch.no_grad()
def embed_texts(texts: list[str], prefix: str = "") -> list[list[float]]:
    """Embed a batch of texts using BGE-large. Returns normalized 1024-dim vectors."""
    if not texts:
        return []

    # BGE models use instruction prefixes for asymmetric retrieval
    prefixed = [prefix + t for t in texts]

    encoded = tokenizer(
        prefixed,
        padding=True,
        truncation=True,
        max_length=512,
        return_tensors="pt",
    ).to(DEVICE)

    outputs = model(**encoded)

    # Use [CLS] token embedding (BGE convention)
    embeddings = outputs.last_hidden_state[:, 0]

    # L2 normalize
    embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)

    return embeddings.cpu().tolist()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

class EmbedRequest(BaseModel):
    texts: list[str]
    prefix: str = ""


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dim: int
    count: int
    latency_ms: float


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        "gpu": torch.cuda.is_available(),
        "dim": EMBED_DIM,
    }


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    start = time.perf_counter()

    # Batch limit
    texts = req.texts[:MAX_BATCH]
    vectors = embed_texts(texts, req.prefix)

    latency = (time.perf_counter() - start) * 1000

    return EmbedResponse(
        embeddings=vectors,
        dim=EMBED_DIM,
        count=len(vectors),
        latency_ms=round(latency, 2),
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
