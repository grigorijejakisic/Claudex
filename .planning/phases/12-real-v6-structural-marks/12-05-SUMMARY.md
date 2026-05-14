---
plan: 12-05
phase: 12-real-v6-structural-marks
wave: 3
status: complete
requires: []
provides:
  - lesson-application probe audit (3 probes audited, confirmed genuine)
  - deliberation-engagement → deliberation-pipeline-fanout rename (5 probes)
  - deliberation-agent-engagement new category (3 new probes)
  - ProbeCategory union updated in types.ts, loader.ts, index.ts, cli.ts
affects:
  - Vesna SC#1 ship gate (29/29 probes at 100% after changes)
key_files:
  - src/benchmark/vesna/types.ts
  - src/benchmark/vesna/loader.ts
  - src/benchmark/vesna/index.ts
  - src/benchmark/vesna/cli.ts
  - src/benchmark/vesna/probes/deliberation-pipeline-fanout-{a,b,c,d,e}-001.json
  - src/benchmark/vesna/probes/deliberation-agent-engagement-{001,002,003}.json
---

# 12-05 Summary — Vesna Probe Suite Polishing

## What Was Built

**lesson-application audit result:** All 3 lesson-application probes pass the discriminator test ("if removing the directional language from the artifact makes the probe still pass, it is entity-recall in disguise"). Each probe was confirmed as genuine lesson-application: the directional language is load-bearing for the pass condition.

**deliberation-engagement → deliberation-pipeline-fanout:** The original 5 probes test `## Deliberation Surfaced` markdown (pipeline injection) which is binary and correct for what it tests. The rename makes the test name match the test behavior. Probe IDs updated to `deliberation-pipeline-fanout-{a,b,c,d,e}-001`.

**deliberation-agent-engagement:** 3 new probes test agent BEHAVIOR — does the agent apply the deliberation surface's direction? Not just "did the header appear?":
- `deliberation-agent-engagement-001`: KILL-verdict application — agent must not re-litigate a bound-negative result
- `deliberation-agent-engagement-002`: Methodology critique application — agent must apply the disjoint-pools constraint
- `deliberation-agent-engagement-003`: Config value refusal — agent must surface UNVALIDATED marker and refuse to fabricate

## Vesna Pass Rates Post-Polish

```
entity-recall:                   5/5  (100%)
constraint-recall:                3/3  (100%)
handoff-pickup:                   3/3  (100%)
cross-project:                    3/3  (100%)
lesson-application:               3/3  (100%)
self-instrumented:                4/4  (100%)
deliberation-pipeline-fanout:     5/5  (100%)
deliberation-agent-engagement:    3/3  (100%)
AGGREGATE: 100% — GATED PASS
```

## Decision Notes

1. **ProbeCategory union updated in 4 files** — types.ts, loader.ts, index.ts, cli.ts must stay in sync. The split of `deliberation-engagement` into two distinct categories reflects the name-vs-implementation gap that was documented in the 2026-05-10 probe audit.

2. **lesson-application probes kept as-is** — all three use directional language that is load-bearing for the regex pass condition. None are entity-recall in disguise.

3. **deliberation-agent-engagement probes test the behavioral layer** — pipeline injection (`## Deliberation Surfaced`) and agent engagement are separate phenomena. The original category name promised the latter but tested the former. Both categories now exist and are distinct.
