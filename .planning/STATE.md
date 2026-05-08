# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-08 after v5 closure + v6 milestone kickoff)

**Core value:** v5 closed the *lying-memory* surface; v6 closes the *lazy-memory* surface. Surface the moments that produced decisions and lessons, not summaries about them.
**Current focus:** v6 — Deliberation Surfacing (Phase 8 SHIPPED 2026-05-08; Phase 9 empirical measurement ready to start).

## Current Position

**Current Milestone:** v6 — Deliberation Surfacing
**Phase:** Phase 9 — Empirical measurement (not started)
**Plan:** —
**Status:** Phase 8 (transcript ingestion substrate) SHIPPED 2026-05-08. V32 migration + ingestion pipeline + WIR-01 ship gate landed. 76 new tests pass; 8 of 9 ship gates PASS, 1 (sc3 big-mozzy-v2) carry-forward pre-existing project-content gap verified pre-P8 via git-stash test. Vesna 21/21 preserved.

**Last activity:** 2026-05-08 — Phase 8 close-out commit; CHANGELOG `[Unreleased]` populated with v6 substrate landing; STATE.md + ROADMAP.md flipped.

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

## v6 Phase Structure (ROADMAP.md authoritative)

| Phase | Goal | Type | Status | Requirements |
|-------|------|------|--------|--------------|
| 8 — Transcript ingestion substrate | V32 schema (transcript_chunk promotion + vec0 binding); JSONL watcher hook into Phase 6 boundary close; redaction-at-ingestion via parseWrappers; chunking strategy locked; backfill scope locked; live-wiring ship gate against V17-collapsed + base-table | engineering | **SHIPPED 2026-05-08** | TRX-01..05 + WIR-01 + WIR-02 |
| 9 — Empirical measurement | Pre-commit decision rule in CONTEXT.md; lock corpus + harness; build drift-detection probe suite (≥5 condition-shift kinds); A/B with-transcript vs. summary-only baseline; ≥2 bound replications; Wilson/Newcombe CI binding; aggregate to `.planning/aggregates/deliberation-surfacing.{md,json}` | empirical | not started | ENG-01..04 |
| 10 — Conditional ship | Bound positive: routing (BGE-reranker fan-out from artifact references) + assembly (transcript span citations + advisory narration + budget caps) + Vesna probe extension to 24+ + ship gate validation + v6.0.0 tag. Bound negative: KILL receipt (Phase 2 shape) + substrate-alone ship + v6.0.0 tag with kill leading | engineering OR documentation | not started | ROU-01..03 + ASM-01..03 (engineering branch); WIR-01 inherited via WIR-02 phase coupling |

## v6 Phase Verdict Log

- **Phase 8 (2026-05-08, type: engineering): SHIPPED.** V32 schema (transcript_chunk_v6 + vec_transcript_chunks_v6) + ingestion pipeline (chunkTranscript + upsertChunk + parseWrappers redaction) + SessionEnd hook enqueue + Angel heartbeat drain + backfill CLI + reranker-fitness CLI. WIR-01 wire test against V17-collapsed + base-table fresh-DB fixtures lands at ninth-gate severity. 76 new tests; Vesna 21/21 preserved. 8 of 9 ship gates PASS (sc3 big-mozzy-v2 at 70% is pre-existing project-content gap verified pre-P8). Boundary-detector enqueue path deferred to v6.x — see 08-03 SUMMARY Rule 4 deferral. NO v6.0.0 tag — that is P10's job after P9's empirical verdict.

**v6 coverage:** 17/17 requirements mapped, 0 unmapped.

## Empirical Methodology (v5 standard, mandatory in v6)

Promoted to standard practice 2026-05-05. Mandatory for v6 P9 empirical phase and any future empirical work:

1. **Pre-commit the decision rule** in CONTEXT.md before measurement runs. No goalpost shifts after seeing results.
2. **Lock the corpus and harness.** Same code, same data, same pair-set across replications.
3. **Multiple bound measurements before milestone-level claims.** Append-only aggregator at `.planning/aggregates/{topic}.{md,json}`. One experience is not abstraction.
4. **Wilson/Newcombe CI binding for noise rejection.** At small n, point-deltas of +5pp can be inside the CI of zero. Require the lower bound to bind.
5. **Descriptive-not-gating audits.** Agent autonomy on audit work; precision/recall metrics reported, not used as gates.
6. **Negative results are valid outputs.** "This didn't work, here's what we learned" is a successful empirical-phase outcome.

## New Mandatory Ship Gate (promoted from v5.0.0 silent-fail)

**Live-wiring smoke against every production DB shape currently in the wild.** Every v6 engineering phase must include this as a ship gate alongside unit/integration tests. V17-collapsed shape at minimum, plus base-table fresh-DB. Anchored to Phase 8 in REQUIREMENTS.md traceability (WIR-01 + WIR-02); P10 engineering branch inherits the gate via WIR-02's "ship gates include WIR-01" phase coupling. See WIR-* category in REQUIREMENTS.md.

## Notes for the Operator

- v4-final archive at `.planning/v4-final/` is read-only history; do not modify.
- v5.0.0 + v5.0.1 are public on origin. v5 milestone CLOSED.
- Aggregator non-determinism (Phase 4/6/7 close-out pattern) — continue documented "revert as known noise" close-out discipline; queue for v6.x cleanup.
- 27 pre-existing test failures (llama-server-supervisor, llama-client, phase-5-full-gate) carry forward as v4-debt; not blocking v6.
- Standing user directive 2026-05-08: autonomous through v6 milestone end; operator-confirms public push at v6.0.0 tag (same pattern as v5).
- If `/auto-orchestrate` is interrupted, resume via `--from-phase 8`. The disk is the state machine.
- v6 P10 type-of-phase resolves only after P9 verdict — engineering branch (bound positive) lands routing + assembly; documentation branch (bound negative) lands KILL receipt + substrate-alone ship. Both end at v6.0.0 tag.
