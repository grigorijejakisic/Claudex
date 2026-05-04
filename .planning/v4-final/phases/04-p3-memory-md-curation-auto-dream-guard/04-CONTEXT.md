# Phase 4: P3 — MEMORY.md curation + auto-dream guard — Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers three things and only these three things:

1. Angel writes a sectioned, ≤25KB MEMORY.md at `/endsession` under a sentinel write-guard.
2. CC's auto-dream subsystem is disabled via `CLAUDEX_ENV_FILE` and prevented from overwriting Angel's MEMORY.md.
3. The `/endsession` transcript-chunking pipeline writes `artifact(kind='transcript_chunk')` rows with `topic_label`, `turn_range`, `session_id`, and embedding.

**Explicitly out of scope for this phase:**
- Deleting or replacing any existing session-start injection section (that is Phase 5 / P4, gated by BENCH-05/06/07).
- Reading MEMORY.md into the assembled session-start prompt. Phase 4 only reads MEMORY.md at session-start for the size + sentinel **verification** required by SC-5; no section formatter consumes it yet.
- Retrieval scoring changes (Phase 6 / P5).
- Any change to existing injection sections — dual-injection stays; old sections continue to fire alongside MEMORY.md.

Benchmarks must remain ≥ P2 baseline (LongMemEval ≥88%, LoCoMo within 2pp). Dual-injection is the safety net during this phase.

</domain>

<decisions>
## Implementation Decisions

### Entity importance scoring (for `## Entities` top-15)
- Rank by existing `artifact.importance` column. Do not introduce a new composite score — Angel's existing scoring path already writes this value.
- Tiebreakers in order: `artifact.updated_at` DESC, then `created_at` DESC as deterministic fallback.
- No hand-curated boost table in this phase; no LLM-time importance re-scoring at curation time. If importance is wrong, the fix is upstream in Angel's scorer, not in the curator.

### Recent Threads source (for `## Recent Threads` top-5)
- Source: `artifact(kind='transcript_chunk')` rows written by the new chunking pipeline.
- A "thread" = one or more transcript chunks sharing a `topic_label`.
- Window: most recent 10 sessions by `session_id` recency.
- Rank: most-recent-chunk `created_at` DESC within window; deduplicate by `topic_label`; take top 5.
- Cold start: before enough `transcript_chunk` rows exist, this section may be empty or sparse — that is acceptable behavior, not a bug. The section still renders (possibly with zero rows) to keep the file shape stable.

### Active Projects criteria (for `## Active Projects` top-5)
- Active = distinct `project` value on any artifact with activity in the last 7 days.
- Rank: activity count in that 7-day window DESC; tiebreaker: most-recent activity timestamp.
- Take top 5.
- Rationale: 7 days matches how multi-project scope resolution already thinks about "active" (decision 37). No explicit pin mechanism in this phase.

### Sentinel + user-edit semantics
- Top-of-file HTML sentinel:
  `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=<sha256 of Angel-owned content> -->`
- Bottom-of-file user-editable block:
  - Marker: `<!-- USER EDITABLE -->`
  - Section header: `## User Notes`
- Rewrite rule: Angel rewrites everything **above** the `<!-- USER EDITABLE -->` marker on each curation run. Everything at and below the marker is preserved byte-for-byte.
- Missing-sentinel rule: if the top `CLAUDEX-MANAGED` sentinel is absent when Angel attempts a write (corruption or user tampering), Angel **refuses the write and logs**. Fail loud at the boundary; do not corrupt user state.
- Auto-dream guard: `autoDreamEnabled: false` enforced via `CLAUDEX_ENV_FILE`. The sentinel is the second line of defense if auto-dream runs anyway.

### Idempotency (CUR-04) under the preamble user-memory model
- The sentinel hash covers Angel-owned content above `## User Notes`, **including** the preamble universal-user-memory block.
- A user edit to a `user_memory` source (e.g., `user_pc_specs.md`) legitimately changes Angel's input and therefore the hash. That is not an idempotency violation.
- Idempotency means: **given the same inputs (same artifacts, same user memories, same handoff state), two curation runs produce byte-identical output**. Downstream planner should build tests on input-stability, not timestamp-stability.

### Transcript chunk granularity
- LLM topic-detected boundaries (Q1 decision in PROJECT.md is locked; no fixed-window or turn-stitch hybrid).
- Soft bounds: min 3 turns, max 20 turns per chunk.
- Hard cap: 30 turns to prevent runaway chunks from a bad LLM segmentation.
- Latency budget: ~20–30s per `/endsession` accepted per the locked Q1 trade-off.
- Each chunk stored as `artifact(kind='transcript_chunk')` with `session_id`, `turn_range`, `topic_label`, embedding (STOR-06).

### Handoff section source (for `## Handoff`)
- Source of truth: `context/handoffs/ACTIVE.md`. Do not build a parallel distillation path.
- Content: `## Commander's Intent` block + `## What's Left To Do` list distilled, capped at 10 lines total.
- Append explicit pointer: `See: context/handoffs/ACTIVE.md`.
- No active handoff / file archived: render the single line `No active handoff.` (keeps shape stable for idempotency tests).

### "How to Query" section
- Static stock text. No dynamic per-session generation.
- Content: brief one-liner examples for `claudex_search`, `claudex_events`, `claudex_recall` + pointer to `~/.claude/CLAUDE.md` reference docs.
- Rationale: dynamic query hints would be a second system; this project is in deletion mode. Static keeps the section byte-stable and idempotent.

### Universal user memory placement
- Preamble block **above** `## Entities`, no section header of its own.
- Cap: 5 lines.
- Rationale: ROADMAP locks the file to 5 named sections. Adding a 6th `## Universal` section violates that lock. Inlining into Entities blurs categories (user memories aren't entities — they're meta-instructions). Preamble preserves both the 5-section shape and the natural reading order.
- The existing ad-hoc `~/.claude/projects/.../memory/MEMORY.md` 6-section layout is **not** the target shape — do not mirror it.

### Claude's Discretion (planner free to decide)
- File-write atomicity mechanism (`rename(2)`-style temp-file swap, fcntl lock, etc.).
- How the LLM topic-segmenter is invoked (single pass vs. sliding window, exact prompt, which model — subject to the Q1 ~20-30s latency envelope).
- Concrete SQL query shape for each section's selection.
- Sentinel hash algorithm detail (sha256 specified; framing of what bytes go into the digest — likely the rendered Angel-owned text pre-newline-normalization, planner may specify normalization).
- Logging format and destination for sentinel-missing refusals.
- Whether session-start MEMORY.md verification (size + sentinel) is a dedicated hook, a lifecycle check, or a startup-path function.

</decisions>

<specifics>
## Specific Ideas

- Deletion-over-addition discipline: reuse `artifact.importance` rather than introducing a new composite score. Every instinct to add a new ranking knob in this phase should be questioned.
- Fail-loud-at-boundaries: Angel refuses to overwrite on sentinel corruption rather than auto-recovering. Quiet corruption of user state is worse than a loud failure that the user sees and fixes.
- ACTIVE.md as single source of truth for handoff content — no parallel distillation artifact.
- The static "How to Query" block is a feature, not a limitation — it is what makes the section byte-stable and idempotent and keeps the surface small.

</specifics>

<deferred>
## Deferred Ideas

- **Context-aware "How to Query" generation** from recent retrieval misses — sounds interesting, not in this phase; future phase or dropped.
- **Project pin mechanism** (user-elevated "always show" projects) — would extend `## Active Projects` selection beyond 7-day activity; not needed for v4, park for later.
- **Hand-curated entity importance overrides** — same reasoning; if importance is wrong, fix it in the Angel scorer, not here.
- **Session-start MEMORY.md injection into the assembled prompt** — that is Phase 5 (P4) work, gated by BENCH-05/06/07.

</deferred>

---

*Phase: 04-p3-memory-md-curation-auto-dream-guard*
*Context gathered: 2026-04-22*
