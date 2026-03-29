"""
Cross-encoder reranker microservice for Claudex.

Runs ms-marco-MiniLM-L-6-v2 (~22M params, ~85MB) on GPU via sentence-transformers.
Exposes a single /rerank endpoint that scores (query, document) pairs.

Usage:
    python services/reranker.py                    # port 7439
    python services/reranker.py --port 7440        # custom port
    python services/reranker.py --model cross-encoder/ms-marco-MiniLM-L-6-v2

The model downloads automatically on first run (~85MB).
"""

import argparse
import logging
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("reranker")

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

model: CrossEncoder | None = None
device: str = "cpu"

def load_model(model_name: str) -> CrossEncoder:
    global device
    if torch.cuda.is_available():
        device = "cuda"
    elif hasattr(torch, "hip") and torch.hip.is_available():
        device = "cuda"  # ROCm uses cuda device string
    log.info(f"Loading {model_name} on {device}")
    m = CrossEncoder(model_name, device=device, trust_remote_code=True)
    log.info(f"Model loaded. Device: {device}")
    return m

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

class RerankRequest(BaseModel):
    query: str
    documents: list[str]
    top_k: int | None = None

class RerankResult(BaseModel):
    scores: list[float]
    indices: list[int]  # sorted by score descending

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Model loaded in main()
    yield

app = FastAPI(title="Claudex Reranker", lifespan=lifespan)

@app.post("/rerank", response_model=RerankResult)
async def rerank(req: RerankRequest):
    if model is None:
        return RerankResult(scores=[], indices=[])

    pairs = [(req.query, doc) for doc in req.documents]
    scores = model.predict(pairs).tolist()

    # Sort by score descending
    indexed = list(enumerate(scores))
    indexed.sort(key=lambda x: x[1], reverse=True)

    top_k = req.top_k or len(scores)
    top_indices = [i for i, _ in indexed[:top_k]]
    top_scores = [s for _, s in indexed[:top_k]]

    return RerankResult(scores=top_scores, indices=top_indices)

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": model.model.name_or_path if model else None,
        "device": device,
        "gpu": torch.cuda.is_available(),
    }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global model

    parser = argparse.ArgumentParser(description="Claudex cross-encoder reranker")
    parser.add_argument("--port", type=int, default=7439)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="BAAI/bge-reranker-v2-m3")
    args = parser.parse_args()

    model = load_model(args.model)

    import uvicorn
    log.info(f"Starting reranker on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
