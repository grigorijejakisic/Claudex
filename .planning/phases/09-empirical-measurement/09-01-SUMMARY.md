---
phase: 09-empirical-measurement
plan: 01
subsystem: empirical-fixtures
tags: [v6, p9, empirical, drift-detection, pre-commitment, zod]
requires: []
provides: [ProbeSchema, Probe type, DriftKind, loadProbe, loadAllProbes, PROBES_DIR, judge-prompt.md, 30 fixture JSONs, 4 synthetic transcripts]
affects: [09-02, 09-03, 09-04]
tech-stack:
  added: []
  patterns: [zod-schema-as-runtime-gate, locked-fixture-set, real-vs-synthetic-cap, pre-commitment-audit-anchor]
key-files:
  created:
    - src/benchmark/deliberation-surfacing/probe-schema.ts
    - src/tests/benchmark/deliberation-surfacing/probe-schema.test.ts
    - .planning/phases/09-empirical-measurement/probes/README.md
    - .planning/phases/09-empirical-measurement/judge-prompt.md
    - .planning/phases/09-empirical-measurement/probes/drift-a-01.json
    - .planning/phases/09-empirical-measurement/probes/drift-a-02.json
    - .planning/phases/09-empirical-measurement/probes/drift-a-03.json
    - .planning/phases/09-empirical-measurement/probes/drift-a-04.json
    - .planning/phases/09-empirical-measurement/probes/drift-a-05.json
    - .planning/phases/09-empirical-measurement/probes/drift-a-06.json
    - .planning/phases/09-empirical-measurement/probes/drift-b-01.json
    - .planning/phases/09-empirical-measurement/probes/drift-b-02.json
    - .planning/phases/09-empirical-measurement/probes/drift-b-03.json
    - .planning/phases/09-empirical-measurement/probes/drift-b-04.json
    - .planning/phases/09-empirical-measurement/probes/drift-b-05.json
    - .planning/phases/09-empirical-measurement/probes/drift-b-06.json
    - .planning/phases/09-empirical-measurement/probes/drift-c-01.json
    - .planning/phases/09-empirical-measurement/probes/drift-c-02.json
    - .planning/phases/09-empirical-measurement/probes/drift-c-03.json
    - .planning/phases/09-empirical-measurement/probes/drift-c-04.json
    - .planning/phases/09-empirical-measurement/probes/drift-c-05.json
    - .planning/phases/09-empirical-measurement/probes/drift-c-06.json
    - .planning/phases/09-empirical-measurement/probes/drift-d-01.json
    - .planning/phases/09-empirical-measurement/probes/drift-d-02.json
    - .planning/phases/09-empirical-measurement/probes/drift-d-03.json
    - .planning/phases/09-empirical-measurement/probes/drift-d-04.json
    - .planning/phases/09-empirical-measurement/probes/drift-d-05.json
    - .planning/phases/09-empirical-measurement/probes/drift-d-06.json
    - .planning/phases/09-empirical-measurement/probes/drift-e-01.json
    - .planning/phases/09-empirical-measurement/probes/drift-e-02.json
    - .planning/phases/09-empirical-measurement/probes/drift-e-03.json
    - .planning/phases/09-empirical-measurement/probes/drift-e-04.json
    - .planning/phases/09-empirical-measurement/probes/drift-e-05.json
    - .planning/phases/09-empirical-measurement/probes/drift-e-06.json
    - .planning/phases/09-empirical-measurement/probes/synthetic-transcripts/drift-c-05.jsonl
    - .planning/phases/09-empirical-measurement/probes/synthetic-transcripts/drift-c-06.jsonl
    - .planning/phases/09-empirical-measurement/probes/synthetic-transcripts/drift-d-05.jsonl
    - .planning/phases/09-empirical-measurement/probes/synthetic-transcripts/drift-d-06.jsonl
key-decisions:
  - "Fixture taxonomy locked at 5 kinds × 6 fixtures = 30 probes. Real ≥4 / synthetic ≤2 per kind enforced via vitest. Per-kind realized: a=6/0, b=5/1, c=4/2, d=4/2, e=6/0."
  - "Zod ProbeSchema is the runtime gate — malformed fixtures throw at load time. loadAllProbes returns exactly 30 typed Probe objects."
  - "Judge prompt locked verbatim per CONTEXT decision 1 — three-prong rubric (surfaces-divergence, cites-specifically, concludes-engagement). Byte-immutable for P9 binding replications."
  - "Synthetic fixtures (4 total: c-05, c-06, d-05, d-06) use deterministic synthetic-{id} session IDs; plan 09-04 ingests the JSONL transcripts into transcript_chunk_v6 to satisfy B-arm anchor lookups."
  - "Pre-commitment audit anchor: this commit's git timestamp + 09-CONTEXT.md commit (00ab2bb) must precede every aggregator row appended in plan 09-04."
requirements-completed: [ENG-01 (partial — pass_criterion locked per fixture; cross-cutting decision rule lands in 09-03's verdict module), ENG-02]
duration: 12 min
completed: 2026-05-08
---

# Phase 9 Plan 01: Pre-commitment artifacts (probes + judge + Zod gate) Summary

30 drift-detection probe fixtures (5 kinds × 6) plus the LLM-as-judge prompt template plus the runtime Zod schema land as the methodology-gate pre-commitment artifacts. The fixture set is byte-frozen for P9 binding replications; the judge prompt is byte-immutable for the same window. ProbeSchema enforces the JSON shape at every harness load, so plan 09-02's harness cannot consume malformed input.

Real-vs-synthetic ratio enforced by vitest: every kind has ≥4 real fixtures and ≤2 synthetic fixtures. Real fixtures are anchored to actual claudex-v3 session JSONLs (Phase 2 KILL deliberation, Mem0-trap closure, view-mode silent-fail, Critical-Reminders Session 44, etc.); synthetic fixtures (kinds c and d only — 4 total) get author-committed JSONL transcripts that plan 09-04 ingests with synthetic session IDs.

## Files

**Created (40 total):**
- `src/benchmark/deliberation-surfacing/probe-schema.ts` (Zod schema + loaders).
- `src/tests/benchmark/deliberation-surfacing/probe-schema.test.ts` (5 tests, all pass).
- `.planning/phases/09-empirical-measurement/probes/README.md` (directory contract).
- `.planning/phases/09-empirical-measurement/judge-prompt.md` (locked three-prong rubric).
- 30 × `.planning/phases/09-empirical-measurement/probes/drift-{a..e}-{01..06}.json`.
- 4 × `.planning/phases/09-empirical-measurement/probes/synthetic-transcripts/drift-{c-05, c-06, d-05, d-06}.jsonl`.

## Verification

- `bun run build` — exits 0.
- `bun run vitest run src/tests/benchmark/deliberation-surfacing/probe-schema.test.ts` — 5/5 tests pass.
- `ls .planning/phases/09-empirical-measurement/probes/drift-*.json | wc -l` → 30.
- ProbeSchema rejects malformed input (negative test passes).

## Deviations from Plan

None — plan executed exactly as written. Real-fixture session IDs were resolved via direct grep of `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/*.jsonl`; turn_index_range placeholders (`[0, 0]`) are explicit per the plan's "if exact-turn resolution requires reading the JSONL — plan 09-04 can refine via metadata-augmented anchor lookup, but this plan's fixture must commit a concrete value" guidance.

## Issues Encountered

None.

## Next Phase Readiness

Ready for plan 09-02 — harness scaffolding can now import `ProbeSchema`, `loadAllProbes`, and the locked judge prompt. The wave-2 dependency on 09-01 is satisfied.
