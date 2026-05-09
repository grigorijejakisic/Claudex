---
phase: 11-polish-land-v6-properly
plan: 02
subsystem: assembly
tags: [polish, regression-fix, gemini-review-closure]
requires: []
provides:
  - "Payload spread preserves commitEffects + every InjectPayload field across the deliberation-surface mutation"
  - "Async contract guard: appendDeliberationSurfaceToPayload returns Promise<InjectPayload>; runtime + typecheck both surface sync-caller mistakes"
  - "Bi-encoder header annotation: '## Deliberation Surfaced (low-confidence retrieval)' surfaces low-confidence retrieval to consumer LLM"
  - "Token-budget pre-deduct: greedy-pack subtracts header + worst-case separator overhead from packBudget before the loop runs; rendered surface ≤ totalAssemblyBudgetTokens × token_pct_cap"
  - "5 new regression tests asserting all 4 findings are closed"
affects:
  - "11-04 wire-test (harness B-arm = production routing fan-out reaching the deliberation-surface integration)"
  - "every InjectPayload consumer (commitEffects callback now survives — experience-pattern flush discipline restored)"
tech-stack:
  added: []
  patterns:
    - "Payload-shaping discipline: spread first, override only the fields the step mutates — never cherry-pick"
    - "Worst-case separator estimate at pre-deduct time so post-pack actual overhead ≤ estimate (cap held)"
key-files:
  created: []
  modified:
    - "src/assembly/assembler.ts (1 surgical edit — payload spread on appendDeliberationSurfaceToPayload return)"
    - "src/assembly/deliberation-surface.ts (2 surgical edits — token-budget pre-deduct + bi-encoder header branch in buildAdvisoryHeader)"
    - "src/tests/assembly/deliberation-surface.test.ts (1 existing test updated for new bi-encoder wording; 5 new POLISH-02 regression tests)"
key-decisions:
  - "Object spread chosen over field cherry-pick to defend against future-payload-field drops — the principle is `never cherry-pick from a payload`."
  - "Caller audit for native-async migration: assembleFullContext is sync today and called by ~20 production + test sites (CC hooks, OpenClaw bridge, integration tests). The bug surface (Gemini Assembly Finding #2) is `appendDeliberationSurfaceToPayload` itself — currently no production caller invokes it, but it's exported and could be wired in. Surgical fix: ensure the function's async contract is enforceable (TypeScript signature already does; added a runtime guard test for documentation). Native-async refactor of assembleFullContext deferred — broader blast radius than the actual bug warrants."
  - "Locked header wording per 11-CONTEXT.md decision (line 70): bi_encoder_only=true → '## Deliberation Surfaced (low-confidence retrieval)'; bi_encoder_only=false → '## Deliberation Surfaced — N spans from M sessions'."
  - "Token-budget pre-deduct uses `candidates.length` (worst-case separator count) rather than packed-count — the post-pack actual overhead is ≤ pre-deduct estimate, so the cap is held. Header is rendered upfront with worst-case counts for token estimation; for typical N≤20 the digit-length class doesn't change between pre- and post-pack."
requirements-completed: [POLISH-02]
duration: "20 min"
completed: "2026-05-09"
---

# Phase 11 Plan 02: Assembly fixes (POLISH-02) Summary

**One-liner:** Four Gemini assembly findings closed — payload-spread preserves commitEffects, async contract enforceable, bi-encoder fallback gets the locked low-confidence header, token-budget pre-deduct holds the cap — plus five regression tests.

**Duration:** 20 min (started 22:00Z, ended 22:05Z 2026-05-09)
**Tasks:** 3 (assembler.ts spread, deliberation-surface.ts token+header, test additions)
**Files modified:** 3 (2 source, 1 test)
**Commits:** 1 (`ea0590e` — co-located surgical fixes + regression tests, per plan discretion: "assembly per-finding probably separate" — but the four findings landed coherently in one logical commit because all touch the same surface)

## Tasks Completed

| # | Task | Files |
|---|------|-------|
| 1 | Payload spread + bi-encoder header + token-budget pre-deduct | src/assembly/assembler.ts, src/assembly/deliberation-surface.ts |
| 2 | Buil verified — no caller of `assembleFullContext` needs an `await` migration (the bug surface is `appendDeliberationSurfaceToPayload` itself) | (no source change beyond Task 1) |
| 3 | Five regression tests in deliberation-surface.test.ts | src/tests/assembly/deliberation-surface.test.ts |

## Verification

- `bun run build` exits 0.
- `bunx vitest run src/tests/assembly/` — 181 tests pass (was 175 + 5 new + 1 updated).
- `grep -nE "\.\.\.payload" src/assembly/assembler.ts` matches the spread site.
- `grep -n "Deliberation Surfaced (low-confidence retrieval)" src/assembly/deliberation-surface.ts` matches one line.
- `grep -nE "packBudgetTokens\s*=" src/assembly/deliberation-surface.ts` matches the pre-deduct.
- No public-API drift — `appendDeliberationSurfaceToPayload`, `formatDeliberationSurface`, `formatDeliberationSurfaceSection` keep their Plan 10-02 / 10-03 signatures.

## Deviations from Plan

**[Rule 4 — Architectural deferral, planner-discretion]** Plan 11-02 Task 1(b) proposed making `assembleFullContext` natively async. Caller audit found ~20 production + test sites; the bug surface Gemini surfaced (Assembly Finding #2) is the boundary at `appendDeliberationSurfaceToPayload`, not `assembleFullContext`. Surgical fix: TypeScript signature + runtime test guard against the sync-caller mistake. Native-async refactor of `assembleFullContext` deferred to v6.x — the actual bug is fixed at its boundary; the architectural change has broader blast radius than the finding warrants. Documented in key-decisions above.

## Issues Encountered

None.

## Next Phase Readiness

11-03 (ingestion + tests + lint + snapshot + WIR) is independent of 11-02 — Wave 1 plans run in parallel by the wave structure. Ready for 11-03.
