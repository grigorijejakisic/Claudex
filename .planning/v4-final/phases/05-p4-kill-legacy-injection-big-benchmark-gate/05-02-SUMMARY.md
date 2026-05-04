---
phase: 05-p4-kill-legacy-injection-big-benchmark-gate
plan: "02"
status: complete
completed: 2026-04-29
---

# Plan 05-02 SUMMARY: 3-layer cache-stability harness

## What landed

- `gpt-tokenizer@^3.4.0` added (runtime; pure JS).
- `src/tests/assembly/assembler-cache-fixtures.ts` (NEW): 4 scenario builders + `cleanupFixture` teardown.
- `src/tests/assembly/assembler.cache-stability.test.ts` (NEW): 12 tests = 4 scenarios × 3 layers.

## Per-scenario token baseline (cl100k_base, current cascade)

| Scenario | Tokens | Budget | Layer 2 | Layer 3 |
|----------|--------|--------|---------|---------|
| cold-start | 124 | 500 | ✓ pass | ✓ pass |
| warm-start-with-memory-md | 148 | 500 | ✓ pass | ✓ pass |
| handoff-start | 145 | 500 | ✓ pass | ✓ pass |
| gsd-active-start | 191 | 500 | ✓ pass | ✓ pass |

Layer 2 (byte-identical across runs) and Layer 3 (invariance under clock/session-ID/host-env mutation) are GREEN against the post-Plan-01 codebase. CACH-03 hardening from Plan 01 successfully closes all volatile-state leaks at session-start in these scenarios.

Layer 1 numbers are smaller than the production cascade because the test fixtures don't seed the deletion-target sections (Flow, Reference Layer, Materialization, Predicted Context, etc.) — those need real DB content + heavy artifact rows. The harness is in place; deletion plans 03-05 verify it stays green per tier; Plan 09 flips the strict mode default.

## How Layer 3 works

Each scenario builder returns a fixture whose `run()` reads LIVE `nowEpoch`/`sessionId`/`projectDir` fields. Layer 3:
1. Captures baseline SHA-256 of `assembleFullContext().content`.
2. Mutates `nowEpoch += 100`, swaps `sessionId` to a different UUID, normalizes `projectDir` backslashes to forward slashes.
3. `vi.useFakeTimers()` + `vi.setSystemTime` defenses-in-depth pin the system clock as well.
4. Re-runs `fx.run()` and compares SHA-256 to baseline.

If Layer 2 or 3 fails for a scenario, that's a CACH-03 hardening gap — the cascade is still leaking volatile state somewhere. Plan 01 needs to extend; Plan 02 is not the home for the fix.

## Notes for downstream plans

- Plans 03-05 re-run this suite per tier and record per-scenario token deltas in their gate reports.
- Plan 06 adds `assembler-ups-budget.test.ts` (sibling harness for UPS ≤1KB).
- Plan 09 sets `CLAUDEX_P5_TOKEN_GATE_STRICT=1` in CI and asserts Layer 1 hard.

## Verification

- ✓ `bun run test src/tests/assembly/assembler.cache-stability.test.ts` — 12 pass.
- ✓ `bun run build` — green.
- ✓ `package.json` shows `gpt-tokenizer` dep.
- ✓ Both fixture and test files committed (commit `5918381`).
