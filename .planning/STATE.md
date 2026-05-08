# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-08 after v5 closure + v6 milestone kickoff)

**Core value:** v5 closed the *lying-memory* surface; v6 closes the *lazy-memory* surface. Surface the moments that produced decisions and lessons, not summaries about them.
**Current focus:** v6 — Deliberation Surfacing (defining requirements + roadmap).

## Current Position

**Current Milestone:** v6 — Deliberation Surfacing
**Phase:** Not started (defining requirements + roadmap)
**Plan:** —
**Status:** v6 milestone kicked off 2026-05-08. Spec at `.planning/research/2026-05-08-v6-deliberation-surfacing.md` (committed `8d0477b`) is the requirements input. PROJECT.md flipped from v5-active to v5-validated + v6-active. Research stage SKIPPED — spec is research-grade and represents user-locked thesis (Critical Reminders Layer-1-proven, Layers 2 + 3 are v6).

**Last activity:** 2026-05-08 — v5 milestone CLOSED + v5.0.0 + v5.0.1 published to origin + v6 milestone kicked off.

## v5 Verdict Log (CLOSED 2026-05-08)

- Phase 1 (2026-05-04, type: engineering): SHIPPED. V25 migration + episodic_events table + dualWrite helpers + 60+ EPI-tagged tests. Stub-extractor proves Mem0-trap structurally impossible. Vesna 17/17 preserved.
- Phase 2 (2026-05-04, n=20 ad-hoc held-out): KILL. Criterion 1 failed CI binding (Δp@5 +10pp but Wilson CI lower -0.157); criterion 2 failed density (intra_project_share 0.234 < 0.30); criterion 3 passed (latency p99 ratio 0.89). Decision rule fired honestly. Code retained at flag-off; harness preserved.
- Phase 2.1-strict (2026-05-05, ≥3-frame, n=20): KILL. Δp@5 +0.10 [-0.157, +0.376]; Δr@10 -0.05 [-0.274, +0.172]; density 0.2418; latency p99 ratio 0.83.
- Phase 2.1-relaxed (2026-05-05, ≥2-frame, n=19): KILL. Δp@5 +0.21 [-0.033, +0.491]; Δr@10 +0.05 [-0.141, +0.226]; density 0.2418; latency p99 ratio 1.31.
- Phase 3 (multi-handle retrieval cutover): DROPPED 2026-05-05 — premised on dead thesis.
- Phase 4 (2026-05-05, type: engineering): SHIPPED. Three extraction sites deleted (A `pattern-extractor.ts`, B `experience-scoring.ts` step 1, C `heartbeat.ts` synthesis loop). V28 BEFORE INSERT trigger blocks new rows structurally. ~1100 lines deleted, ~700 added. Vesna 18/18 PASS.
- Phase 5 (density-based abstraction): DROPPED 2026-05-05 — same dead thesis.
- Phase 6 (2026-05-05, type: engineering): SHIPPED. V29 schema bump (episode_boundary_cursor + sessions liveness columns). Chokidar watcher + heartbeat hooks + atomic close marker + boundary detector with re-open + offset-overflow recovery. 55 boundary tests + 7 V29 migration tests + 6 hook regression tests.
- Phase 7 (2026-05-08, type: engineering): SHIPPED. V30 schema bump (`learnings.provenance` closed-enum CHECK). `captureInsightsAsLearnings` calls `parseWrappers` from production code path. Vesna 18 → 21 functional probes. 3 new vitest integration tests. CHANGELOG.md `[5.0.0]` entry. v5.0.0 local annotated tag created and pushed to origin.
- v5.0.1 hot-fix (2026-05-08): V31 view-mode learnings.provenance close + shape-agnostic upsertLearning (SELECT-then-INSERT-or-UPDATE) + live-wiring regression test against V17-collapsed fixture + 191-row backfill to 'organic'. Closes the silent-fail discovered in post-ship audit.

## v6 Phase Structure (planned, ROADMAP.md authoritative when written)

| Phase | Goal | Type | Status | Requirements |
|-------|------|------|--------|--------------|
| 8 — Transcript ingestion substrate | V32 schema (transcript_chunk promotion + vec0 binding); JSONL watcher hook into Phase 6 boundary close; redaction-at-ingestion; chunking strategy locked | engineering | pending | TRX-* + WIR-* |
| 9 — Empirical measurement | Lock corpus + harness; pre-commit decision rule; build engagement probes; A/B with-transcript vs. without; multiple bound runs; Wilson CI; aggregate to `.planning/aggregates/deliberation-surfacing.{md,json}` | empirical | pending | ENG-* |
| 10 — Conditional ship | Bound positive: assembly integration + artifact-to-transcript routing + Vesna probe extension + ship gate validation + v6.0.0 tag. Bound negative: KILL receipt + substrate-alone ship + v6.0.0 tag with kill leading | engineering OR documentation | pending | ROU-* + ASM-* |

## Empirical Methodology (v5 standard, mandatory in v6)

Promoted to standard practice 2026-05-05. Mandatory for v6 P9 empirical phase and any future empirical work:

1. **Pre-commit the decision rule** in CONTEXT.md before measurement runs. No goalpost shifts after seeing results.
2. **Lock the corpus and harness.** Same code, same data, same pair-set across replications.
3. **Multiple bound measurements before milestone-level claims.** Append-only aggregator at `.planning/aggregates/{topic}.{md,json}`. One experience is not abstraction.
4. **Wilson/Newcombe CI binding for noise rejection.** At small n, point-deltas of +5pp can be inside the CI of zero. Require the lower bound to bind.
5. **Descriptive-not-gating audits.** Agent autonomy on audit work; precision/recall metrics reported, not used as gates.
6. **Negative results are valid outputs.** "This didn't work, here's what we learned" is a successful empirical-phase outcome.

## New Mandatory Ship Gate (promoted from v5.0.0 silent-fail)

**Live-wiring smoke against every production DB shape currently in the wild.** Every v6 engineering phase must include this as a ship gate alongside unit/integration tests. V17-collapsed shape at minimum. See WIR-* category in REQUIREMENTS.md.

## Notes for the Operator

- v4-final archive at `.planning/v4-final/` is read-only history; do not modify.
- v5.0.0 + v5.0.1 are public on origin. v5 milestone CLOSED.
- Aggregator non-determinism (Phase 4/6/7 close-out pattern) — continue documented "revert as known noise" close-out discipline; queue for v6.x cleanup.
- 27 pre-existing test failures (llama-server-supervisor, llama-client, phase-5-full-gate) carry forward as v4-debt; not blocking v6.
- Standing user directive 2026-05-08: autonomous through v6 milestone end; operator-confirms public push at v6.0.0 tag (same pattern as v5).
- If `/auto-orchestrate` is interrupted, resume via `--from-phase 8`. The disk is the state machine.
