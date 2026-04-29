---
phase: 7
plan: 07-02
title: Vesna purge probe + Phase 6.5 gate re-run + purge result writeup
subsystem: integration-tests
tags: [framing, fram-04, sc1-gate, vesna, advisory-voice]
requires: [07-01]
provides: [phase-7-vesna-result, advisory-voice-probe]
affects:
  - src/tests/integration/phase-7-advisory-voice.test.ts
  - .planning/phases/07-p6-framing-rewrite-advisory-voice/07-VESNA-RESULT.md
tech-stack:
  added: []
  patterns: [no-imperative-regex-gate, lexical-leakage-discipline]
key-files:
  created:
    - src/tests/integration/phase-7-advisory-voice.test.ts
    - .planning/phases/07-p6-framing-rewrite-advisory-voice/07-VESNA-RESULT.md
  modified: []
key-decisions:
  - 11 test cases organized by formatter (Proven Principles, Experience Warnings, Pressure Response) plus cross-formatter sweep + wrap retention
  - Pre-flight regex `/WARNING:|MUST\s|REQUIRED|Always |Never |do not |STOP NOW|Wrap up/` mirrors phase-6-5 vesna lexical-leakage discipline
  - 8/8 probes pass (5 from new test + 3 from re-run 6.5 vesna), giving 100% on the SC#1 gate vs ≥80% floor
  - No retrieval regression — Phase 6.5 cross-project probes all pass unchanged
  - Token-budget delta sanity check passed (UPS within 500-token Proven Principles cap, pressure response not bound by UPS budget)
requirements-completed:
  - FRAM-04
duration: 4 min
completed: 2026-04-29
---

# Phase 7 Plan 02: Vesna purge probe + 6.5 gate re-run Summary

Author 11-test no-imperative regex probe across the three rewritten formatters and re-run the Phase 6.5 cross-project Vesna gate to confirm zero retrieval regression. Result: **8/8 probes PASS** on the SC#1 gate (100% vs ≥80% floor). FRAM-04 verified.

## Execution

- **Duration:** ~4 min
- **Tasks executed:** 4/4
- **Files created:** 2 (test file + result md)
- **Atomic commit:** 1 (this plan is purely additive)
- **Tests added:** 11 (across 5 describe blocks)

## What changed

### Task 07-02-01 — `phase-7-advisory-voice.test.ts` authored

`src/tests/integration/phase-7-advisory-voice.test.ts` mirrors the import shape and lexical-leakage discipline of `phase-6-5-cross-project-vesna.test.ts`. 11 cases:

1. `formatProvenPrinciplesSection` emits no imperative footer + retains per-bullet shape (2 cases).
2. `renderExperienceWarnings` advisory shape (no escalation prefixes, no `**Correct approach:**`, yes `Past pattern:` / `Observed approach:` / `Outcome learned:`) + count-rendering shape (2 cases).
3. `formatPressureResponse` per-zone observation, not command (advisory/warning/critical via `it.each`, plus `normal → null`) (4 cases).
4. Cross-formatter negative regex sweep against `/WARNING:|MUST\s|REQUIRED|Always |Never |do not |STOP NOW|Wrap up/` (1 case).
5. `<experience-data>` wrap retention + boundary-breakout rejection + framing preamble position outside the wrap (FRAM-03 carve-out, 2 cases).

Helper: `pattern(overrides)` constructs a minimal valid `ExperiencePattern` fixture; `gauge(util)` constructs a `TokenUsage` for pressure tests.

Run result: 11/11 PASS.

### Task 07-02-02 — Phase 6.5 cross-project Vesna gate re-run

`bun run test src/tests/integration/phase-6-5-cross-project-vesna.test.ts` → 4/4 PASS.

The `formatExperienceTierSection` output (Phase 6.5's canonical advisory-voice precedent) is unchanged by Plan 07-01, so retrieval scoring and surfacing behavior is unaffected. All three perceptual probes (shadowban Lacuna→big-mozzy-v2, auth-token-expiry multi→third, schema-migration multi→Oracle) and the wrapping no-imperative regex check continue to pass.

### Task 07-02-03 — Broader regression sweep

| Suite | Tests | Result |
|-------|------:|--------|
| `src/tests/assembly/` | 165/165 | PASS |
| `src/tests/intelligence/` | 801/801 | PASS |
| `src/tests/integration/phase-5-full-gate.test.ts` | 7/7 | PASS |
| `src/tests/integration/phase-6-5-cross-project-vesna.test.ts` | 4/4 | PASS |
| `src/tests/integration/phase-7-advisory-voice.test.ts` | 11/11 | PASS |

The 20 pre-existing llama-server-supervisor failures remain unchanged from STATE.md baseline (unrelated to Plan 07-01 / 07-02 scope).

### Task 07-02-04 — `07-VESNA-RESULT.md` authored

Per-probe verdict table, broader regression check, token-budget delta sanity, carve-outs, and SC#1 verdict captured at `.planning/phases/07-p6-framing-rewrite-advisory-voice/07-VESNA-RESULT.md`. Mirrors the shape of `06.5-VESNA-RESULT.md`.

**SC#1 verdict: PASS — 8/8 probes (100% vs ≥80% floor).**

## must-haves checklist

- [x] `src/tests/integration/phase-7-advisory-voice.test.ts` exists, all cases pass green
- [x] `phase-6-5-cross-project-vesna.test.ts` continues to pass 4/4 (no retrieval regression)
- [x] `bun run test src/tests/assembly/` and `src/tests/intelligence/` both green
- [x] `07-VESNA-RESULT.md` records overall ≥80% pass rate (8/8 here) — SC#1 PASS
- [x] Atomic commit lands on master (this plan's deliverables: test file + result md)

## Deviations from Plan

**[Rule 3 - Blocking] ExperiencePattern fixture literal types**
- Found during: Task 07-02-01 (test file authoring).
- Issue: Initial fixture used `severity: 'high'` and `abstraction_level: 'general'`; both are invalid per the `Severity` and `AbstractionLevel` exported unions in `src/intelligence/experience-patterns.ts:85-91`. Type checker would have rejected the file under stricter compile, and TS/vitest test discovery may have surfaced the error.
- Fix: Replaced with valid literals `severity: 'important'` and `abstraction_level: 'tip'` to match the exported unions.
- Files modified: `src/tests/integration/phase-7-advisory-voice.test.ts` (helper `pattern()`).
- Verification: `bun run test src/tests/integration/phase-7-advisory-voice.test.ts` now exits clean with 11/11 PASS.
- Commit: included in this plan's single atomic commit (Plan 02 ships in one piece).

**Total deviations:** 1 auto-fixed (Rule 3 — blocking literal-type mismatch).
**Impact:** None — typo-class fix; advisory-voice probe shape and verdict unchanged.

## Authentication Gates

None — no external services touched.

## Issues Encountered

None.

## Next Phase Readiness

Ready for Plan 07-03 (behavioral A/B scaffold + STATE/ROADMAP/REQUIREMENTS update + phase close).

The advisory-voice rewrite (07-01) and the verification probe (07-02) are both green on disk. Plan 07-03 will (1) ship the loose 1-week behavioral A/B scaffold (markdown checklist for end-of-week perceptual-similarity comparison, no env-flag toggle), (2) update STATE.md / ROADMAP.md / REQUIREMENTS to mark Phase 7 complete, (3) write the phase-close 07-SUMMARY.md.
