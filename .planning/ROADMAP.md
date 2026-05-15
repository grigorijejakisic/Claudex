# Roadmap: Claudex — v6 Deliberation Surfacing

## Milestones

- ✅ **v4.0 / v4.1** — Phases 1-? (shipped 2026-04-30 / 2026-05-02; archived at `.planning/v4-final/`)
- ✅ **v5.0 / v5.0.1 — Bound Multi-Modal Episodes (substrate-only)** — Phases 1-7 (shipped 2026-05-08; tagged on origin)
- ✅ **v6.0 — Deliberation Surfacing** — Phases 8-10 (shipped 2026-05-09; v6.0.0 tag created locally; operator-confirms public push)

## Overview

**v5 closed the lying-memory surface; v6 closes the lazy-memory surface.** v5 made memory trustworthy (provenance, no fabricated patterns, Mem0 trap structurally impossible). v5 left memory under-engaged — retrieval surfaces summaries, agents apply them generically, the agent doesn't *think*, it *restates*. v6 surfaces the **moment** at retrieval time (the transcript span where a decision was forged, where a lesson crystallized) instead of the summary about the moment.

**v6 is not a new bet.** Critical Reminders (Session 44, decisions `106`/`110` → learning `aee9461`) proved the parable at Layer 1 (rules) in production. v6 extends a proven principle to Layer 2 (decisions) and Layer 3 (lessons). Retrieval algorithm is unchanged — conventional v4 hybrid-retrieval (semantic + FTS + reranker) applied to a different corpus (transcript chunks). The bet is the *substrate shift*, not the ranking. v5 KILLs (multi-handle recall, density-based abstraction) are honored — not revived.

**v6 shape (3 phases):** P8 substrate (engineering, mandatory) → P9 empirical (measurement, mandatory) → P10 conditional ship (engineering OR documentation, branches on P9 verdict). Bound positive ships full v6.0.0 (substrate + routing + assembly). Bound negative ships substrate alone with KILL receipt (Phase 2 shape) and v6.0.0 tag with the kill leading the annotation. Inconclusive triggers Phase 2.1-shape corpus-expansion rerun before final verdict.

**Methodology gates promoted from v5 (mandatory for every v6 phase):**
1. Pre-committed decision rule in CONTEXT.md before any empirical run
2. Locked corpus and harness across replications
3. Multiple bound measurements before milestone-level claims
4. Wilson/Newcombe CI binding for noise rejection
5. **Live-wiring smoke against every production DB shape currently in the wild** (NEW — V17-collapsed at minimum, learned from v5.0.0 silent-fail)
6. Negative results are valid outputs

**Status legend:**
- `[ ]` Pending
- `[x]` Complete
- `[~]` Partial-with-followups
- `[-]` Dropped (with reasoning)
- `type: engineering` — discuss → plan → execute, ship feature
- `type: empirical` — discuss → plan → measure, ship learning (which may include negative results)
- `type: engineering OR documentation` — branches on prior empirical verdict

## Phases

<details>
<summary>✅ v5.0 Bound Multi-Modal Episodes (Phases 1-7) — SHIPPED 2026-05-08</summary>

See git history at `v5.0.0` and `v5.0.1` tags. Phase summary preserved below for narrative continuity:

- [x] **Phase 1: Episode substrate** _(engineering)_ — SHIPPED 2026-05-04. V25 `episodic_events` + provenance enum + dual-write helpers + 60+ EPI-tagged tests. Vesna 17/17 preserved.
- [x] **Phase 2: Multi-modal index seeds + density-at-scale** _(empirical)_ — SHIPPED 2026-05-04, **verdict KILL**. Δp@5 +10pp Wilson CI lower -0.157 at n=20; density 0.234 < 0.30.
- [x] **Phase 2.1: Corpus-expansion rerun** _(empirical)_ — SHIPPED 2026-05-05, **verdict KILL × 2**. Strict + relaxed tiers both KILL; density 0.2418 (identical to 3 decimals — corpus's actual density floor). Three KILL bound experiences in `.planning/aggregates/multi-handle.json`.
- [-] **Phase 3: Multi-handle retrieval cutover** _(engineering)_ — DROPPED 2026-05-05. Premised on dead thesis.
- [x] **Phase 4: Angel reduction** _(engineering)_ — SHIPPED 2026-05-05. Three extraction sites deleted; V28 BEFORE INSERT trigger blocks new rows structurally. Vesna 18/18.
- [-] **Phase 5: Density-based abstraction** _(empirical)_ — DROPPED 2026-05-05. Same dead thesis.
- [x] **Phase 6: Crash-resilient episode boundary** _(engineering)_ — SHIPPED 2026-05-05. V29 schema + chokidar watcher + heartbeat hooks + atomic `clean_endsession` close marker + boundary detector with re-open + offset-overflow recovery.
- [x] **Phase 7: v4 coexistence / migration / ship** _(engineering)_ — SHIPPED 2026-05-08. V30 `learnings.provenance` + parseWrappers write-path filter + 10 reader-comment downgrades + 3 Vesna probes (21/21) + 3 vitest integration tests + CHANGELOG `[5.0.0]`. **v5.0.1 hot-fix:** V31 view-mode learnings.provenance + shape-agnostic upsertLearning + V17-fixture regression test (the silent-fail from v5.0.0 that promoted the WIR ship gate to v6).

Reframe artifact: `.planning/reframes/2026-05-05-multi-handle-kill.md`. Aggregator: `.planning/aggregates/multi-handle.json`.

</details>

### ✅ v6.0 Deliberation Surfacing — PHASE 13 COMPLETE (2026-05-14)

**Milestone Goal:** Surface the verbatim moments that produced decisions and crystallized lessons at retrieval time, not the summaries about them. Make the agent touch the stove, not be told about it.

**Status:** v6.0.0 was tagged locally on 2026-05-09 ~03:46 by autonomous orchestration but pre-push consultation (5 Gemini reviews) surfaced verdict-invalidating methodology defects + critical code regressions. Polish work consolidated as **Phase 11**. v6 is not closed until Phase 11 lands and v6.0.0 is re-tagged with a corrected annotation reflecting the polish-rerun verdict. Audit trail: `.planning/audits/2026-05-09-v6-gemini-reviews/`. Spec: `.planning/research/2026-05-09-v6-polish.md`.

- [x] **Phase 8: Transcript ingestion substrate** _(type: engineering)_ — SHIPPED 2026-05-08. V32 schema bump + transcript-chunk write path + JSONL ingestion hook + redaction-at-ingestion + WIR live-wiring ship gate.
- [x] **Phase 9: Empirical measurement** _(type: empirical)_ — SHIPPED 2026-05-09 (originally BOUND POSITIVE; verdict invalidated post-hoc by Gemini methodology audit — see Phase 11). Pooled n=60 across 2 replications; Δ +0.1667; Wilson Δ CI [+0.0038, +0.3434]. Bi-encoder-only retrieval baseline; per-kind concentration in kinds b/d/e.
- [x] **Phase 10: Conditional ship** _(type: engineering branch)_ — SHIPPED 2026-05-09. Routing + assembly + Vesna 21→26 + WIR-01 wire-test + 9/9 ship gates + v6.0.0 annotated tag (operator-confirms public push). Note: 3 critical regressions surfaced post-hoc by Gemini review — Phase 11 W1 fixes.
- [x] **Phase 11: Polish — land v6 properly** _(type: engineering + empirical hybrid)_ — SHIPPED 2026-05-09. Three internal waves: (W1) code regressions across routing / assembly / ingestion; (W2) methodology fix for the P9 harness + multi-judge ensemble + bake external-review gate into auto-orchestrate; (W3) re-bind under corrected methodology + cross-corpus generalization on big-mozzy-v2 + conditional ship (positive bind / kill receipt / inconclusive). Closes v6.0.0 once with the annotation matching whatever the corrected verdict produces. NEVER pushes during the polish. v6.0.0 tag delete-and-retag at close. (completed 2026-05-09)
- [x] **Phase 12: Real v6 structural marks** _(type: engineering)_ — SHIPPED 2026-05-14. Nine structural fixes responding to the Big Mozzy V2 diagnostic: (1) cross-family-wrapper.ts with invokeCrossFamily; (2) methodology-critique-gate.ts for pre-commitment cross-family critique; (3) adversarial-probe-gate.ts for cross-family test authoring; (4) four telemetry signal recorders for post-push behavior observability; (5) Vesna probe polishing (lesson-application audit, deliberation-engagement split into pipeline-fanout + agent-engagement, 3 new agent-engagement probes); (6) mid-flight commit visibility via PostToolUse sidecar + statusline script; (7) topical-distance importance cap in hybrid-retrieval (big-balkan fix); (8) three context-pull cues wired into PreToolUse + Stop hooks; (9) block-gate.ts shared module + silence-means-escalate patch documents for all three auto-* skills. Vesna 29/29 at 100%. All 9 plan SUMMARY.md files written.
- [x] **Phase 13: Organic Claudex** _(type: engineering)_ — SHIPPED 2026-05-14 (engineering work complete; operator gate pending on /starthere + /endsession deletion). Six structural marks across 3 waves landed: (1) Sessions/ per-turn fsync writes from UserPromptSubmit + Stop + (opt-in) PostToolUse hooks; (2) Angel heartbeat scans Sessions/ via mtime and re-indexes via Phase 8 `chunkTranscript` + `upsertChunk` (recovery = normal path); (3) V33 `session_highlights` + Angel extractor with Opus 4.7 OAuth primary, local-LLM fallback, degraded-flag discipline mirroring reranker-fallback; (4) `assembleFullContext` Priority 2.6 `## Recent Session Frames` (budget-capped 25%) + per-turn `**Current time:**` injection in SessionStart + UserPromptSubmit + `## Frame Extraction Degraded` health line; (5) 3 new PreToolUse cue surfaces (script_encounter, error_investigation, package_install) with `shouldFireCue` highlights-coverage gate — total 6 cue types; (6) deletion-action documents produced for /starthere + /endsession at `src/skills/auto/{starthere,endsession}-deprecation-notice.md` (operator applies manually after one-week window; deletion window opens 2026-05-14, closes 2026-05-21). Vesna 29/29 at 100% GATED PASS. v6.0.0 retag pending operator confirmation on wake with telemetry-based annotation (W3 synthetic re-bind DEPRECATED 2026-05-14).
- [x] **Phase 14: Substrate Coherence** _(type: engineering)_ — SHIPPED 2026-05-16 as **v6.6.0**. Eight contract-tightening fixes that close the structural debt surfaced in the 2026-05-15 substrate audits (`context/measurements/2026-05-15-substrate-{readout-test,big-mozzy-substrate-audit,cross-project-equivalence-hit-rate,contract-matrix,rcas}.md`). Plans: 14-00 Opus rate-limit hybrid (zero-degraded highlights path); 14-01 handoff schema canonicalization + migrator CLI; 14-02 V17 project_id → project unification; 14-03 isSubstantive predicate + experience-tier filter (**AC-3 PASS — cross-project noise rate 83% → 18%**); 14-04 P2.7 Project Knowledge surface (closes same-project starvation gap); 14-05 boundary-detector single-owner session-end + ordered action chain; 14-06 epoch canonicalization to ms across ~10 tables; 14-08 multi-agent ACTIVE*.md visibility. Schema migrations: V33→V34 (project naming), V34→V35 (epoch ms), V35→V36 (session_end_action telemetry enum). 4080/4088 tests passing (31 failures all pre-existing v4-debt baseline). Wave structure: parallel 3 → 1 → parallel 2 → 1. v6.6.0 annotated tag pending operator-confirmed push. **14-07 (V17 ↔ legacy `artifacts` migration) deferred to v7.0.0 milestone** — too large for v6.6.0 bundle (22 production sites, ranking regression risk requires Vesna + LongMemEval + LoCoMo benchmark gates, separate spec authoring scheduled for next session). Close doc: `.planning/phases/14-substrate-coherence/14-CLOSE.md`.

## Phase Details

### Phase 8: Transcript ingestion substrate
**Goal**: Land the v6 substrate — full session JSONL ingested into a transcript-chunk store at the moment Phase 6 emits `clean_endsession`, chunked on natural boundaries, embedded via existing arctic-embed2 path, redacted via Phase 1's `parseWrappers`, schema bumped to V32, and verified against every production DB shape currently in the wild. No retrieval-side changes — the substrate is reusable regardless of the P9 verdict.
**Depends on**: Phase 7 (v5 closure — V31 shape-agnostic discipline + Phase 6's atomic close marker)
**Type**: engineering
**Requirements**: TRX-01, TRX-02, TRX-03, TRX-04, TRX-05, WIR-01, WIR-02
**Success Criteria** (what must be TRUE):
  1. When Phase 6's `clean_endsession` close marker fires, the system ingests the full session JSONL into a `transcript_chunk` (or vec0-backed equivalent) store; crash-killed sessions ingest via the same idle-sweep path Phase 6 already implements (no new boundary logic added).
  2. Each chunk lands with a closed-enum `provenance` tag matching V25 (`organic | injected | tool_result | environmental`), `session_id`, `project_id`, `turn_index`, `role`, `created_at_epoch_ms`; wrapper-tagged spans (`<system-reminder>`, `<experience-data>`, `<file-content>`, `<command-message>`) are redacted at ingestion via Phase 1's `parseWrappers` source-of-truth — Mem0-trap stays structurally closed at the new write surface.
  3. V32 schema migration runs idempotently on both base-table fresh-DB and V17-collapsed shapes per the v5.0.1 lesson; chunks land in a vec0-backed virtual table with embeddings produced by the existing arctic-embed2 Ollama path; backfill scope (last 30d / per-project / full archive) is locked during P8 planning.
  4. **Live-wiring ship gate (WIR-01):** the production-shape integration test runs the *exported* ingestion function (e.g., `upsertChunk`) against fixtures for every DB shape currently in the wild — V17-collapsed at minimum, plus base-table fresh-DB — not against a mocked or `:memory:` DB. Test failure blocks ship at the same severity as Vesna failure (WIR-02 ship-gate coupling).
  5. Vesna 21/21 baseline preserved; existing v4 hybrid-retrieval pipeline unchanged; no retrieval-side surface visible to the agent yet (substrate-only — engagement is P9's question).
**Plans** (5 plans across 5 sequential waves — SHIPPED 2026-05-08):
- [x] 08-01-PLAN.md — V32 schema migration + fresh vec0 table (TRX-05) [wave 1]
- [x] 08-02-PLAN.md — chunkTranscript + upsertChunk (TRX-02, TRX-04) [wave 2]
- [x] 08-03-PLAN.md — Ingestion hook + Angel heartbeat drain (TRX-01, TRX-03) [wave 3]
- [x] 08-04-PLAN.md — Full-archive backfill CLI + reranker fitness CLI (TRX-03) [wave 4]
- [x] 08-05-PLAN.md — WIR-01 live-wiring + Mem0-trap closure + Phase 8 ship close-out (WIR-01, WIR-02) [wave 5]

### Phase 9: Empirical measurement
**Goal**: Bind whether next-session task performance improves when the agent has access to verbatim historical deliberation vs. summary-only baseline. Same methodology shape as v5 Phase 2/2.1 — pre-committed decision rule before any A/B run, locked corpus + harness across replications, drift-detection probes as the primary binding signal, Wilson/Newcombe CI binding for noise rejection at small n. Negative result is a valid output.
**Depends on**: Phase 8 (substrate must exist before transcript spans can be A/B'd against summary-only baseline)
**Type**: empirical
**Requirements**: ENG-01, ENG-02, ENG-03, ENG-04
**Success Criteria** (what must be TRUE):
  1. P9 CONTEXT.md pre-commits the engagement metric and decision rule **before** measurement begins — primary candidate is drift-detection probes (synthetic cases where current state differs from the conditions that produced a past decision; summary-only context: agent applies the verdict generically and FAILs; transcript context: agent surfaces the divergence and PASSes). Decision rule: lower-CI of Δ(transcript − summary) > 0 across N probes via Wilson/Newcombe binding. Citation density and specificity-contrast appear only as secondary signals if time permits.
  2. P9 builds the engagement probe suite with synthetic drift fixtures covering at least 5 distinct kinds of condition-shift (sample-size shift, scope expansion, dependency change, etc.); harness, code, and pair-set are locked across replications.
  3. P9 produces ≥2 bound measurements (more if first run is inconclusive); each replication appends a row to `.planning/aggregates/deliberation-surfacing.{md,json}` per the v5 standard practice; one experience is not abstraction.
  4. Wilson/Newcombe CI binding is required for any milestone-level claim — point-deltas without CI binding are reported but never gated on. Bound-positive verdict triggers P10 engineering branch; bound-negative triggers P10 documentation branch (KILL receipt + substrate-alone ship); inconclusive triggers Phase-2.1-shape corpus-expansion rerun before final verdict.
  5. Methodology gate compliance is auditable: pre-committed decision rule visible in P9 CONTEXT.md commit before A/B run timestamps; corpus + harness diff-locked; aggregator append-only; descriptive-not-gating audits with full agent autonomy.
**Plans**: 4 plans (SHIPPED 2026-05-09)
- [x] 09-01-PLAN.md — drift fixtures (5×6=30) + judge prompt + probe-schema Zod gate (pre-commitment artifacts)
- [x] 09-02-PLAN.md — harness scaffolding (wilson re-export, types, judge, arm-summary, arm-transcript, runReplication)
- [x] 09-03-PLAN.md — verdict + aggregator + runner CLI + empty aggregator container files
- [x] 09-04-PLAN.md — synthetic ingest + run replications 1+2 (operator sanity-checkpoint after r1) + 09-RESULTS.md close-out

**Outcome:** Phase 9 verdict POSITIVE (pooled n=60 across 2 replications). Pooled Δ pass-rate +0.1667; Wilson Δ CI [+0.0038, +0.3434] — lower bound binds zero by 38 thousandths. Per-replication: r1 (s=14, t=18) and r2 (s=15, t=21) both INCONCLUSIVE individually; pooling cleared zero per CONTEXT decision 4. Bi-encoder-only baseline (cross-encoder fitness 56.0% < 60% post-backfill). Per-kind concentration in b/d/e (threshold-source/dependency-change/assumption drift); a/c flat. P10 engineering branch unlocked. Aggregator at `.planning/aggregates/deliberation-surfacing.{md,json}` populated with 3 BoundExperience entries (9-r1, 9-r2, 9-pooled-r1+r2).

### Phase 10: Conditional ship
**Goal**: Branch on P9 verdict and ship v6.0.0. Bound-positive lands the routing + assembly integration that surface transcript spans alongside summaries at retrieval time, extends Vesna with deliberation-engagement probes, runs all ship gates including WIR-01 inheritance, and tags v6.0.0. Bound-negative ships substrate alone (P8 work) with a KILL receipt in the Phase 2 shape and tags v6.0.0 with the kill leading the annotation. Either branch closes the milestone honestly.
**Depends on**: Phase 9 (verdict drives branch selection); Phase 8 substrate (already shipped regardless)
**Type**: engineering OR documentation (branches on P9 verdict)
**Requirements**: ROU-01, ROU-02, ROU-03, ASM-01, ASM-02, ASM-03 (engineering branch); WIR-01 inherited via WIR-02 phase coupling
**Success Criteria** (what must be TRUE):
  1. **If P9 bound-positive (engineering branch):** when retrieval surfaces an artifact reference (CONTEXT.md decision / SUMMARY.md outcome / learning / experience pattern / mental model / directive rule / critical rule), the system optionally fans out (opt-in per assembly site) to transcript chunks that informed that artifact — joined by `session_id` + time window from the artifact's creation timestamp; reranking uses the existing BGE-reranker-v2-m3 service (port 7439) with the bi-encoder fallback pattern Phase 1 established for episodic_events; routing budget caps prevent token bloat (top-K per artifact, max-K-per-query, configurable per assembly site, defaults locked during P8 substrate validation).
  2. **If P9 bound-positive (engineering branch):** assembly pipeline includes surfaced transcript spans formatted as labeled citations alongside their source artifact (e.g., "From session X turn 47, where Phase 2.1 KILL was decided: …") with `session_id` + `turn_index` so the agent can cite specifically; emits the advisory-narration line ("## Deliberation Surfaced — N spans from M sessions") consistent with Phase 7's "When You Recall — Narrate" discipline; token-budget cap on transcript-span content as a percentage of the assembly window (default locked during P8); bi-encoder-only retrieval surfaces lower-confidence spans with a smaller budget.
  3. **If P9 bound-positive (engineering branch):** Vesna grows from 21 to 24+ functional probes (deliberation-engagement extensions); WIR-01 production-shape integration test runs against the routing + assembly code paths on every DB shape currently in the wild and passes; full ship-gate suite passes (Vesna 100%, vitest, build, full suite, sc3, handoff pickup, bundle smoke, doctor); v6.0.0 annotated tag created locally; operator confirms public push at the v6.0.0 tag (same pattern as v5.0.0).
  4. **If P9 bound-negative (documentation branch):** v6.0.0 ships substrate alone (P8 work). A KILL receipt artifact in the Phase 2 shape lands at `.planning/reframes/2026-XX-XX-deliberation-surfacing-kill.md` documenting the bound-negative outcome, the locked decision rule that fired honestly, and what would have to change for a future revisit. CHANGELOG `[6.0.0]` entry leads with the kill. v6.0.0 annotated tag created locally; operator confirms public push.
  5. **Either branch:** P9 verdict is locked and audit-traceable to P9 CONTEXT.md's pre-committed decision rule; no goalpost shifts after seeing results; STATE.md flipped from v6-active to v6-validated; aggregator at `.planning/aggregates/deliberation-surfacing.{md,json}` is append-only and complete.
**Plans**: 4 plans (SHIPPED 2026-05-09 via /auto-execute-phase, engineering branch)
- [x] 10-01-PLAN.md — Routing layer: `routeFromArtifact` / `routeFromArtifacts` + `v6.routing.*` config + tests (ROU-01..03)
- [x] 10-02-PLAN.md — Assembly layer: `formatDeliberationSurface` + sections.ts wrapper + assembler.ts L2.5 opt-in + tests (ASM-01..03)
- [x] 10-03-PLAN.md — Vesna 21→26: 5 deliberation-engagement probes (a-e) + setup_step DSL extension + dispatcher
- [x] 10-04-PLAN.md — WIR-01 wire-test + 9/9 ship gates + CHANGELOG `[6.0.0]` + STATE/ROADMAP flip + v6.0.0 annotated tag (autonomous: false on the public push)

**Outcome:** Phase 10 SHIPPED 2026-05-09 (engineering branch — bound-POSITIVE verdict from P9 unlocked routing+assembly path). Routing layer landed (`src/retrieval/transcript-routing.ts` — bi-encoder primary; cross-encoder behind `v6.routing.reranker_mode` flag; artifact-kind-agnostic per CONTEXT decision 2). Assembly layer landed (`src/assembly/deliberation-surface.ts` — labeled citation format + advisory narration + asymmetric token budget per CONTEXT decision 3; opt-in via `FullAssemblyParams.deliberationSurfacing` + `appendDeliberationSurfaceToPayload` async helper at L2.5 cascade). Vesna 21→26 (5 deliberation-engagement probes a-e). WIR-01 wire-test against V17-collapsed + base-table fresh-DB fixtures (4 assertions × 2 fixture shapes = 8 sub-assertions). All 9 ship gates PASS. v6.0.0 annotated tag created locally; public push pending operator confirm. **Note (2026-05-09):** Pre-push Gemini consultation surfaced 3 verdict-invalidating methodology defects in P9 + 12 critical code regressions in P10 + 6 silent-failure modes in P8 ingestion — Phase 11 polish addresses all of them.

### Phase 11: Polish — land v6 properly
**Goal**: Close v6 once, correctly. The autonomous v6.0.0 tag from 2026-05-09 ~03:46 didn't survive pre-push review — the +0.0038 Wilson lower-bound bind is structurally invalid for three independent reasons (harness B-arm uses dense vector KNN while production routing uses temporal SQL hard-join; prong-2 rubric requires session_id/turn_index citations but A-arm context strips this metadata while B-arm is fed it; pooling treats r1+r2 as n=60 independent samples but they ran the same 30 probes — pseudoreplication), and the routing/assembly/ingestion paths have 13+ critical code regressions (3 assembly state-corruption bugs, 6 ingestion silent-failure modes, 2 routing non-throwing-contract violations, 1 chunker formatting destruction). Polish lands v6.0.0 *once*, with whatever annotation the corrected methodology produces.

**Internal wave structure** (sequential):

1. **W1 — Code regressions** _(engineering)_ — Fix the 13+ critical code findings from `.planning/audits/2026-05-09-v6-gemini-reviews/`. Includes: routing null-body coalescing + telemetry-bypass try/catch; assembly payload-spread + native-async + bi-encoder-budget surfacing; ingestion DELETE-then-INSERT idempotency + ghost-row cleanup + visible missing-file telemetry + bounded-chunk overflow split + format-preserving sub-chunker; chunker overhaul. Tests rewritten to assert visible failures (not enshrine silent successes). Production-shape integration tests against sanitized DB snapshot promoted to ship gate.

2. **W2 — Methodology fix** _(engineering)_ — Replace harness B-arm with direct call to production `routeFromArtifact`. Resolve prong-2 metadata starvation (give A-arm metadata OR remove the metadata-citation requirement). Replace pooling with paired McNemar's test on identical-probe pass/fail patterns OR run replications with disjoint probe pools. Wire 4-judge ensemble (Gemini-3-Flash + Claude Opus 4.7 + GLM-5.1 + Kimi-K2.6) with 3-of-4 majority + pre-committed 3-of-3 fallback if any judge errors >10% of probes. Audit probes a/c for parametric-knowledge confounds. Bake external-review gate into auto-orchestrate / auto-execute-phase skill (mandatory default for all engineering + empirical phase close-outs going forward).

3. **W3 — Re-bind + conditional ship** _(empirical OR documentation)_ — Run Q1 (within-corpus paired McNemar, locked 30-probe set) → if positive, run Q2 (disjoint-probe rebind on 60 fresh probes) → if positive, run Q3 (cross-corpus generalization on big-mozzy-v2 session log corpus). Author 11-RESULTS.md with verdict reflecting actual data. Tag v6.0.0 locally with annotation matching the verdict (positive bind / kill receipt / inconclusive triggers P11.1 corpus expansion + no tag). Operator-confirmed public push.

**Plans**: 8 plans across 3 waves (planned 2026-05-09 by `/auto-plan-phase 11`).

**Plans:**
8/8 plans complete
- [ ] 11-02-PLAN.md — Assembly fixes (4 Gemini findings: payload-spread for commitEffects, native-async, bi-encoder fallback annotation, token-budget pre-deduct) + regression tests [W1, POLISH-02]
- [ ] 11-03-PLAN.md — Ingestion fixes (6 Gemini findings) + test rewrites + test-discipline lint + sanitized production-shape snapshot + WIR-promoted integration test [W1, POLISH-03..06]
- [ ] 11-04-PLAN.md — Methodology fix: harness B-arm via routeFromArtifact + A-arm metadata parity + paired-McNemar verdict + 4-judge ensemble + P9 a/c parametric-knowledge audit [W2, POLISH-07..11]
- [ ] 11-05-PLAN.md — External-review-gate skill modification (auto-orchestrate + auto-execute-phase) + scripts/external-review-gate.cjs orchestrator [W2, POLISH-12]
- [ ] 11-06-PLAN.md — Q1: within-corpus paired-McNemar bind on locked 30 probes [W3, POLISH-13]
- [ ] 11-07-PLAN.md — Q2 (conditional on Q1 BIND_POSITIVE): disjoint-probe rebind on 60 fresh probes [W3, POLISH-14]
- [ ] 11-08-PLAN.md — Q3 (conditional on Q1+Q2 BIND_POSITIVE): cross-corpus on big-mozzy-v2 + 11-RESULTS.md authoring + v6.0.0 retag (operator-confirmed) + STATE/ROADMAP/REQUIREMENTS update [W3, POLISH-15..16]

**Spec**: `.planning/research/2026-05-09-v6-polish.md` (committed `a9fa77e`) — exhaustive with 6 locked decisions, pre-committed conditional outcomes, methodology gates promoted from this polish, and complete must-fix list mapping each Gemini finding to a wave/task.

**Audit trail**: `.planning/audits/2026-05-09-v6-gemini-reviews/` — 5 reviews (architecture, assembly, ingestion, harness, routing), 5 prompts, README with finding→Phase-11-task index.

**Outcome**: TBD. Pre-committed: positive bind ships v6.0.0 with corrected annotation; bound-negative ships substrate-only with kill receipt + v6.0.0 with kill leading; inconclusive triggers P11.1 corpus expansion at n=50+ on locked fixture-set with no v6.0.0 tag yet.

## Phase typing rationale

v6 is mostly engineering (P8 substrate, P10 engineering branch) bracketing a single empirical phase (P9). The empirical phase is the load-bearing question for the milestone; bound results determine whether P10 ships engineering or documentation. Auto-orchestrate runs each phase with discuss → plan → execute → user-approval flow.

The methodology proven by v5 Phase 2/2.1 (pre-committed decision rule, locked corpus, multiple bound measurements, append-only aggregator, descriptive-not-gating audits, Wilson/Newcombe CI binding) is **mandatory v5 standard practice** for v6's P9 empirical phase. The new live-wiring ship gate (WIR-01/02), promoted from the v5.0.0 silent-fail lesson, is **mandatory for every v6 engineering phase** — substrate (P8) and engineering branch of P10. WIR is anchored to P8 for traceability but functions as a cross-cutting gate; P10's engineering branch inherits the gate via WIR-02's "ship gates include WIR-01" phase coupling.

## v6 ship gates

Same eight gates as v5 ship-time, plus WIR-01 promoted to ninth-gate severity:

- **SC#1: Vesna** — 21/21 baseline preserved through P8; P10 engineering branch grows to 24+ with deliberation-engagement probes; bound-negative branch preserves 21/21.
- **SC#2: ≤500 token cache-stable** — preserved through ingestion-only P8; P10 engineering branch validates under transcript-span surface load.
- **SC#3: MEMORY.md content quality ≥80%** — preserved through P8; P10 engineering branch validates with transcript spans surfacing.
- **SC#4: Handoff pickup** — preserved through all v6 phases.
- **vitest integration** — substrate tests in P8; routing + assembly tests in P10 engineering branch.
- **build / full suite / sc3 / doctor / bundle smoke** — every phase ship.
- **WIR-01 (NEW): live-wiring against every production DB shape in the wild.** V17-collapsed at minimum, plus base-table fresh-DB. Mandatory for P8 and P10 engineering branch.

## Validation criteria — v6 specific

- **SC-V6-1: Ingestion substrate alive.** Every clean session close emits a transcript-chunk write batch; crash-killed sessions ingest via idle-sweep; chunks land with V25-matching provenance enum and wrapper-tagged content redacted at the boundary. Validated by P8 vitest integration tests + WIR-01 against V17-collapsed fixture.
- **SC-V6-2: V32 idempotent migration.** Migration runs on base-table fresh-DB and V17-collapsed shapes; no-op on already-V32 DBs; respects the v5.0.1 shape-agnostic discipline. Validated by P8 vitest migration tests against both fixture shapes.
- **SC-V6-3: Engagement metric bound (or honestly KILL'd).** P9 produces ≥2 bound replications with Wilson/Newcombe CI binding against the pre-committed decision rule; verdict drives P10 branch.
- **SC-V6-4: Deliberation surfaced (engineering branch only).** P10 engineering branch surfaces transcript spans alongside summaries with budget management; advisory narration line emitted; Vesna deliberation-engagement probes pass.

## Progress

**Execution Order:**
Phase 8 (substrate) → Phase 9 (empirical) → Phase 10 (conditional ship). Decimal phases (8.1, 9.1, etc.) may insert via `/gsd:insert-phase` for urgent fixes between integers.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Episode substrate | v5.0 | n/n | Complete | 2026-05-04 |
| 2. Multi-modal index seeds + density check | v5.0 | n/n | Complete (KILL) | 2026-05-04 |
| 2.1. Corpus-expansion rerun | v5.0 | n/n | Complete (KILL × 2) | 2026-05-05 |
| 3. Multi-handle retrieval cutover | v5.0 | — | Dropped | 2026-05-05 |
| 4. Angel reduction | v5.0 | 9/9 | Complete | 2026-05-05 |
| 5. Density-based abstraction | v5.0 | — | Dropped | 2026-05-05 |
| 6. Crash-resilient episode boundary | v5.0 | 5/5 | Complete | 2026-05-05 |
| 7. v4 coexistence / migration / ship | v5.0 | 5/5 | Complete | 2026-05-08 |
| 8. Transcript ingestion substrate | v6.0 | 5/5 | Complete | 2026-05-08 |
| 9. Empirical measurement | v6.0 | 4/4 | Complete (verdict invalidated post-hoc; see P11) | 2026-05-09 |
| 10. Conditional ship | v6.0 | 4/4 | Complete (regressions found post-hoc; see P11) | 2026-05-09 |
| 11. Polish — land v6 properly | 8/8 | Complete   | 2026-05-09 | started 2026-05-09 |
| 12. Real v6 structural marks | v6.0 | 9/9 | Complete | 2026-05-14 |
| 13. Organic Claudex | v6.0 | 6/6 | Complete (pending one-week deprecation window + operator-applied deletion of /starthere + /endsession from ~/.claude/skills/) | 2026-05-14 |

---

*Roadmap last updated: 2026-05-16 — Phase 14 (Substrate Coherence) SHIPPED as v6.6.0 (8/8 plans, AC-3 PASS noise 83% → 18%, zero new regressions outside v4-debt baseline). 14-07 deferred to v7.0.0 milestone (V17 ↔ legacy artifacts migration; spec authoring scheduled next session). Operator-gates pending: v6.0.0 + v6.6.0 public push.*
