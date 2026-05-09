---
phase: 11-polish-land-v6-properly
plan: 06
subsystem: benchmark/deliberation-surfacing
tags: [polish, w3-scaffolding, runQ1, paired-mcnemar, ensemble-orchestration]
requires: [11-01, 11-02, 11-03, 11-04, 11-05]
provides:
  - "runQ1(db, config) orchestration in runner.ts: pre-flight reranker health, paired r1+r2 driver, fallback-rate monitoring, per-judge error tracking with run-level fallback, paired-McNemar verdict computation"
  - "preflightRerankerHealth(fetcher) helper: synthetic POST /rerank at port 7439"
  - "pairReplicationOutcomes(r1, r2) + aggregateJudgeErrors(replications) helpers"
  - "writeQ1Verdict(verdict, outDir) — emits q1-verdict.json for Plan 11-07 gate"
  - "29 regression tests covering all INCONCLUSIVE paths + happy path"
affects:
  - "11-07 (gate-reader consumes q1-verdict.json)"
  - "11-08 (loadAndClassifyPhase11 reads q1-verdict.json + q2/q3 artifacts)"
tech-stack:
  added: []
  patterns:
    - "Pluggable JudgeDispatcher + replicationDriver — production plumbs live cloud endpoints; tests mock at module boundary"
    - "Pre-flight gate failure → INCONCLUSIVE verdict (defensive — never run a measurement on degraded retrieval substrate)"
    - "Mid-run fallback evaluation after r1 — drop high-error judge for r2 before measurement integrity is compromised"
key-files:
  created:
    - "src/tests/benchmark/deliberation-surfacing/runQ1.test.ts (29 tests)"
  modified:
    - "src/benchmark/deliberation-surfacing/runner.ts (runQ1 + helpers + Q2/Q3 gate readers + applyConditionalOutcomes)"
key-decisions:
  - "Engineering-only scope — Plan 11-06 Task 1 lands the orchestration; Task 2 (live ensemble run, 2-4 days compute) remains operator work."
  - "Pluggable replicationDriver lets tests exercise the orchestration end-to-end without live LLM endpoints. Production runs pass a driver that wires the actual judge ensemble + routing layer."
  - "Pre-flight reranker health gate fails closed — without confirmed reranker access the run cannot start. Bi-encoder-only measurements would conflate retrieval quality with engagement quality (CONTEXT § Methodology critique #5)."
  - "OR-aggregation across replications + minimum discordant-pair threshold (5) baked into pairedMcNemar from Plan 11-04. runQ1 inherits both."
requirements-completed: [POLISH-13]
duration: "engineering scaffolding only — Task 1 of plan; Task 2 (live run) remains operator work"
completed: "2026-05-09"
---

# Phase 11 Plan 06: Q1 within-corpus paired-McNemar (engineering scaffolding) Summary

**One-liner:** runQ1 orchestration scaffolding shipped. Live 4-judge ensemble + 2-4 days GPU/cloud compute (Plan 11-06 Task 2) is the operator's run.

**Engineering shipped:** runner.ts gains runQ1 + preflight + pair + aggregate helpers + writeQ1Verdict. 29 regression tests cover every INCONCLUSIVE path (reranker pre-flight fail, missing replicationDriver, probe count != 30, fallback rate >10%, >1 judge error rate >10%) plus the happy-path BIND_POSITIVE.

**Operator-driven work remaining:** Run the live ensemble against the 30 locked probes. Operator-actionable invocation pattern documented in context/handoffs/ACTIVE.md.

**Verification:**
- `bun run build` exits 0
- `bunx vitest run src/tests/benchmark/deliberation-surfacing/runQ1.test.ts` — 29/29 pass
- `bun run vesna` — 26/26 = 100% PASS preserved
- Full suite — 3748 passes / 27 v4-debt failures / 8 skipped — no new regressions

**Deviation:** Plan 11-06 Task 2 (the live run) is intentionally not executed in this session. The single-context budget cannot honestly run 2-4 days of cloud compute against a 4-judge ensemble; attempting so would produce a botched empirical run that corrupts the audit-trail under the "no goalpost shifting" pre-commit. Operator runs Task 2 separately per the resume instructions in ACTIVE.md.

**Next:** Plan 11-07 (Q2 gate-reader + disjoint-pool authoring rules) — also engineering-scaffolding-only; the 60-probe authoring itself is user-pair work per CONTEXT line 108.
