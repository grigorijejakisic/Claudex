# Phase 14: Negative Retrieval Learning — Context

**Spec:** context/specs/PROACTIVE_MEMORY.md Part 4

## Problem
When artifacts are surfaced in assembly but never referenced by the LLM, that's a negative signal we're not using. Currently ~96% of surfaced artifacts go unreferenced. We track `retrieval_events` but don't feed negative signals back into scoring.

## Solution
Enhance the retrieval feedback system. Track was_referenced at session end. After 3+ unreferenced retrievals, apply suppression to retrieval_score. Implement retrieval-induced suppression (RIF) for non-selected candidates.

## Key Research
- Virtually nobody in the field does systematic negative retrieval learning (our most original feature)
- Ori-Mnemos uses Q-value penalties: "Dead end = -0.15"
- Psychology's retrieval-induced forgetting: non-selected candidates actively suppressed

## Key Files
- `src/intelligence/retrieval-feedback.ts` (303 lines) — enhance scoring model
- `src/adapters/cc-hooks/stop.ts` (406 lines) — record reference signals
- `src/core/hybrid-retrieval.ts` (750 lines) — apply weights via `getRetrievalScoreMultiplier()`
