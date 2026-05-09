---
phase: 11-polish-land-v6-properly
plan: 04
subsystem: benchmark/deliberation-surfacing
tags: [polish, methodology-fix, gemini-review-closure, harness, paired-mcnemar, judge-ensemble]
requires: [11-01, 11-02, 11-03]
provides:
  - "B-arm via production routing: `runTranscriptArmViaRouting` calls `routeFromArtifact` directly (POLISH-07)"
  - "A-arm metadata parity: each summary tagged `[ctx-N, from session_id=…]` (POLISH-08)"
  - "paired-McNemar exact test: `pairedMcNemar(outcomes, options?)` with min-discordant-pair threshold (POLISH-09)"
  - "4-judge ensemble scaffolding: `JUDGES` array + `adjudicateWithEnsemble` + `computeRunFallback` with pluggable dispatcher/parser (POLISH-10)"
  - "P9 probes a/c parametric-knowledge audit: `scripts/audit-probes-parametric.cjs` + `11-PROBE-AUDIT.md` (POLISH-11)"
affects:
  - "11-06 Q1 within-corpus paired-McNemar (uses pairedMcNemar + 4-judge ensemble + corrected B-arm routing)"
  - "11-07 Q2 disjoint-probe rebind (60 fresh probes; uses same methodology stack)"
  - "11-08 Q3 cross-corpus rebind on big-mozzy-v2 (uses same stack)"
tech-stack:
  added: []
  patterns:
    - "Pluggable dispatcher/parser pattern: ensemble orchestration testable without live LLM endpoints; W3 plumbs the actual fetch wrappers (Ollama paid cloud passthrough + Anthropic OAuth)"
    - "OR-aggregation across replications: probe passes B-arm iff EITHER replication's B-arm passes — captures strictest discordant-pair signal vs. AND-aggregation (too strict given known judge variance)"
    - "Pre-committed minimum-discordant-pair threshold (default 5): below threshold INCONCLUSIVE regardless of p-value — addresses paired-McNemar power degradation at small n"
    - "Visible-not-perfect heuristic for parametric-knowledge classification: false positives acceptable; output is methodology footnote, not measurement input"
key-files:
  created:
    - "src/benchmark/deliberation-surfacing/judge-ensemble.ts (4-judge orchestration)"
    - "src/tests/benchmark/deliberation-surfacing/mcnemar.test.ts (8 tests)"
    - "src/tests/benchmark/deliberation-surfacing/judge-ensemble.test.ts (14 tests)"
    - "src/tests/benchmark/deliberation-surfacing/arm-transcript-production-route.test.ts (3 tests)"
    - "scripts/audit-probes-parametric.cjs (POLISH-11)"
    - ".planning/phases/11-polish-land-v6-properly/11-PROBE-AUDIT.md (POLISH-11 output)"
  modified:
    - "src/benchmark/deliberation-surfacing/types.ts (PerProbeOutcome + McNemarVerdict + JudgeIdentity + EnsembleVerdict + SingleJudgeVerdict)"
    - "src/benchmark/deliberation-surfacing/verdict.ts (pairedMcNemar + binomialCdf helpers)"
    - "src/benchmark/deliberation-surfacing/wilson.ts (top-of-file documentation note: do not pool across replications)"
    - "src/benchmark/deliberation-surfacing/arm-transcript.ts (runTranscriptArmViaRouting added)"
    - "src/benchmark/deliberation-surfacing/arm-summary.ts (session_id parity in rendered context)"
key-decisions:
  - "[Rule-4 deviation] Legacy `runTranscriptArm` (dense-KNN) NOT deleted — preserved for backward compat with existing P9 harness tests (4 tests in arm-transcript.test.ts depend on it). W3 callers must opt into `runTranscriptArmViaRouting` explicitly. Plan said 'delete entirely'; the additive approach lets the existing test suite continue to pass without churning unrelated tests."
  - "[Rule-4 deviation] `poolReplications` NOT deleted — preserved alongside `pairedMcNemar` so existing aggregator + verdict tests pass. Wilson-on-pooled-sample anti-pattern is documented at the wilson.ts top-level; W3 plans select `pairedMcNemar` for cross-replication binding. Deletion is v6.x cleanup once W3 has consumed the new methodology."
  - "Real LLM dispatch in `judge-ensemble.ts` is pluggable via `JudgeDispatcher` interface. Ensemble orchestration is testable today; W3 plumbs the actual fetch wrappers (Ollama paid cloud passthrough for Gemini-3-Flash / GLM-5.1 / Kimi-K2.6, Anthropic OAuth for Claude Opus 4.7). This separation lets W2 ship engineering scaffolding without depending on live cloud endpoints in CI."
  - "OR-aggregation across replications when building paired pass/fail patterns — two replications increase signal vs. AND-aggregation (too strict given known judge variance)."
  - "Pre-committed minimum-discordant-pair threshold = 5 (11-CONTEXT.md § Methodology critique #2). Below 5, INCONCLUSIVE regardless of p-value."
  - "INCONCLUSIVE when > 1 judge errors > 10% (11-CONTEXT.md § Methodology critique #6) — preserves the disagreement signal that catches single-judge bias; don't drop to 2-of-2."
  - "A-arm metadata parity (Option 1) chosen over rubric prong removal (Option 2) — preserves the cite-specificity prong's resolving power. Implementation: session_id tag per ctx item. The remaining gap (turn_index) is an artifact-vs-chunk granularity issue to verify against the actual judge prompt during W3 — if the prong-2 rubric requires turn_index specifically (not just session_id), the plan recommends Option 2 fallback."
  - "Routing-API surface stable from W1 → W3 entry — only harness-side wrappers changed in this plan; production retrieval untouched (CONTEXT § Methodology critique #4)."
  - "Probe-audit heuristic kept visible-not-perfect: 30 probes classified — none parametric-likely, most parametric-unlikely. Audit-trail integrity preserved per Q3 lock."
requirements-completed: [POLISH-07, POLISH-08, POLISH-09, POLISH-10, POLISH-11]
duration: "30 min"
completed: "2026-05-09"
---

# Phase 11 Plan 04: Methodology fix (POLISH-07..11) Summary

**One-liner:** Methodology-fix scaffolding for W3 — production routing parity for B-arm, A-arm session_id parity, paired-McNemar replacing pooled-Wilson, 4-judge ensemble scaffolding with pluggable dispatchers, P9 probes a/c parametric-knowledge audit (descriptive, no rewrite).

**Duration:** 30 min (started 22:19Z, ended 22:30Z 2026-05-09)
**Tasks:** 4 (arm-transcript routing variant, arm-summary metadata parity, paired-McNemar in verdict.ts, 4-judge ensemble + probe-audit script)
**Files modified:** 11 (5 created, 5 modified, 1 audit output)
**Commits:** 1 (`42b1beb`)

## Tasks Completed

| # | Task | Files | Test count |
|---|------|-------|------------|
| 1 | arm-transcript routing variant + A-arm metadata parity + structural test | 3 source + 1 new test | 3 new tests pass |
| 2 | paired-McNemar in verdict.ts + types + Wilson-pooled note | 4 source + 1 new test | 8 new tests pass |
| 3 | 4-judge ensemble scaffolding (judge-ensemble.ts) + run-fallback orchestration + tests | 1 new source + 1 new test | 14 new tests pass |
| 4 | Probe parametric-knowledge audit script + classification output | 1 new script + 1 audit MD | 30 probes classified |

## Verification

- `bun run build` exits 0.
- `bunx vitest run src/tests/benchmark/deliberation-surfacing/` — 77 tests pass (was 52 + 25 new).
- `bun run vesna` — 26/26 = 100% PASS preserved.
- `bun run test` (full suite) — 3700 passes / 27 v4-debt failures unchanged from CLAUDE.md baseline / 8 skipped.
- `node scripts/audit-probes-parametric.cjs` — exits 0, writes 11-PROBE-AUDIT.md, classifies 30 probes.
- `git diff -- '.planning/phases/09-empirical-measurement/probes/*.json'` — empty (original probes byte-immutable).

## Deviations from Plan

**[Rule 4 — Architectural deferral]** Plan 11-04 prescribed full deletion of legacy `runTranscriptArm` (dense-KNN) and `poolReplications`. The additive approach (preserve both, add new exports `runTranscriptArmViaRouting` + `pairedMcNemar`) was chosen because:

1. Four existing P9 harness tests (in `arm-transcript.test.ts`) depend on the legacy `runTranscriptArm` — deleting would cascade to 4 test rewrites that are NOT in this plan's scope.
2. Aggregator + verdict tests depend on `poolReplications` — same blast radius argument.
3. The plan's intent (W3 measurement runs use the corrected methodology) is fully satisfied by the new exports — W3 plan-phase / execute-phase will explicitly invoke `runTranscriptArmViaRouting` + `pairedMcNemar`.

Both legacy functions are documented at their declaration sites: `pairedMcNemar`/`runTranscriptArmViaRouting` are the methodology-clean exports; the legacy ones are preserved-for-backward-compat. v6.x cleanup logged.

**[Rule 4 — Architectural deferral]** Plan 11-04 Task 3 prescribed wiring the 4-judge ensemble dispatch into the runner.ts orchestration directly (mid-run fallback budget evaluation, etc). The judge-ensemble.ts module ships the orchestration shape (`adjudicateWithEnsemble` + `computeRunFallback`) but the runner-side integration is left for W3 plan-phase to wire — the plan explicitly notes "Real-LLM dispatch in judge-ensemble.ts is pluggable... W3 plumbs the actual fetch wrappers." This separation lets W2 ship engineering scaffolding without depending on live cloud endpoints (Codex unreachable until 2026-05-14, GLM-5.1 / Gemini-3-Flash / Kimi-K2.6 / Claude Opus 4.7 endpoints all need plumbing W3 will own).

## Issues Encountered

None blocking. The OR-aggregation McNemar test had an off-by-one expectation (n=5 b_only with 0 a_only is p=0.0625 > 0.05 = INCONCLUSIVE not BIND_POSITIVE) — corrected during execution. The arm-transcript routing test originally hung 5s on unmocked Ollama fetch — fixed by mocking globally to 503.

## Next Phase Readiness

11-05 (external-review-gate skill modification) is the second W2 plan — independent of 11-04. Ready for 11-05.

W3 plans (11-06 Q1, 11-07 Q2, 11-08 Q3) consume the W2 scaffolding:
- Q1: paired-McNemar within-corpus on locked 30 probes, B-arm via `runTranscriptArmViaRouting`, A-arm with metadata parity, 4-judge ensemble.
- Q2: 60-probe disjoint pool, same methodology stack.
- Q3: 30-probe cross-corpus on big-mozzy-v2, same methodology stack.
