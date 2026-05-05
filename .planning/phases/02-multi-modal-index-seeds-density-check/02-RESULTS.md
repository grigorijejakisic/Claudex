# Phase 2 Results: Multi-modal index seeds + density-at-scale check

**Generated:** 2026-05-05T00:13:22.000Z
**Harness seed:** 42
**Verdict:** **KILL** — see reasoning below

---

## Decision rule (CONTEXT.md item 5, locked BEFORE measurement)

> ## 5. Decision rule — locked BEFORE measurement runs
> 
> Empirical-phase discipline: this rule is committed to CONTEXT.md and PLAN.md before the harness is built. **No moving goalposts after we see results.**
> 
> **GREEN-LIGHT Phase 3 — proceed with full multi-handle retrieval cutover:**
> 
> ALL three must hold on the **held-out test set**:
> 1. RRF-fusion has measurable improvement over semantic-only — minimum **+5pp on either precision@5 OR recall@10**, AND the **Wilson 95% CI lower bound on the delta is ≥ 0** (i.e., the improvement is not statistically indistinguishable from zero at our sample size). The AND-CI-bound is the discipline that prevents green-lighting on noise — at n≈40-60 pairs, raw point-deltas of +5pp can be inside the CI of zero.
> 2. Density at scale produces signal — ≥30% of high-similarity pairs (per #4) are intra-project recurrent.
> 3. Latency p99 of fused retrieval < 2× semantic-only baseline. Cost discipline: a marginally-better signal that doubles tail latency is not worth shipping.
> 
> **SCOPE-DOWN to advisory — Phase 3 ships, but lighter than originally planned:**
> Improvement exists on specific subsets (e.g. only Python stack traces, only one project) but not broadly. Phase 3 ships an **advisory-only surface** ("you've hit a similar error before, see episode X") without aggressive RRF fusion in the production retrieval path. Phase 5 density abstraction is de-scoped accordingly (advisory, not abstraction).
> 
> **KILL — pivot or stop:**
> No measurable improvement (criteria 1 fails on held-out CI bound) OR density is pure noise (criteria 2 fails). Phase 3 plan is rewritten or the multi-handle thesis is reconsidered at the milestone level.

---

## Criterion checks (held-out test set)

| # | Criterion | Threshold | Observed | Passed | Evidence |
|---|-----------|-----------|----------|--------|----------|
| 1 | Fusion improvement (max(Δp@5,Δr@10) ≥ +5pp AND CI lower ≥ 0 on the same metric) | 0.05 / CI≥0 | 0.1000 | NO | delta_p5=0.1000 (CI lower -0.1574); delta_r10=-0.0500 (CI lower -0.2735); n=20; CI-binding failed both metrics |
| 2 | Density signal (intra-project share of high-similarity pairs ≥ 30%) | 0.3 | 0.2343 | NO | intra_project_share=0.2343 (threshold 0.30) |
| 3 | Latency budget (p99 fused / p99 semantic < 2.0) | 2 | 0.8928 | YES | p99(C) / p99(A) = 0.8928 (threshold 2.0) |

---

## Quality metrics — held-out test set

### Pooled
| Variant | precision@5 (Wilson 95% CI) | recall@10 (Wilson 95% CI) | MRR (mean ± bootstrap CI) | n |
|---------|------------------------------|----------------------------|----------------------------|---|
| A semantic-only | 0.6500 [0.4329, 0.8188] | 0.9000 [0.6990, 0.9721] | 0.4335 [0.2753, 0.6101] | 20 |
| B fingerprint-only | 0.7500 [0.5313, 0.8881] | 0.9500 [0.7639, 0.9911] | 0.4935 [0.3354, 0.6406] | 20 |
| C RRF-fused (k=60) | 0.7500 [0.5313, 0.8881] | 0.8500 [0.6396, 0.9476] | 0.4269 [0.2669, 0.6136] | 20 |

### phase1_organic only
| Variant | precision@5 (Wilson 95% CI) | recall@10 (Wilson 95% CI) | MRR (mean ± bootstrap CI) | n |
|---------|------------------------------|----------------------------|----------------------------|---|
| A semantic-only | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0 |
| B fingerprint-only | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0 |
| C RRF-fused (k=60) | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0 |

### v4_backfill only
| Variant | precision@5 (Wilson 95% CI) | recall@10 (Wilson 95% CI) | MRR (mean ± bootstrap CI) | n |
|---------|------------------------------|----------------------------|----------------------------|---|
| A semantic-only | 0.6500 [0.4329, 0.8188] | 0.9000 [0.6990, 0.9721] | 0.4335 [0.2753, 0.6101] | 20 |
| B fingerprint-only | 0.7500 [0.5313, 0.8881] | 0.9500 [0.7639, 0.9911] | 0.4935 [0.3354, 0.6406] | 20 |
| C RRF-fused (k=60) | 0.7500 [0.5313, 0.8881] | 0.8500 [0.6396, 0.9476] | 0.4269 [0.2669, 0.6136] | 20 |

### Deltas vs A (Newcombe 95% CI)
| Comparison | Δ precision@5 (CI) | Δ recall@10 (CI) | Origin split |
|------------|--------------------|------------------|--------------|
| C - A | 0.1000 [-0.1574, 0.3763] | -0.0500 [-0.2735, 0.1724] | pooled |
| C - A | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | phase1_organic |
| C - A | 0.1000 [-0.1574, 0.3763] | -0.0500 [-0.2735, 0.1724] | v4_backfill |
| B - A | 0.1000 [-0.1574, 0.3763] | 0.0500 [-0.1552, 0.2496] | pooled |

---

## Latency

| Variant | p50 (ms) | p95 (ms) | p99 (ms) |
|---------|----------|----------|----------|
| A | 1.395 | 1.976 | 2.880 |
| B | 0.215 | 0.509 | 0.546 |
| C | 1.617 | 2.165 | 2.571 |

p99(C) / p99(A) = 0.8928 (criterion 3 threshold = 2.0)

---

## Density signal (CONTEXT item 4)

- Random-pair sample size: 1000
- Noise floor (95th percentile of random pair Jaccard): 0.0000
- Sample stddev (σ): 0.1099
- Cluster threshold (noise floor + 2σ): 0.2198
- Weak clusters (K=2..4): 9
- Strong clusters (K≥5): 2
- Intra-project share of high-similarity pairs: 0.2343 (CONTEXT item 4 threshold = 0.30)
- Density meaningful: NO

---

## Corpus

- Total fingerprinted episodes: 136
- phase1_organic: 7
- v4_backfill: 129
- Projects covered: big-balkan, big-mozzart-clean, big-mozzy-v2, claude-code-buildable-6deec3e5, claudex, claudex-v2, claudex-v3, daemon-9f9827ee, desktop-01dcc792, kompas-98604047, lacuna-betting-9f1d552c, nexus-app-56a23c73, nexus-app-f0158b12, nexus-e53c6c93, nexus-v2-7e3c3a02, openclaw-main, oracle-3951898e, projects-3892a6d8, vesna-6abb357b
- Test set size: 39 pairs

See: 02-03-corpus-audit.md for source breakdown and 20-pair spot-check.

---

## Verdict reasoning

Criterion 1 FAILED (delta_p5=0.1000 (CI lower -0.1574); delta_r10=-0.0500 (CI lower -0.2735); n=20; CI-binding failed both metrics). Criterion 2 FAILED (intra_project_share=0.2343 (threshold 0.30)). Criterion 3 PASSED (p99(C) / p99(A) = 0.8928 (threshold 2.0)). Verdict: KILL — no measurable signal or density is noise; Phase 3 plan rewritten at user-approval gate.

---

## Next steps

- **KILL**: Phase 3 plan rewritten; multi-handle thesis reconsidered at user-approval gate; flag default flipped to false; backfilled rows and harness retained per CONTEXT item 7.

Code retained at flag for future reference. Phase 5 (the second empirical phase) reuses this harness shape.
