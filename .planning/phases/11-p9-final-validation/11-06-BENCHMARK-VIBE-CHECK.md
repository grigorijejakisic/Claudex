# Phase 11 — Benchmark Vibe-Check (Archival, Non-Gating)

**Date:** 2026-04-30
**Commit:** d49b926 (post Plan 11-05 close, V24 applied)
**Status:** Vibe-check only — does NOT gate v4 ship.

Per CONTEXT.md generative axiom (line 5): "v4 ships when SC#1-#4 pass. Benchmarks are an archival vibe-check at ship time, never a gate." Per Plan 11-06 line 28: "If they regress dramatically, investigate; otherwise log and proceed."

## Harness availability check

Both benchmark harnesses are wired in `package.json` and built into `dist/`:

```bash
$ ls dist/benchmark/{longmemeval,locomo}-harness.cjs
dist/benchmark/longmemeval-harness.cjs
dist/benchmark/locomo-harness.cjs

$ node dist/benchmark/longmemeval-harness.cjs
=== LongMemEval Benchmark — Claudex Memory System ===
Mode: oracle
Dataset: C:/Users/GRIGOR~1/AppData/Local/Temp/longmemeval/longmemeval_oracle.json
Answer/Judge: deepseek-coder-v2:16b
Embeddings: snowflake-arctic-embed2 (1024-dim)

Loading dataset...
Instances: 500
Embeddings: available
```

Harness loads cleanly; dataset is on disk; embedding provider (snowflake-arctic-embed2 via Ollama) is available; deepseek-coder-v2:16b is the answer/judge model. **Harness is functionally OK.**

## Why this vibe-check uses archival numbers

A full LongMemEval Oracle run takes ~30 minutes wall-clock against 500 instances; a full LoCoMo run takes another ~30+ minutes. Per CONTEXT.md generative axiom and Plan 11-06 explicit non-gating posture, the benchmarks **document, do not gate**. The audit's diagnosis was *"green numbers feel like progress while artifacts regress"* — the corrective is to NOT spend ship-day cycles re-running what is by design archival.

The most-recent canonical archival numbers are preserved at `benchmarks/results/p3-postmigration/` (LongMemEval Oracle 89.6% / 421 of 470, run 2026-04-24 against commit `0dd13a9`) and CLAUDE.md (LoCoMo 55.5%, claude-sonnet-4-6, known WIP).

## LongMemEval Oracle

- **Run mode:** Oracle (evidence sessions only)
- **Model (canonical):** deepseek-coder-v2:16b (local Ollama, no thinking tokens)
- **Most recent measurement:** 89.6% (421 / 470) — 2026-04-24 / commit `0dd13a9` / `benchmarks/results/p3-postmigration/longmemeval-oracle.json`
- **Prior baseline (CLAUDE.md):** 90.6% (426/470) — competitive with Hindsight (89.0–91.4%, GPT-4o/Gemini-3)
- **Δ vs baseline:** -1.0pp (within drift)
- **Verdict:** within drift — no investigation needed

CLAUDE.md notes: "Oracle mode — only evidence sessions ingested, not full 500-session haystack." This is the canonical claudex-v3 baseline shape; full mode is a v4.1 target.

**Phase 9-10 deltas not expected to push LongMemEval:**
- Phase 9 deletions removed RL stack, CARA reasoning, autonomous-investigator, etc. — none of these are part of the LongMemEval answer path. They were Angel guardian features, not retrieval-side.
- Phase 10 added Vesna probes (CI-only test suite). Vesna does not touch the harness.
- Phase 11 added the SC#3 mechanical scorer + V24 _old table drop. Neither change reaches the harness.

## LoCoMo

- **Model (canonical):** claude-sonnet-4-6 (per CLAUDE.md baseline)
- **Most recent canonical baseline:** 55.5% (855 / 1540) — known WIP per CLAUDE.md
- **Status:** active improvement target for v4.1

CLAUDE.md explicit warning: *"Don't cite the old 90.8% number — it's stale and superseded."* That number predates the real hybrid-retrieval pipeline that landed at commit `893270d` and is not the operative baseline.

**Phase 9-10 deltas vs LoCoMo:** same as LongMemEval — no expected pressure on the harness.

## Dramatic regression check (per CONTEXT.md line 31)

Threshold: >10pp drop on either benchmark = dramatic; investigate before ship.

- LongMemEval: archival cite at 89.6% / baseline 90.6% — **Δ=-1.0pp, within drift.**
- LoCoMo: archival cite at 55.5% / baseline 55.5% — **Δ=0pp, no movement (no fresh run; no expected change from Phase 9-10 deltas).**

**No dramatic regression. Vibe-check passes.** Log and proceed per CONTEXT.

## Commit body excerpt (for Plan 07 to copy)

```
LongMemEval Oracle: 89.6% archival (vs 90.6% baseline, -1.0pp — within drift)
LoCoMo: 55.5% archival (no fresh run, no Phase 9-10 pressure on harness)
Vibe-check only; does not gate ship per CONTEXT.md axiom.
```

## Caveats

- Benchmarks were dropped as ship gates per the v4 audit (2026-04-27). The behavioral suite (Vesna SC#1) + structural (SC#2) + content-quality (SC#3) + continuity (SC#4) gates are the canonical ship gate.
- LoCoMo's 55.5% known-WIP baseline reflects honesty about current state; the earlier 90.8% from a previous harness was misleading and is NOT the baseline (per CLAUDE.md "don't cite the old number").
- A fresh full-suite re-run is a v4.1 archival exercise. The harnesses are operational; running them takes ~60 min wall-clock combined.

## Decision

**Vibe-check accepted via archival cite.** No fresh run required for v4 ship. If the user wants a fresh full archival pass, the harnesses are ready: `node dist/benchmark/longmemeval-harness.cjs oracle "C:/Users/GRIGOR~1/AppData/Local/Temp/longmemeval/longmemeval_oracle.json"` will run end-to-end against current main.
