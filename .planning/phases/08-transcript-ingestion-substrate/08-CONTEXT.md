# Phase 8: Transcript ingestion substrate - Context

**Gathered:** 2026-05-08
**Status:** Ready for planning

<domain>
## Phase Boundary

V32 schema bump + transcript-chunk write path + JSONL ingestion hook (firing on Phase 6's `clean_endsession` close marker) + redaction-at-ingestion via `parseWrappers` + WIR-01 live-wiring ship gate.

**Substrate-only.** No retrieval-side surface. No assembly integration. No artifact-to-transcript routing. Those are P10's problem (and only land if P9 binds positive).

**Requirements covered:** TRX-01, TRX-02, TRX-03, TRX-04, TRX-05, WIR-01, WIR-02.

**In scope:** ingestion pipeline, chunking, embedding, redaction, V32 migration, fresh vec0-backed table, full-archive backfill (async), reranker-fitness sanity check, WIR-01 production-shape integration tests.

**Out of scope (locked elsewhere or deferred):**
- Retrieval-side changes (P10).
- Engagement metric / decision rule (P9 — pre-committed there per v5 standard practice).
- Retention policy (post-v6 unless backfill scope blows budget; trivial at current ~1GB scale).
- Visibility/narration during retrieval (P10's assembly-side problem — Phase 7's "When You Recall — Narrate" applies there).

</domain>

<spec_locked>
## Spec-Locked Decisions (not up for discussion)

These are pre-committed by ROADMAP.md, REQUIREMENTS.md, or `.planning/research/2026-05-08-v6-deliberation-surfacing.md` and are inputs to planning, not decisions to revisit:

- **Hook point:** Phase 6's atomic `clean_endsession` close marker. No new boundary logic added.
- **Crash-killed sessions:** Ingest via the same idle-sweep path Phase 6 already implements (idle-sweep promotes to `clean_endsession`, ingestion fires from that — see decision 5 below for the timing semantics).
- **Redaction source:** Phase 1's `parseWrappers` — the source-of-truth for wrapper-tagged span detection (`<system-reminder>`, `<experience-data>`, `<file-content>`, `<command-message>`, etc.). Mem0-trap stays structurally closed at the new write surface — redaction at the boundary, no extraction-time abstraction.
- **Embedder:** Existing arctic-embed2 path (Ollama, snowflake-arctic-embed2, 1024d). No new embedding model.
- **Vector store:** sqlite-vec (vec0 virtual table) embedded in `~/.claudex/db/claudex.db`. Single-store discipline preserved.
- **Provenance enum:** Closed enum matching V25 (`organic | injected | tool_result | environmental`). CHECK constraint enforced at write surface.
- **Chunk metadata (mandatory):** `session_id`, `project_id`, `turn_index`, `role`, `created_at_epoch_ms`, `provenance`.
- **WIR-01 fixture set:** V17-collapsed at minimum, plus base-table fresh-DB. Tests run the *exported* function (`upsertChunk` or equivalent), not a mocked or `:memory:` DB. Failure blocks ship at Vesna severity.
- **WIR-02 ship-gate coupling:** Substrate ship gates include WIR-01 alongside the existing 8 (Vesna, vitest integration, build, full suite, sc3, handoff pickup, bundle smoke, doctor).
- **Vesna baseline:** 21/21 preserved through P8. No new probes added in P8 (deliberation-engagement probes are P10 engineering branch only, conditional on P9 verdict).
- **No retrieval-side surface:** v4 hybrid-retrieval pipeline unchanged; substrate is reusable regardless of P9 verdict.

</spec_locked>

<decisions>
## Implementation Decisions (locked during this discussion)

### 1. Chunk granularity (TRX-02)

**Lock:** Turn boundaries primary — one chunk per user/assistant turn, matching JSONL structure naturally.

**Sub-chunk rule:** Turns exceeding 1500 tokens are split at sentence boundaries to preserve retrieval precision. This codebase routinely produces 5000+ token assistant turns; un-split chunks would degrade reranker top-K behavior.

**Explicitly NOT investigating in P8:** tool-call-level chunking, fixed-token-window chunking. Added complexity for diminishing returns. Lock the simple discipline.

**Reasoning:** Matches v5's "store substrate, judge at retrieval" stance. Chunk size is for retrieval precision, not semantic-boundary cleverness — the reranker handles relevance. ROADMAP's TRX-02 names turn-level as default and permits investigation; we're closing the investigation here in favor of the simple rule.

### 2. Backfill scope (TRX-03)

**Lock:** Full archive — all projects, all sessions in the user's historical JSONL archive (~1000+ sessions, ~1GB plain text + embeddings).

**Constraint:** Ingestion runs **async / background**, not blocking. Embedding ~50k chunks via Ollama is a one-shot multi-hour cost. Plan it as a background job, not a CC-hook-blocking operation. Architectural prior art: Phase 6's `Angel.heartbeatTick` + chokidar watcher pattern — non-blocking long-running work supervised by Angel.

**Scopes rejected:**
- *Last 30d:* misses the v5 deliberation (Phases 1–7) we explicitly want to make engageable for P9.
- *claudex-v3 only:* loses cross-project pollination; P9 corpus needs richness.
- *Per-project:* same problem as above.

**Retention policy:** Deferred to v7+ per spec Q6. Trivial at current ~1GB scale. Revisit if storage growth becomes load-bearing.

### 3. transcript_chunk slot reuse vs. fresh vec0 table (TRX-05)

**Lock:** Fresh vec0-backed virtual table. Legacy `transcript_chunk` slot (~20 historical rows from pre-Phase-1 era) stays preserve-as-legacy, untouched, per Phase 7's CONTEXT decision 1.

**Naming:** Final name locked at plan-phase time. Suggested candidates: `transcript_chunk_v6`, `chunk_index`. Avoid `transcript_chunk` itself to keep legacy/new boundary unambiguous.

**Migration shape:** V32 is purely **additive** on both base-table fresh-DB and V17-collapsed shapes. No view rebuild required for the legacy `transcript_chunk` slot since we're not touching it. The new vec0 virtual table + companion metadata table land alongside, not on top of, the legacy slot.

**Reasoning:** Promoting the legacy slot would force the new V32 schema into the legacy shape and require view rebuilds on V17-collapsed DBs — exactly the surface the v5.0.1 lesson burned us on. Clean separation preserves V17-collapsed legacy semantics intact.

### 4. Reranker fitness gate (spec Q4)

**Lock:** In-scope during P8 substrate validation. Lightweight sanity check, not a full retrieval-quality study.

**Procedure:**
- Pick 50 representative transcript queries (drawn from past Phase 1–7 deliberation moments).
- Compare BGE-reranker-v2-m3 (cross-encoder, port 7439) scores vs. arctic-embed2 bi-encoder cosine on the same chunk pool.
- Sanity-check top-K stability.

**Pass criterion:** Reranker top-3 overlap with bi-encoder top-3 ≥ 60% on transcript chunks. Loose threshold — we're not validating retrieval quality (P9's job), only confirming the reranker doesn't catastrophically degrade on conversation-distribution data (BGE-v2-m3 was trained on web/document corpora, not conversation transcripts).

**Failure mode:** If BGE-v2-m3 fails this check on transcripts, P9 uses bi-encoder-only as baseline retrieval. **NOT a P8 ship blocker** either way — this is informational, sets P9's defaults.

### 5. Crash-killed session ingestion semantics (TRX-01)

**Lock:** Clean-only initially. Ingestion fires only when Phase 6 emits `clean_endsession` close marker.

**Crash-killed flow:** Phase 6's idle-sweep (pid-liveness check + heartbeat-staleness threshold) promotes orphaned sessions to `clean_endsession`. Ingestion fires from *that* event, not from idle-sweep detection time. So crash-killed sessions still ingest, just via the existing idle-sweep → clean_endsession path Phase 6 already ships.

**Partial ingestion (rejected initially):** Ingesting partial transcripts at idle-sweep detection time (mid-turn cuts, ambiguous reasoning state) creates retrieval-confounding chunks that pollute P9's measurement corpus. Conservative-by-default matches v6's store-substrate-judge-at-retrieval philosophy.

**Deferred to v6.x:** Partial-with-flag ingestion if P9 measurement surfaces a missing-content gap that would be closed by partials. Cheap to add later; expensive to retract from a poisoned corpus.

</decisions>

<additional_locks>
## Additional Architectural Locks

- **V32 schema bump number:** V32 is the next migration after V31 (Phase 7's last shape-agnostic discipline migration). Idempotent on already-V32 DBs. Respects both base-table and V17-collapsed shapes per the v5.0.1 lesson.
- **Ingestion-as-async-background-job pattern:** Cite Phase 6's `Angel.heartbeatTick` + chokidar watcher as architectural prior art for non-blocking long-running work. Backfill and per-session ingestion both run via Angel-supervised background tasks, not in-hook.
- **Hook deadlock discipline:** The CC hook that fires on `clean_endsession` enqueues the ingestion job and returns immediately. Never call CC's CLIProxyAPI from a hook. Embedding via Ollama, redaction via parseWrappers, and DB writes all happen out-of-band.
- **Fire-and-forget discipline:** The hook awaits its enqueue call. Only Angel/OpenClaw can fire-and-forget the actual embedding work.

</additional_locks>

<specifics>
## Specific Ideas

- **Reuse, don't reinvent:** v6 substrate is mostly already shipped per the spec (Phase 1 `episodic_events` provenance, Phase 6 atomic close marker, arctic-embed2 + sqlite-vec, BGE-reranker-v2-m3, parseWrappers). Net-new work is the ingestion pipeline + chunking + V32 schema + WIR-01 tests.
- **Live-wiring discipline from day 1:** v5.0.0 silent-fail lesson promoted WIR-01 to ship-gate severity. Tests must hit the *exported* function against real DB shapes, not mocks or `:memory:`. This is the gate that catches Mem0-trap regression at the new write surface.
- **Closed-enum CHECK on chunk provenance:** Structural impossibility, not just a code rule. Same V28/V31 trigger pattern Phase 1/4/7 used to close the Mem0-trap.

</specifics>

<deferred>
## Deferred Ideas

- **Tool-call-level and fixed-token-window chunking alternatives.** Decision 1 locked turn-boundary chunking with sentence-boundary sub-chunking on long turns. Alternatives investigated only if P9 measurement shows turn-level chunking is the binding constraint. Roadmap candidate: v6.x decimal phase if needed.
- **Partial-with-flag ingestion of crash-killed sessions.** Decision 5 locked clean-only. Revisit if P9 measurement shows missing-content gap that partials would close.
- **Retention policy / salience-weighted forgetting.** Spec Q6. Trivial at current scale. Roadmap candidate: v7+ when storage growth becomes load-bearing.
- **Reranker degradation mitigation beyond bi-encoder fallback.** Decision 4 locks bi-encoder-only as P9 baseline if BGE-v2-m3 fails the 60% overlap check on transcripts. Training/fine-tuning a conversation-distribution reranker is a v7+ research direction.
- **Visibility/narration during retrieval (spec Q5).** P10's assembly-side problem; Phase 7's "When You Recall — Narrate" discipline applies there.

</deferred>

---

*Phase: 08-transcript-ingestion-substrate*
*Context gathered: 2026-05-08*
