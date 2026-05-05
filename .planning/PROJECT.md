# Claudex

## What This Is

Claudex is a persistent memory system for LLM coding agents. **v4.0.0 SHIPPED 2026-04-30, v4.1.0 SHIPPED 2026-05-02** — internal infrastructure now distributed publicly on `github.com/grigorijejakisic/Claudex`. Built on SQLite + sqlite-vec + Ollama embeddings + BGE-reranker-v2-m3. v4 archived at `.planning/v4-final/`.

**Current milestone: v5 — Bound Multi-Modal Episodes (substrate-only after 2026-05-05 reframe).** The cognitive layer Claudex was missing — stop storing extracted rules, start storing bound experiences with provenance. The original thesis had three load-bearing legs (substrate + multi-handle recall + density abstraction). Phase 2/2.1 produced 3 consistent KILL bound experiences against legs 2 and 3 at our scale; the locked decision rule fired and those legs were dropped 2026-05-05. Leg 1 (substrate with provenance, shipped in Phase 1) survives. Recall in v5 stays on v4's hybrid-retrieval pipeline. Reframe: `.planning/reframes/2026-05-05-multi-handle-kill.md`.

## The Parable (Cognitive Frame)

A small child sees a stove for the first time, approaches, feels heat (warmth = positive), touches, burns its hand, cries. Mamma intervenes: *"don't touch hot stuff."* The child stores not *"rule: hot = bad"* but the **bound multi-modal record** — color of the stove, heat, pain, surprise, mamma's words. At recall, **any one modality** fires the whole memory: see red glow, fires; feel radiating heat, fires; hear "careful," fires. Over many similar moments, abstraction emerges naturally — *"hot stove burns"* → *"hot surfaces burn"* → *"things that radiate heat are dangerous unless I'm holding mamma."* **Pattern density does the work, not pre-codified rules.**

Source: session `b3e10b98-262b-4a56-814d-fae32726be60` turn 14 (verbatim user statement); turn 15 synthesis confirmed both ways. Locked here on 2026-05-04 after the previous "lock as CONTEXT.md framing" intent (turn 18) was lost between sessions — exactly the cross-session continuity failure v5 is designed to prevent.

Full framing: `.planning/research/2026-05-04-v5-bound-episodes-framing.md`. Engineering substrate: `.planning/research/2026-04-30-v5-episodic-memory.md`.

## Core Value (post-reframe 2026-05-05)

**v5 = Claudex stores bound multi-modal episodes with provenance.** That's the surviving thesis. Recall by any modality and abstraction-from-density were empirically rejected at our scale (3 consistent KILL bound experiences in `.planning/aggregates/multi-handle.json`); v5 keeps v4's hybrid-retrieval pipeline unchanged. Future milestones may revisit retrieval theses on Phase 1's substrate, under the methodology Phase 2/2.1 proved.

**Canonical example (still relevant):** when the agent was asked about the "child and stove parable" it took 5 turns of `claudex_search` archaeology because the parable was stored only as a synthesized abstract, not as a bound episode. Phase 1's provenance-tagged substrate makes the parable retrievable by direct key (session, project, topic). Whether *better* retrieval mechanics surface it more reliably is a question for future milestones — not v5.

## Current Milestone: v5 — Bound Multi-Modal Episodes

**Goal:** Replace v4's extract-and-store-rules architecture with bind-and-store-episodes, retrievable by multi-modal handles, with abstraction emerging from clusters at recall time rather than from upfront LLM extraction.

**Locked claims (post-reframe 2026-05-05):**

1. **Episode substrate is structured-by-modality** with provenance — SHIPPED Phase 1. Every event row carries `{type, ts, source, content, provenance}` minimum. Provenance tag (`organic | injected | tool_result | environmental`) is non-negotiable and structurally prevents the Mem0 feedback loop tactically patched in commit `0d0fbca`.
2. ~~**Recall is multi-handle.**~~ — **REJECTED 2026-05-05** by 3 consistent KILL bound experiences. v4's hybrid-retrieval (semantic + FTS + reranker) stays in production unchanged in v5.
3. ~~**Abstraction is density-driven, not extraction-driven.**~~ — **REJECTED 2026-05-05** by same 3 KILLs. Density at our scale measured at 0.2418 (threshold 0.30), repeatable across labelers — not noise, just below threshold. `experience_patterns` legacy reads stay live; no replacement abstraction in v5.
4. **Extraction-time pattern creation is dead under v5.** Phase 4 deletes it from `src/angel/pattern-extractor.ts`. The mechanism *itself* violates the parable (abstracts from N=1 experience), independent of whether multi-handle retrieval ever ships. The Mem0 fix from `0d0fbca` becomes structurally obsolete.
5. **The 2026-04-30 engineering research doc** remains valid as engineering reference for the substrate. The 2026-05-04 framing doc remains valid as the cognitive frame (the parable). Both docs are now annotated by the reframe — the parable's *epistemic discipline* is what we keep; the parable's *retrieval thesis at our scale* is what the data rejected.

**Target capability (post-reframe scope):**

- ✓ Event-log table (`episodic_events`) with provenance-tagged structured rows; coexists with `conversation_turns` (Phase 1 SHIPPED)
- ✗ Multi-modal indexes beyond semantic+FTS — error-fingerprint built and tested, KILL verdict; no further indexes pursued in v5
- ✗ Multi-handle retrieval / RRF fusion — dropped (thesis KILL)
- Angel reduction: delete extraction-time pattern creation (Phase 4 — surviving and sharpened)
- ✗ Density-based abstraction — dropped (thesis KILL)
- Crash-resilient episode boundary: Angel-as-source-of-truth for session-end via fsnotify + heartbeat + idle-sweep + PID liveness (Phase 6, engineering-doc Recommendation #1)
- v4 coexistence / migration plan: per-table decision (Phase 7 — narrowed: no multi-handle retrieval to migrate)

**Out of scope for v5:**

- Multi-harness support (Cursor/Zed adapters) — separate future milestone
- Hosted/SaaS variant — separate future milestone
- Privacy/PII redaction infrastructure (engineering-doc Recommendation #5) — captured as a sub-phase but the milestone-level lift is *the substrate*, not the privacy layer; revisit scope during phase 9 planning if it's larger than expected

## Requirements

See `REQUIREMENTS.md` for the requirements graph. Categories (post-reframe scope):

- **EPI** — Episode substrate (schema, write path, provenance tags) — **SHIPPED Phase 1**
- ~~**IDX**~~ — Multi-modal indexes — **investigation closed Phase 2/2.1, KILL × 3**
- ~~**RET**~~ — Multi-handle retrieval — **dropped 2026-05-05**
- ~~**ABS**~~ — Density-based abstraction — **dropped 2026-05-05**
- **AR** — Angel reduction (extraction-time pattern creation deletion) — Phase 4 NEXT
- **EBD** — Episode-boundary detection (crash-resilient session-end) — Phase 6
- **MIG** — v4 coexistence / migration — Phase 7 (narrowed)
- **VAL** — Validation (Vesna probes; VAL-03 transformed to KILL-regression probe) — Phase 7

## Empirical Methodology — v5 Standard Practice (promoted from Phase 2/2.1)

The Phase 2/2.1 discipline produced the honest KILL that drove the reframe. It is now the v5 standard for any future empirical phase:

1. **Pre-commit the decision rule** in CONTEXT.md before measurement runs. No goalpost shifts after seeing results.
2. **Lock the corpus and harness.** Same code, same data, same pair-set across replications.
3. **Multiple bound measurements before milestone-level claims** — append-only aggregator at `.planning/aggregates/{topic}.{md,json}`. One experience is not abstraction. The parable applies to ourselves.
4. **Wilson/Newcombe CI binding for noise rejection.** At small n, point-deltas of +5pp can be inside the CI of zero. Require the lower bound to bind.
5. **Descriptive-not-gating audits.** Agent autonomy on audit work; precision/recall metrics reported, not used as gates.
6. **Negative results are valid outputs.** "This didn't work, here's what we learned" is a successful empirical-phase outcome.

## Honest Uncertainties (post-reframe)

Resolved by Phase 2/2.1:

- ✗ ~~Density at our scale~~ — answered NO empirically (intra_project_share 0.2418 < 0.30 threshold, repeatable across labelers).
- ✗ ~~Multi-modal "any handle fires episode" at scale~~ — moot, multi-handle thesis dropped.
- ✗ ~~Query-time LLM cost~~ — moot, no query-time fusion in v5.
- ✗ ~~Whether the parable holds at engineering-scale~~ — answered partially: the *epistemic discipline* (density across measurements before abstraction) holds and was validated by being applied to ourselves. The *retrieval claim* (multi-modal handles + density-driven abstraction beat semantic-only) does not hold at our scale on this corpus.

Surviving for phase 4/6/7 execution:

1. **Angel reduction depends on a code trace** — `experience_patterns` reads scattered across `intelligence/`, `assembly/`, dashboard CLI. Trace before deletion (Phase 4 prerequisite).
2. **Episode boundary unit** — per-thread, per-intent-shift, per-task-completion — investigated during Phase 6 discuss.
3. **Per-table migration decisions** — `experience_patterns`, `learning`, `decision`, `mental_model`, `directive_rule`, `critical_rule`, `transcript_chunk`. Phase 7 discuss.
