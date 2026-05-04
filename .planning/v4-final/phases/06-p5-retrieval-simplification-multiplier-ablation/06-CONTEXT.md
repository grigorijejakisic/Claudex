# Phase 6: P5 — Retrieval Simplification + Per-Multiplier Ablation — Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Generative axiom:** Cut what isn't load-bearing; keep what is. Per-multiplier ablation is the evidence; bulk delete without it is the failure mode the audit caught.

---

<domain>
## Phase Boundary

This phase delivers three things and only these three things:

1. **Per-multiplier A/B ablation** before any deletion — one A/B per scoring multiplier (`novelty`, `activation`, `q_value`, `recency`, etc.) measured against a Vesna probe subset. Results committed to `.planning/phases/06/06-MULTIPLIER-ABLATION.md`. Drop multipliers with ≤1pp Vesna delta; keep load-bearing ones.
2. **Simplified `hybrid-retrieval.ts`**: minimum RRF(FTS5 + vec0 + recency) → cross-encoder rerank → budget-gated top-k. Multipliers retained based on ablation evidence only.
3. **Cross-encoder reranker hard-required**: BGE-v2-m3 must be alive for production retrieval; bi-encoder fallback explicitly degraded-mode (telemetry counter `reranker_fallback_fired` increments visibly).

**Out of scope:**
- New retrieval signals (Phase 6.5 ships task-pattern fingerprint extension)
- Reranker model swap or training (sticks with BGE-v2-m3)
- MCP surface changes (`claudex_search`, `claudex_recall`, etc. interfaces unchanged)

**Hard gates:**
- DB backup at `~/.claudex/backups/pre-v4-P5-{ts}.db` BEFORE any schema drop
- RIF suppression and spread activation retained (light + measurably useful for dedup)
- Vesna pass rate maintained (SC#1 ≥80%) — if drops below, multiplier deletion was too aggressive
- No benchmarks (LongMemEval/LoCoMo) used as gate per v4 rebind

</domain>

<decisions>
## Implementation Decisions

### Per-multiplier ablation methodology

- Identify all multipliers currently composing `hybrid-retrieval.ts` final score (planner enumerates; expected: novelty, activation, q_value, recency, RIF suppression, spread activation, plus any others)
- For each multiplier: A = full pipeline, B = pipeline with multiplier disabled (set to 1.0 or removed)
- Run Vesna probe subset (minimum 10 probes spanning entity recall, constraint recall, handoff pickup) under both conditions
- Measure Vesna pass rate delta (A vs B). Confidence interval reported per multiplier.
- Commit results to `.planning/phases/06/06-MULTIPLIER-ABLATION.md` as a structured table

### Drop criteria

- Vesna delta ≤1pp (and not statistically significant): multiplier is not load-bearing → drop
- Vesna delta >1pp OR statistically significant degradation: multiplier is load-bearing → keep
- Edge: multiplier improves one Vesna category but degrades another → keep with documented trade-off; planner notes for future review

### Reranker hard-required policy

- Production retrieval requires the BGE-v2-m3 cross-encoder service alive on port 7439
- If service is down: bi-encoder fallback runs (existing path) but logs a counter `reranker_fallback_fired` and emits a visible telemetry warning at next /endsession
- Health check: Angel supervises the reranker via existing `RerankerSupervisor`; production gates require ≥99% uptime over rolling 24h before next release
- Documentation update: README + CLAUDE.md note reranker as load-bearing infrastructure

### Schema and RRF changes

- Simplified pipeline: `RRF(FTS5_results, vec0_results, recency_results)` → cross-encoder rerank → budget-gated top-k
- Multipliers that survive ablation are applied within RRF or as post-rerank weights (planner picks based on ablation findings)
- DB backup gate (STOR-08) before any schema drop

### Vesna pass rate maintenance

- Target: SC#1 ≥80% Vesna pass rate maintained throughout the deletion sequence
- Measurement: Vesna probe suite runs after each multiplier removal commit
- Tripwire: any commit dropping Vesna pass rate >2pp triggers immediate revert + investigation

### Claude's Discretion (planner free to decide)

- Exact Vesna probe subset for ablation (planner picks 10+ probes representative of categories)
- Statistical significance threshold (recommendation: simple delta + sample size; full hypothesis testing not required at 10-probe scale)
- Order of multiplier ablation (recommendation: lowest-suspected-impact first to build confidence; planner can sequence based on multiplier interdependence)
- Whether to also ablate RIF suppression and spread activation (recommendation: keep — ROADMAP says retained; ablate only if planner finds reason)

</decisions>

<specifics>
## Specific Ideas

- **Evidence-before-deletion**: the audit caught Phase 5 about to bulk-delete against gates that don't measure deletion. Phase 6 corrects this pattern at the multiplier level — measure first, delete second.
- **Reranker as load-bearing infra**: BGE-v2-m3 isn't an enhancement, it's the precision layer. Phase 6 codifies this; degraded-mode telemetry makes failures visible instead of silent.
- **Cache the embeddings, not the rerank scores**: rerank is fast (~50ms for top-50), embeddings are slow. Reuse the existing embedding cache; don't add a rerank cache.

</specifics>

<deferred>
## Deferred Ideas

- **Cross-project task-pattern multiplier** — Phase 6.5 ships fingerprint matching as a new retrieval signal; not part of 6's simplification.
- **Reranker model swap** (e.g., to a smaller faster model) — Phase 6 sticks with BGE-v2-m3; revisit if latency becomes an issue.
- **Adaptive top-k** — currently fixed; dynamic based on score distribution is a future refinement, not 6.

</deferred>

<artifacts>
## Reference Artifacts

- `src/intelligence/hybrid-retrieval.ts` — primary deliverable
- `services/reranker.py` — BGE-v2-m3 cross-encoder service
- `src/angel/reranker-supervisor.ts` — supervises reranker lifecycle
- `src/benchmark/vesna/` — probe suite for ablation measurement
- `.planning/audits/2026-04-27-v4-trajectory-audit.md` — audit findings T6 (consumer surface analysis)

</artifacts>

---

*Phase: 06-p5-retrieval-simplification-multiplier-ablation*
*Context gathered: 2026-04-29*
