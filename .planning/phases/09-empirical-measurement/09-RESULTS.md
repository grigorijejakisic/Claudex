# Phase 9: Empirical Measurement — Results

**Status:** Bound POSITIVE
**Bound on:** 2026-05-09
**Aggregator entries:** `9-r1`, `9-r2`, `9-pooled-r1+r2` in `.planning/aggregates/deliberation-surfacing.json`
**Run report:** `context/measurements/2026-05-09-deliberation-surfacing.md`

## Pooled Verdict

**POSITIVE** at n=60, Δ CI [+0.0038, +0.3434].

Wilson lower bound > 0 → the pooled-cross-replication delta of `transcript_pass_rate − summary_pass_rate` is statistically distinguishable from zero at 95% confidence. Per CONTEXT decision 4 (locked before measurement, audit-anchored at 09-CONTEXT.md commit `00ab2bb`), this binds POSITIVE: verbatim transcript context produces measurably more deliberation-conditional engagement than summary-only context at our scale.

The lower bound is tight (+0.0038) — the bind is barely above zero, not a strong-positive signal. The methodology gate fired honestly: individual replications at n=30 were both INCONCLUSIVE (CI brackets zero), but pooling at n=60 narrowed the CI enough to clear zero. This matches the locked discipline exactly — the pooled cross-replication verdict is the gate, not per-replication outcomes.

**P10 engineering branch unlocked:** routing + assembly integration (transcript span citations into production retrieval), Vesna probe extension from 21 → 24+ deliberation-engagement probes, and v6.0.0 tag with the bind narrative leading the annotation.

## Per-Replication Verdicts

| Replication | n | Summary pass | Transcript pass | Δ pass rate | Δ CI lower | Δ CI upper | Verdict | Retrieval baseline |
|-------------|---|--------------|-----------------|-------------|------------|------------|---------|--------------------|
| r1          | 30 | 14           | 18              | +0.1333     | -0.0920    | +0.3799    | INCONCLUSIVE | bi_encoder_fallback |
| r2          | 30 | 15           | 21              | +0.2000     | -0.0149    | +0.4456    | INCONCLUSIVE | bi_encoder_fallback |
| **pooled**  | **60** | **29**       | **39**          | **+0.1667** | **+0.0038** | **+0.3434** | **POSITIVE** | bi_encoder_fallback |

Both replications used the bi-encoder fallback retrieval baseline because P9 reranker-fitness re-check (post-backfill) reported mean top-3 overlap 56.0% (n=47) — below the 60% threshold from CONTEXT decision 4's branch-selection rule. The cross-encoder is alive (BGE-v2-m3 on port 7439, CUDA, GPU) but its top-3 stability against the bi-encoder on transcript-distribution data is below the fitness threshold. Per the locked rule, that selects bi-encoder-only for the binding baseline.

r1 and r2 verdicts being INCONCLUSIVE individually is consistent with the small per-replication n; pooling absorbs the per-replication variance into a tighter CI as designed.

## Per-Kind Descriptive Breakdown (NOT a gate)

CONTEXT additional_locks rules out per-kind binding: "the pooled cross-kind verdict is the gate." Per-kind metrics are descriptive-only (`descriptive_only: true` tagged in code). Reading them as ship-blocking is methodology drift.

| Kind | Description | Summary pass rate | Transcript pass rate | Δ |
|------|-------------|-------------------|----------------------|---|
| a    | sample-size shift            | 0.500 | 0.500 | 0.000 |
| b    | threshold-source drift       | 0.167 | 0.583 | +0.417 |
| c    | scope-change drift           | 0.583 | 0.583 | 0.000 |
| d    | dependency-change drift      | 0.583 | 0.833 | +0.250 |
| e    | assumption drift             | 0.583 | 0.750 | +0.167 |

The pooled positive bind is driven primarily by kind b (threshold-source drift, Δ=+0.417), with moderate contributions from kind d (dependency-change, +0.250) and kind e (assumption drift, +0.167). Kinds a (sample-size) and c (scope-change) show flat per-kind delta — neither arm gained nor lost ground on those. This is informational color for P10 engineering branch's routing/assembly tuning; it does not affect the ship gate.

## Methodology-Gate Audit

CONTEXT additional_locks: every aggregator row's `started_at_iso` MUST be strictly greater than the 09-CONTEXT.md commit timestamp (commit `00ab2bb`).

| Anchor | Timestamp |
|--------|-----------|
| 09-CONTEXT.md commit (00ab2bb)  | 2026-05-08T21:48:07+02:00 (= 2026-05-08T19:48:07Z) |
| 9-r1 started_at_iso             | 2026-05-09T00:43:42.333Z |
| 9-r2 started_at_iso             | 2026-05-09T01:31:56.948Z |

Strict-inequality holds: ✓ (r1 and r2 both began after 09-CONTEXT.md was committed; pre-commitment audit anchor satisfied).

## Probe-Set Pre-Commitment

| Anchor | Commit |
|--------|--------|
| Probe fixtures (30 JSONs) committed | `e23ea60` (Wave 1, 2026-05-08) |
| Judge prompt committed              | `e23ea60` (same Wave 1 commit) |
| First aggregator row written        | 2026-05-09T01:31:56.945Z (r1 completed_at_iso) |

Fixtures + judge prompt are byte-immutable for P9 binding replications. Both r1 and r2 used the same locked probe-set under `.planning/phases/09-empirical-measurement/probes/` — fresh agent runs over the locked set, not fresh probes per replication. Single-source-of-variance discipline preserved (CONTEXT decision 2).

## P10 Branch Direction

**P10 will ship: engineering branch.**

P10 engineering branch will:
1. Integrate the deliberation-surfacing retrieval primitives (B-arm path) into production assembly + routing — replace the harness's manual span injection with the routing+assembly integration around the same retrieval primitives, per CONTEXT decision 3's "harness as working spec" framing.
2. Extend Vesna probe suite from 21 → 24+ with deliberation-engagement probes covering the prong-1/2/3 rubric structure.
3. Tag `v6.0.0` with the bind narrative leading the annotation (POSITIVE verdict + Wilson CI + per-kind context).

The bind is on the tighter side (Wilson lower +0.0038), so P10 should treat the ship surface conservatively: the binding signal exists and is honest, but it is not a wide-margin win. Per-kind data suggests B-arm gains are concentrated in threshold-source / dependency-change / assumption-drift queries; routing tuning that uses those signals to score B-arm injection-worthiness has a stronger empirical anchor than mechanical "always inject" defaults.

## Operational Notes

**Reranker baseline is bi-encoder-only**, not cross-encoder. P10 routing should preserve the bi-encoder fallback path as a primary execution mode, not a degraded one — the binding measurement was conducted under it. If the cross-encoder fitness improves on a future post-backfill check (e.g., after meaningful corpus drift), P10 may switch to cross-encoder primary, but that is its own re-bind decision, not assumed forward.

**Embedding coverage** of the substrate at measurement time was 45,553/47,330 = 96.2% (the gap is empty-body or oversized chunks that skip embedding by design at `src/ingestion/ingest-session.ts:241-247`). The synthetic-corpus partition (37 chunks across 4 sessions, deterministic `synthetic-drift-{c-05,c-06,d-05,d-06}` IDs) was 100% embedded after the post-drain re-import.

**Two production bug fixes** landed during the binding-run prep (commit `4e9da8c`): the vec0 BigInt rowid coercion in `src/ingestion/ingest-session.ts` and the JSON-extract WHERE clause in both `src/cli/drain-transcripts.ts` and `src/angel/heartbeat.ts`. Both were latent in P8 and surfaced when the first real-DB backfill ran. Vesna 21/21 PASS preserved post-fix.

## Closure

P9 is bound POSITIVE. Phase 9 is closed. P10 engineering branch (which was conditional on this verdict) is now unblocked.

The empirical record is preserved in:
- `.planning/aggregates/deliberation-surfacing.json` (3 entries; byte-frozen for prior content; future phases may append)
- `.planning/aggregates/deliberation-surfacing.md` (markdown projection auto-rebuilt from JSON)
- `context/measurements/2026-05-09-deliberation-surfacing.md` (per-run report)

P9.1 corpus-expansion replication is **NOT triggered** — the pooled CI bound positive at n=60, so the inconclusive-escalation cadence does not fire. The fixture set + judge prompt remain byte-immutable; future re-measurements (e.g., on grown corpus, on cross-encoder baseline) would land as new aggregator rows under the same append-only contract.
