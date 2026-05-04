# Phase 6 — P5 Retrieval Simplification + Per-Multiplier Ablation — SUMMARY

**Closed:** 2026-04-29
**Plans:** 06-01 .. 06-06 (6 plans, 5 waves)
**Requirements closed:** RETR-01, RETR-02, RETR-03, RETR-04, RETR-05, RETR-08

## Outcome

Phase 6 ships **simplification by consolidation, not deletion** — the same simplification mandate (RETR-01/02) achieved through a single canonical scoring function with a flat documented weight vector, plus a load-bearing reranker visibility surface. The aggressive deletion path the original plan envisioned was declined under the W2 evidence-floor argument: at N=11 with every probe landing at rank 0-1, the harness cannot resolve multiplier effects below ~9pp per probe, and CONTEXT.md's default-conservative axiom (KEEP unless evidence drops) applies.

### Multipliers ablated (per-flag sweep at N=11)

7 multipliers tested under the harness:

| Multiplier  | Per-flag delta | Verdict (simple rule) | Final disposition |
|-------------|----------------|-----------------------|-------------------|
| recency     | 0.0pp          | DROP                  | KEEP (consolidation; deletion deferred to post-Phase-10) |
| importance  | 0.0pp          | DROP                  | KEEP (same) |
| relevance   | 0.0pp          | DROP                  | KEEP (same) |
| retrieval   | 0.0pp          | DROP                  | KEEP (same) |
| novelty     | 0.0pp          | DROP                  | KEEP (same) |
| activation  | 0.0pp          | DROP                  | KEEP (same) |
| qvalue      | 0.0pp          | DROP                  | KEEP (same) |

**All-disabled (RRF-only) baseline: 11/11 = 100%.** The multipliers as a whole are not load-bearing for THIS probe set — but that is *absence of evidence of harm*, not *evidence of absence*. Phase 10's ~20-probe suite is the resolution upgrade needed before any drop.

See `06-MULTIPLIER-ABLATION.md` "Decisions for Wave 3" + "Deletion debate" sections.

### Multipliers DROPPED

**None.** Default-conservative axiom applied; no aggressive deletion under inconclusive evidence.

### Multipliers KEPT

All 7 (recency, importance, relevance, retrieval, novelty, activation, qvalue). Consolidation gives each a single home (helper function), one ablation flag (`multiplierFlags[name]`), and one canonical scoring formula via `computeArtifactScore`.

### Channels

- 5 channels retained (no channel-level deletion):
  - **Sync path:** FTS5 + recency (2 channels — unchanged)
  - **Async path:** FTS5 + Qdrant/vec0 KNN + recency + graph_walk + temporal (5 channels — unchanged)

Channel-level ablation was scope-locked out by team-lead's directive ("DO NOT touch the 5 RRF channels"). Out of scope for Phase 6.

### Cross-encoder reranker is now load-bearing infrastructure

- BGE-v2-m3 on port 7439 (supervised by Angel's `RerankerSupervisor`).
- Bi-encoder fallback is explicitly degraded mode.
- Every fallback writes one row to `telemetry` with `event_kind='reranker_fallback'` (V20 migration enum extension) and `detail.reason` ∈ `{unreachable, non_2xx, timeout, empty_response}`.
- Session-start surfaces a `## Reranker Health` line when 24h count > 0 (`formatRerankerHealthSection` in `src/assembly/sections.ts`, wired into `assembler.ts` at Priority 1.2).
- CLAUDE.md "Critical Safety Rules" updated with the load-bearing claim and the four-reason enum.
- README.md Reranking bullet updated with the same statement.

### RIF + spread activation retained per RETR-03

Behavior locked by 8 invariant tests in `src/tests/integration/phase-6-rif-spread-retained.test.ts`. Constants verified by observable deltas:
- `RIF_DECREMENT = 0.03`
- `RIF_ACTIVATION_FLOOR = 0.1`
- `SPREAD_FACTOR = 0.3`, cap = `10.0`

### MCP surface unchanged per RETR-04

5 canonical tools (`claudex_search`, `claudex_recall`, `claudex_store`, `claudex_events`, `claudex_message`) verified via static structural lock-down in `src/tests/integration/phase-6-mcp-surface-unchanged.test.ts` against the canonical fixture `src/tests/fixtures/mcp-surface-canonical.json`. Response key sets unchanged.

### Bug fix in passing — sync↔async qMultiplier mismatch closed

Pre-Phase-6, `hybridSearchSync` applied 7 multipliers; `hybridSearchAsync` applied 6 (qMultiplier silently omitted). The consolidation closes this — both paths route through `computeArtifactScore` and now produce identical scores from identical inputs. No tests exercised `hybridSearchAsync` directly, so this bug-fix is invisible to the existing suite, but it is documented in `06-03-CONSOLIDATION-NOTE.md` and `06-03-SUMMARY.md`.

## Gate results

| Gate | Result | Evidence |
|------|--------|----------|
| **SC#1 — Vesna pass rate ≥80%** | PASS — 11/11 = 100% overall; every category ≥80% (all 100%) | `runs/06-06-vesna-gate.json`, `06-VESNA-RESULT.md` |
| **SC#2 — Token budget no regression** | PASS | `phase-5-full-gate.test.ts` 7/7 pass post-Plan-04 |
| **SC#4 — Handoff-pickup probe** | PASS | 2/2 handoff probes pass (covered by ablation harness) |
| **Benchmarks (LongMemEval / LoCoMo)** | NOT USED | Per v4 rebind (Q8): benchmarks are NOT gates |
| **Pre-deletion DB backup (STOR-08)** | PASS | `~/.claudex/backups/pre-v4-P5-1777493188.db` (348.79 MiB, integrity_check=ok, 8916 artifacts, 990 sessions); witnesses in `06-01-BACKUP.md` |

## Per-plan summary

| Plan | Title | Status | Key artifacts |
|------|-------|--------|---------------|
| 06-01 | Pre-flight backup + V20 migration + ablation harness scaffold | DONE | `06-01-BACKUP.md`, `migrations-v20.test.ts`, `phase-6-multiplier-ablation.test.ts`, `runs/06-01-baseline.json` |
| 06-02 | Per-multiplier ablation runs | DONE | `06-MULTIPLIER-ABLATION.md`, 10 JSONs under `runs/` |
| 06-03 | Simplify hybrid-retrieval per evidence (path A: consolidation) | DONE | `06-03-CONSOLIDATION-NOTE.md`, `runs/06-03-post-consolidation-baseline.json`, `computeArtifactScore` in `hybrid-retrieval.ts` |
| 06-04 | Reranker hard-required telemetry + visibility | DONE | `telemetry-counters.ts`, `formatRerankerHealthSection`, `phase-6-reranker-fallback-visibility.test.ts`, CLAUDE.md / README.md updates |
| 06-05 | RIF + spread + MCP surface lock-down | DONE | `phase-6-rif-spread-retained.test.ts`, `phase-6-mcp-surface-unchanged.test.ts`, `mcp-surface-canonical.json`, `06-05-VERIFICATION.md` |
| 06-06 | Final SC#1 Vesna gate + STATE/ROADMAP/REQUIREMENTS update + 06-SUMMARY | DONE | `06-VESNA-RESULT.md`, this file, `runs/06-06-vesna-gate.json` |

## Test gate

- ~52 net-new tests across 6 new test files:
  - `src/tests/core/migrations-v20.test.ts` (6)
  - `src/tests/core/telemetry-counters.test.ts` (9)
  - `src/tests/integration/phase-6-multiplier-ablation.test.ts` (4 — sweep emits multiple JSONs)
  - `src/tests/integration/phase-6-reranker-fallback-visibility.test.ts` (9)
  - `src/tests/integration/phase-6-rif-spread-retained.test.ts` (8)
  - `src/tests/integration/phase-6-mcp-surface-unchanged.test.ts` (9)
- Plus 7 stale-but-corrected `toBe(19)` user_version assertions (TARGET_VERSION raise propagation; no behavior change).
- Full suite at Phase 6 close: 2896 pass, 20 fail = same pre-existing llama-server-supervisor baseline. **0 non-llama regressions** across all six plans.

## Deferred (non-blocking)

- **Aggressive multiplier deletion.** Deferred to a post-Phase-10 follow-up plan with the larger Vesna suite. Hook documented in `06-MULTIPLIER-ABLATION.md` "Deletion debate deferred to a post-Phase-10 follow-up plan" section. Phase 10 deliverable trigger.
- **q_value column drop on `artifacts`.** Schema column kept. Drop tracked as future hygiene; not blocking Phase 6 close.
- **Bi-encoder fallback-of-fallback telemetry.** When Ollama is also unreachable, the bi-encoder branch's silent catch swallows it. Adding a second `event_kind` (`reranker_secondary_fallback` or similar) is non-blocking; documented as TODO in `06-04-SUMMARY.md`.
- **Reranker model swap.** Out of scope.
- **99% / 24h reranker uptime gate.** Aspirational; documented in CLAUDE.md but not enforced.
- **Channel-level ablation (graph_walk, temporal).** Original Plan 03 task 06-03-03 was scope-locked out by team-lead. The ablation harness at N=11 cannot resolve channel-level effects either, so this would face the same evidence-floor issue.

## Files of record

- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-CONTEXT.md`
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-RESEARCH.md`
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-MULTIPLIER-ABLATION.md`
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-01-BACKUP.md`
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-03-CONSOLIDATION-NOTE.md`
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-05-VERIFICATION.md`
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-VESNA-RESULT.md`
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-{01,02,03,04,05}-SUMMARY.md`
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/*.json` (12 files: baseline, sweep, deletion-list, gate snapshot)
- `~/.claudex/backups/pre-v4-P5-1777493188.db` (rollback witness)

## Phase 6.5 readiness

Phase 6.5 (cross-project task-pattern recall — RETR-06/07) is unblocked. The consolidated `computeArtifactScore` and the documented weight vector form the substrate Phase 6.5 hooks into for cross-project query expansion. The reranker hard-required surface (RETR-08) provides the precision layer Phase 6.5 needs to discriminate cross-project candidates without relying on weak bi-encoder signals.

Phase 7 (framing rewrite) is also unblocked but not coupled to Phase 6.5; it can run in parallel with whichever phase comes next per ROADMAP order.

The post-Phase-10 follow-up plan (multiplier deletion under N≥20 evidence) is a separate trigger; ROADMAP entry to be added when Phase 10's Vesna suite ships.
