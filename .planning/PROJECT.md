# Claudex v4

## What This Is

Claudex v4 is a behavioral reframe of the Claudex v3 persistent memory system. It turns stored memory from imperative push into advisory pull: session-start stops flooding the agent with prescriptive "rules," one unified `artifact` table replaces nine overlapping knowledge tables, and a curated 25KB MEMORY.md index teaches the agent what to query rather than pre-injecting answers. Built on the existing v3 runtime (SQLite + sqlite-vec + Ollama embeddings + BGE-reranker-v2-m3), with no rewrite — consolidation plus framing.

## Core Value

Memory stops acting like rules — the agent thinks again, pulling curated artifacts on demand instead of blindly following injected imperatives.

## Requirements

### Validated

*(none — new project)*

### Active

- [ ] Ship unified `artifact(kind, ...)` table collapsing 9 knowledge tables with legacy views preserving all v3 callers
- [ ] Detect user directives ("remember this", "from now on", "never X") via regex + LLM-confirmed classifier, persist as `artifact(kind='directive_rule')` with scope
- [ ] Angel writes a sectioned ≤25KB MEMORY.md at `/endsession` (entities, projects, handoff, threads, query hint) for native CC auto-load
- [ ] Delete 9 legacy injection sections from assembler (Proven Principles, Entity Summaries, Angel Opinions, Predicted Context, Curated Context, Experience Warnings auto-surface, Flow, Reference Layer, Materialization)
- [ ] Session-start injection budget ≤500 tokens; UPS per-turn payload ≤1KB; all surviving injected text cache-stable (no timestamps, turn counts, session IDs)
- [ ] Implement `initialUserMessage` auto-prime when `ACTIVE.md` handoff exists
- [ ] Collapse hybrid-retrieval scoring to RRF(FTS5 + vec0 + recency) → cross-encoder rerank → top-k; remove the 6-multiplier chain
- [ ] Rewrite every surviving formatter in `sections.ts` to advisory voice (no WARNING, no "Correct approach", no "Apply them proactively")
- [ ] Gate RL-stack deletion on P6.5 ablation (flag `CLAUDEX_DISABLE_RL_SCORING=1`, LoCoMo drop ≤2pp to clear)
- [ ] Gut Angel heartbeat: delete CARA, autonomous-investigator, dream consolidation, skill crystallization, cross-project consolidator, proactive curator, data-quality phase
- [ ] Add `directive_rule` lifecycle: scope detection, supersession edges via LLM contradiction check, confidence decay with auto-archive below threshold
- [ ] Path-scoped artifacts (`scope='project'` + `paths:` glob) surface via `.claude/rules/` lazy-load
- [ ] **Prove the "thinks again" thesis is falsifiable**: capture pre-v4 baseline of agent-initiated `claudex_search` frequency in P3; gate every phase from P4 onward on median calls per non-trivial session ≥ baseline (post-v4 target ≥ 2× baseline). Without this, the reframe could "succeed" by amnesia.
- [ ] Vesna smoke check: `claudex_search("Vesna")` from a fresh session returns the entity artifact in rank 1-3 (smoke check, not ship gate; BENCH-09 carries the load)
- [ ] Pass full v3 test suite (2020 tests) after every phase with zero regression
- [ ] Maintain LongMemEval Oracle ≥88% floor at every phase boundary; LoCoMo never regresses >2pp per phase
- [ ] MEMORY.md write-time integrity defense — sha256 read-back compare, alert + skip on external mutation; agents-don't-edit-above-sentinel rule documented

### Out of Scope

- Ground-up rewrite — v4 is consolidation + behavioral reframe; 124 commits of v3 bug fixes stay
- `services/reranker.py` (BGE-v2-m3 on port 7439, `RerankerSupervisor`) — don't touch
- sqlite-vec integration and the 5 vec0 virtual tables — V15 foundation stays
- CC hook plumbing (`src/adapters/cc-hooks/`, 26 hooks) — working, leave alone
- Ollama arctic-embed2 embeddings (1024d) — infrastructure stays
- `lifecycle.ts` shared module (1466 lines) — reused across hooks + OpenClaw bridge
- Angel-as-subagent migration — discussed and parked until v4 stabilizes
- Agent Teams integration (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) — experimental API, unstable
- LongMemEval baseline — 90.6% is strong, never risk it
- `conversation_turns` schema — raw turn storage is correct; only new chunking pipeline layers on top
- **Public-release polish (LICENSE, install ergonomics, cross-platform audit, README rewrite, self-diagnosis tooling, stranger-onboarding fixture)** — addressed in **v4.1 = Distribution** as a dedicated follow-up milestone. v4.0 README will carry a "v4 in progress — not yet installable by strangers; v4.1 will fix this" banner so the 9 GitHub stargazers (and future discoverers) aren't misled. Bolting v4.1 onto v4 dilutes the focused behavioral reframe.

## Context

- **Source brief:** `context/specs/CLAUDEX_V4_SCOPE.md` (session 51, authored by Grigorije + Crux)
- **Supersedes:** `CLAUDEX_V3_5_CONSOLIDATION.md` (session 49 spec) — v3.5 diagnosis of proliferation was correct but proposed a schema fix; v4 is the behavioral reframe
- **Prior `.planning/`:** Archived to `.planning.archive.2026-04-20/` — it was the "CC Source Upgrades" project, never started, unrelated to v4
- **Runtime substrate (unchanged):** SQLite at `~/.claudex/db/claudex.db`, V15 schema with 33 tables, sqlite-vec embedded, Ollama snowflake-arctic-embed2 (1024d), BGE-reranker-v2-m3 cross-encoder (port 7439, Python service supervised by Angel's `RerankerSupervisor`)
- **Components:** CC Hooks (26 ephemeral Node scripts), Angel (persistent guardian, auto-spawned), OpenClaw Bridge (long-lived process)
- **Benchmarks (v3 baseline):** LongMemEval Oracle 90.6% (426/470, `deepseek-coder-v2:16b`), LoCoMo 55.5% (855/1540, `claude-sonnet-4-6`). **Internal-validation only** — these numbers are not for public leaderboards. Mem0/Zep cite GPT-4o; we use deepseek (LongMemEval) and Sonnet (LoCoMo). Cross-comparison is misleading and not in scope. v4.0 README will say so explicitly.
- **User hardware:** Ryzen 9 9950X, 128GB RAM, RTX 5090 32GB — maximize parallelism, latency budget is generous

## Constraints

- **Benchmark floor:** LongMemEval Oracle must never drop below 88% at any phase boundary. Violating floor is a revert trigger.
- **Benchmark tolerance:** No single phase may regress LoCoMo by more than 2pp from the prior phase's measurement.
- **Test suite:** All 2020 existing Vitest tests must pass after every phase. No regressions allowed.
- **Commits:** Atomic and revertible per phase. Benchmark scores recorded in commit messages. P1 and P5 are irreversible-data phases — require DB backup to `~/.claudex/backups/pre-v4-{phase}-{ts}.db` before drop commits.
- **Session-start tokens:** Target ≤500 (down from ~4000 in v3). Hard.
- **UPS per-turn payload:** Target ≤1KB. Distinct from session-start budget; carries only dynamic signals (decay-TTL reminders, gauge/pressure), never bulk context.
- **Cache stability (T5):** All remaining injected text stripped of timestamps, turn counts, session IDs, wall-clock references — any dynamic content kills prompt-cache hits (10× cost).
- **Net LOC target:** −8000 to −10000 lines by end of P9.
- **Build tool:** `bun run test` NOT `bun test` — `bun test` invokes Bun's native runner, not Vitest.
- **Hook safety:** Never call CC's CLIProxyAPI from a hook (deadlock). Ollama only.
- **Windows-specific:** File-lock and subprocess quirks live in `docs/platform.md`. Codex CLI on Windows has its own caveats (`docs/codex.md`).
- **Benchmark deterministic measurement:** The 2pp LoCoMo tolerance and 88% LongMemEval floor assume deterministic input. Pin model snapshot, harness sha, judge prompt sha for every recorded number. The "honest harness" rewrite alone moved LoCoMo by ~35pp (90.8% → 55.5% in session 47ish); a 1pp infra-side shift would trip the 2pp gate on noise. Every benchmark commit message must include the pinned hashes.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Transcript chunking = **LLM topic-detected boundaries** (Q1) | User chose quality over latency: "we have all the space in the world to do this right." ~20-30s added to `/endsession` is acceptable on RTX 5090. Per-exchange or sliding-window loses semantic coherence the reranker needs. | Locked for P1. Angel runs an LLM-segmentation pass at `/endsession` producing topic-coherent chunks. `artifact(kind='transcript_chunk')` carries `topic_label` + `turn_range` metadata. |
| MEMORY.md = **sectioned markdown, importance-sorted, capped** (Q2) | Native CC convention expects `##` headers; importance DESC with recency tiebreaker matches what an agent reaching for pull actually needs; caps prevent drift. | Locked for P3. Sections: `## Entities` (≤15), `## Active Projects` (≤5), `## Recent Threads` (≤5), `## Handoff` (≤1), `## How to Query` (≤1). Hard ceiling 25KB / 200 lines. Includes universal user memories (user_pc_specs, identity). Angel maintains iteratively. |
| Directive detection = **regex + LLM confirm, threshold ≥0.7** (Q3) | User's stated language pattern ("please do this, remember this, from now on") favors inclusion over strict precision; 0.7 balances precision/recall. Final value calibrated against fixture sessions in P2. | Locked starting threshold for P2. Calibration may tune to 0.65–0.8 based on fixture precision/recall. Regex-only and user-marker-only rejected (too loose and too narrow respectively). |
| `project_curated_context` = **migrate to `artifact(kind='mental_model')`** (Q4) | Existing entries carry session provenance worth keeping. Deleting loses signal; migrating to `workspace_fact` confuses two kinds. | Locked for P1 migration. **Caveat:** migration script flags entries contradicting current state (e.g., "Angel runs local Gemma" — contradicted by session 50's swap to Ollama Cloud `glm-5.1:cloud`) as `status='stale'` rather than `status='active'`. Known-stale keyword markers for scan: `Gemma 4 31B`, `llama-server:8081`, `local llama-server`. Human review of flagged entries is a P0 deliverable. |
| Keep CC hooks, Ollama, sqlite-vec, reranker, lifecycle.ts untouched | Shipped, tested, working. v4 is behavioral, not infrastructural. | Enforced via out-of-scope list. Any change to these files requires re-opening scope. |
| RL deletion gated on P6.5 ablation | Scope-hedge: if the 6-multiplier chain is quietly load-bearing for LoCoMo, deleting it blind would collapse the benchmark. A feature-flag ablation decides deterministically. | P6.5 runs full LoCoMo with `CLAUDEX_DISABLE_RL_SCORING=1`. ≤2pp drop clears P7 deletion; >2pp forces redesign. Decision committed to `context/specs/V4_RL_ABLATION.md`. |
| Phases are atomic and revertible; DB backups before P1 and P5 drops | Migration and scoring-chain deletion are the high-risk commits; reversible by design. | `~/.claudex/backups/pre-v4-{phase}-{ts}.db` before each irreversible commit. Restore verified before the drop itself runs. |

## Next Milestones

### v4.1 — Distribution (planned, follows v4.0 tag)

**Intent:** Make Claudex installable by strangers without dilluting v4's behavioral focus. Triggered immediately after `v4.0.0` tag lands.

**Sketch (subject to refinement at v4.1 = Distribution `/gsd:new-milestone`):**
- LICENSE file (decision: MIT vs Apache 2.0 vs AGPL — copyleft consideration because Claudex has opinions about agent memory)
- `package.json` metadata — remove `private: true`, version, repo, keywords, engines
- Cross-platform audit — Mac/Linux path handling, hook scripts, file locks (currently Windows-first)
- Bootstrap script — one-command setup that handles Ollama, snowflake-arctic-embed2 pull, BGE reranker on 7439, useful errors on missing deps
- Hardcoded path discovery — `~/Desktop/Projects/` is in MCP instructions; needs to be configurable/discovered
- README rewrite for outsiders — what Claudex does, why (the v4 thesis is the actual selling point), install, basic usage, troubleshooting
- `claudex doctor` self-diagnosis tool
- Onboarding fixture — install on a fresh VM, document every friction
- CHANGELOG + release notes for v4

**Why scoped separately:** Distribution work is cross-platform debugging + product polish, fundamentally different from v4's behavioral reframe + deletion work. Combined scope would push v4 ship by weeks AND contaminate the focused work. Sequencing keeps both clean.

---

*Last updated: 2026-04-26 after honest-review feedback (BENCH-09 thesis falsification gate, deterministic-measurement constraint, v4.1 = Distribution scoping)*
