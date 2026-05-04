---
phase: 06-p5-retrieval-simplification-multiplier-ablation
plan: 06-05
subsystem: retrieval
tags: [phase-6, retr-03, retr-04, lock-down, regression-prevention, rif, spread-activation, mcp-surface]
requires: [06-03, 06-04]
provides: [rif-spread-lock-down-tests, mcp-surface-lock-down-tests, mcp-canonical-fixture, 06-05-verification-doc]
affects:
  - src/tests/integration/phase-6-rif-spread-retained.test.ts
  - src/tests/integration/phase-6-mcp-surface-unchanged.test.ts
  - src/tests/fixtures/mcp-surface-canonical.json
tech-stack:
  added: []
  patterns: [behavioral-lock-down-via-known-deltas, source-grep-shape-assertion, canonical-fixture-as-frozen-reference]
key-files:
  created:
    - src/tests/integration/phase-6-rif-spread-retained.test.ts
    - src/tests/integration/phase-6-mcp-surface-unchanged.test.ts
    - src/tests/fixtures/mcp-surface-canonical.json
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-05-VERIFICATION.md
  modified: []
key-decisions:
  - decision: RIF lock-down asserts behavior via observable activation_score deltas
    rationale: RIF_DECREMENT/RIF_ACTIVATION_FLOOR are not exported. Asserting "starting activation 0.8 → ending activation 0.77" infers the constant. If a future edit changes the constant, the test fails with a descriptive comparison ("expected 0.77, got 0.78"), making the regression obvious.
  - decision: Spread lock-down asserts each helper invariant separately (delta math, cap, packed-skip, closed-DB)
    rationale: Phase 6 simplification could touch any of these as a side effect. Splitting into one test per invariant means any regression points at the specific failure mode.
  - decision: MCP surface lock-down uses static source-grep, not runtime invocation
    rationale: The MCP handlers are not exported (registered inline against the McpServer instance). Spawning the server process to test would be heavyweight. A static structural check on src/mcp/recall-server.ts catches the only thing that matters for RETR-04 — whether the JSON.stringify object literals still carry the canonical key set.
  - decision: Canonical fixture src/tests/fixtures/mcp-surface-canonical.json is a frozen reference
    rationale: Future Phase 7+ work that wants to alter the MCP surface must update the fixture explicitly. The fixture acts as a one-way ratchet — keys can only be added with deliberate intent.
  - decision: claudex_events and claudex_message tested at registration + handler-body level only
    rationale: Their response shape varies (events array; cross-session messaging routing). Asserting registration + handler presence catches accidental removal, which is the RETR-04 concern. Deeper shape checks belong in dedicated handler tests, not this lock-down.
  - decision: registerTool count assertion (≥5) catches mass deletion
    rationale: A regex grep counts `server.registerTool(` occurrences; >= 5 guards against accidentally collapsing the tool surface during refactor. The actual count today is 7 (curated_context, session also exist), so the >= 5 floor is loose by design.
requirements-completed:
  - RETR-03 (RIF suppression and spread activation retained; behavior locked)
  - RETR-04 (MCP surface unchanged for the five canonical tools)
duration: 9 min
completed: 2026-04-29
---

# Phase 06 Plan 05: RETR-03 / RETR-04 verification — RIF/spread retained, MCP surface unchanged

**One-liner.** Wrote 17 lock-down tests across two files plus a canonical MCP-surface fixture, and a verification recap doc — RIF/spread behavior is byte-equal to Phase 5 and the five canonical MCP tools' response shapes are still emitted by `recall-server.ts` source verbatim.

## Duration

- Started: 2026-04-29 ~22:42 UTC
- Ended:   2026-04-29 ~22:51 UTC
- Wall clock: ~9 min

## Tasks (3 of 3 complete)

### 06-05-01 — RIF + spread lock-down test

- New `src/tests/integration/phase-6-rif-spread-retained.test.ts` with 8 tests:
  - RIF decrement = 0.03 on above-threshold non-selected (asserts both starting and ending activation_score values).
  - RIF activation floor = 0.1 (asserts MAX-clamping behavior).
  - RIF policy gate respected (sub-threshold rrf → no decrement).
  - RIF non-throwing on closed DB.
  - Spread delta = 0.3 × link.strength × source.activation_score (with multi-link scenario).
  - Spread cap = 10.0 (boost would be 30 → capped).
  - Spread skips packed targets.
  - Spread non-throwing on closed DB.
- 2 minor schema-fixture corrections during authoring: `link_kind` → `link_type` and `'related_to'` → `'related'` (CHECK enum values).

### 06-05-02 — MCP surface lock-down test + canonical fixture

- New `src/tests/integration/phase-6-mcp-surface-unchanged.test.ts` with 9 tests covering all five RETR-04 tools.
- New `src/tests/fixtures/mcp-surface-canonical.json` — frozen reference of the pre-Phase-6 MCP response key shapes for `claudex_search`, `claudex_recall`, `claudex_store`, `claudex_events`, `claudex_message`.
- Static-source-grep approach: assertions read `src/mcp/recall-server.ts` and verify each canonical key is still present in the JSON.stringify object literals. Robust to ordering changes; loud on key removal/rename.

### 06-05-03 — Sanity recap doc

- New `06-05-VERIFICATION.md`: 8-row RETR-03 table + 9-row RETR-04 table, both with PASS markers and test-file references.

## Verification

### must_haves checklist

| Item | Status |
|------|--------|
| RIF behavior preserved (decrement, floor, gate, non-throw) | PASS (4 tests) |
| Spread behavior preserved (delta math, cap, packed skip, non-throw) | PASS (4 tests) |
| Each of the five MCP tools' response shape verified vs canonical fixture | PASS (9 tests) |
| Canonical fixture exists and is parseable | PASS |
| `06-05-VERIFICATION.md` exists at the phase directory | PASS |
| `bun run build` clean | PASS |
| Full suite passes (no non-llama regressions) | PASS (2896 pass, 20 = pre-existing llama baseline) |

### Wave-end gate

- 17/17 lock-down tests pass.
- `06-05-VERIFICATION.md` reflects what shipped.
- Atomic commit: `phase(06-05): RETR-03/04 verification — RIF/spread retained, MCP surface unchanged`.

## Deviations from Plan

**[Rule 3 — Blocking] artifact_links schema column name + CHECK enum value mismatch** — Found during: integration test authoring | Issue: plan-suggested test code referenced `link_kind` but schema uses `link_type`; plan-suggested test code used `'related_to'` but schema CHECK enum admits `'related'` | Fix: corrected both (replace_all). The test now uses the actual schema values; the plan's pseudocode was directionally correct but had stale field names. | Files modified: `phase-6-rif-spread-retained.test.ts` only | Verification: 8/8 RIF/spread tests pass.

**Total deviations: 1 Rule-3 blocking fix (schema-column-name correction).**

## Authentication Gates

None.

## Issues Encountered

None.

## Next Phase Readiness

Plan 06 (W5 — SC#1 Vesna gate + STATE/ROADMAP/REQUIREMENTS update + 06-SUMMARY.md) is unblocked. The lock-down tests in Plan 05 form part of the regression evidence Plan 06 will summarize:

- RIF/spread invariant preservation (Plan 05) plus consolidated scoring math (Plan 03) plus reranker visibility (Plan 04) all feed into Plan 06's SC#1 Vesna gate.
- The full Phase 6 test count post-Plan-05 is +71 net new tests since the start of Phase 6 (W1: 35 hybrid-retrieval green; W2: 4 sweep + 6 V20 migration; W3: 4 sweep again; W4: 9 telemetry-counter + 9 visibility; W5: 8 RIF/spread + 9 MCP shape).

## Files Touched (summary)

- 2 new integration tests: 8 + 9 = 17 lock-down assertions.
- 1 new fixture: `mcp-surface-canonical.json` (frozen reference for Phase 7+).
- 1 new doc: `06-05-VERIFICATION.md` recap.
- 0 source-code changes — Plan 05 is pure verification.
