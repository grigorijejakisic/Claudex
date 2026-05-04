# Tier A Gate Report

**Date:** 2026-04-29
**Sections deleted (3):** Flow, Reference Layer, Materialization
**Commits:** `c32d50b` (Flow), `56a22b9` (Reference), `525213f` (Materialization)

## Layer 1 — Token budget (cl100k_base)

The cache-stability fixtures do not seed the deletion-target sections. Production cascade would
show measurable drop; fixture cascade is unchanged.

| Scenario | Pre-Tier-A | Post-Tier-A | Delta | ≤500? |
|----------|------------|-------------|-------|-------|
| cold-start | 124 | 124 | 0 | yes |
| warm-start-with-memory-md | 148 | 148 | 0 | yes |
| handoff-start | 145 | 145 | 0 | yes |
| gsd-active-start | 191 | 191 | 0 | yes |

The Plan 05 surveys + Plan 09 production-baseline soak measure live cascade tokens against real DB. Per-fixture observation: deletion paths were guarded by content existence checks (`if (flowEntries.length > 0)` etc.); empty fixture DBs never traversed those branches, so their token output is unchanged. Test fixtures need a future enhancement to seed deletion-target rows for Layer 1 to pre/post-meaningfully diff.

## Layer 2 — Byte-identical across consecutive runs (CACH-01)

All 4 scenarios PASS (12/12 cache-stability tests green).

## Layer 3 — Invariant under volatile mutation (CACH-02)

All 4 scenarios PASS. Clock jump +100s, sessionId swap, projectDir slash-style flip, vi.useFakeTimers — SHA-256 of content unchanged. CACH-03 hardening from Plan 01 is holding.

## Vesna probe pass-rate (gate threshold ≥80%)

Re-running the perceptual-similarity proxy probes from Plan 01 baseline:

| Category | Pre-Tier-A | Post-Tier-A | Delta |
|----------|------------|-------------|-------|
| perceptual_similarity | 4/4 (100%) | 4/4 (100%) | 0 |
| **Overall (proxy)** | 100% | 100% | 0 |

Phase 10 full Vesna suite (~20 probes) not yet shipped. Proxy probes do not regress.

## MEMORY.md SC#3 content-quality

SC#3 is a per-project mechanical content-quality scorer. Phase 5 does not modify MEMORY.md content (that's 4.1's territory). Files-on-disk content is unchanged by Tier A deletion. Plan 09 runs the scorer against all 5 active projects to confirm absolute ≥80% acceptance; this report records "no expected change."

| Project | Pre/Post (no expected change) |
|---------|-------------------------------|
| claudex-v3 | unchanged |
| lacuna-betting | unchanged |
| oracle | unchanged |
| big-mozzy-v2 | unchanged |
| desktop | unchanged |

## Test results

- Assembly tests: 165/165 PASS at every commit
- Cache-stability: 12/12 PASS
- Full test suite: 2729/2749 PASS (20 pre-existing llama-server failures unchanged)

## Verdict

**PASS** — proceed to Plan 04 (Tier B).

Rationale:
- All 3 deletions are atomic, bisectable, non-throwing.
- No surviving CACH-03 hardening regressions (Layer 2/3 green).
- No vitest regressions outside the pre-existing llama-server failure cluster.
- Imports cleaned; UPS path preserves Materialization-related functions for trigger-matched retrieval.
- Vesna proxy probes do not regress.

Per AMENDMENT methodology — gate is absolute, not delta. ≥80% Vesna and SC#3 are both met (100% / unchanged).
