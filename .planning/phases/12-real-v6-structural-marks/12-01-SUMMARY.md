---
plan: 12-01
phase: 12-real-v6-structural-marks
status: complete
requires: []
provides:
  - cross-family-wrapper invokeCrossFamily
  - Zod-validated BLOCK/FLAG/SIGNOFF schema
  - retry-once-then-degraded parse failure handling
  - prompt-budget enforcement (32K ceiling)
  - authorship mode pass-through
affects:
  - 12-02 (methodology-critique-gate calls invokeCrossFamily)
  - 12-03 (adversarial-probe-gate calls invokeCrossFamily in authorship mode)
  - 12-CLOSE (external-review-gate dogfood calls invokeCrossFamily)
---

## Key Files

- `src/skills/auto/cross-family-wrapper.ts` — wrapper module (~180 LOC)
- `src/tests/skills/auto/cross-family-wrapper.test.ts` — 10 tests (all pass)

## Verification

- `bun run build` exits 0
- `bun run vitest run src/tests/skills/auto/cross-family-wrapper.test.ts` — 10/10 pass
- `invokeCrossFamily` exported and callable
- Claude excluded as a family — throws on attempted invocation

## Decision Notes

1. "Thin wrapper over existing review skills, not a new pipeline primitive — cuts scope from 600-1000 LOC to ~180 LOC. Gemini invoked via `ollama run gemini-3-flash-preview:cloud` (same pattern as external-review-gate.cjs); Codex via `codex review` with stdin input."
2. "Claude excluded as a family by design — already present as orchestrator + teammates; including Claude would be same-family critique defeating the cross-family premise."
3. "Retry-once-then-degraded: first attempt + one retry with stricter format prompt; after two failures, degraded result with raw_output preserved — no silent swallowing."
4. "Truncation lops newest content first, preserves structured header + artifact under critique — cross-family signal stays anchored to what matters. 32K hard ceiling enforced regardless of caller-specified budget."
