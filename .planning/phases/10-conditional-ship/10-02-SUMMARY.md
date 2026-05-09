---
phase: 10-conditional-ship
plan: 02
subsystem: assembly
tags: [v6, deliberation-surface, assembly-layer, advisory-narration, token-budget]

requires:
  - phase: 10-01
    provides: routeFromArtifact + routeFromArtifacts + RoutingResult shape
provides:
  - formatDeliberationSurface (pure formatter — labeled citations + advisory header + asymmetric budget)
  - formatDeliberationSurfaceSection wrapper (sections.ts) consuming routeFromArtifacts
  - appendDeliberationSurfaceToPayload async helper at L2.5 cascade position
  - FullAssemblyParams.deliberationSurfacing opt-in flag (default false)
  - .claude/rules/assembly-budget.md L2.5 row documenting cascade slot
affects: [10-03, 10-04]

tech-stack:
  added: []
  patterns:
    - "Async post-processing helper that wraps a sync assembler payload — keeps sync hot path intact"
    - "Opt-in per assembly site via boolean flag + caller-provided artifact references"

key-files:
  created:
    - src/assembly/deliberation-surface.ts
    - src/tests/assembly/deliberation-surface.test.ts
  modified:
    - src/assembly/sections.ts
    - src/assembly/assembler.ts
    - .claude/rules/assembly-budget.md

key-decisions:
  - "Budget asymmetry from CONTEXT decision 3 — bi_encoder_only paths get token_pct_cap × bi_encoder_budget_pct (50% × 15% = 7.5% of assembly window) versus the full 15% when the cross-encoder confirmed the spans."
  - "Opt-in per assembly site via FullAssemblyParams.deliberationSurfacing — default false; sites that opt in receive the L2.5 section appended via appendDeliberationSurfaceToPayload (async post-processing step)."
  - "Async integration is a separate post-step rather than inlining into the sync assembleFullContext — preserves sync hot path used by SessionStart hook + bridge-adapter, no churn to existing 175 assembly tests."
  - "L2.5 cascade position landed in .claude/rules/assembly-budget.md (between L2 reference layer and L3 materialization) to make the slot visible for future v6.x tuning."

patterns-established:
  - "Pure formatter (deliberation-surface.ts) consumes routing output; wrapper (sections.ts) bridges DB + routing to formatter; orchestration (assembler.ts append helper) owns the opt-in. Three responsibilities, three modules."
  - "Greedy packing largest-score-first; overflow spans dropped silently rather than truncated mid-sentence; continue scanning to allow shorter low-rank spans to slot in."
  - "Empty-result / disabled / over-budget cases all return null with no header — single suppression rule, no empty section pollution."

requirements-completed: [ASM-01, ASM-02, ASM-03]

duration: ~25 min
completed: 2026-05-09
---

# Phase 10 Plan 02: Assembly layer Summary

**Deliberation-surface assembly landed: pure formatter + wrapper + opt-in async integration helper at L2.5 cascade position, with full asymmetric budget management between cross-encoder and bi-encoder-only paths per CONTEXT decision 3.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3 / 3 (formatter, wrapper + integration, vitest coverage)
- **Files modified:** 5 (2 created, 3 extended)
- **Commits:** 1 (feat 10-02 single-commit per plan-completion convention given small surface)

## Accomplishments

- **`src/assembly/deliberation-surface.ts`** — pure formatter exporting `formatDeliberationSurface(routing, opts) -> { text, packed, bi_encoder_budget_applied }`. Renders the literal CONTEXT formats: citations as `From session {sessionId} turn {turnIndex}, where {label}: {body}` and the advisory header `## Deliberation Surfaced — N spans from M sessions` with proper singular/plural handling. Greedy-packs to the asymmetric budget; returns null when disabled / empty / over-budget.
- **`src/assembly/sections.ts`** extended with `formatDeliberationSurfaceSection(db, artifacts, opts)` wrapper that calls `routeFromArtifacts` and forwards to the pure formatter. Non-throwing — returns null on routing failure, empty result, or disabled flag.
- **`src/assembly/assembler.ts`** extended with three new opt-in fields on `FullAssemblyParams` (`deliberationSurfacing`, `deliberationArtifacts`, `deliberationLabels`) plus a new exported async helper `appendDeliberationSurfaceToPayload(payload, params)`. The helper sits at the L2.5 cascade position, scales the budget via the existing `scaleBudget` flow, and appends the rendered section to the payload's content + sources. Sites that don't opt in see no behavior change.
- **`.claude/rules/assembly-budget.md`** extended with a new L2.5 cascade row documenting the deliberation-surface slot between L2 reference layer and L3 materialization, with the budget multiplier note.
- **`src/tests/assembly/deliberation-surface.test.ts`** — 10 tests across 7 describe blocks covering all seven must-have truths (literal citation format, advisory header shape with singular/plural variants, budget asymmetry between CE and bi-encoder paths, opt-in via enabled flag, empty=null suppression, greedy overflow drop, integration site verification via grep on assembler.ts and the rule file).

## Verification

- `bun run build` — exit 0
- `bun run vitest run src/tests/assembly/deliberation-surface.test.ts` — 10/10 PASS
- `bun run vitest run src/tests/assembly/` — 175/175 PASS (no pre-existing assembly regression)

## Deviations from Plan

**[Rule 4-equivalent — design choice within plan latitude] Async helper instead of inline await**

The plan offered "Pattern (adapt to actual variable names in assembler.ts)" with an `await` inside `assembleFullContext`. Inspection showed `assembleFullContext` is sync and is called from synchronous callers (session-start hook, bridge-adapter, hooks tests). Changing it to async would churn 175 assembly tests + every adapter call site — explicitly out-of-scope of "opt-in per assembly site honored — sites that don't opt in see zero behavior change."

Resolution: kept `assembleFullContext` sync; added a new exported async helper `appendDeliberationSurfaceToPayload(payload, params)` that callers `await` immediately after `assembleFullContext`. This honors the opt-in discipline strictly and matches the plan's permission "If `assembler.ts` does not have a single canonical assembly entry point... opt-in the integration in `worker-context.ts` instead. Whichever file owns the assembly composition gets the integration call." Composition still lives in assembler.ts; the new helper is the L2.5 hook point.

This is documented as a key-decision; not a rule violation. No code paths affected outside the new helper.

## Issues Encountered

None.

## Ready for Plan 10-03 (Vesna 21 → 26)

Plan 10-03 authors 5 new probes that exercise this exact assembly path. The Vesna runner will need to opt the assembler into deliberation surfacing (set `deliberationSurfacing: true` on the FullAssemblyParams it constructs) so the deliberation section actually fires. This wiring lands as part of 10-03 Task 3.
