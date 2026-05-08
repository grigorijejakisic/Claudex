# Roadmap: Claudex — v6 Deliberation Surfacing

## Milestones

- ✅ **v4.0 / v4.1** — Phases 1-? (shipped 2026-04-30 / 2026-05-02; archived at `.planning/v4-final/`)
- ✅ **v5.0 / v5.0.1 — Bound Multi-Modal Episodes (substrate-only)** — Phases 1-7 (shipped 2026-05-08; tagged on origin)
- 🚧 **v6.0 — Deliberation Surfacing** — Phases 8-10 (active, kicked off 2026-05-08)

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

### 🚧 v6.0 Deliberation Surfacing (In Progress)

**Milestone Goal:** Surface the verbatim moments that produced decisions and crystallized lessons at retrieval time, not the summaries about them. Make the agent touch the stove, not be told about it.

- [ ] **Phase 8: Transcript ingestion substrate** _(type: engineering)_ — Foundation layer. V32 schema bump + transcript-chunk write path + JSONL ingestion hook + redaction-at-ingestion + WIR live-wiring ship gate.
- [ ] **Phase 9: Empirical measurement** _(type: empirical)_ — Pre-committed decision rule + locked corpus + drift-detection probe suite + ≥2 bound replications + Wilson/Newcombe CI binding + aggregator at `.planning/aggregates/deliberation-surfacing.{md,json}`.
- [ ] **Phase 10: Conditional ship** _(type: engineering OR documentation)_ — Branches on P9 verdict. Bound-positive: routing + assembly + Vesna probe extension + ship gates + v6.0.0 tag. Bound-negative: KILL receipt (Phase 2 shape) + substrate-alone ship + v6.0.0 tag with kill leading annotation.

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
**Plans**: TBD (locked at plan-phase time)

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
**Plans**: TBD (locked at plan-phase time)

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
**Plans**: TBD (locked at plan-phase time after P9 verdict)

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
| 8. Transcript ingestion substrate | v6.0 | 0/TBD | Not started | - |
| 9. Empirical measurement | v6.0 | 0/TBD | Not started | - |
| 10. Conditional ship | v6.0 | 0/TBD | Not started | - |

---

*Roadmap last updated: 2026-05-08 after v6 milestone kickoff.*
