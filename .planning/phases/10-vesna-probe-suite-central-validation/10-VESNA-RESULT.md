# Phase 10 Vesna Result

**Run date:** 2026-04-30
**Trigger:** Phase 10 close (Plan 10-05 verification)
**Trials per probe:** 3 (default)
**Reranker:** unavailable in this run; harness uses sync retrieval (FTS5 + recency)

## Result

```
exit 0
gated: true
aggregate_pass_rate: 100%
flaky_probes: 0
failed_probes: 0
```

## Per-Category

| Category | Passed | Total | Flaky | Pass rate |
|---|---|---|---|---|
| entity-recall | 3 | 3 | 0 | 100% |
| constraint-recall | 3 | 3 | 0 | 100% |
| handoff-pickup | 3 | 3 | 0 | 100% |
| cross-project | 3 | 3 | 0 | 100% |
| lesson-application | 3 | 3 | 0 | 100% |
| self-instrumented | 2 | 2 | 0 | 100% |
| buffer | 0 | 0 | 0 | (excluded — placeholder slots) |

## Verdict

**SC#1 floor (≥80% aggregate AND ≥80% per non-empty category):** PASS at 100%/100%.

Phase 10 ships the surface; Phase 11 runs the gate. This phase-close result
is recorded for archival and to satisfy Plan 10-05 task 3's "Step 1 — Run
the full suite locally and capture the report" expectation.
