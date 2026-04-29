# Phase 6 Wave 4 — RETR-03 / RETR-04 verification

**Captured:** 2026-04-29T22:46Z
**Plan:** 06-05 (RIF + spread retained; MCP surface unchanged)
**Tests:** 17/17 PASS (8 RIF/spread + 9 MCP shape)

## RETR-03 — RIF + spread activation retained

| Check | Test file | Status |
|-------|-----------|--------|
| RIF: above-threshold non-selected loses 0.03 from activation_score | `phase-6-rif-spread-retained.test.ts::decrements activation_score by 0.03 on above-threshold non-selected candidates` | PASS |
| RIF: floor at 0.1 (RIF_ACTIVATION_FLOOR) | `…::clamps the decrement at RIF_ACTIVATION_FLOOR = 0.1` | PASS |
| RIF: respects `policy.shouldSuppressCandidate(rrf)` gate | `…::respects policy.shouldSuppressCandidate gate (default: rrf < threshold → not suppressed)` | PASS |
| RIF: non-throwing on closed DB | `…::is non-throwing on a closed DB` | PASS |
| Spread: 0.3 × strength × source.activation per linked target | `phase-6-rif-spread-retained.test.ts::boosts linked targets by 0.3 × link.strength × source.activation_score` | PASS |
| Spread: 10.0 cap honored | `…::caps boosted activation at 10.0` | PASS |
| Spread: skip packed targets | `…::skips packed targets` | PASS |
| Spread: non-throwing on closed DB | `…::is non-throwing on a closed DB` | PASS |

**Conclusion.** RIF (RIF_DECREMENT=0.03, RIF_ACTIVATION_FLOOR=0.1) and spread activation (SPREAD_FACTOR=0.3, cap=10.0) behavior is unchanged from Phase 5. Phase 6 consolidation in Plan 03 left both subsystems untouched, as expected — they are downstream of the multiplier chain, not part of it.

## RETR-04 — MCP surface unchanged

| Tool | Test file | Status |
|------|-----------|--------|
| `claudex_search` registration + result keys (results, total, has_more) | `phase-6-mcp-surface-unchanged.test.ts::claudex_search response keys (results, total, has_more) still present in source` | PASS |
| `claudex_search` SearchResult element keys (id, type, summary, provenance, importance, project, source, score) | `…::claudex_search result-element keys … still present in source` | PASS |
| `claudex_recall` response keys (id, type, summary, content, provenance, project, importance) | `…::claudex_recall response keys … still present in source` | PASS |
| `claudex_store` response keys (stored, type, project, agent_id|topic_key|upserted) | `…::claudex_store response keys … still present` | PASS |
| `claudex_events` JSON-stringified events payload | `…::claudex_events handler returns a JSON-stringified events payload` | PASS |
| `claudex_message` registration + handler body | `…::claudex_message handler is still registered and still has a non-trivial body` | PASS |
| All five tool registrations present (no regressions) | `…::recall-server.ts source has not lost any of the five tool registrations versus pre-Phase-6` | PASS |
| Canonical fixture exists and is parseable | `…::canonical fixture file exists and is parseable` | PASS |
| All five tools registered in source | `…::recall-server.ts source still registers all five MCP tools` | PASS |

**Approach.** Lock-down is structural — assertions read `src/mcp/recall-server.ts` directly and verify the JSON.stringify object literals + the `server.registerTool(...)` registrations still carry the canonical key set. This catches deletion/rename without spawning the server process or running the MCP transport.

**Canonical fixture.** `src/tests/fixtures/mcp-surface-canonical.json` records the pre-Phase-6 surface for future audit. Any Phase 7+ work that wants to alter these keys must update the fixture explicitly.

## Wave-end gate

- All four W4 must_haves satisfied (RIF behavior, spread behavior, MCP shape, sanity recap doc).
- 17 new lock-down tests; full suite remains at 0 non-llama failures.
- Atomic commit: `phase(06-05): RETR-03/04 verification — RIF/spread retained, MCP surface unchanged`.

## Out of scope (deferred to Plan 06)

- Vesna SC#1 ≥80% gate.
- STATE.md / ROADMAP.md / REQUIREMENTS.md final update.
- Phase 06-SUMMARY.md (the phase-level summary, separate from per-plan summaries).
