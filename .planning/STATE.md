# Project State

## Project Reference

See: `.planning/PROJECT.md` (created 2026-05-04, reframed 2026-05-05)

**Core value (post-reframe 2026-05-05):** v5 = Claudex stores bound multi-modal episodes with provenance (substrate). Recall remains v4's hybrid-retrieval (semantic + FTS + reranker) unchanged in v5. Abstraction-from-density was empirically rejected at our scale (3 KILL bound experiences in `.planning/aggregates/multi-handle.json`).

**Current focus:** Post-reframe execution. v5 is now a **substrate-only milestone** — no replacement thesis. Phase 1 shipped (V25/V26/V27 substrate). Phase 2/2.1 closed with KILL verdict. Phases 3 and 5 DROPPED. Next surviving phase: **Phase 4 (Angel reduction)**, then 6 (boundary), then 7 (narrowed coexistence/migration/ship).

## Current Position

**Current Milestone:** v5 — Bound Multi-Modal Episodes (reframed 2026-05-05 to substrate-only)
**Phase:** 4 — Angel reduction (next; pending discuss)
**Plan:** —
**Status:** Milestone reframe committed 2026-05-05 after Phase 2.1 closed with KILL × 2 (joining Phase 2's KILL → 3 consistent KILL bound experiences). Locked decision rule fired honestly; phases premised on the multi-handle/density-fusion thesis (3, 5) dropped. Methodology that produced the honest KILL — pre-committed decision rule, locked corpus, multiple bound measurements, append-only aggregator, Wilson/Newcombe CI binding — promoted to v5 standard practice. Full reframe: `.planning/reframes/2026-05-05-multi-handle-kill.md`.

**Verdict log:**
- Phase 1 (2026-05-04, type: engineering): SHIPPED. V25 migration + episodic_events table + dualWrite helpers + 60+ EPI-tagged tests. Stub-extractor proves Mem0-trap structurally impossible. Vesna 17/17 preserved.
- Phase 2 (2026-05-04, n=20 ad-hoc held-out): KILL. Criterion 1 failed CI binding (Δp@5 +10pp but Wilson CI lower -0.157); criterion 2 failed density (intra_project_share 0.234 < 0.30); criterion 3 passed (latency p99 ratio 0.89). Decision rule fired honestly. Code retained at flag-off; harness preserved.
- Phase 2.1-strict (2026-05-05, ≥3-frame, n=20): KILL. Δp@5 +0.10 [-0.157, +0.376]; Δr@10 -0.05 [-0.274, +0.172]; density 0.2418; latency p99 ratio 0.83.
- Phase 2.1-relaxed (2026-05-05, ≥2-frame, n=19): KILL. Δp@5 +0.21 [-0.033, +0.491]; Δr@10 +0.05 [-0.141, +0.226]; density 0.2418; latency p99 ratio 1.31.
- Phase 3 (multi-handle retrieval cutover): DROPPED 2026-05-05 — premised on dead thesis.
- Phase 5 (density-based abstraction): DROPPED 2026-05-05 — same dead thesis.

**Last activity:** 2026-05-05 — Phase 2.1 closed (commits da56ecd → ac2bcb2); aggregator updated; user-approval gate fired; milestone reframe committed; ROADMAP/REQUIREMENTS/PROJECT/STATE updated.

**Next step:** `/gsd:discuss-phase 4` (or `/auto-orchestrate --from-phase 4`) for Angel reduction. Phase 4 reframed (sharpened, not weakened) — strip extraction-time pattern creation because the mechanism *itself* violates the parable, independent of whether multi-handle retrieval ever ships.

## v5 Phase Structure (Post-Reframe)

| Phase | Goal | Type | Status | Requirements |
|-------|------|------|--------|--------------|
| 1 — Episode substrate | Schema + write path with provenance tags; Mem0 trap structurally impossible | engineering | SHIPPED 2026-05-04 | EPI-01..07 |
| 2 — Multi-modal index seeds + density-at-scale check | Build error-fingerprint index, measure recall improvement, validate density at our scale | empirical | SHIPPED 2026-05-04, KILL | IDX-01..04 (closed) |
| 2.1 — Corpus-expansion rerun | Second + third bound measurements with strict and relaxed labelers | empirical | SHIPPED 2026-05-05, KILL × 2 | IDX-* (investigation closed) |
| 3 — Multi-handle retrieval cutover | Rewrite hybrid-retrieval to fuse N indexes | engineering | **DROPPED 2026-05-05** | RET-01..05 (dropped) |
| 4 — Angel reduction | Trace dependencies; delete extraction-time pattern creation; Angel becomes bind+index, not abstract | engineering | **NEXT** | AR-01..05 |
| 5 — Density-based abstraction | Cluster matching episodes; surface high-density clusters as inferred patterns at retrieval time | empirical | **DROPPED 2026-05-05** | ABS-01..04 (dropped) |
| 6 — Crash-resilient episode boundary | fsnotify + heartbeat + idle-sweep + PID-liveness | engineering | pending | EBD-01..06 |
| 7 — v4 coexistence / migration / ship (narrowed) | Per-table decision (retire/re-derive/preserve); Vesna update; **v5.0.0 tag** | engineering | pending | MIG-01..05, VAL-01/02/03'/04/05/06 |

**Coverage:** 4 surviving phases (1 shipped, 4/6/7 pending). Phases 2/2.1 closed with KILL. Phases 3/5 dropped.

## Empirical methodology (v5 standard, promoted from Phase 2/2.1)

Any future empirical phase in v5 (or future milestones) follows this pattern, proven by Phase 2/2.1:

1. **Pre-commit the decision rule** in CONTEXT.md before measurement runs. No goalpost shifts after seeing results.
2. **Lock the corpus and harness.** Same code, same data, same pair-set across replications.
3. **Multiple bound measurements before milestone-level claims.** Append-only aggregator at `.planning/aggregates/{topic}.{md,json}`. One experience is not abstraction.
4. **Wilson/Newcombe CI binding for noise rejection.** At small n, point-deltas of +5pp can be inside the CI of zero. Require the lower bound to bind.
5. **Descriptive-not-gating audits.** Agent autonomy on audit work; precision/recall metrics reported, not used as gates.
6. **Negative results are valid outputs.** "This didn't work, here's what we learned" is a successful empirical-phase outcome.

## Notes for the Operator

- v4-final archive at `.planning/v4-final/` is read-only history; do not modify.
- v4.1 HITL items (PLAT-06/07/08, VER-04/05, REL-04/05/07) remain on your plate at your discretion — they don't block v5.
- The Mem0 fix from commit `0d0fbca` (2026-05-04) is tactical; Phase 4 makes it structurally obsolete via extraction-time-pattern-creation deletion (the structural cause).
- If `/auto-orchestrate` is interrupted, resume via `--from-phase 4`. The disk is the state machine.
- Aggregator bug noted in 2026-05-05 closeout: `.planning/aggregates/multi-handle.md` shows Unix-epoch dates ("1970-01-01") and n=60 row aggregations instead of the per-tier 19/20. The summary numbers in `02.1-RESULTS.md` are correct; only the aggregator's snapshot is wrong. Cosmetic; non-blocking. Fix during Phase 4 sweep or carry to v5.1.
