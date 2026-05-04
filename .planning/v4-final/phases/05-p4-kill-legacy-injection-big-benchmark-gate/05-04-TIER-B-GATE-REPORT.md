# Tier B Gate Report

**Date:** 2026-04-29
**Sections deleted (4):** Predicted Context, Angel Opinions, Proven Principles (session-start only), project_overview
**Commits:**
- `8bc78e8` (Predicted Context + session-start.ts predictedContext field)
- `a68f006` (Angel Opinions)
- `f4933aa` (Proven Principles session-start; UPS path retained)
- `1cb258f` (project_overview)

## Layer 1 — Token budget (cl100k_base)

| Scenario | Pre-Tier-A | Post-Tier-A | Post-Tier-B | ≤500? |
|----------|-----------|-------------|-------------|-------|
| cold-start | 124 | 124 | 124 | yes |
| warm-start-with-memory-md | 148 | 148 | 148 | yes |
| handoff-start | 145 | 145 | 145 | yes |
| gsd-active-start | 191 | 191 | 191 | yes |

Same observation as Tier A: fixture cascade unchanged. Empty fixture DB never traverses content-gated branches in production (predictedContext === undefined; angel_opinions empty; getProvenPrinciples empty). Plan 09 production-baseline soak measures live cascade tokens against real DB content; Phase 5 close numbers go in 05-09-SC2-CACHE-RESULT.md.

## Layer 2 — Byte-identical across consecutive runs (CACH-01)

All 4 scenarios PASS. 12/12 cache-stability tests green.

## Layer 3 — Invariant under volatile mutation (CACH-02)

All 4 scenarios PASS. CACH-03 hardening still holds across deletions.

## Vesna probe pass-rate

Re-running phase-4-1-perceptual-similarity-probes proxy:

| Category | Pre-Tier-A | Post-Tier-A | Post-Tier-B | Delta vs baseline |
|----------|------------|-------------|-------------|---------------------|
| perceptual_similarity | 4/4 | 4/4 | 4/4 | 0 |
| **Overall (proxy)** | 100% | 100% | 100% | 0 |

Phase 10 full Vesna suite not yet shipped; Plan 09 will re-measure against whatever subset is live.

## MEMORY.md SC#3 content-quality

Phase 5 doesn't modify MEMORY.md content. No expected change. Plan 09 runs the SC#3 mechanical scorer against all 5 active projects.

| Project | Pre/Post (no expected change) |
|---------|-------------------------------|
| claudex-v3 | unchanged |
| lacuna-betting | unchanged |
| oracle | unchanged |
| big-mozzy-v2 | unchanged |
| desktop | unchanged |

## Headroom check before Tier C

Per RESEARCH pitfall 5: "Tier C should only proceed if Vesna is comfortably above 80%."

**Tier B post-deletion Vesna:** 100% (proxy; full suite TBD)
**Headroom for Tier C:** **GREEN** — Plan 05 proceeds.

## Test results

- Assembly tests: 165/165 PASS at every commit
- Cache-stability: 12/12 PASS
- Full test suite: 2729/2749 (20 pre-existing llama-server failures unchanged; not regressions)

## Verdict

**PASS** — proceed to Plan 05 (Tier C).

Rationale:
- 4 atomic deletion commits land cleanly; no test regressions outside the pre-existing llama-server cluster.
- Cache-stability harness Layer 2/3 green (CACH-03 hardening continues to hold).
- Vesna proxy unchanged at 100%; SC#3 file content unmodified.
- session-start.ts updated: predictedContext local variable + assembleFullContext arg removed; predictSessionIntent telemetry preserved for accuracy tracking.
- imports cleaned: formatPredictedContextSection, formatProjectsOverview, ProjectOverviewRow type all removed (no other consumers in assembler.ts).
- Proven Principles UPS-side import (formatProvenPrinciplesSection, getProvenPrinciples) intentionally preserved — Plan 06 audits.

Cumulative tier impact (assembler.ts deletion lines, code only):
- Tier A: 154
- Tier B: 121
- **Tier A + B total: ~275 lines removed from assembleFullContext()**
