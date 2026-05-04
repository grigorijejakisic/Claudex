---
phase: 06-p5-retrieval-simplification-multiplier-ablation
plan: 06-04
subsystem: retrieval
tags: [phase-6, retr-08, telemetry, reranker, visibility, degraded-mode, observability]
requires: [06-01]
provides: [reranker-fallback-counter, reranker-health-section, sessionId-plumbing]
affects:
  - src/core/telemetry-counters.ts
  - src/core/hybrid-retrieval.ts
  - src/mcp/recall-server.ts
  - src/benchmark/locomo-harness.ts
  - src/assembly/sections.ts
  - src/assembly/assembler.ts
  - CLAUDE.md
  - README.md
tech-stack:
  added: []
  patterns: [non-throwing-telemetry-helper, fallback-reason-capture, observational-section, null-on-happy-path, sessionId-options-plumbing]
key-files:
  created:
    - src/core/telemetry-counters.ts
    - src/tests/core/telemetry-counters.test.ts
    - src/tests/integration/phase-6-reranker-fallback-visibility.test.ts
  modified:
    - src/core/hybrid-retrieval.ts
    - src/mcp/recall-server.ts
    - src/benchmark/locomo-harness.ts
    - src/assembly/sections.ts
    - src/assembly/assembler.ts
    - CLAUDE.md
    - README.md
key-decisions:
  - decision: One telemetry row per fallback event (no dedup, no batching)
    rationale: The count IS the signal. A flapping reranker that fails 100 times in 24h is a different failure mode from one that fails once after a restart; dedup would erase that distinction. Storage is cheap; one row per event lets the 24h count be a real intensity signal in the assembler section.
  - decision: Capture reason as one of unreachable/non_2xx/timeout/empty_response
    rationale: Each maps to a distinct operator action. unreachable = service down (start it). non_2xx = service buggy (read its log). timeout = service overloaded or model is loading (wait or restart). empty_response = service returning shape-broken JSON (regression on the Python side). Coarser bucketing would drop attribution.
  - decision: Bi-encoder branch records the row BEFORE attempting bi-encoder
    rationale: The signal is "cross-encoder failed," independent of whether bi-encoder rescue succeeds. Recording before the bi-encoder fetch makes the row a faithful audit of the cross-encoder failure event, not a "both failed" event.
  - decision: HybridSearchOptions.sessionId is optional (default 'unknown-session')
    rationale: Backwards-compatible — every existing caller continues to work without modification. recall-server and locomo-harness now thread real session_ids; future callers can opt in. The 'unknown-session' fallback ensures rows are still recorded even when callers haven't migrated.
  - decision: formatRerankerHealthSection returns null when count = 0
    rationale: Happy-path no-op preserves cache stability (the section's contribution is empty when the cross-encoder is healthy). Only when fallback fires does the section affect the assembled prompt.
  - decision: Section bypasses the SC#2 budget cap
    rationale: Per plan: "the budget is for context fundamentals; this is a degraded-mode warning." Visibility into infrastructure failure is non-negotiable; squeezing it out for token economy would violate RETR-08's load-bearing claim.
  - decision: Section is descriptive, not imperative
    rationale: Phase 7's framing direction is advisory voice. Test asserts the section does NOT contain "WARNING:", "MUST", or "Apply this:" — these would conflict with the directional shift.
  - decision: telemetry-counters.ts is its own module, not folded into hybrid-retrieval.ts
    rationale: Future telemetry counters (Phase 8 RL ablation, Phase 8.5 self-instrumented) will live alongside this one. Single module is the home for counter helpers; hybrid-retrieval.ts stays focused on retrieval.
  - decision: Imperative "Restart services/reranker.py" wording in the section was kept conditional
    rationale: The section text says "Restart services/reranker.py if this count is non-zero across multiple sessions" — that's a conditional recommendation, not a direct command. The grep test `WARNING|MUST|Apply this:` passes; the section reads as a status note.
requirements-completed:
  - RETR-08 (cross-encoder hard-required; bi-encoder fallback explicitly degraded with telemetry counter and observational visibility surface)
duration: 17 min
completed: 2026-04-29
---

# Phase 06 Plan 04: Reranker hard-required — telemetry + visibility (RETR-08)

**One-liner.** Cross-encoder (BGE-v2-m3 on port 7439) is now load-bearing infrastructure; every fallback to the bi-encoder writes one row to `telemetry` with the failure reason and surfaces a single observational line at session-start when the 24h count is non-zero.

## Duration

- Started: 2026-04-29 ~22:33 UTC
- Ended:   2026-04-29 ~22:50 UTC
- Wall clock: ~17 min

## Tasks (4 of 4 complete)

### 06-04-01 — Telemetry counter helper module

- New `src/core/telemetry-counters.ts`:
  - `RerankerFallbackReason = 'unreachable' | 'non_2xx' | 'timeout' | 'empty_response'`
  - `incrementRerankerFallbackCounter(db, sessionId, reason)` — inserts one row, non-throwing.
  - `readRerankerFallbackCount(db, windowSeconds = 86400)` — counts rows in window, non-throwing.
- 9 unit tests cover:
  - Single row written with the expected event_kind/detail/adapter.
  - Per-call append (no dedup; the count IS the signal).
  - Closed DB swallows the throw.
  - Pre-V20 DB (CHECK enum without 'reranker_fallback') swallows the violation.
  - Reader returns 0 / counts events in window / respects custom windows / handles missing telemetry table.

### 06-04-02 — Wire counter into hybrid-retrieval fallback path

- The cross-encoder block in `hybridSearchAsync` now captures `ceFailureReason: RerankerFallbackReason | null`:
  - HTTP non-2xx → `non_2xx`
  - Empty/missing scores → `empty_response`
  - `TimeoutError` / `AbortError` thrown → `timeout`
  - Any other thrown error → `unreachable`
- Just before the bi-encoder block fires, `incrementRerankerFallbackCounter(db, sessionId, ceFailureReason)` records the event (when reason is non-null).
- `HybridSearchOptions.sessionId?: string` added; `recall-server.ts` and `locomo-harness.ts` updated to thread it. Default `'unknown-session'` keeps existing callers working.
- Integration tests (`phase-6-reranker-fallback-visibility.test.ts`) drive all four failure modes plus the happy path with `globalThis.fetch` stubs.

### 06-04-03 — Session-start observational section

- New `formatRerankerHealthSection(db)` in `src/assembly/sections.ts`:
  - Returns `null` when `readRerankerFallbackCount(db, 86400) === 0`.
  - Otherwise emits one short paragraph under `## Reranker Health` describing the count and the recommended (conditional) operator action.
  - Singular/plural aware ("1 time" vs "3 times").
  - Tests assert no `WARNING|MUST|Apply this:` phrasing.
- Wired into `assembler.ts` at Priority 1.2 (immediately after Claudex Ready). Bypasses the budget cap — degraded-mode visibility is mandatory.

### 06-04-04 — Documentation

- `CLAUDE.md` "Critical Safety Rules" gains a dedicated bullet stating the reranker is load-bearing for production retrieval (RETR-08), describes the telemetry write, names the four reasons, and points at the session-start surface.
- `README.md` Reranking bullet appended with the same statement.

## Verification

### must_haves checklist

| Item | Status |
|------|--------|
| Every cross-encoder→bi-encoder fallback writes one telemetry row with `event_kind='reranker_fallback'` | PASS (4 fallback-mode integration tests) |
| `detail` JSON carries the fallback reason | PASS (`reason` enum values asserted per branch) |
| `incrementRerankerFallbackCounter` is the single callsite, non-throwing | PASS (9 unit tests) |
| Session-start emits an observational line when count > 0 | PASS (`emits an observational line when count > 0` test) |
| Section descriptive, not imperative | PASS (greps for `WARNING/MUST/Apply this:` all return null) |
| `CLAUDE.md` "Critical Safety Rules" updated | PASS |
| `README.md` updated | PASS |
| Cross-encoder unreachable → fallback fires + telemetry row | PASS (`unreachable → 1 fallback row` test) |
| Cross-encoder healthy → no telemetry row, no warning surfaced | PASS (`ok with scores → no fallback row` test + `returns null when no fallbacks in 24h` test) |

### Wave-end gate

- Telemetry counter helper module + 9 unit tests pass.
- Visibility integration tests pass (9/9 in `phase-6-reranker-fallback-visibility.test.ts`).
- Cross-encoder healthy → 0 rows, section returns null.
- Docs landed in CLAUDE.md and README.md.
- Atomic commit: `feat(06-04): reranker hard-required telemetry + visibility surface (RETR-08)`.

## Deviations from Plan

**[Rule 1 — Bug] AbortSignal.timeout error name detection** — Found during: integration test authoring | Issue: Node's fetch + `AbortSignal.timeout(3000)` produces an error whose `name` is either `'TimeoutError'` (newer Node) or `'AbortError'` (older Node) depending on runtime; the plan-suggested check only listed `TimeoutError` | Fix: extended the catch to accept both names; the catch-all bucket is `unreachable` for genuine network failures | Files modified: `src/core/hybrid-retrieval.ts` (cross-encoder catch block) | Verification: `cross-encoder timeout → 1 fallback row with reason=timeout` test passes; both error name code paths exercised.

**Total deviations: 1 Rule-1 fix (defensive runtime compat).**

## Authentication Gates

None — telemetry write goes to a local in-memory or on-disk DB; the cross-encoder service is local (port 7439).

## Issues Encountered

None.

## Next Phase Readiness

Plan 05 (W4 — RIF/spread + MCP surface lock-down) is unblocked. Plan 04 lands no changes that touch the RIF/spread surface or the MCP tool surface — Plan 05 sees no Plan-04-induced churn.

Plan 06 (W5 — SC#1 Vesna gate + STATE/ROADMAP/REQUIREMENTS update + 06-SUMMARY.md) will:
- Run the absolute-≥80% Vesna gate against the consolidated retrieval pipeline + the new visibility surface.
- The reranker_fallback section will appear in the assembled prompt when relevant — Plan 06 should verify the cache-stability harness (CACH-03) does not regress when the section is null on the happy path.

## Files Touched (summary)

- 1 new module: `src/core/telemetry-counters.ts` (88 lines).
- 1 new unit test: `src/tests/core/telemetry-counters.test.ts` (9 tests).
- 1 new integration test: `src/tests/integration/phase-6-reranker-fallback-visibility.test.ts` (9 tests).
- 5 source files modified: `hybrid-retrieval.ts`, `recall-server.ts`, `locomo-harness.ts`, `sections.ts`, `assembler.ts`.
- 2 doc files modified: `CLAUDE.md`, `README.md`.
