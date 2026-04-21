---
phase: 03-p2-directive-detector
plan: 03
subsystem: testing
tags: [fixture, gold-labels, llm-labeling, precision-harness, deepseek]

requires:
  - phase: 03-p2-directive-detector
    provides: regex families + stripCodeBlocks (Plan 03-01) for candidate extraction
provides:
  - `fixture-candidates.jsonl` — 106 regex-pre-filtered candidates across 14 sessions (37–50)
  - `gold-labels.jsonl` — 106 deepseek-v3.2:cloud gold labels (14 human-verified at labeling review)
  - `fixture-sessions.ts` — 14-session ID mapping (curated from 37–50; 51 excluded — zero turns)
  - `build-candidates.ts` — DB scan + regex pre-filter with sanity floor (≥90 or non-zero exit)
  - `label-candidates.ts` — label / list-flagged / review subcommands; resumable via output skip-list; refuses to run if labeler-model == detector-model (self-agreement guard)
  - `apply-review.cjs` — team-lead review application (9 accept, 5 override) with reasoning per row
affects: [03-05 precision harness consumes both JSONL files; 03-06 calibration measured against gold-labels.jsonl]

tech-stack:
  added: []
  patterns:
    - Cross-family labeler (deepseek-v3.2:cloud) vs detector (glm-5.1:cloud) to avoid self-agreement bias
    - Resumable batch LLM labeling via skip-list over existing output rows
    - Sanity floor + non-zero exit enforces corpus-size assumption from RESEARCH §1.2

key-files:
  created:
    - .planning/phases/03-p2-directive-detector/fixtures/fixture-candidates.jsonl
    - .planning/phases/03-p2-directive-detector/fixtures/gold-labels.jsonl
    - src/benchmarks/directive-detector/fixture-sessions.ts
    - src/benchmarks/directive-detector/build-candidates.ts
    - src/benchmarks/directive-detector/label-candidates.ts
    - .planning/phases/03-p2-directive-detector/apply-review.cjs
  modified: []

key-decisions:
  - "Cross-family labeler (deepseek) vs detector (glm) per CONTEXT §Area 4 self-agreement-bias guard"
  - "14 sessions, 526 user turns, 106 candidates — matches RESEARCH §1.2 projection (~105)"
  - "Human verification targeted at labeling-review step (14/106 rows) rather than full re-label"
  - "Overrides tracked in apply-review.cjs with per-row reasoning"

patterns-established:
  - "Labeler model family MUST differ from detector model family (hard-gate in label-candidates.ts)"
  - "Fixture JSONL files are versioned in `.planning` — treat as test fixtures, not code"
  - "Review overrides preserve prior auto-label in git history; apply-review.cjs is the audit record"

requirements-completed:
  - EXTR-03
  - EXTR-04

duration: ~45min (build + label + review)
completed: 2026-04-20
---

# Plan 03-03: Fixture Corpus + LLM Labeling Summary

**14-session × 526-turn fixture with 106 deepseek-v3.2:cloud gold labels (14 human-verified). Cross-family labeler guards against self-agreement bias vs the glm-5.1:cloud detector. Feeds Plan 03-05's precision harness.**

## Performance

- **Completed:** 2026-04-20
- **Tasks:** 3 (build candidates, label via LLM, apply human review)
- **Files created:** 6
- **Rows:** 106 candidates × 106 labels (14 human-verified)

## Accomplishments

- Candidates assembled from sessions 37–50 (session 51 excluded — zero DB turns).
- Regex pre-filter emits 106 rows, matches RESEARCH §1.2 projection (~105).
- Gold labels via deepseek-v3.2:cloud (different family than glm-5.1:cloud detector).
- `label-candidates.ts` resumable and enforces cross-family rule at startup.
- Team-lead review applied 2026-04-20: 9 accepts, 5 overrides, tracked per-row in `apply-review.cjs`.

## Task Commits

1. **Fixture + labeler shipped** — `8402aab` (feat: fixture corpus + LLM labeling harness)
2. **Team-lead review applied** — `93b2913` (docs: 9 accept, 5 override)

## Files Created/Modified

- `.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates.jsonl` — 106 candidates
- `.planning/phases/03-p2-directive-detector/fixtures/gold-labels.jsonl` — 106 gold labels
- `src/benchmarks/directive-detector/fixture-sessions.ts` — 14-session mapping
- `src/benchmarks/directive-detector/build-candidates.ts` — DB scan + regex filter
- `src/benchmarks/directive-detector/label-candidates.ts` — label / list-flagged / review CLI
- `.planning/phases/03-p2-directive-detector/apply-review.cjs` — team-lead override application

## Decisions Made

- 5 team-lead overrides (from 14 human-verified): 4 flipped is_directive→false (task-specific, exploratory questions, system-reminder-wrapped text, one-off task), 1 flipped scope project→universal (mirrors global no-quick-fixes rule).
- Review reasoning persisted in `apply-review.cjs` comments, not a separate ledger.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- Label noise surfaced during 03-06 calibration: the 92 non-human-verified deepseek labels showed measurable noise (over-universalization, hallucinated rationale). Addressed in the 2026-04-21 Option-D audit + user re-label of 12 contested cases.

## Next Phase Readiness

- Fixtures ready for Plan 03-05's precision harness.
- Fixture-v2 follow-up noted in 03-CALIBRATION.md: ±2-turn context window too narrow for rebukes referencing prior-session rules. Not blocking ship.

---
*Phase: 03-p2-directive-detector*
*Completed: 2026-04-20*
