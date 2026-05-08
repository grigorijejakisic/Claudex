---
phase: 07-v4-coexistence-migration-ship
plan: 04
subsystem: validation
tags: [vesna, probes, ship-gates, VAL-01, VAL-03, VAL-04, VAL-05]
requires: [07-01, 07-03]
provides:
  - 3 Vesna probes (episodic-recall-001/002, learnings-injected-guard-001)
  - phase-2-1-kill-regression.test.ts (VAL-03' substrate gate)
  - phase-6-crash-resilience.test.ts (VAL-04 substrate gate)
affects:
  - src/benchmark/vesna/probes/buffer-001.json
  - src/benchmark/vesna/probes/buffer-002.json
  - src/benchmark/vesna/probes/buffer-003.json
  - src/tests/integration/phase-2-1-kill-regression.test.ts
  - src/tests/integration/phase-6-crash-resilience.test.ts
tech-stack:
  added: []
  patterns:
    - "Buffer-slot-claim convention (replace contents in place; remove buffer_placeholder)"
    - "Locked-byte-match aggregator regression test"
key-files:
  created:
    - src/tests/integration/phase-2-1-kill-regression.test.ts
    - src/tests/integration/phase-6-crash-resilience.test.ts
  modified:
    - src/benchmark/vesna/probes/buffer-001.json
    - src/benchmark/vesna/probes/buffer-002.json
    - src/benchmark/vesna/probes/buffer-003.json
key-decisions:
  - "VAL-04 ships at substrate level; Vesna probe deferred to v6+ (no consumer surface yet)"
  - "Optional bun run kill-regression script NOT shipped — vitest assertion is the mandatory form"
  - "Threshold import is LOCKED_DEFAULTS (not DEFAULT_THRESHOLDS as plan suggested) — verified via thresholds.ts source"
requirements-completed:
  - VAL-01
  - VAL-03
  - VAL-04
  - VAL-05
duration: ~15 min
completed: 2026-05-08
---

# Phase 7 Plan 04: Vesna probes + vitest integration tests — Summary

Lands the three new Vesna probes (`episodic-recall-001`, `episodic-recall-002`, `learnings-injected-guard-001`) and the two new vitest integration tests that close out v5's validation surface (VAL-01, VAL-03', VAL-04, VAL-05). Vesna asserts regex-over-`agent_text` from production assembly; vitest asserts substrate-level DB state. Plan 07-05 ships the v5.0.0 tag against this validation surface.

**Duration:** ~15 min
**Tasks:** 6
**Files touched:** 5 (3 probe slots replaced in place, 2 integration tests created)

## Tasks completed

| # | Task | Commit |
|---|---|---|
| 1 | Author episodic-recall-001 (claim buffer-001) | d31f3bc |
| 2 | Author episodic-recall-002 (claim buffer-002) | d31f3bc |
| 3 | Author learnings-injected-guard-001 (claim buffer-003) | d31f3bc |
| 4 | Add phase-2-1-kill-regression integration test (7 cases) | d31f3bc |
| 5 | Add phase-6-crash-resilience integration test (4 cases) | d31f3bc |
| 6 | Run full Vesna + full test suite verification | (verification only) |

## Deviations from Plan

**[Rule 1 - Bug] Threshold import name**
- Found during: Task 5 verification
- Issue: Plan suggested `DEFAULT_THRESHOLDS` from `thresholds.ts`. Actual export is `LOCKED_DEFAULTS`.
- Fix: Use `LOCKED_DEFAULTS` import in phase-6-crash-resilience.test.ts.
- Files modified: src/tests/integration/phase-6-crash-resilience.test.ts (test author choice during execution)
- Verification: 4/4 tests pass

**[Rule 1 - Bug] resolvePid signature**
- Found during: Task 5 verification
- Issue: Plan suggested `resolvePid: () => false`. Actual signature returns `number | null`.
- Fix: Use `resolvePid: () => null` (PID resolution returns null for kill -9 case).
- Verification: 4/4 tests pass

**Total deviations:** 2 auto-fixed bugs in plan-suggested code (R1 each). **Impact:** none — both adapted at write time.

## Verification results

- `bun run build` — clean
- `bun run vesna` — **AGGREGATE: 100% — GATED PASS**, per-category 5+3+3+3+3+4 = **21/21**
- `bun run vitest run src/tests/integration/phase-2-1-kill-regression.test.ts` — 7/7 PASS
- `bun run vitest run src/tests/integration/phase-6-crash-resilience.test.ts` — 4/4 PASS
- `bun run vitest run src/tests/integration/phase-7-learnings-provenance.test.ts` — 4/4 PASS (Plan 07-03 still green)
- `bun run vitest run src/tests/core/migrations-v30.test.ts` — 8/8 PASS (Plan 07-01 still green)
- **Full suite post-merge baseline: 3471 passing / 27 failing / 8 skipped (3506 total).** +11 from this plan's new tests; the 27 pre-existing failures (`llama-client`, `llama-server-supervisor`, `phase-5-full-gate`) persist unchanged. Cite this number in Plan 07-05 as the reference baseline for ship-gate 4.

## Issues Encountered

None blocking. Two minor plan-vs-implementation drifts (threshold name + resolvePid signature) corrected at write time.

## Next Phase Readiness

Wave 4 (Plan 07-05) unblocked. v5 SC gates fully validated at substrate level:
- VAL-01 (SC-V5-1): 2 episodic-recall Vesna probes
- VAL-02 (SC-V5-2): `extraction-deleted-001` (Phase 4) + `learnings-injected-guard-001` + `phase-7-learnings-provenance.test.ts`
- VAL-03' (SC-V5-3'): `phase-2-1-kill-regression.test.ts`
- VAL-04 (SC-V5-4): `phase-6-crash-resilience.test.ts` (substrate level; Vesna deferred to v6+)
- VAL-05 (Vesna update): 18 → 21 GATED PASS at 100%
