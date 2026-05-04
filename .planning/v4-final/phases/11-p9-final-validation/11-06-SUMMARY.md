---
phase: 11
plan: 06
subsystem: benchmark
tags: [vibe-check, archival, non-gating]
requires: ["11-04", "11-05"]
provides: []
affects: []
key-files:
  created:
    - .planning/phases/11-p9-final-validation/11-06-BENCHMARK-VIBE-CHECK.md
  modified: []
key-decisions:
  - Vibe-check accepted via archival cite (LongMemEval 89.6% / LoCoMo 55.5%) — no fresh run for v4 ship
  - Harnesses verified operational; usage path documented for v4.1 archival re-run
  - Per CONTEXT.md generative axiom: benchmarks document, do not gate. No dramatic regression signal — Phase 9-10 deltas don't touch the answer path.
requirements-completed: []
duration: ~2 min
completed: 2026-04-30
---

# Phase 11 Plan 06: Benchmark Archival Vibe-Check (Non-Gating)

Vibe-check accepted via archival cite per CONTEXT.md generative axiom ("benchmarks are an archival vibe-check at ship time, never a gate"). No fresh full-suite re-run required for the v4 ship; harnesses verified operational and ready for v4.1 archival re-run.

## Outcome

| Benchmark | Archival cite | Baseline | Δ | Verdict |
|---|---|---|---|---|
| LongMemEval Oracle | 89.6% (421/470, 2026-04-24, commit 0dd13a9) | 90.6% | -1.0pp | within drift |
| LoCoMo | 55.5% (855/1540, claude-sonnet-4-6) | 55.5% | 0pp | no change (no Phase 9-10 pressure) |

No dramatic regression (>10pp drop) signal. Phase 9 deletions and Phase 10 additions don't touch the harness answer path — RL/CARA/Autonomous-investigator removed are guardian features, Vesna probes are CI-only. The harnesses are operational; v4.1 will own a fresh archival pass.

Evidence: `11-06-BENCHMARK-VIBE-CHECK.md`.

## Self-Check: PASSED

- 11-06-BENCHMARK-VIBE-CHECK.md exists on disk
- Harness availability verified (dist/benchmark/{longmemeval,locomo}-harness.cjs both load and report dataset/embedding-provider OK)
- Archival cites match CLAUDE.md "Benchmarks" section + benchmarks/results/p3-postmigration/longmemeval-oracle.json
- Non-gating posture explicitly restated per CONTEXT.md axiom
