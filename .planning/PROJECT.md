# Claudex

## What This Is

Claudex is a persistent memory system for LLM coding agents. **v4.0.0 SHIPPED 2026-04-30, v4.1.0 SHIPPED 2026-05-02, v5.0.0 + v5.0.1 SHIPPED 2026-05-08** — internal infrastructure now distributed publicly on `github.com/grigorijejakisic/Claudex`. Built on SQLite + sqlite-vec + Ollama embeddings + BGE-reranker-v2-m3. v4 archived at `.planning/v4-final/`.

**Current milestone: v6 — Deliberation Surfacing.** v5 closed the *lying-memory* surface (no fabricated patterns, structurally impossible Mem0 trap on every preserved write surface). v6 closes the *lazy-memory* surface (retrieval surfaces summaries; agents apply them generically; the agent doesn't *think*, it *restates*). Surface the **moment** at retrieval time (the transcript span where a decision was forged, where a lesson was learned) instead of the summary about the moment. Spec: `.planning/research/2026-05-08-v6-deliberation-surfacing.md`.

## The Parable (Cognitive Frame)

A small child sees a stove for the first time, approaches, feels heat (warmth = positive), touches, burns its hand, cries. Mamma intervenes: *"don't touch hot stuff."* The child stores not *"rule: hot = bad"* but the **bound multi-modal record** — color of the stove, heat, pain, surprise, mamma's words. At recall, **any one modality** fires the whole memory: see red glow, fires; feel radiating heat, fires; hear "careful," fires. Over many similar moments, abstraction emerges naturally — *"hot stove burns"* → *"hot surfaces burn"* → *"things that radiate heat are dangerous unless I'm holding mamma."* **Pattern density does the work, not pre-codified rules.**

Source: session `b3e10b98-262b-4a56-814d-fae32726be60` turn 14 (verbatim user statement); turn 15 synthesis confirmed both ways. Locked here on 2026-05-04 after the previous "lock as CONTEXT.md framing" intent (turn 18) was lost between sessions — exactly the cross-session continuity failure v5 is designed to prevent.

**v6 framing of the parable:** the child doesn't apply a stored rule when seeing a new stove — they relive the moment of burning, and *that* governs behavior. Experiential recall beats propositional recall. v5 shipped *storing* the experience (Phase 1 episodic_events). v5 did **not** ship *recalling* the experience for *deliberation* and *lessons*. Layer 1 (rules) was solved by Critical Reminders (Session 44, decisions `106`/`110`) — proven in production. Layers 2 (decisions) and 3 (lessons) are v6.

Full framing: `.planning/research/2026-05-04-v5-bound-episodes-framing.md`. Engineering substrate: `.planning/research/2026-04-30-v5-episodic-memory.md`. v6 spec: `.planning/research/2026-05-08-v6-deliberation-surfacing.md`.

## Core Value

**v5 = Claudex stores bound multi-modal episodes with provenance** (the substrate). **v6 = Claudex surfaces the moments that produced decisions and lessons, not just the summaries about them** (the engagement). Recall by any modality and abstraction-from-density were empirically rejected at our scale by 3 KILL bound experiences in `.planning/aggregates/multi-handle.json`; v5 keeps v4's hybrid-retrieval pipeline unchanged. v6 uses conventional v4 hybrid-retrieval (semantic + FTS + reranker) applied to a different corpus (transcript chunks) — no new retrieval theses; the bet is the *substrate shift*, not the ranking algorithm.

**Two failure modes Claudex closes:**

| Surface | Closed by | Status |
|---|---|---|
| **Lying memory** — fabricated patterns from sparse signal (Mem0 trap) | v5: provenance enum + Phase 4 extraction-time deletion + V28/V31 structural triggers | SHIPPED 2026-05-08 |
| **Lazy memory** — generic restatement of summaries instead of engagement with moments | v6: transcript-as-substrate + artifact-vectored retrieval | ACTIVE |

## Current Milestone: v6 — Deliberation Surfacing

**Goal:** Make the agent *touch the stove, not be told about it* — extend the Critical Reminders principle (Layer 1, shipped) from rules to deliberation (Layer 2) and lessons (Layer 3). Surface the verbatim moments that produced decisions and crystallized lessons at retrieval time, not the summaries about them.

**Locked claims (from v6 spec):**

1. **v6 is not a new bet.** Critical Reminders proved the parable at Layer 1 in production (Session 44 → decisions `106`/`110` → learning `aee9461`). v6 extends a proven principle to two more layers. Risk asymmetric.
2. **v5 KILLs are honored.** v6 does NOT revive multi-handle recall (KILLED) or density-based abstraction (KILLED). Conventional v4 hybrid-retrieval applied to a different corpus.
3. **No extraction-time abstraction.** Mem0-trap stays structurally closed. parseWrappers + V28 + V31 disciplines apply at the new ingestion surface — redaction at the boundary, no fabricated structure.
4. **Empirical methodology promoted from v5 applies.** Pre-committed decision rule, locked corpus, Wilson CI binding for any v6 retrieval claim. Negative results valid outputs.
5. **New mandatory ship gate.** Live-wiring smoke against every production DB shape currently in the wild — learned from v5.0.0 silent-fail on V17-collapsed DBs.

**Target capability:**

- Transcript ingestion pipeline hooked into Phase 6's `clean_endsession` close marker; chunk on natural boundaries (turn / tool-call); embed via existing arctic-embed2; land in vec0 + FTS5
- Artifact → transcript routing: when retrieval surfaces a CONTEXT.md decision, SUMMARY.md outcome, learning, or experience pattern, optionally fan out to the transcript chunks that informed it
- Assembly integration: surface transcript spans alongside summaries with budget management
- Engagement measurement methodology: drift-detection probes (primary binding signal), with citation-density / specificity-contrast as secondary signals
- Conditional ship: bound-positive ships full v6.0.0; bound-negative ships substrate alone with KILL receipt (Phase 2 shape)

**Out of scope for v6:**

- Multi-harness support (Cursor/Zed adapters) — separate future milestone
- Hosted/SaaS variant — separate future milestone
- Full retention-policy / forgetting-curve layer (open question #6 in spec) — defer to v7+
- Reviving any killed v5 thesis (multi-handle, density abstraction)
- Offline pattern extraction from transcripts (Mem0-trap re-opening)

## Previous Milestone: v5 — Bound Multi-Modal Episodes (substrate-only)

**SHIPPED 2026-05-08.** v5.0.0 + v5.0.1 tagged on origin.

- Phase 1 (V25 episodic_events with provenance) SHIPPED 2026-05-04
- Phase 2 + 2.1 (multi-handle index seeds + density-at-scale): KILL × 3 (decision rule fired honestly)
- Phase 3 (multi-handle retrieval cutover): DROPPED 2026-05-05
- Phase 4 (Angel reduction — extraction-time pattern deletion + V28 structural trigger): SHIPPED 2026-05-05
- Phase 5 (density-based abstraction): DROPPED 2026-05-05
- Phase 6 (V29 crash-resilient episode boundary + chokidar watcher + heartbeat hooks + atomic close marker): SHIPPED 2026-05-05
- Phase 7 (V30 learnings.provenance + parseWrappers write-path filter + 10 reader-comment downgrades + 3 Vesna probes + 3 vitest integration tests + CHANGELOG): SHIPPED 2026-05-08
- v5.0.1 hot-fix (V31 view-mode learnings.provenance + shape-agnostic upsertLearning + live-wiring regression test): SHIPPED 2026-05-08

Reframe artifact: `.planning/reframes/2026-05-05-multi-handle-kill.md`. Aggregator: `.planning/aggregates/multi-handle.json`.

## Requirements

See `REQUIREMENTS.md` for the requirements graph. Categories:

### v6 Active (this milestone)

- **TRX** — Transcript substrate (ingestion, chunking, embedding, table promotion)
- **ROU** — Artifact-to-transcript routing (retrieval-time fan-out from artifact references to informing transcript chunks)
- **ASM** — Assembly integration (surfacing transcript spans + budget management + advisory narration)
- **ENG** — Engagement measurement (drift-detection probes; pre-committed decision rule; locked corpus)
- **WIR** — Live-wiring ship gate (production-shape integration test against every DB shape in the wild)

### v5 Validated (shipped 2026-05-08)

- **EPI** — Episode substrate (schema + write path + provenance tags) — Phase 1
- **AR** — Angel reduction — Phase 4
- **EBD** — Episode-boundary detection — Phase 6
- **MIG** — v4 coexistence / migration — Phase 7
- **VAL** — Validation (Vesna 21/21) — Phase 7

### Closed without ship (v5)

- ~~**IDX**~~ — Multi-modal indexes — investigation closed Phase 2/2.1, KILL × 3
- ~~**RET**~~ — Multi-handle retrieval — dropped 2026-05-05
- ~~**ABS**~~ — Density-based abstraction — dropped 2026-05-05

## Empirical Methodology — v5 Standard Practice (mandatory in v6)

The Phase 2/2.1 discipline produced the honest KILL that drove the v5 reframe. It is now mandatory for any v6 empirical phase:

1. **Pre-commit the decision rule** in CONTEXT.md before measurement runs. No goalpost shifts after seeing results.
2. **Lock the corpus and harness.** Same code, same data, same pair-set across replications.
3. **Multiple bound measurements before milestone-level claims** — append-only aggregator at `.planning/aggregates/{topic}.{md,json}`. One experience is not abstraction.
4. **Wilson/Newcombe CI binding for noise rejection.** At small n, point-deltas of +5pp can be inside the CI of zero. Require the lower bound to bind.
5. **Descriptive-not-gating audits.** Agent autonomy on audit work; precision/recall metrics reported, not used as gates.
6. **Negative results are valid outputs.** "This didn't work, here's what we learned" is a successful empirical-phase outcome.

## New Mandatory Ship Gate (promoted from v5.0.0 silent-fail lesson)

**Live-wiring smoke against every production DB shape currently in the wild.** v5.0.0 shipped a Phase 7 contribution (learnings.provenance discipline) that silently failed on V17-collapsed DBs because the integration test ran against a fresh `:memory:` DB shape, not the production shape. v5.0.1 closed the bug (V31 + shape-agnostic upsertLearning + V17-fixture regression test). v6 promotes the lesson: every engineering phase must include "production-shape integration test against every DB shape currently in the wild" alongside unit/integration tests. V17-collapsed at minimum.

## Honest Uncertainties (v6)

Open questions before any v6 phase plan:

1. **Engagement metric operationalization.** Drift-detection probes (strongest case, requires synthetic drift fixtures) is the primary candidate. Citation density and specificity contrast are secondary signals. Decision rule must lock at P2 CONTEXT.md before measurement runs.
2. **Chunk granularity** — turn boundaries, tool-call boundaries, or fixed token windows. Each has different retrieval/specificity tradeoffs. Investigated during P1 substrate validation.
3. **Backfill scope** — full historical JSONL archive (~1000 sessions) or scoped (last 30d / per-project). Cost vs. coverage; settled during P1 planning.
4. **Reranker fitness** — BGE-v2-m3 trained on web/document corpora; transcript chunks are different distribution. Measure as part of P1 substrate validation, not P2 empirical.
5. **Citation narration** — when surfacing transcript spans, indicate "citing turn N of session X." Connects to the Phase 7 advisory-narration discipline.
6. **Storage cost trajectory + retention** — ~1GB plain text + embeddings unbounded growth. v6 may need a retention-policy layer; defer to v7+.

---
*Last updated: 2026-05-08 after v5 closure + v6 milestone kickoff.*
