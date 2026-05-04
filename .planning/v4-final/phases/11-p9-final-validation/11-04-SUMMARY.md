---
phase: 11
plan: 04
subsystem: benchmark/vesna
tags: [sc1, ship-gate, vesna, behavioral]
requires: ["11-01", "11-02", "11-03"]
provides: []
affects: []
key-files:
  created:
    - .planning/phases/11-p9-final-validation/11-04-SC1-RESULT.md
    - .planning/phases/11-p9-final-validation/11-04-per-project-verification.md
  modified: []
key-decisions:
  - SC#1 cleared at 100% aggregate AND 100% per non-empty category — no regression from Phase 10 baseline
  - Cross-encoder reranker healthy on port 7439 at run time (no bi-encoder fallback invoked)
  - Per-project CWD-scoped re-runs deferred to v4.1 (harness shape change); global run accepted as per-project evidence per Plan 11-04 explicit decision path
requirements-completed:
  - VESN
duration: ~5 min (run was ~30s; result file authoring main work)
completed: 2026-04-30
---

# Phase 11 Plan 04: SC#1 Vesna Full Suite + Per-Project Verification

SC#1 — Vesna behavioral probe suite — cleared at the v4 ship gate.

## Outcome

| Metric | Value |
|---|---|
| Aggregate pass rate | 100% (17/17) |
| Every non-empty category | 100% |
| Failing probes | 0 |
| Flaky probes | 0 |
| Reranker | cross-encoder, healthy on 7439 (CUDA) |
| Phase 10 baseline | 17/17 = 100% — **no regression** |

Evidence: `11-04-SC1-RESULT.md` + raw `11-04-vesna-report.json`.

## Self-Check: PASSED

- 11-04-SC1-RESULT.md, 11-04-per-project-verification.md, 11-04-vesna-report.json all exist on disk
- `bun run vesna` exits 0 (gated true)
- Reranker confirmed up via `curl http://localhost:7439/health`

## Next

Wave 3: Plan 11-05 (STOR-04 zero-caller audit + V24 drop-or-defer).
