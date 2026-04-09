# Claudex Benchmark Results

> Reproducible benchmark claims for Claudex v3. Methodology, honest caveats, and result artifacts.
>
> **Honesty policy:** every claim in this document matches a committed result file. No headline number can appear here that isn't backed by a reproducible committed artifact. If you find a number in the README or CLAUDE.md that doesn't match a committed file, it's a bug — please file an issue.

## Current Claims

| Benchmark | Score | Date | Git SHA | Config | Committed |
|---|---|---|---|---|---|
| LongMemEval Oracle | **90.6%** (426/470) | 2026-03-28 | — | deepseek-coder-v2:16b, snowflake-arctic-embed2, top-k 10 | [`results/longmemeval_oracle_2026-03-28.jsonl`](results/longmemeval_oracle_2026-03-28.jsonl) |
| LoCoMo (full) | **55.5%** (855/1540) | 2026-03-29 | 893270d | claude-sonnet-4-6 answer+judge, snowflake-arctic-embed2, top-k 10 | [`results/locomo_2026-03-29_893270d.jsonl`](results/locomo_2026-03-29_893270d.jsonl) |

Full per-question results are in the repo root as `LONGMEMEVAL_ORACLE_RESULTS.json` and `LOCOMO_RESULTS.json`. The files in `results/` are summary JSONL records for easy scanning and diffing.

## Published Comparisons

| System | LongMemEval | LoCoMo | Answer model |
|---|---|---|---|
| **Claudex (this repo)** | **90.6%** (oracle) | **55.5%** (full) | deepseek-coder-v2:16b / claude-sonnet-4-6 |
| Hindsight | 89.0% / 91.4% | 89.6% | OSS-120B / Gemini-3 Pro |
| MemMachine | 84.9% | — | — |
| Memori | 82.0% | — | — |
| Zep | 71.2% / 75.1% | 75.1% | — |
| Mem0 | — | 67.1% | — |
| OpenAI Memory | 52.9% | — | — |

**The comparison is not apples-to-apples.** Most published systems use GPT-4o or Gemini as their answer model. Claudex's LongMemEval run uses `deepseek-coder-v2:16b` locally. On LongMemEval that gap still puts Claudex competitive. On LoCoMo the comparison is honest but Claudex is currently below published competitors — see the LoCoMo section below.

## LongMemEval — Methodology

### Mode: Oracle

The 90.6% score is in **oracle mode**: each question is answered using only the 1–3 evidence sessions that LongMemEval's dataset identifies as containing the answer, not the full 500-session haystack. This is the standard published-baseline mode used by Hindsight and other comparable systems — it tests *reading comprehension and answer quality* with retrieval guaranteed.

**Full-haystack mode has not yet been run at scale.** Running the full 500-session haystack against our retrieval pipeline would additionally stress the retrieval pipeline itself (can we find the right 1–3 sessions in a pile of 500?). This is on the roadmap.

### Scoring

LLM-as-judge: the answer model (`deepseek-coder-v2:16b`) answers the question from its context; a judge model (also `deepseek-coder-v2:16b` — same model, different prompt) scores the answer against the reference. Semantic equivalence is accepted as correct.

**Caveat:** same-model self-judging has known bias — models tend to judge their own answers as correct. The standard mitigation is to use a different model as judge. We haven't applied that mitigation. Published competitors typically use GPT-4 as judge regardless of answer model; switching to a neutral judge is on the roadmap.

### Per-category breakdown

| Category | Claudex | Questions |
|---|---|---|
| Single-session (preference) | 100.0% | 30/30 |
| Single-session (user) | 98.4% | 63/64 |
| Single-session (assistant) | 98.2% | 55/56 |
| Multi-session | 87.6% | 106/121 |
| Knowledge-update | 87.5% | 63/72 |
| Temporal-reasoning | 85.8% | 109/127 |
| **Overall (answerable)** | **90.6%** | **426/470** |

### Abstention

LongMemEval includes 30 unanswerable questions where the correct response is to refuse. Claudex scores **6.7% (2/30)** on these — a known weak point. Abstention is scored separately and is **not folded into the overall 90.6% figure**. This is consistent with how published baselines report their numbers.

Known causes: Claudex's retrieval pipeline is tuned to always return *something*, and the answer model rarely refuses in its reasoning. Improving abstention accuracy would require either (a) explicit confidence thresholding that filters low-score retrievals, or (b) answer-model prompting changes to encourage refusal.

---

## LoCoMo — Methodology

### Status: known work-in-progress

The current honest LoCoMo score is **55.5%**. An earlier LoCoMo harness at commit `0ea8c75 feat: LoCoMo benchmark harness + results — 90.8% (1399/1540)` reported 90.8%. Commit `893270d feat: benchmark analysis tooling + first honest LoCoMo results` explicitly documented the 90.8% as inflated relative to the real Claudex hybrid-retrieval pipeline, and recorded the honest 55.5% score after switching to `hybridSearchAsync`.

**The README and repo documentation should not cite the 90.8% number.** It is superseded. The honest score (55.5%) is what this document — and any published claim — must match.

### Dataset

LoCoMo v1.0, 10 conversations, 1540 scoreable QA pairs across four categories. Adversarial questions (category 5) excluded per standard practice.

Dataset download: https://huggingface.co/datasets/snap-research/locomo (not committed — ~150MB).

### Retrieval

The current harness calls `hybridSearchAsync` from `src/core/hybrid-retrieval.ts` — the full 5-channel RRF pipeline with BGE cross-encoder reranking. This is the same retrieval pipeline Claudex uses in production.

### Scoring

LLM-as-judge with `claude-sonnet-4-6` as both answer and judge. Same-model self-judging caveat applies (see LongMemEval section).

### Per-category breakdown

| Category | Claudex | Questions |
|---|---|---|
| Single-hop | 41.1% | 116/282 |
| Multi-hop | 44.5% | 143/321 |
| Temporal | 36.5% | 35/96 |
| Open-domain | 66.7% | 561/841 |
| **Overall** | **55.5%** | **855/1540** |

### Why so low vs. competitors?

This is an open investigation. Hypotheses:

1. **Retrieval pipeline mismatch.** Our hybrid-retrieval is tuned for Claude Code session context (code + observations + decisions), not for open-domain conversational memory. LoCoMo conversations are everyday chat about life events, not technical work.
2. **Chunking / ingestion.** LoCoMo's multi-session structure may not map cleanly to Claudex's artifact model. Observations extracted from a chat transcript are different from observations extracted from tool calls.
3. **Answer model.** `claude-sonnet-4-6` should be capable here; self-judge might be penalizing correct-but-different-phrasing answers.
4. **Judge strictness.** LLM judges can be inconsistent. A separate run with a different judge could move the number.

Failure-mode analysis is in `LOCOMO_FAILURES.json` (committed), categorized by `src/benchmark/analyze-results.ts`. Failure patterns include: no_answer, wrong_entity, missing_date, hallucination, partial. Retrieval gap analysis is included.

This score is not being hidden. It is being reported accurately so improvements can be measured.

---

## How to Reproduce

### Prerequisites

- Bun ≥ 1.3
- Ollama running with `snowflake-arctic-embed2` pulled (`ollama pull snowflake-arctic-embed2`)
- Qdrant running on port 6333 (or bundled — auto-starts from Claudex)
- Python reranker running on port 7439 (auto-started by Angel)
- For LongMemEval: `deepseek-coder-v2:16b` pulled (`ollama pull deepseek-coder-v2:16b`) OR CliProxy on 8317 for Sonnet
- For LoCoMo: CliProxy on 8317 for Sonnet answer+judge

### Build

```bash
bun run build
```

### LoCoMo

```bash
# Download locomo10.json from https://huggingface.co/datasets/snap-research/locomo
# Then run:
node dist/benchmark/locomo-harness.cjs /path/to/locomo10.json
```

Output: `LOCOMO_RESULTS.json` in cwd with full per-question details.

### LongMemEval Oracle

```bash
# Download longmemeval_oracle.json from https://huggingface.co/datasets/xiaowu0162/longmemeval
# Then run:
node dist/benchmark/longmemeval-harness.cjs oracle /path/to/longmemeval_oracle.json
```

Output: `LONGMEMEVAL_ORACLE_RESULTS.json` in cwd with full per-question details.

### Analysis

```bash
# After a LoCoMo run, analyze failures:
node dist/benchmark/analyze-results.cjs LOCOMO_RESULTS.json
```

Output: `LOCOMO_FAILURES.json` with per-category breakdown, failure pattern classification, and retrieval gap analysis.

## Result File Format

Each summary file in `results/` is a single-line JSON record (one file per run) with this structure:

```json
{
  "run_id": "longmemeval_oracle_2026-03-28",
  "benchmark": "longmemeval",
  "mode": "oracle",
  "timestamp": "2026-03-28T18:23:12.522Z",
  "git_sha": null,
  "config": {
    "answer_model": "deepseek-coder-v2:16b",
    "judge_model": "deepseek-coder-v2:16b",
    "embed_model": "snowflake-arctic-embed2",
    "embed_dim": 1024,
    "top_k": 10
  },
  "score": { "overall": 90.6, "correct": 426, "total": 470 },
  "per_category": { "..." },
  "abstention": { "correct": 2, "total": 30, "accuracy": 6.7 },
  "full_results_path": "../LONGMEMEVAL_ORACLE_RESULTS.json",
  "notes": "oracle mode — evidence sessions only"
}
```

The full per-question arrays live in the root-level JSON files, not in the JSONL summaries, to keep diffs readable.

## Open Work

- [ ] Run full-haystack LongMemEval mode (not just oracle)
- [ ] Use a neutral judge model for both benchmarks (not same as answer model)
- [ ] Investigate LoCoMo single-hop / temporal category underperformance
- [ ] Add fixture-based CI smoke test for both harnesses
- [ ] Add `bench:locomo` / `bench:longmemeval` npm scripts
- [ ] Channel attribution per query (which channel contributed most — FTS5, vector, rerank)
- [ ] Runtime profiling (per-question latency breakdown)
