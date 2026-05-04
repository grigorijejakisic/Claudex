# Project State

## Project Reference

See: `.planning/PROJECT.md` (created 2026-05-04)

**Core value:** v5 = Claudex stores bound multi-modal episodes; recall is by any modality; abstraction emerges from density.

**Current focus:** **v5 milestone seeded 2026-05-04.** PROJECT.md / ROADMAP.md / REQUIREMENTS.md / STATE.md written from the framing doc (`research/2026-05-04-v5-bound-episodes-framing.md`) + engineering doc (`research/2026-04-30-v5-episodic-memory.md`) + the 2026-05-04 architectural conversation. v4.0.0 + v4.1.0 SHIPPED (archived at `.planning/v4-final/`). Ready for `/auto-orchestrate` to start phase 1.

## Current Position

**Current Milestone:** v5 — Bound Multi-Modal Episodes
**Phase:** 1 — Episode substrate (about to begin)
**Plan:** —
**Status:** Seeded; awaiting `/auto-orchestrate` to spawn phase 1 discuss
**Last activity:** 2026-05-04 — milestone seeded; archive of v4 → `v4-final/` committed (`077b3ec`); v5 framing doc committed (`f07d893`)

### v5 Phase Structure (Initial — Refinable in Phase 1 Discuss)

| Phase | Goal | Type | Requirements |
|-------|------|------|--------------|
| 1 — Episode substrate | Schema + write path with provenance tags; Mem0 trap structurally impossible | engineering | EPI-01..07 |
| 2 — Multi-modal index seeds + density-at-scale check | Build one non-semantic index (error-fingerprint), measure recall improvement, validate density at our scale | empirical | IDX-01..04 |
| 3 — Multi-handle retrieval cutover | Rewrite hybrid-retrieval to fuse N indexes; cut warning_triggers + assembly injection over to episode-based | engineering | RET-01..05 |
| 4 — Angel reduction | Trace dependencies; delete extraction-time pattern creation; Angel becomes bind+index, not abstract | engineering | AR-01..05 |
| 5 — Density-based abstraction | Cluster matching episodes; surface high-density clusters as inferred patterns at retrieval time (not stored) | empirical | ABS-01..04 |
| 6 — Crash-resilient episode boundary | fsnotify + heartbeat + idle-sweep + PID-liveness; episode unit defined; agent lifetime decoupled from memory persistence | engineering | EBD-01..06 |
| 7 — v4 coexistence / migration / ship | Per-table decision (retire/re-derive/preserve); Vesna update; **v5.0.0 tag** | engineering | MIG-01..05, VAL-01..06 |

**Coverage:** 7 phases, ~35 requirements (initial seed; will expand/contract during per-phase discuss).

**Phase typing:** Phases 2 and 5 are `type: empirical` — their CONTEXT.md must frame success as measurable hypotheses; their PLAN.md include measurement protocols; their SUMMARY.md may legitimately report "this didn't work, here's what we learned." Auto-orchestrate's user-approval gate after each phase IS the iteration loop.

## Notes for the Phase 1 Discuss Teammate

You are the first teammate spawned by `/auto-orchestrate` for v5. The orchestrator (the calling Claude session) seeded this `.planning/` from the framing doc + engineering doc, but the user has not yet had a discuss-step conversation about Phase 1's specific scope. Your job:

1. **Read the framing doc first** (`.planning/research/2026-05-04-v5-bound-episodes-framing.md`). Then engineering doc. Then PROJECT.md. Then this STATE.md.
2. **Frame Phase 1 as: "Episode substrate."** Schema + write path. EPI-01..07 are the seeded requirements. You may add or refine.
3. **Open questions to surface during discuss** (not exhaustive):
    - Exact schema for `episodic_events` — single table or one-per-event-type?
    - Backfill strategy: do we re-process existing `conversation_turns` into events on cutover, or only forward-flow?
    - How are tool_use blocks (which today live in `assistant_text` as embedded JSON) decomposed into typed tool_result events?
    - Coexistence depth: how long do we maintain both `conversation_turns` and `episodic_events`?
    - How does the substrate interact with the existing observation/artifact tables — separate concern, or unified?
4. **Honor the parable.** The v5 thesis is locked. Don't redesign the cognitive frame — refine the engineering plumbing to serve it.
5. **The orchestrator that wrote this STATE.md is in a separate session.** When you SendMessage with questions, the orchestrator answers from its conversation context (which includes the architectural discussion that produced this seed) — but it does not have access to its own prior thinking past `/clear`. So ask precise, scoped questions that the framing doc + engineering doc + this STATE.md should not already answer.

## Notes for the Operator

- v4-final archive at `.planning/v4-final/` is read-only history; do not modify.
- v4.1 HITL items (PLAT-06/07/08, VER-04/05, REL-04/05/07) remain on your plate at your discretion — they don't block v5.
- The Mem0 fix from commit `0d0fbca` (2026-05-04) is tactical; v5 phase 4 makes it structurally obsolete via provenance tagging.
- If `/auto-orchestrate` is interrupted, resume via `--from-phase N`. The disk is the state machine.
