---
plan: 12-02
phase: 12-real-v6-structural-marks
wave: 2
status: complete
requires: [12-01]
provides:
  - runMethodologyCritiqueGate export
  - tag-triggered methodology critique before phase plan pre-commitment
  - BLOCKED/PROCEED/PROCEED_WITH_ANNOTATION verdict routing
affects:
  - 12-09 wires this into auto-plan-phase skill via patch document
key_files:
  - src/skills/auto/methodology-critique-gate.ts
  - src/tests/skills/auto/methodology-critique-gate.test.ts
---

# 12-02 Summary — Methodology Critique Gate

## What Was Built

`src/skills/auto/methodology-critique-gate.ts` exports `runMethodologyCritiqueGate(planContent, options)`. The gate calls `invokeCrossFamily` in `mode: 'review'` against the methodology/architecture section of a phase plan when the plan's frontmatter contains any of: `architecture`, `workflow`, `methodology` tags.

## Decision Notes

1. **Tag-trigger on architecture/workflow/methodology only** — engineering-only phases are exempt by default, preventing noise on routine bug fixes. Only phases with explicit methodology/architecture scope warrant cross-family critique.

2. **BLOCKED requires severity='critical' + verdict='BLOCK'** — FLAG and major findings are PROCEED_WITH_ANNOTATION (real signal, not a blocker); SIGNOFF is PROCEED. This mirrors Phase 11's external-review-gate.cjs routing logic for consistency.

3. **Degraded family → PROCEED_WITH_ANNOTATION, not BLOCKED** — single clean family is partial-but-real signal per 12-CONTEXT.md Q1 calling-skill policy. A degraded cross-family reviewer does not invalidate the gate; it annotates the limitation.

4. **Critique prompt targets the four historical failure modes** — measurement-path mismatch (harness B-arm vs production), pseudoreplication (pooled r1+r2 as independent samples), same-family judge (self-grading bias), decision-rule post-hoc commitment. These are the exact errors that produced the v6.0.0 +0.0038 Wilson overbind.

## Tests

7 tests pass: trigger detection (tag-based + force flag), BLOCKED/PROCEED/PROCEED_WITH_ANNOTATION routing, degraded-family annotation. All tests use mocked `invokeCrossFamily`.
