---
plan: 12-03
phase: 12-real-v6-structural-marks
wave: 2
status: complete
requires: [12-01]
provides:
  - requestAdversarialProbes export
  - cross-family adversarial test authoring in mode=authorship
  - .adversarial.test.ts naming convention (audit-trail load-bearing)
affects:
  - 12-09 wires this into auto-plan-phase skill via patch document
key_files:
  - src/skills/auto/adversarial-probe-gate.ts
  - src/tests/skills/auto/adversarial-probe-gate.test.ts
---

# 12-03 Summary — Adversarial Probe Gate

## What Was Built

`src/skills/auto/adversarial-probe-gate.ts` exports `requestAdversarialProbes(planContent, taskDescription, options)`. The gate calls `invokeCrossFamily` in `mode: 'authorship'` to request cross-family agents to write vitest tests that a same-family agent would not have written. Adversarial probe files are written to `<testFilePath-basename>.<family>-adversarial.test.ts` alongside the same-family test, both runnable via `bun run test`.

## Decision Notes

1. **Naming convention is load-bearing for audit trail** — `<basename>.<family>-adversarial.test.ts` lets reviewers identify which tests were authored by a cross-family agent at a glance. The convention must not be changed without updating the audit spec.

2. **Both layers run in `bun run test`** — adversarial probes are not a separate gate but part of the full test suite. This ensures adversarial coverage is not bypassed in CI.

3. **BLOCKED (family refused) → gate records absence in SUMMARY; PARTIAL (one family degraded) → probes from clean family ship; PRODUCED → both families shipped probes.** Degraded family is not a hard blocker — single clean family provides partial coverage.

4. **Authorship prompt explicitly names the v5.0.1 silent-fail pattern** — instructs the cross-family agent to author tests that catch what the same-family agent would miss, not duplicate the happy-path coverage. The root cause being addressed: same-family agents wrote both the silent-failure code AND the tests asserting "should not throw" on it.

## Tests

5 tests pass: authorship-mode invocation, file naming convention (`routing.gemini-adversarial.test.ts`), two-family file separation, degraded-family PARTIAL verdict, all-blocked BLOCKED verdict.
