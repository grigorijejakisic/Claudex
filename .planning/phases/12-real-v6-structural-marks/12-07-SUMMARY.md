---
plan: 12-07
phase: 12-real-v6-structural-marks
wave: 3
status: complete
requires: []
provides:
  - Topical-distance importance cap in computeArtifactScore
  - ArtifactScoringContext.topicalRelevance field
  - importance_topical_threshold and importance_falloff config defaults
  - Phase 12 retrieval ranking rebalance regression harness (4 tests)
affects:
  - claudex_search ranking behavior (importance score no longer dominates domain-unrelated queries)
  - retrieved_but_unapplied telemetry signal volume post-push
key_files:
  - src/core/hybrid-retrieval.ts
  - src/tests/integration/phase-12-retrieval-ranking-rebalance.test.ts
---

# 12-07 Summary — Retrieval Ranking Rebalance

## What Was Built

A post-rerank topical-distance importance cap in `computeArtifactScore` (`src/core/hybrid-retrieval.ts`):

```
importanceMult = max(0, 1 - (topicalDistance - threshold) / falloff)
```

Where `topicalDistance = 1 - topicalRelevance`. Applied via the new `ArtifactScoringContext.topicalRelevance` optional field — when provided, the importance term is multiplied by `importanceMult` instead of contributing at full weight.

**Config defaults:** `v6.routing.importance_topical_threshold = 0.4`, `v6.routing.importance_falloff = 0.3`.

## Regression Harness

4 tests in `phase-12-retrieval-ranking-rebalance.test.ts`:
- 2 domain-unrelated queries: big-balkan pattern must NOT appear at position 0 for TT-cycle and polymorphic-Account queries
- 2 topically-related queries: big-balkan pattern must appear in top-5 for "big-balkan betting limitations"; TT-cycle artifact must surface for "TT cycle detection" query

All 4 tests pass post-fix.

## Decision Notes

1. **Pre-fix**: big-balkan `importance_score=0.95` allowed it to dominate across topically-unrelated queries via the β·importance term in the three-factor score.

2. **Threshold=0.4, falloff=0.3** — at `topicalRelevance=0.6` (topicalDistance=0.4), multiplier = 1.0 (no cap). At `topicalRelevance=0.3` (topicalDistance=0.7), multiplier = max(0, 1 - (0.7-0.4)/0.3) = 0. This zeros importance for clearly domain-unrelated queries.

3. **Topical-distance proxy** — implemented via `ArtifactScoringContext.topicalRelevance`: callers pass the cosine similarity from the embedding channel. When not provided, the cap is not applied (backward-compatible).

4. **RRF, reranker, and bi-encoder are unchanged** — the fix is solely at the post-rerank rescoring step. Anti-scope preserved.

5. **Formula applies in both cross-encoder and bi-encoder paths** — the big-balkan fix is not gated on reranker availability.
