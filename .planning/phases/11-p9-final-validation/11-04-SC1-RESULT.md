# SC#1 Result — Vesna Probe Suite Pass Rate

**Run date:** 2026-04-30
**Commit:** 60d56e2 (post Plan 11-02/11-03 close)
**Reranker:** cross-encoder (BAAI/bge-reranker-v2-m3 on port 7439, CUDA-accelerated, healthy at run time)
**Verdict:** **PASS** — gated true

## Aggregate

- Total probes: 17 (4 buffer slots intentionally empty per Phase 10 design)
- Passed: 17
- **Aggregate pass rate: 100%**
- Bar: ≥80% — **PASS**

## Per-category pass rates

| Category | Total | Passed | Pass rate | Bar | Verdict |
|---|---|---|---|---|---|
| entity-recall | 3 | 3 | 100% | ≥80% | PASS |
| constraint-recall | 3 | 3 | 100% | ≥80% | PASS |
| handoff-pickup | 3 | 3 | 100% | ≥80% | PASS |
| cross-project | 3 | 3 | 100% | ≥80% | PASS |
| lesson-application | 3 | 3 | 100% | ≥80% | PASS |
| self-instrumented | 2 | 2 | 100% | ≥80% | PASS |
| buffer | 0 | 0 | n/a | exempt | n/a (empty by design) |

**Every non-empty category at 100%.** Per-category bar prevents masking; that bar is also met.

## Per-project pass rates

See `11-04-per-project-verification.md` for explicit decision: the global Vesna run is accepted as per-project evidence because each probe carries its own `source_project` and the runner scopes retrieval to that source. CWD-filtered re-runs are deferred to v4.1 (harness-shape change, out of scope).

## Failing probes

**None.** `failed_probes: []` in the SuiteReport JSON. `flaky_probes: []`.

## Phase 10 baseline cross-reference

Phase 10 closed at 17/17 = 100%. Phase 11 SC#1 measurement against v4 main: 17/17 = 100%. **No regression** from the Phase 10 baseline. Phase 9 deletions and Phase 10 additions did not push retrieval quality.

## Reranker health

```bash
$ curl -s http://localhost:7439/health
{"status":"ok","model":"BAAI/bge-reranker-v2-m3","device":"cuda","gpu":true}
```

Cross-encoder reranker confirmed up and CUDA-accelerated during the SC#1 ship-gate run. No bi-encoder fallback was invoked. Per CLAUDE.md SAFE-08: "BGE-v2-m3 on port 7439 must be alive — Angel's `RerankerSupervisor` spawns and monitors it. Bi-encoder fallback is a degraded mode, not a transparent default." Run was on the load-bearing path.

## Decision

**SC#1 cleared at 100% aggregate AND 100% per non-empty category.** Ready for the v4 ship commit to reference this evidence file.

## Run command

```bash
bun run vesna -- --probes-dir src/benchmark/vesna/probes --json > .planning/phases/11-p9-final-validation/11-04-vesna-report.json
echo "exit:$?"  # → 0 (gated true)
```

Raw report at `.planning/phases/11-p9-final-validation/11-04-vesna-report.json`. Captured during Plan 11-03 SC#4 synthetic-counterpart inspection — reused here because the run is identical and the JSON is canonical.
