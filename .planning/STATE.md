# Project State

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-05-08 after v5 closure + v6 milestone kickoff)

**Core value:** v5 closed the *lying-memory* surface; v6 closes the *lazy-memory* surface. Surface the moments that produced decisions and lessons, not summaries about them.
**Current focus:** v6 — Deliberation Surfacing **CLOSED 2026-05-09**. Phase 8 SHIPPED 2026-05-08; Phase 9 BOUND POSITIVE 2026-05-09; Phase 10 SHIPPED 2026-05-09 with v6.0.0 annotated tag created locally (operator-confirms public push).

## Current Position

**Current Milestone:** v6 — Deliberation Surfacing — **REOPENED 2026-05-09 for Phase 11 polish.** Pre-push Gemini consultation surfaced verdict-invalidating P9 methodology defects + 13+ critical code regressions across P8/P10. v6.0.0 local tag stays unpushed; will be delete-and-retagged at Phase 11 close-out with corrected annotation reflecting actual rebound verdict (positive / kill receipt / inconclusive).
**Phase:** Phase 11 — Polish (started 2026-05-09; not yet planned)
**Plan:** —
**Status:** Phase 11 spec committed at `.planning/research/2026-05-09-v6-polish.md` (commit `a9fa77e`). 6 user-locked decisions: (1) Phase numbering = Phase 11; (2) cross-corpus = big-mozzy-v2 primary; (3) judge ensemble = Gemini-3-Flash + Claude Opus 4.7 + GLM-5.1 + Kimi-K2.6 (3-of-4 majority, 3-of-3 fallback if any errors >10%); (4) v6.0.0 tag kept until polish completes then delete + retag; (5) audit trail at `.planning/audits/2026-05-09-v6-gemini-reviews/`; (6) external-review gate baked into auto-orchestrate. Three internal waves: W1 code regressions, W2 methodology fix + skill update, W3 re-bind + cross-corpus + conditional ship. Audit trail (5 Gemini reviews + 5 prompts + README + finding-to-task index) committed at `a9fa77e`.

**Last activity:** 2026-05-15 — Phase 14 Wave 1 in progress. Plan 14-02 (project_id→project column unification) COMPLETE. V33→V34 migration shipped: artifact.project_id + transcript_chunk_v6.project_id renamed to project. Reversible migration with column-existence guards + view/trigger/index audit. Comprehensive caller sweep (30+ files). production-shape-v32.db rebuilt at V34. 10 new migration tests. Branch: phase-14/01-handoff-schema. Key decisions: hasColumn guard for idempotency; schema_versions column-aware INSERT; view audit pattern for learnings VIEW; EXPRESSION_INDEXES_DDL updated to match fresh-DB column name.

**2026-05-09 note (preserved):** Phase 11 polish spec + Gemini audit trail committed. Standing user directive: autonomous through milestone end (Phase 11 is part of v6); operator-confirmed push at v6.0.0 retagged tag. Phase 11 ready for `/auto-orchestrate --from-phase 11` or `/gsd:plan-phase 11`.

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
| 9 — Empirical measurement | Pre-commit decision rule in CONTEXT.md; lock corpus + harness; build drift-detection probe suite (≥5 condition-shift kinds); A/B with-transcript vs. summary-only baseline; ≥2 bound replications; Wilson/Newcombe CI binding; aggregate to `.planning/aggregates/deliberation-surfacing.{md,json}` | empirical | **BOUND POSITIVE 2026-05-09** | ENG-01..04 |
| 10 — Conditional ship | Bound positive: routing (BGE-reranker fan-out from artifact references) + assembly (transcript span citations + advisory narration + budget caps) + Vesna probe extension to 24+ + ship gate validation + v6.0.0 tag. Bound negative: KILL receipt (Phase 2 shape) + substrate-alone ship + v6.0.0 tag with kill leading | engineering | **SHIPPED 2026-05-09** (regressions found post-hoc; see P11) | ROU-01..03 + ASM-01..03 (engineering branch); WIR-01 inherited via WIR-02 phase coupling |
| 11 — Polish — land v6 properly | W1 code regressions (12+ critical fixes across routing/assembly/ingestion/chunker; tests rewrite to assert visible failures); W2 methodology fix (harness B-arm = production routing; prong-2 metadata; paired McNemar OR disjoint-probe; 4-judge ensemble; bake external-review into auto-orchestrate); W3 re-bind on corrected methodology + cross-corpus generalization on big-mozzy-v2 + conditional ship (positive bind / kill receipt / inconclusive triggers P11.1) | engineering + empirical hybrid | **STARTED 2026-05-09** | POLISH-* (TBD by /gsd:plan-phase 11) |

## v6 Phase Verdict Log

- **Phase 8 (2026-05-08, type: engineering): SHIPPED.** V32 schema (transcript_chunk_v6 + vec_transcript_chunks_v6) + ingestion pipeline (chunkTranscript + upsertChunk + parseWrappers redaction) + SessionEnd hook enqueue + Angel heartbeat drain + backfill CLI + reranker-fitness CLI. WIR-01 wire test against V17-collapsed + base-table fresh-DB fixtures lands at ninth-gate severity. 76 new tests; Vesna 21/21 preserved. 8 of 9 ship gates PASS (sc3 big-mozzy-v2 at 70% is pre-existing project-content gap verified pre-P8). Boundary-detector enqueue path deferred to v6.x — see 08-03 SUMMARY Rule 4 deferral. NO v6.0.0 tag — that is P10's job after P9's empirical verdict.
- **Phase 9 (2026-05-09, type: empirical, n=60 pooled across 2 replications): BOUND POSITIVE.** Pooled Δ pass-rate +0.1667, Wilson Δ CI [+0.0038, +0.3434]. Per-replication: r1 (s=14, t=18) and r2 (s=15, t=21) both INCONCLUSIVE individually; pooling cleared zero per CONTEXT decision 4. Bi-encoder-only baseline (cross-encoder fitness 56.0% < 60% post-backfill). Per-kind concentrated in b/d/e (threshold-source/dependency-change/assumption drift); a/c flat. P10 engineering branch unlocked. Two production bugs fixed in-flight (vec0 BigInt + JSON-extract WHERE; commit 4e9da8c). Vesna 21/21 preserved. 47330 chunks + 45553 embeddings substrate. Pre-commitment audit anchor (09-CONTEXT.md@00ab2bb) satisfied. See `.planning/phases/09-empirical-measurement/09-RESULTS.md`.
- **Phase 10 (2026-05-09, type: engineering): SHIPPED.** v6.0 deliberation-surfacing close-out. Routing layer (`src/retrieval/transcript-routing.ts` — `routeFromArtifact`/`routeFromArtifacts`; bi-encoder primary; cross-encoder behind `v6.routing.reranker_mode` flag; artifact-kind-agnostic per CONTEXT decision 2). Assembly layer (`src/assembly/deliberation-surface.ts` — labeled citation format + advisory narration line + asymmetric token budget per CONTEXT decision 3; opt-in via `FullAssemblyParams.deliberationSurfacing` + async `appendDeliberationSurfaceToPayload` helper at L2.5 cascade). Five new Vesna probes (deliberation-engagement a-e); 21 → 26 PASS at 100%. WIR-01 wire-test against V17-collapsed + base-table fresh-DB fixtures (4 assertions × 2 fixture shapes = 8 sub-assertions, all PASS). All 9 ship gates PASS (vesna 26/26, P10 vitest 27/27, build, full suite 3656/3691 with 27 pre-existing v4-debt unchanged, sc3 88.3% with big-mozzy carry-forward, handoff-pickup 3/3 within vesna, bundle-smoke 7/7, doctor exit 0, WIR-01 PASS). v6.0.0 annotated tag created locally with bind narrative leading the annotation (pooled n=60, Wilson CI [+0.0038, +0.3434], `bi_encoder_fallback` baseline, kinds b/d/e concentration). Operator-confirmed public push pending.

**v6 coverage:** 17/17 v6.0.0 requirements mapped + Phase 11 polish requirements TBD via `/gsd:plan-phase 11`. **Milestone REOPENED for Phase 11 polish — 2026-05-09.**

- **Phase 11 (2026-05-09, type: engineering + empirical hybrid): IN PROGRESS.** Trigger: pre-push Gemini consultation (5 reviews; 4 of 5 grade F) surfaced 3 verdict-invalidating P9 methodology defects (harness B-arm KNN ≠ production temporal-join; prong-2 metadata starvation; pseudoreplication pooling at n=60) + 13+ critical code regressions (3 assembly state-corruption, 6 ingestion silent-failure modes, 2 routing non-throwing-contract violations, 1 chunker formatting destruction, plus several recommended). Plus 7 architectural concerns (recursive-corpus risk, self-grading bias, narrow margin, async post-step pattern, methodology misapplication, parable claim narrower than implementation, bus-factor-1 in autonomous orchestration). Audit trail: `.planning/audits/2026-05-09-v6-gemini-reviews/`. Spec: `.planning/research/2026-05-09-v6-polish.md` (commit `a9fa77e`). 6 user-locked decisions on phase numbering / cross-corpus / judge ensemble / tag handling / audit / external-review-gate. Three internal waves (W1 code, W2 methodology, W3 rebind+ship). Standing user directive: autonomous through milestone end (Phase 11 IS v6's proper landing). v6.0.0 tag will be delete-and-retagged with corrected annotation at Phase 11 close-out.

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
- v6.0.0 annotated tag exists locally on master. Public push (`git push origin master --tags`) is the operator's gate; do NOT push autonomously per CLAUDE.md rule 1 + CONTEXT § Decisions ("NEVER push autonomously").
- Aggregator non-determinism (Phase 4/6/7 close-out pattern) — continue documented "revert as known noise" close-out discipline; queue for v6.x cleanup.
- 27 pre-existing test failures (llama-server-supervisor, llama-client, phase-5-full-gate) carry forward as v4-debt; not blocking v6.
- Standing user directive 2026-05-08: autonomous through v6 milestone end; operator-confirms public push at v6.0.0 tag (same pattern as v5). v6 milestone now CLOSED; next operator action is the public push.
- v6.x or v7+ deferred ideas: per-kind routing weight tuning, cross-encoder re-bind on grown corpus, default tuning from production telemetry, kind-a/kind-c null-result investigation, retention policy (forgetting-curve), cross-harness transcript sources. See CHANGELOG [6.0.0] § Deferred and 10-CONTEXT.md § Deferred Ideas.

## Phase 14 Progress (Substrate Coherence)

- Plan 14-01 (handoff schema): COMPLETE — commit `see 14-01-SUMMARY.md`
- Plan 14-02 (project_id→project): COMPLETE — commit `see 14-02-SUMMARY.md`
- Plan 14-03 (isSubstantive predicate + experience-tier filter): **COMPLETE 2026-05-16** — noise 83% → 18% (AC-3 PASS). isSubstantive() + substantiveSqlClause() in src/core/artifact-filters.ts. Experience-tier candidate pool uses SQL clause. JS-vs-SQL lockstep enforced by 40-test suite. Commits: d1c826c, 3c1ee7b, b126132, 09fadc8, d8f2ac3, cfdf4b2.
- Plan 14-04 (P2.7 Project Knowledge surface): **COMPLETE 2026-05-16** — same-project starvation gap closed. ACTIVE.md summary drives hybrid retrieval (substantiveOnly=true) against top-K same-project artifacts at session-start. 800 token cap. Cache-stable (CACH-02). AC-1 PASS (synthesized big-mozzy-v2 fixture surfaces bet365 entry). 13 new tests + 3 assembler cascade tests. Commits: 7ef9732, 110cef4, 2eb2d5e, e9dc8a7.
- Plan 14-05 (single-owner session-end lifecycle): **COMPLETE 2026-05-16** — boundary-detector sole writer of status='completed'. 5-step ordered action chain with per-action telemetry. V35→V36 migration adds session_end_action to CHECK constraint. heartbeat.ts + session-start.ts delegate to promoteSessionToCompleted. 26 new tests. Commits: 272118e, 1e83ef3, 5e65afb, b1c11e9.
- Plan 14-06 (epoch-ms canonicalization): **COMPLETE 2026-05-16** — V35 migration + 166 files canonicalized. Starting failures: 38 files / 171 tests. Final: 5 files / 31 tests (all pre-existing). Commits: 05e9594, 0276a78. Key decisions: TARGET_USER_VERSION=35; WHERE guard `< 1e12`; cutoffMs() vs cutoff() distinction preserved.
- Plan 14-08 (Wave 2 integration): COMPLETE — see 14-08-SUMMARY.md

### Decisions

- 2026-05-16: V35 epoch-ms canonicalization — 16 tables renamed `*_epoch → *_epoch_ms`, scaled sec→ms. 10 tables intentionally excluded (experience_patterns, session_events, etc.). topicalRelevance cap in computeArtifactScore deferred (unimplemented Phase 12 feature).
- 2026-05-16: Plan 14-03 isSubstantive — SQL clause targets legacy artifacts table only (no `kind`). flow type certified-substantive even with short summaries (domain affinity deferred). cross-project-search.ts exception documented. AC-3 PASS at 18% noise rate.
- 2026-05-16: Plan 14-05 single-owner session-end — idempotency guard uses telemetry-presence check (action='session_summary') not status check; initializeSchema requires explicit V36 guard since fresh DBs bypass incremental migration path; Date.now() directly for ended_at_epoch_ms (not floor/1000).
- 2026-05-16: Plan 14-04 P2.7 Project Knowledge — hybridSearchSync (not async) used in assembleFullContext to preserve sync cascade; substantiveOnly threaded via SQL clause for FTS5/recency, JS isSubstantive post-fetch for vector channel; P2.7 inside !isPostCompaction block; budget enforcement: drop-lowest-ranked first then excerpt truncation then null.

## Accumulated Context

### Roadmap Evolution

- 2026-05-10 — Phase 12 added: Real v6 structural marks (cross-family invocation pipeline + methodology critique checkpoint + adversarial test/fixture authoring + Vesna probe-suite polishing + lightweight telemetry instrumentation + mid-flight commit visibility). Lands the structural marks the v6→v6-polish round-trip produced as load-bearing countermeasures. Spec: `.planning/research/2026-05-10-phase-12-real-v6-structural-marks.md`. Six items, three waves (W1 foundation / W2 gates+observation / W3 standalone polish), 12-CLOSE external-review-gate dogfood. Track A on `/auto-orchestrate`; Track B (Phase 11 W3 empirical re-bind) runs operator-driven in parallel; both close before public push.
