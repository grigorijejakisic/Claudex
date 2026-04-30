# SC#2 Result — Token Budget ≤500 Cache-Stable (3-Layer Test)

**Run date:** 2026-04-30
**Commit:** 79cee63 (post Plan 11-01 close, Phase 10 close + SC#3 PASS)
**Test file:** `src/tests/assembly/assembler.cache-stability.test.ts`
**Verdict:** **PASS** — all 12 sub-tests across 4 scenarios × 3 layers green

## Layer 1 — Token budget (TOK-01)

- Tokenizer: cl100k_base via `gpt-tokenizer`
- Budget: ≤500 tokens

| Scenario | Actual tokens | Budget | Result |
|---|---|---|---|
| cold-start | 124 | 500 | PASS |
| warm-start-with-memory-md | 148 | 500 | PASS |
| handoff-start | 145 | 500 | PASS |
| gsd-active-start | 191 | 500 | PASS |

All scenarios well under the 500-token budget. Headroom: 309 tokens minimum (gsd-active-start).

## Layer 2 — Byte-identical across consecutive runs (CACH-01)

The test runs `fx.run()` twice with identical inputs and asserts `sha256(a.content) === sha256(b.content)`. On a PASS the digests are not printed; on a FAIL the test surfaces both digests + content head for diff. **All 4 scenarios PASS** — every run produces byte-identical output for identical inputs. SHA-256 stability verified.

## Layer 3 — Invariance under volatile-state mutation (CACH-02)

The test computes a baseline SHA-256, then mutates volatile state between runs:
- `nowEpoch += 100s` (clock jump)
- `sessionId` flipped to a different UUID
- `projectDir` slash-style normalized
- `vi.useFakeTimers()` pegs system clock

Asserts the mutated SHA-256 equals the baseline SHA-256 — i.e. volatile state cannot leak into the assembled session-start bytes. **All 4 scenarios PASS**. CACH-02 hardening from Phase 5 Plan 02 holds against the live assembler.

## UPS per-turn payload sanity (INJ-05)

Companion test `src/tests/assembly/assembler-ups-budget.test.ts` exercises the per-turn UPS injection budget (≤1024 bytes). **4/4 PASS** — all scenarios respect the 1KB per-turn cap.

## Phase 8.5 budget snapshot cross-reference

Per the Phase 8.5 close note (STATE.md line referencing `budget 191/500`), the gsd-active-start scenario was at 191/500 at Phase 8.5 close and remains exactly at 191/500 today — confirming Phase 9 deletions and Phase 10 additions did not push the assembler section composition. SC#2 is structurally locked.

## Decision

**SC#2 cleared.** No SC#2 sub-plan needed. Ready for the v4 ship commit to reference this evidence file.

## Test command

```bash
bun run vitest run src/tests/assembly/assembler.cache-stability.test.ts --reporter=verbose
bun run vitest run src/tests/assembly/assembler-ups-budget.test.ts --reporter=basic
```

Both exit 0. Full output captured at `/tmp/sc2-phase-11.log` and `/tmp/sc2-ups-budget.log`.
