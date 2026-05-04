# Roadmap: Claudex v5 — Bound Multi-Modal Episodes

## Overview

Seven phases. The architectural commit (parable + thesis) is locked in `.planning/research/2026-05-04-v5-bound-episodes-framing.md` and PROJECT.md. This roadmap is the **execution sketch** — phase boundaries are reasonable hypotheses, not guarantees. The user-approval gate between phases is the iteration loop. Phases marked `type: empirical` are explicitly investigations: their CONTEXT.md frames success as measurable hypotheses, their PLAN.md include measurement protocols, their SUMMARY.md may legitimately report "this didn't work, here's what we learned" as a successful outcome.

The substrate phases (1, 3, 6) ship engineering. The empirical phases (2, 5) prove the parable holds at our scale before we commit further. Phases 4 and 7 are coordinated cleanup — Angel reduction (4) requires the substrate (1, 3) to be live; v4 migration (7) requires the new path to be validated (5).

**Status legend:**
- `[ ]` Pending
- `[x]` Complete
- `[~]` Partial-with-followups
- `type: engineering` — discuss → plan → execute, ship feature
- `type: empirical` — discuss → plan → measure, ship learning (which may include negative results)

## Phases

- [x] **Phase 1: Episode substrate** _(type: engineering)_ — SHIPPED 2026-05-04

    Schema design + write path. New `episodic_events` table with `{id, ts, session_id, type, source, content, provenance, ...}`. Provenance tags: `organic | injected | tool_result | environmental`. Coexists with `conversation_turns` initially — every UserPromptSubmit, every Stop hook, every tool result writes a parallel event row with structured fields. Migration is forward-only; old conversation_turns remain as legacy. Goal: a clean substrate to build the rest on, with the Mem0 trap structurally impossible because injected spans are tagged at write time.

    **Outcome:** V25 migration with 4 indexes + closed-enum `provenance` CHECK; helpers `dualWriteUserPrompt`/`dualWriteAssistantMessage`/`writeToolResult`/`writeEnvironmentalEvent` in `src/core/episodic-events.ts`; PostToolUse + session-start + session-end + Angel heartbeat instrumented; 60+ EPI-tagged tests including stub-extractor proof of EPI-07 Mem0-trap-impossibility; substrate operator README + environmental audit at `.planning/phases/01-episode-substrate/`. Vesna 17/17 preserved.

- [ ] **Phase 2: Multi-modal index seeds + density-at-scale check** _(type: empirical)_

    Investigation phase. Pick **one** non-semantic index and prove it works on a small corpus. Recommended starter: error-fingerprint (token-shingle + edit-distance over stack traces). Build it on Phase 1's substrate, populate with 30–50 episodes from real Claudex sessions, measure: (a) does the index fire on similar errors? (b) when fired alongside semantic recall, does fusion improve precision/recall? (c) at the scale of our episode corpus (~9K observations across projects), is density a meaningful signal or pure noise? Output is a measurement report. **Negative result is a valid output** — if error-fingerprint doesn't justify its complexity, scope it down or pivot before phase 3 builds on it.

- [ ] **Phase 3: Multi-handle retrieval cutover** _(type: engineering)_

    Replace `src/core/hybrid-retrieval.ts` fusion with episode-based multi-handle retrieval. Every recall path queries N indexes (semantic, FTS, plus the validated Phase 2 starters), fuses by RRF or learned weights, applies provenance filter (suppress injected-span hits when extracting / when matching against current organic content). Cut over `experience_warning_triggers` and the assembly pipeline's experience-pattern injection to fire from episodes-by-handle, not from extracted rules. Existing `experience_pattern` rows remain readable but become a deprecation surface.

- [ ] **Phase 4: Angel reduction** _(type: engineering with code-trace prerequisite)_

    Trace dependencies of `src/angel/pattern-extractor.ts` and the `experience_patterns` table across `intelligence/`, `assembly/`, dashboard CLI, observability surfaces. Anything that reads from those structures gets either: (a) re-pointed at the new episode-based retrieval, or (b) preserved as a legacy read path with a TODO. Then delete extraction-time pattern creation. The Angel writes episodes (Phase 1) and indexes (Phase 2/3) but **stops trying to abstract during write**. LLM moves to query-time fusion if needed; otherwise embedding-only. The Mem0 fix from 2026-05-04 (`0d0fbca`) becomes obsolete because the structural cause is gone.

- [ ] **Phase 5: Density-based abstraction** _(type: empirical)_

    Investigation. When N episodes match a query and cluster by semantic+structural similarity above threshold T, surface the cluster as an inferred pattern at retrieval time — without ever storing it as a row. Tune N and T against real recall queries. Validate against Phase 4's migrated readers: does retrieval-time density abstraction subsume what `experience_patterns` did, or are there cases where it under-/over-surfaces? **Negative result is a valid output** — if density at our scale is noise, fall back to a lighter-touch surface (e.g., explicit "you've hit similar episodes N times" advisory) without claiming abstraction.

- [ ] **Phase 6: Crash-resilient episode boundary** _(type: engineering)_

    Implement engineering-doc Recommendation #1: Angel-as-source-of-truth for session-end. fsnotify on the JSONL directory + heartbeat row from session + idle-timeout sweep + PID-liveness with stale detection. Episode boundaries (when does an episode "close" so synthesis fires?) decided here — likely per-thread or per-detected-intent-shift, not per-session. Once this lands, the agent's lifetime is decoupled from memory persistence: PC crash, OOM, hung agent — the episode is on disk, Angel synthesizes when the episode goes quiet.

- [ ] **Phase 7: v4 coexistence / migration / ship** _(type: engineering)_

    Decide per-category what happens to v4 storage:
    - `experience_patterns` (88 rows, inflated): retire — replaced by Phase 5 density abstraction
    - `learning` (191 rows): re-derive as projections from raw episodes? Or preserve as legacy "synthesized fact" surface?
    - `decision` (126 rows): same question
    - `mental_model` (659 rows): probably keep — these are user-/agent-confirmed long-term, not extraction artifacts
    - `directive_rule`, `critical_rule`: likely keep — explicit rules that earned their status
    - `transcript_chunk`: superseded by Phase 1 substrate

    Then: Vesna probe suite update, ship gate validation, **v5.0.0 tag**.

## Phase typing rationale

Two-thirds of v5 is engineering (1, 3, 4, 6, 7) — the substrate, the cutover, the cleanup. One-third is empirical (2, 5) — the density and indexing claims that the parable promises but our scale does not yet prove. Auto-orchestrate runs all of them with the same discuss → plan → execute → user-approval flow; the *type* tag tells phase teammates whether to write CONTEXT/PLAN/SUMMARY as "implement this" or as "investigate this and report what we learned."

## Validation criteria (refined during phase planning)

The v4 ship gates were SC#1 (Vesna 100%), SC#2 (≤500 token cache-stable), SC#3 (MEMORY.md content quality), SC#4 (handoff pickup). v5's ship gates need re-derivation against the parable. Initial sketch:

- **SC-V5-1: Episodic recall.** Probes that establish "the keyword X fires the episode where it was discussed last session" — directly addresses today's failure mode where the parable couldn't be recalled.
- **SC-V5-2: No re-extraction inflation.** Provenance-tagged write path makes the Mem0 feedback loop structurally impossible. Probe asserts injected-span content does not contribute to extracted artifacts.
- **SC-V5-3: Density at scale.** N-fold cross-validation that high-density clusters surface meaningful patterns vs noise; phase 5 output validates or invalidates.
- **SC-V5-4: Crash-resilient.** Kill -9 mid-session; verify Angel still synthesizes on idle timeout. Engineering-doc Recommendation #1 validation.

These are placeholders. Phase 1 discuss may revise.
