---
status: active
phase: "post-v7 substrate hardening — 2026-05-18 round"
summary: Continuation of v7.0.0 (shipped 2026-05-17). Today (2026-05-18) hardened the substrate end-to-end across three layered rounds — the six prior-session residuals, the operator's "honest weakness" follow-up, and the fresh-agent gate test's three exposed bugs. Heartbeat is now reliably ticking (PID 88964 at last restart) with parallelized extractDirectives (4.6x speedup measured against a 79-turn real session — 416s → 89.9s). Ollama llama-server removed from Angel boot path; backend=claude is honest about what's running. session_termination grew from 2 → 1094 rows after backfill + new write-time discipline in boundary-detector. MCP recall-server now survives unhandledRejection / uncaughtException — closes the "MCP just dropped mid-investigation" failure mode the fresh agent exposed. Episodic-recall pipeline shipped end-to-end (channel + multiplier + materialization + regex coverage) with a probe-set gate. Vesna binding gate 100% throughout.
topic: 2026-05-18-substrate-hardening
created_at_epoch_ms: 1779113700000
---

# 2026-05-18 — Post-v7 substrate hardening

**What we found:** The fresh-agent test we set up at the end of v7.0.0 became this morning's gate — and it failed in three real ways the unit tests didn't catch: `claudex_recent_sessions` returned `[]` because Phase 13.1 heartbeat hadn't been writing terminations, the kernel's RRF didn't reach `session_events.user_framing` at all (literal "PC crashed" text was 0.017-score noise), and the V43 migration was retry-looping forever because its `UPDATE artifacts SET timestamp_epoch_ms = ...` collided with the cutover read-only trigger. Three different shapes of breakage, all surfaced by one real-world episodic question. Today closed all three plus the residuals stack the prior session named on close.

**What we decided:**

1. **The episodic gap closes via a kernel channel, not by re-routing agents.** Added `searchEpisodicChannel` + `isEpisodicQuery` in `src/core/hybrid-retrieval.ts` so `claudex_search` natively indexes `session_events.user_framing` + `sessions.session_summary`. The prior session had named this as the next-phase task; it's now shipped. Counter-probes confirm conceptual queries don't get inappropriately episodic-boosted.

2. **session_summary materialization is the right shape; user_framing materialization is not.** Per-session summaries are legitimate first-class memories (one row per session, real provenance, real confidence). User prompts are markers, not memories — kind-confusion concern documented in `saveSessionSummary` + the episodic multiplier comment. The 2.5x multiplier in `computeArtifactScore` compensates for the synth-row asymmetry until/unless we revisit.

3. **session_termination is now load-bearing.** Boundary-detector writes a termination row on every session close (mapping its local 3-value reason to the canonical 5-value enum). Backfill recovered 1092 historical sessions as `end_reason='unknown'` (honest about uncertainty). Derived rows from `getDerivedTerminations` now return `end_reason='unknown'` + `derived: true` provenance flag — the deterministic surface no longer fabricates `endsession` for sessions we don't actually know how ended.

4. **MEMORY.md is invariants only.** State (open issues, current phase, last shipped) belongs in the substrate where it has freshness + decay + queryability. Phase 13.1 "Open substrate work" section was the canonical example of state-in-prose going stale — all three items shipped today, so the section was evicted. Sentinel comment added pointing future writers at the substrate for state.

**What's next:** Operator-runnable post-round:

- Run a fresh-agent test against the latest substrate (Angel PID 88964 has all fixes; MCP killed so fresh CC will spawn a clean one).
- Validate `claudex_recent_sessions` now returns 1094 rows with `derived: true` flags on the inferred ones.
- Confirm `claudex_search "why did production stop"` surfaces episodic content as top-3 via `match_kind='episodic'`.
- Cross-family review of today's diff (`/codex-review` or `/gemini-review`) on the round.
- Re-tag if the round warrants it (no v7.1 needed yet — this is post-v7 hardening, not new feature surface).

**Where to look:**

- `src/core/hybrid-retrieval.ts` — episodic channel + `isEpisodicQuery` regex + 2.5x multiplier
- `src/core/session-termination.ts` — derived-row honesty + open_blockers wiring
- `src/core/migration-steps.ts` — V44 (open_blockers) + V43 read-only trigger fix
- `src/core/session-events.ts` — `saveSessionSummary` materialization
- `src/angel/boundary/boundary-detector.ts` — termination write on close
- `src/angel/highlights-extractor.ts` — parse-tolerance + 180s subprocess timeout
- `src/intelligence/directive-detector.ts` — parallelized confirmation phase
- `src/angel/index.ts` + `src/angel/heartbeat.ts` — Ollama supervisor gate + PHASE2 timeout 60s→180s
- `src/mcp/recall-server.ts` — uncaughtException + unhandledRejection survival, open_blockers + derived surface
- `scripts/backfill-session-terminations.cjs` + `scripts/backfill-degraded-highlights.cjs` + `scripts/run-v43-on-live-db.cjs` — one-shot recovery scripts

## Operator Gates (carry-forward / post-round)

- **Fresh-agent re-test** — Angel + MCP restarted with all fixes; awaiting operator-driven validation that the gate now passes cleanly. The probe set in `src/tests/integration/episodic-recall-gate.test.ts` covers the structural half; the behavioral half (does the agent reach for the right tool first) requires a real fresh CC session.
- **Cross-family review** — `/codex-review` or `/gemini-review` against the round's diff for second-eye review on the 2.5x multiplier magic number, the V43 trigger-drop-and-reinstall pattern, and the derived-row provenance flag.
- **Hard-link proposer flag** (`CLAUDEX_HARD_LINK_PROPOSER`) — operator-gated post-v7 (unchanged from prior).
- **Run full informational benchmarks** (`bun src/scripts/run-wave1-benchmarks.ts`) — LongMemEval + LoCoMo + cross-project — unchanged from prior.

## Schema versions

- V36 (v6.6.0 baseline)
- V37 (Wave 1 — V17 unified artifact)
- V38 (Wave 2 — knowledge graph)
- V39 (Wave 3 — handoff_refresh_state for CHR)
- V40 (Phase 13.1 — DDL DEFAULT scaling fix for 7 tables × 8 columns)
- V41 (Phase 14-08 — chr_pending_classifications queue)
- V42 (Phase 14-09 — session_termination)
- V43 (Phase 14-09b — legacy _epoch → _epoch_ms across 24 columns × 16 tables)
- V44 (2026-05-18 — open_blockers column on session_termination)
- `TARGET_USER_VERSION = 44`
