---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: w0d
type: execute
wave: 0
depends_on: []
status: FORWARD (pending execution before Waves 2 and 3 dispatch)
files_modified:
  - src/assembly/sections.ts (REFACTOR — split into multiple files)
  - src/assembly/sections/lessons.ts (NEW)
  - src/assembly/sections/codebase-context.ts (NEW)
  - src/assembly/sections/links.ts (NEW)
  - src/assembly/sections/index.ts (NEW — re-exports for compat)
  - src/assembly/assembler.ts (extract inline Codebase Context render at L857 into a function)
  - src/tests/assembly/sections-split.test.ts (NEW — round-trip parity test)
autonomous: true
operator_review_gate: false
requirements: ["w0a auto-commit hooks LIVE (provides safe baseline for refactor)"]
---

# 14-07-w0d — sections.ts split (FORWARD SPEC)

**Status:** Forward work. Pending execution. Must complete before Wave 2 dispatches (5 plans across F/G + H/I/J touch sections.ts; the split eliminates their cross-plan collision risk).

## Objective

`src/assembly/sections.ts` currently exports 28 functions across 1500+ lines. v7.0.0 Waves 2 and 3 collectively add 4 new functions (`formatPendingReviewLinksSection`, `formatProvenanceChainSection`, lessons section trigger-rendering, link-aware inline-expansion) and EXTRACT one currently-inline function (Codebase Context formatter from `assembler.ts:857`). Five plans touch this file; without splitting, /auto-orchestrate workers will collide on shared imports + adjacent edits even with strict function-level ownership.

Split into modular files by concern, eliminating cross-plan collision risk:
- `src/assembly/sections/lessons.ts` — all lesson-related rendering (Learnings, Proven Principles, future link-aware inline-expansion)
- `src/assembly/sections/codebase-context.ts` — Codebase Context surface (extracted from `assembler.ts:857`)
- `src/assembly/sections/links.ts` — link-related rendering (Pending Review Links from 14-07f, Provenance Chain from 14-07g)
- `src/assembly/sections/index.ts` — re-exports for backwards compatibility; downstream callers do not need to change imports

The residual `src/assembly/sections.ts` keeps:
- Session continuity (renderSessionContinuity)
- Recent Frames
- Project Knowledge (P2.7)
- Health surfaces (reranker, substrate, FED)
- Identity + Claudex Ready
- Other existing functions

## Acceptance criteria

- AC-1: New files exist with the documented exports.
- AC-2: `src/assembly/sections/index.ts` re-exports the moved functions so existing imports across the codebase work without modification (zero breakage).
- AC-3: `assembler.ts:857` inline Codebase Context render extracted into `src/assembly/sections/codebase-context.ts`'s exported function; assembler.ts calls the function instead of rendering inline.
- AC-4: Round-trip parity test (`src/tests/assembly/sections-split.test.ts`) — for a representative fixture, `formatLessonsSection` output is byte-equivalent pre/post split; same for all moved functions.
- AC-5: `bun run build` green post-split.
- AC-6: `npx vitest run` full suite green; no regressions.
- AC-7: `bun run vesna` SC#1 PASS 18/18 (session-start surfaces unchanged behaviorally).
- AC-8: Wave 2 (14-07f / 14-07g) and Wave 3 (14-07h / 14-07i / 14-07j) plans updated to reference the new file paths (`src/assembly/sections/lessons.ts` etc.) instead of monolithic `src/assembly/sections.ts`.

## Implementation

1. **Survey** — list all current exports in `src/assembly/sections.ts` (already done in VERIFICATION-PASS Section A2 — 28 functions identified).
2. **Categorize** per the split above.
3. **Move functions** into the new files. Imports from each new file follow the existing pattern (use `from '../../shared/...'` style; bump one directory).
4. **Re-export from `sections/index.ts`** so downstream import paths `from '../assembly/sections.js'` still resolve (via `sections/index.ts` if package.json or tsconfig redirects, OR just keep `sections.ts` as a re-export file).
5. **Extract `assembler.ts:857` inline render** — wrap in `formatCodebaseContextSection(params): string` and call from assembler.ts.
6. **Round-trip parity test** — fixture-based equivalence check.
7. **Update Wave 2 / Wave 3 plan docs** with new file paths.

## Anti-scope

- Do NOT change function signatures during the move (signature-preserving refactor only).
- Do NOT add new functions during the move (Wave 2 + 3 plans add them after this lands).
- Do NOT change assembler cascade order.
- Do NOT touch session-start budget computations.
- Do NOT change rendering behavior (round-trip parity is the gate).

## Risks

- **Risk 1: import-cycle introduction.** Splitting could create circular imports if functions in different new files cross-reference. Mitigation: pre-survey internal dependencies; if cycle detected, fall back to a single `sections/internal.ts` for shared helpers.
- **Risk 2: existing callers across the codebase use `from '../assembly/sections.js'` imports.** Mitigation: re-export from a thin `sections.ts` or `sections/index.ts` so caller imports don't change.
- **Risk 3: tests fail because fixtures referenced the inline assembler.ts:857 logic.** Mitigation: round-trip parity test catches this; tests passing pre/post split is the gate.

## Operator approval

Operator-approved 2026-05-16 16:21 as Wave 0 pre-work for v7.0.0's sections.ts collision risk.
