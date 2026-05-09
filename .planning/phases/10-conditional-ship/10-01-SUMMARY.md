---
phase: 10-conditional-ship
plan: 01
subsystem: retrieval
tags: [v6, transcript-routing, reranker, bi-encoder, cross-encoder, telemetry]

requires: []
provides:
  - v6.routing config block with five locked first-principles defaults
  - routeFromArtifact (single artifact -> ranked transcript spans)
  - routeFromArtifacts (multi-artifact fan-out with max_k_per_query budget)
  - RoutingArtifact + RoutingSpan + RoutingResult + RoutingOptions types
  - Reranker fallback telemetry integration matching hybrid-retrieval RETR-08
affects: [10-02, 10-03, 10-04]

tech-stack:
  added: []
  patterns:
    - "Defensive non-throwing routing with degraded-mode telemetry"
    - "Bi-encoder primary on the v6 transcript surface; cross-encoder behind config flag"

key-files:
  created:
    - src/retrieval/transcript-routing.ts
    - src/tests/retrieval/transcript-routing.test.ts
  modified:
    - src/shared/constants.ts
    - src/shared/config.ts
    - src/tests/shared/config.test.ts

key-decisions:
  - "Default time window for the artifact->chunk join is +/-2h around artifact.created_at_epoch_ms — captures the immediate deliberation context; operator can tune via RoutingOptions.window_ms_before/after."
  - "Bi-encoder primary per CONTEXT decision 1 — P9 binding measurement was conducted under bi_encoder_fallback baseline; cross-encoder fitness 56.0% < 60% threshold post-backfill on the conversation-distribution corpus."
  - "Routing is artifact-kind-agnostic per CONTEXT decision 2 — no per-kind weighting; per-kind investigation deferred (see 10-CONTEXT § Deferred Ideas)."
  - "Five locked v6.routing.* defaults are the single source of truth — Plans 10-02 and 10-04 read them via loadConfig().v6.routing, never inline literals."

patterns-established:
  - "Per-artifact sequential calls (mirrors hybrid-retrieval) — parallel would saturate Ollama; routing remains I/O-bound network work serialized on purpose."
  - "Reranker fallback path captures one of {non_2xx, timeout, unreachable, empty_response} reasons and writes one telemetry row before falling through to bi-encoder."

requirements-completed: [ROU-01, ROU-02, ROU-03]

duration: ~30 min
completed: 2026-05-09
---

# Phase 10 Plan 01: Routing layer Summary

**Artifact -> transcript-chunk fan-out surface landed: routeFromArtifact + routeFromArtifacts with bi-encoder primary, cross-encoder behind v6.routing.reranker_mode flag, kind-agnostic ranking, non-throwing degradation across every external dependency.**

## Performance

- **Duration:** ~30 min
- **Tasks:** 3 / 3 (config block, routing module, vitest coverage)
- **Files modified:** 5 (3 created, 2 extended)
- **Commits:** 3 (feat 10-01 config, feat 10-01 routing, test 10-01 coverage)

## Accomplishments

- **v6.routing config block** lands in `src/shared/constants.ts` (DEFAULT_CONFIG.v6.routing) and `src/shared/config.ts` (ClaudexConfig interface + nested validateConfig type guard). Five keys at locked first-principles defaults: `top_k_per_artifact=3`, `max_k_per_query=12`, `token_pct_cap=15`, `bi_encoder_budget_pct=50`, `reranker_mode='bi_encoder_primary'`.
- **`src/retrieval/transcript-routing.ts`** exports `routeFromArtifact` and `routeFromArtifacts` with `RoutingArtifact`/`RoutingSpan`/`RoutingResult`/`RoutingOptions` types. Single-artifact call joins on `session_id` + `artifact.created_at_epoch_ms +/- 2h`; multi-artifact call dedupes by `chunk_id` (highest score wins) and caps the union at `max_k_per_query`.
- **Reranker fallback** captures `non_2xx | timeout | unreachable | empty_response` per hybrid-retrieval taxonomy, calls `incrementRerankerFallbackCounter`, then falls through to bi-encoder — mirrors RETR-08 exactly.
- **Vitest coverage** in `src/tests/retrieval/transcript-routing.test.ts` (9 tests) hits all five must-have truths against an in-memory V32 DB seeded via the production write surface (`upsertChunk`); only the network seams (Ollama embed, reranker /rerank) are mocked. Includes a purity-guard test asserting the routing module is never mocked.
- **`src/tests/shared/config.test.ts`** extended with 4 new cases covering the v6.routing block (defaults, type coercion, valid `cross_encoder_primary` flip, primitive-replacement fallback). 19/19 config tests pass.

## Verification

- `bun run build` — exit 0
- `bun run vitest run src/tests/shared/config.test.ts` — 19/19 PASS
- `bun run vitest run src/tests/retrieval/transcript-routing.test.ts` — 9/9 PASS

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Ready for Plan 10-02 (Assembly layer)

`formatDeliberationSurface` (Plan 10-02) consumes the `RoutingResult { spans, bi_encoder_only, candidate_count }` shape. `bi_encoder_only` is the signal Plan 10-02 reads to apply `bi_encoder_budget_pct × token_pct_cap` instead of the full `token_pct_cap` (CONTEXT decision 3 budget asymmetry).
