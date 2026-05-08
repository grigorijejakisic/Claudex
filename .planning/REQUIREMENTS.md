# Requirements: Claudex

**Defined:** 2026-05-08 (v6 milestone)
**Active milestone:** v6 — Deliberation Surfacing
**Core Value:** v5 closed *lying-memory* (no fabricated patterns); v6 closes *lazy-memory* (no generic restatement of summaries). Surface the moments that produced decisions and lessons, not the summaries about them.
**Source spec:** `.planning/research/2026-05-08-v6-deliberation-surfacing.md` (committed `8d0477b`)

> **v4 requirements** (STOR / EXTR / INJ / RETR / CUR / FRAM / LIFE / DIR / HAND / TOK / CACH / OBS / ABL / VESN / LIC / DOC / PLAT / INST / DIAG / VER / REL) shipped at v4.0.0 (2026-04-30) and v4.1.0 (2026-05-02). Roll-up preserved at `.planning/v4-final/REQUIREMENTS.md`.
>
> **v5 requirements** (EPI / AR / EBD / MIG / VAL) shipped at v5.0.0 + v5.0.1 (2026-05-08). Categories closed without ship: IDX (KILL × 3), RET (dropped), ABS (dropped). Roll-up at the bottom of this file under "v5 Validated."

## v6 Requirements

Requirements for v6.0.0. Each maps to roadmap phases. Conditional outcomes pre-committed: bound-positive on engagement metric ships full v6.0.0; bound-negative ships substrate alone with KILL receipt (Phase 2 shape); inconclusive triggers corpus-expansion rerun (Phase 2.1 shape).

### Transcript Substrate (TRX)

Foundation layer. Ingestion + chunking + embedding. Hooks into Phase 6's `clean_endsession` close marker so substrate work piggybacks on shipped boundary detection.

- [ ] **TRX-01**: System ingests full session JSONL into a transcript-chunk store at the moment Phase 6 emits `clean_endsession`. Crash-killed sessions ingested via the same idle-sweep path Phase 6 already implements; no new boundary logic.
- [ ] **TRX-02**: System chunks ingested transcripts on natural boundaries (turn-level by default — one chunk per user/assistant turn — investigated against tool-call-level + fixed-token-window during P8 validation). Chunk metadata includes `session_id`, `project_id`, `turn_index`, `role`, `created_at_epoch_ms`, `provenance` (closed enum matching V25).
- [ ] **TRX-03**: System embeds each chunk via the existing arctic-embed2 path (Ollama) and lands the vector in a vec0-backed virtual table. Embeddings backfill from existing JSONL archive on first ingestion (scope decided during P8 planning — last 30d / per-project / full archive).
- [ ] **TRX-04**: System redacts wrapper-tagged content (`<system-reminder>`, `<experience-data>`, `<file-content>`, `<command-message>` etc.) at ingestion via Phase 1's `parseWrappers` source-of-truth. Mem0-trap stays structurally closed at the new write surface — no extraction-time abstraction, only redaction.
- [ ] **TRX-05**: System schema bumped to V32 with the transcript-chunk table promoted from the V17-preserved `transcript_chunk` slot (or an equivalent vec0-backed virtual table if the V17 slot is unsuitable). Idempotent migration; no-op on already-V32 DBs; respects both base-table and V17-collapsed shapes per the v5.0.1 lesson.

### Artifact-to-Transcript Routing (ROU)

The retrieval-time leverage point. Artifacts (CONTEXT.md decisions, SUMMARY.md outcomes, learnings, experience patterns) become *indexes* that point at *transcript spans*.

- [ ] **ROU-01**: When retrieval surfaces an artifact reference (decision / learning / experience pattern / mental model / directive rule / critical rule), the system optionally fans out to the transcript chunks that informed that artifact — joined by `session_id` + time window from the artifact's creation timestamp. Fan-out is opt-in per assembly site; not every retrieval surfaces transcripts.
- [ ] **ROU-02**: Reranking of fanned-out transcript spans uses the existing BGE-reranker-v2-m3 service (port 7439) — no new ranking algorithm. Bi-encoder fallback (arctic-embed2 cosine) on reranker unavailable, same degraded-mode pattern Phase 1 established for episodic_events.
- [ ] **ROU-03**: Routing budget caps prevent token bloat — top-K transcript spans per artifact reference, max-K-per-query budget across all referenced artifacts, configurable per assembly site. Defaults locked during P8 substrate validation.

### Assembly Integration (ASM)

Surface the moments to the agent at prompt-build time alongside the existing summaries.

- [ ] **ASM-01**: Assembly pipeline includes surfaced transcript spans in the prompt, formatted as labeled citations alongside their source artifact (e.g., "From session X turn 47, where Phase 2.1 KILL was decided: …"). Spans render with their `session_id` + `turn_index` so the agent can cite specifically.
- [ ] **ASM-02**: Assembly emits an advisory-narration line ("## Deliberation Surfaced — N spans from M sessions") consistent with the Phase 7 "When You Recall — Narrate" discipline. Visible to the agent; not a blocking gate.
- [ ] **ASM-03**: Token budget per assembly turn caps total transcript-span content as a percentage of the assembly window (default locked during P8). Bi-encoder-only retrieval surfaces lower-confidence spans with a smaller budget; reranker-confirmed spans get the full budget.

### Engagement Measurement (ENG)

The empirical phase. Pre-committed decision rule before any A/B run. Same shape as Phase 2/2.1.

- [ ] **ENG-01**: P9 CONTEXT.md pre-commits the engagement metric and decision rule before measurement begins. Primary candidate: drift-detection probes (synthetic cases where current state differs from the conditions that produced a past decision; summaries fail, transcripts pass). Decision rule: lower-CI of Δ(transcript − summary) > 0 across N probes via Wilson/Newcombe binding.
- [ ] **ENG-02**: P9 builds the engagement probe suite (drift-detection probes are mandatory; citation-density and specificity-contrast as secondary signals if time permits). Synthetic drift fixtures cover at least 5 distinct kinds of condition-shift (sample-size shift, scope expansion, dependency change, etc.).
- [ ] **ENG-03**: P9 locks the corpus + harness across replications (same code, same data, same probe-set). Replication runs append to `.planning/aggregates/deliberation-surfacing.{md,json}` per the v5 standard practice.
- [ ] **ENG-04**: P9 produces multiple bound measurements (≥2 replications minimum, more if first run is inconclusive). Wilson CI binding required for any milestone-level claim. Negative results trigger Phase-2-shape KILL receipt; substrate ships alone in P10.

### Live-Wiring Ship Gate (WIR)

Promoted from v5.0.0 silent-fail lesson. Mandatory gate for every v6 engineering phase, not a separate phase.

- [ ] **WIR-01**: Every v6 engineering phase ships a production-shape integration test that runs the actual production code path against fixtures matching every DB shape currently in the wild — V17-collapsed at minimum, plus base-table fresh-DB. Tests must run the *exported* function (e.g., `upsertChunk`, `routeFromArtifact`) against the fixture shape, not a mocked database.
- [ ] **WIR-02**: P8 substrate ship gates include WIR-01 alongside the existing 8 ship gates (Vesna, vitest integration, build, full suite, sc3, handoff pickup, bundle smoke, doctor). Wire-test failure blocks ship; same severity as Vesna failure.

## v7+ Requirements (deferred)

Acknowledged but not in v6 scope. Re-examined at v6 close.

### Retention Policy (RET-NEW)

- **RET-NEW-01**: Salience-weighted forgetting curve over transcript chunks (correlates with the "no selective-memory" gap surfaced in v6 spec)
- **RET-NEW-02**: Storage-cost trajectory management (transcript volume grows unbounded; retention layer required at ~10x current scale)

### Cross-Harness Transcript Sources (XHN)

- **XHN-01**: Ingest Codex / Aider / Gemini-CLI transcripts with the same vectoring substrate (cross-agent-session indexing already exists in Angel's `cross-agent-sessions`; extend to deliberation surfacing)

### Multi-Modal Surfaces (MMS)

- **MMS-01**: Surface non-text modalities (tool-call sequences, file diffs, screenshots) alongside transcript spans — extends the parable's "any modality fires the whole memory" intuition without reviving the killed multi-handle-fusion thesis

## Out of Scope (v6)

Explicit exclusions. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Multi-handle recall (any-modality-fires-whole-memory at retrieval) | KILLED in v5 by 3 KILL bound measurements at our scale. Not revived in v6. |
| Density-based abstraction (offline cluster-emergent patterns) | KILLED in v5. Not revived in v6. |
| Extraction-time pattern creation from transcripts | Mem0-trap re-opening. Phase 4 + V28 + V31 disciplines stay closed. v6 stores raw transcripts; never abstracts at write time. |
| New retrieval algorithm (vector ranking, fusion math, query rewriting) | v6 uses conventional v4 hybrid-retrieval applied to a different corpus. The bet is the *substrate shift*, not the ranking. |
| Multi-harness adapters (Cursor, Zed) | Separate future milestone — substrate must work for CC first. |
| Hosted/SaaS variant | Separate future milestone. |
| Full retention-policy / forgetting-curve layer | v7+ (deferred). v6 is append-only; growth manageable through v6.x lifecycle. |
| Privacy/PII redaction beyond wrapper-tag stripping | v6 inherits Phase 1 redaction discipline. Full PII layer is a v7+ scope question. |

## Traceability

Filled by roadmapper during step 10. Updated through phase execution.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TRX-01 | Phase 8 | Pending |
| TRX-02 | Phase 8 | Pending |
| TRX-03 | Phase 8 | Pending |
| TRX-04 | Phase 8 | Pending |
| TRX-05 | Phase 8 | Pending |
| ROU-01 | Phase 10 | Pending |
| ROU-02 | Phase 10 | Pending |
| ROU-03 | Phase 10 | Pending |
| ASM-01 | Phase 10 | Pending |
| ASM-02 | Phase 10 | Pending |
| ASM-03 | Phase 10 | Pending |
| ENG-01 | Phase 9 | Pending |
| ENG-02 | Phase 9 | Pending |
| ENG-03 | Phase 9 | Pending |
| ENG-04 | Phase 9 | Pending |
| WIR-01 | Phase 8 + Phase 10 | Pending |
| WIR-02 | Phase 8 | Pending |

**Coverage:**
- v6 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0 ✓

## v5 Validated (closed 2026-05-08)

For historical reference. v5 milestone CLOSED.

### EPI — Episode substrate (Phase 1)
- ✓ V25 episodic_events table, structured rows, provenance enum, dual-write helpers, V28 BEFORE INSERT trigger blocking new experience_patterns rows

### AR — Angel reduction (Phase 4)
- ✓ Extraction-time pattern creation deleted across 3 sites, V28 trigger structural, classifySessionDomains relocated, three-layer cutoff

### EBD — Episode-boundary detection (Phase 6)
- ✓ V29 schema (episode_boundary_cursor + sessions liveness), chokidar JSONL watcher, heartbeat hooks, atomic clean_endsession close marker, boundary detector with re-open + offset-overflow recovery

### MIG — v4 coexistence / migration (Phase 7)
- ✓ V30 learnings.provenance, parseWrappers write-path filter, 10 reader-comment downgrades, CHANGELOG v5.0.0 entry, V31 view-mode hot-fix in v5.0.1

### VAL — Validation (Phase 7)
- ✓ Vesna 21/21 (3 new probes: episodic-recall-001/002, learnings-injected-guard-001) + 3 vitest integration tests + 8 ship gates

### Closed without ship

- ~~IDX-01..04~~ — Multi-modal indexes — investigation closed Phase 2/2.1, KILL × 3
- ~~RET-01..05~~ — Multi-handle retrieval — Phase 3 dropped 2026-05-05
- ~~ABS-01..04~~ — Density-based abstraction — Phase 5 dropped 2026-05-05

---
*Requirements defined: 2026-05-04 for v5 (now closed); 2026-05-08 for v6.*
*Last updated: 2026-05-08 after v6 milestone kickoff.*
