# Phase 5: P4 — Kill legacy injection (BIG BENCHMARK GATE) - Context

**Gathered:** 2026-04-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Surgical removal of 9 legacy injection sections from `src/intelligence/assembler.ts`. Drop session-start payload to ≤500 tokens, UPS per-turn to ≤1KB, prove cache-stable prefix (byte-identical repeat), add `initialUserMessage` auto-prime gated on `ACTIVE.md` existence, and pass the BENCH-09 behavioral gate (post-P4 median `claudex_search` calls per non-trivial session ≥ baseline N captured in P3).

**Locked from ROADMAP.md success criteria — non-negotiable:**
- DELETE: Proven Principles, Entity Summaries, Angel Opinions, Predicted Context, Curated Context, Experience Warnings auto-surface, Flow, Reference Layer, Materialization
- KEEP: Identity, Project (CLAUDE.md), Session Continuity, Checkpoint, GSD, MEMORY.md (native load)
- Token budgets: session-start ≤500, UPS ≤1KB
- Cache-stable: zero timestamps/turn-counts/session-IDs/wall-clock in surviving injected text
- Fallback ladder L1→L4 (UPS budget bump → keep one section → dual-inject diagnostic → full revert)
- Requirements: INJ-01..07, BENCH-05/06/07, BENCH-09 (gate)

Out of scope (other phases): retrieval simplification (P5), framing rewrite (P6), Angel deletions (P7).

</domain>

<decisions>
## Implementation Decisions

### Pre-flight safety (STOR-08, team-lead directive)
- DB backup at `~/.claudex/backups/pre-v4-P4-{ts}.db` MUST be taken and verified restorable before any code change to `assembler.ts` lands. This mirrors the P1/P5 backup gate pattern. **Backup gate is plan task 05-01-pre.**

### Deletion sequencing & bisectability
- **One commit per deleted section** (9 commits + setup + close), mirroring P7's per-module discipline. Mega-commit is unbisectable when BENCH-09 fails.
- Deletion order: lowest-signal-density first, highest-density last. Provisional order (planner to confirm via signal-density measurement before sequencing): Materialization → Reference Layer → Flow → Predicted Context → Proven Principles → Curated Context → Angel Opinions → Experience Warnings auto-surface → Entity Summaries.
- Vitest must pass after every commit. LongMemEval Oracle fast-subset spot-check (~30 min) after every commit. Full LongMemEval + LoCoMo run only at the end of the umbrella phase, not after each cut.
- BENCH-09 telemetry must be capturing throughout the deletion sequence (not just measured at the end), so we can spot the inflection point in real time.

### `initialUserMessage` auto-prime mechanics
- Trigger: `ACTIVE.md` exists at `.planning/handoffs/ACTIVE.md` (project-scoped). No staleness/hash gating in v1 — keep it dumb and predictable; revisit if false-fires occur.
- Primed message contents: a **pointer + one-line summary**, not the full handoff text (cache-stability cost too high if the handoff body changes). Format: `"Resume handoff: <ACTIVE.md first-line summary>. Full state at .planning/handoffs/ACTIVE.md."`
- `/starthere` interaction: `/starthere` reads `ACTIVE.md` directly and supersedes the prime when the user invokes it. The prime is for the case where the user types a real task and expects continuity without ceremony.
- Fires once per session-start, not per UPS turn.

### Experience-warning trigger surface (SC#7)
- Removed from auto-surface in session-start. Resurfaces on:
  - **Explicit query**: keyword/phrase match on user prompt (e.g., "do you remember", "have we", "last time") — keyword list, not LLM intent classifier (cost + latency).
  - **Path trigger**: regex match on Edit/Write `file_path` argument against stored experience-pattern `path_glob` field. No grep/glob result triggers in v1 (too noisy).
  - **Command trigger**: substring match on Bash `command` arg against stored experience-pattern `command_substring` field.
- Implemented in UPS, not session-start, so it's reactive not proactive.

### BENCH-09 measurement methodology
- "Non-trivial session" = ≥6 user turns AND ≥1 substantive tool call (Edit/Write/Bash/Task), excluding harness/test sessions tagged via session metadata.
- Window: rolling 7-day median, computed daily. Baseline N from `benchmarks/results/p3-postmigration/bench09-baseline.json` (Phase 4 deliverable).
- Outlier handling: cap per-session `claudex_search` count at p99 of the baseline distribution before taking the median. Excludes retry storms.
- Gate fires on the post-P4 7-day rolling median crossing below baseline N for ≥3 consecutive days (debounce against single-day noise).

### Cache-stability verification
- **Snapshot test** on `assembler.ts` output for a fixed corpus of session-start scenarios. Hash the output, assert byte-identical across two consecutive invocations with identical inputs.
- Corpus (4 scenarios minimum): cold start (fresh project, no MEMORY.md), warm start (MEMORY.md present, no handoff), handoff start (MEMORY.md + ACTIVE.md), GSD-active start (MEMORY.md + GSD `.planning/` present).
- CI gate: vitest snapshot, fails the build on diff. Lives in `tests/intelligence/assembler.cache-stability.test.ts`.

### Fallback ladder execution policy
- **Stop after each rung for human review.** Autonomously climbing L1→L4 risks shipping a degraded experience without explicit consent. Each rung produces a measurement report; team-lead approves the next rung.
- L3 dual-inject diagnostic telemetry: log per-section contribution to LongMemEval delta to `benchmarks/results/p4-fallback/L3-attribution.json` (one row per question × section toggle), DB-backed via a temp telemetry table that gets dropped when L3 closes.
- Attribution: scripted, not eyeball. `scripts/p4-attribute-l3.ts` reads the telemetry and emits per-section delta-pp and confidence intervals. Human reviews the report; tool produces it.

### Claude's Discretion
- Specific tokenizer choice for the ≤500 / ≤1KB measurement (assume `tiktoken` cl100k_base unless researcher finds reason otherwise).
- Exact filename/path for the `initialUserMessage` prime emitter (planner picks; somewhere under `src/adapters/cc-hooks/`).
- BENCH-09 metric storage table schema (planner designs as an extension of existing `bench09_telemetry` if it exists, else new).
- Pre-existing test fixture reuse vs. new fixtures for the cache-stability corpus.

</decisions>

<specifics>
## Specific Ideas

- **Per-commit benchmark spot-check pattern** is borrowed from P7's atomic-deletion discipline (ROADMAP Phase 9 SC#1). Apply the same rigor here because BENCH-09 failure attribution requires it.
- **STOR-08 backup gate** explicitly emphasized by team-lead directive on this phase: "Plan must incorporate L1..L4 fallback ladder and STOR-08 DB backup gate before any code change."
- **MEMORY.md is the new injection** — the legacy sections being deleted are functionally replaced by MEMORY.md (Phase 4 deliverable, completed 2026-04-26). The deletion is safe because the index already exists and is loaded natively by CC.
- "Cache-stable prefix proven by byte-identical repeat" implies that all dynamic content (timestamps, session IDs, turn counts) must move into either MEMORY.md (which CC loads natively, outside the cache window) or UPS dynamic signals (post-cache).

</specifics>

<deferred>
## Deferred Ideas

- LLM-based intent classifier for experience-warning surfacing (deferred from "Experience-warning trigger surface" — keyword match in v1 is good enough; revisit if false-negative rate is high).
- Staleness/hash gating on `initialUserMessage` prime (deferred from "auto-prime mechanics" — add only if false-fire rate observed in production warrants it).
- Auto-climbing fallback ladder without human approval (deferred from "fallback ladder execution policy" — would need explicit user opt-in flag in `config.json`; not for v1).
- Glob/Grep result triggers for experience warnings (deferred from "trigger surface" — too noisy in v1; revisit with measurement).

</deferred>

---

*Phase: 05-p4-kill-legacy-injection-big-benchmark-gate*
*Context gathered: 2026-04-26*
