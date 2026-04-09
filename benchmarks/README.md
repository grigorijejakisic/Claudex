# Claudex Benchmarks

Reproducible benchmark harness for Claudex v3. Current benchmarks: LongMemEval Oracle and LoCoMo.

**For claims, methodology, and honest caveats, read [`BENCHMARKS.md`](BENCHMARKS.md).**

## Quick Start

```bash
# 1. Build
bun run build

# 2. Start services (Claudex needs these)
ollama serve                    # embeddings + local LLM
# Qdrant and the Python reranker auto-start from Angel

# 3. Run a benchmark
node dist/benchmark/longmemeval-harness.cjs oracle /path/to/longmemeval_oracle.json
node dist/benchmark/locomo-harness.cjs /path/to/locomo10.json
```

## Datasets

Datasets are not committed to the repo (size + licensing).

- **LongMemEval** — https://huggingface.co/datasets/xiaowu0162/longmemeval
  - `longmemeval_oracle.json` (~10MB) for oracle mode
  - `longmemeval_m_cleaned.json` (~2GB) for full-haystack mode (not yet used)
- **LoCoMo** — https://huggingface.co/datasets/snap-research/locomo
  - `locomo10.json` (~150MB), 10 conversations, 1540 scoreable QA pairs

## Output

Each run writes two files:

1. **Full per-question results** in the repo root (e.g. `LONGMEMEVAL_ORACLE_RESULTS.json`, `LOCOMO_RESULTS.json`) — large, with complete details per question
2. **Summary JSONL** in `benchmarks/results/` — one line per run, committed to the repo for audit trail

## Committed Results

Current committed summaries:

- [`results/longmemeval_oracle_2026-03-28.jsonl`](results/longmemeval_oracle_2026-03-28.jsonl) — LongMemEval Oracle 90.6%
- [`results/locomo_2026-03-29_893270d.jsonl`](results/locomo_2026-03-29_893270d.jsonl) — LoCoMo 55.5% (honest harness)

## Prerequisites

- Bun ≥ 1.3
- Node.js ≥ 22
- Ollama with `snowflake-arctic-embed2` (embeddings), `deepseek-coder-v2:16b` (local LLM) or CliProxy for Sonnet
- Qdrant (bundled, auto-starts)
- Python 3.10+ with PyTorch CUDA for the BGE reranker (auto-started by Angel)

## Architecture

See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full Claudex retrieval pipeline. The benchmark harnesses exercise the real production pipeline — no mocks, no simplifications.
