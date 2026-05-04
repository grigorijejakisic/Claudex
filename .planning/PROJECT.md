# Claudex

## What This Is

Claudex is a persistent memory system for LLM coding agents. **v4.0.0 SHIPPED 2026-04-30, v4.1.0 SHIPPED 2026-05-02** — internal infrastructure now distributed publicly on `github.com/grigorijejakisic/Claudex`. Built on SQLite + sqlite-vec + Ollama embeddings + BGE-reranker-v2-m3. v4 archived at `.planning/v4-final/`.

**Current milestone: v5 — Bound Multi-Modal Episodes.** The cognitive layer Claudex was missing: stop storing extracted rules, start storing bound experiences with multi-modal recall handles.

## The Parable (Cognitive Frame)

A small child sees a stove for the first time, approaches, feels heat (warmth = positive), touches, burns its hand, cries. Mamma intervenes: *"don't touch hot stuff."* The child stores not *"rule: hot = bad"* but the **bound multi-modal record** — color of the stove, heat, pain, surprise, mamma's words. At recall, **any one modality** fires the whole memory: see red glow, fires; feel radiating heat, fires; hear "careful," fires. Over many similar moments, abstraction emerges naturally — *"hot stove burns"* → *"hot surfaces burn"* → *"things that radiate heat are dangerous unless I'm holding mamma."* **Pattern density does the work, not pre-codified rules.**

Source: session `b3e10b98-262b-4a56-814d-fae32726be60` turn 14 (verbatim user statement); turn 15 synthesis confirmed both ways. Locked here on 2026-05-04 after the previous "lock as CONTEXT.md framing" intent (turn 18) was lost between sessions — exactly the cross-session continuity failure v5 is designed to prevent.

Full framing: `.planning/research/2026-05-04-v5-bound-episodes-framing.md`. Engineering substrate: `.planning/research/2026-04-30-v5-episodic-memory.md`.

## Core Value

**v5 = Claudex stores bound multi-modal episodes; recall is by any modality; abstraction emerges from density.**

That's the whole thesis. Everything else — substrate format, projection model, session-end detection, privacy scoping, multi-modal indexing — is plumbing for this idea.

**Canonical example:** today, when the agent in this session was asked about the "child and stove parable" it took 5 turns of `claudex_search` archaeology because the parable was stored only as a synthesized abstract, not as a bound episode. Under v5, the keyword "child" or "parable" or "v5 framing" would have fired the whole conversation back as a single recall event.

## Current Milestone: v5 — Bound Multi-Modal Episodes

**Goal:** Replace v4's extract-and-store-rules architecture with bind-and-store-episodes, retrievable by multi-modal handles, with abstraction emerging from clusters at recall time rather than from upfront LLM extraction.

**Locked claims (2026-05-04 framing-doc commit):**

1. **Episode substrate is structured-by-modality**, not flat text. Every event row carries `{type, ts, source, content, provenance}` minimum. Provenance tag (`organic | injected | tool_result | environmental`) is non-negotiable — that's the structural fix for the Mem0 feedback loop tactically patched in commit `0d0fbca`.
2. **Recall is multi-handle.** Any modality can fire an episode. No single canonical query path. Today's semantic-only retrieval is one handle of many.
3. **Abstraction is density-driven, not extraction-driven.** Patterns are not pre-stored as rules; they emerge from clusters of episodes at recall time.
4. **The 2026-04-30 engineering research doc is plumbing for this, not the thesis.** It remains valid as engineering reference; the framing doc supersedes it as the cognitive frame.
5. **Most of v4's `src/angel/pattern-extractor.ts` is dead-code under v5.** The Mem0 fix from 2026-05-04 stops the bleeding; v5's binding-substrate prevents the wound.

**Target capability (subject to refinement during phase planning):**

- New event-log table (working name: `episodic_events`) with provenance-tagged structured rows; coexists with `conversation_turns` initially, supersedes for retrieval purposes
- Multi-modal indexes beyond semantic+FTS: error-fingerprint, structural-shape, affect-signal, speaker-typed (each a small specialized retrieval surface)
- Multi-handle retrieval: hybrid fusion across all live indexes, with provenance-aware extraction filtering
- Angel reduction: delete LLM-extraction at write-time; LLM moves to query-time density-fusion if needed (or embedding-only path if cost demands)
- Density-based abstraction: cluster episodes that fire together; surface clusters that exceed thresholds as inferred (non-stored) patterns
- Crash-resilient episode boundary: Angel-as-source-of-truth for session-end via fsnotify + heartbeat + idle-sweep + PID liveness (engineering-doc Recommendation #1)
- v4 coexistence / migration plan: existing 88 experience_patterns + 191 learnings + 126 decisions + 659 mental_models — migrate, re-derive, or coexist? Decided per-category during phase planning.

**Out of scope for v5:**

- Multi-harness support (Cursor/Zed adapters) — separate future milestone
- Hosted/SaaS variant — separate future milestone
- Privacy/PII redaction infrastructure (engineering-doc Recommendation #5) — captured as a sub-phase but the milestone-level lift is *the substrate*, not the privacy layer; revisit scope during phase 9 planning if it's larger than expected

## Requirements

See `REQUIREMENTS.md` for the requirements graph. Categories (initial scope, refinable during phase planning):

- **EPI** — Episode substrate (schema, write path, provenance tags)
- **IDX** — Multi-modal indexes (error-fingerprint, structural, affect, speaker)
- **RET** — Multi-handle retrieval (fusion, provenance filtering)
- **ABS** — Density-based abstraction (clustering, surfacing)
- **AR** — Angel reduction (LLM extraction removal, replacement architecture)
- **EBD** — Episode-boundary detection (crash-resilient session-end)
- **MIG** — v4 coexistence / migration
- **VAL** — Validation (Vesna probes, density at scale, multi-handle recall behavior)

## Honest Uncertainties (locked from 2026-05-04 conversation)

These are **not** architectural blockers — they are empirical/engineering questions that get resolved during phase execution:

1. **Angel reduction depends on a code trace** — `experience_patterns` reads scattered across `intelligence/`, `assembly/`, dashboard CLI. Trace before deletion.
2. **Density at our scale** — Stanford Generative Agents had hundreds of observations per NPC; we have ~9K observations across 1,001 sessions and 6 active projects. Whether density-driven abstraction surfaces signal vs noise is empirical.
3. **Multi-modal "any handle fires episode" at scale** — works for one burn memory; we'll have thousands. Suppression / ranking / dampening rules are tuning work.
4. **Query-time LLM cost** — moving extraction from post-hoc (offline, cheap-ish) to recall-time (hot path) shifts cost profile. Local model? Embedding-only? Per-phase decision.
5. **Whether the parable holds at engineering-scale** — strong cognitive frame, well-grounded, but unproven on our substrate. Empirical phases must allow "this didn't work as theorized" as a valid outcome.

These five inform per-phase scoping; they are NOT a list of risks to mitigate before starting. They are surfaced here so phase teammates know what's known-uncertain vs. locked.
