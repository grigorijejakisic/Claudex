# Claudex v4

## What This Is

Claudex v4 is a behavioral reframe of the Claudex v3 persistent memory system. Originally scoped (2026-04-19) as a behavioral push-to-pull shift; rebounded (2026-04-27) after a trajectory audit found phase gates that didn't measure phase changes and a flagship deliverable (MEMORY.md) shipping with visible content regressions. The audit closed with a 16-phase rebalance: 5 deletion/cleanup phases stay (the v4 thesis is correct), 5 new upgrade phases added (4.1, 5.5, 6.5, 7.5, 8.5), Vesna promoted to Phase 10 as central validation, Phase 3+10 merged so directive detector ships with consumer surface and lifecycle. Built on the existing v3 runtime (SQLite + sqlite-vec + Ollama embeddings + BGE-reranker-v2-m3) — no rewrite, consolidation + framing + targeted upgrades.

## Core Value

**v4 makes the agent USE Claudex organically as part of how it works in Claude Code.** Memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) get reached for the same way `Read` or `Grep` are used — natural extensions of reasoning, not a separate "fetch context" step that has to be remembered. Memory stops acting like rules; the agent stops following injected imperatives and starts using Claudex as a tool of working thought.

**Canonical example (user-articulated 2026-04-27):** if last session we discovered *"60 HTTP polls to backend X = 15-min IP shadowban"*, and this session user says *"investigate another backend for intel gathering,"* the agent should automatically (1) recognize this is rate-limit-research-shaped work, (2) recall the shadowban finding, (3) apply it to scoping — all without being told to query memory.

## Requirements

### Validated

*(none yet — Phase 11 final validation not run)*

### Active

**Storage (STOR):**
- [ ] STOR-01..STOR-08: artifact unification (V17 migration) — *complete via Phase 2 (T3 verified)*
- [ ] STOR-09 (NEW): task-pattern fingerprint column on artifacts of `kind ∈ {mental_model, learning, experience_pattern, workspace_fact, lesson}` — auto-classified at write time

**Extraction (EXTR):**
- [x] EXTR-01..EXTR-03: directive detector core + Angel wiring — complete
- [~] EXTR-04: detector precision — partial-B at joint=0.50; held-out recall measurement + `negation_dont` tune owned by Phase 3 merger
- [ ] EXTR-05: replace 6 v3 extractors with single Angel semantic ingester — owned by Phase 9
- [ ] EXTR-06: transcript chunking via LLM topic-segmentation — owned by Phase 4.1 (reach fix)

**Injection (INJ):**
- [ ] INJ-01..INJ-07: session-start ≤500 tokens, delete 9 sections, `initialUserMessage` prime, UPS ≤1KB, cache-stable — owned by Phase 5

**Retrieval (RETR):**
- [ ] RETR-01..RETR-04: collapse hybrid-retrieval to RRF + cross-encoder rerank — owned by Phase 6
- [ ] RETR-05 (NEW): per-multiplier ablation A/B before bulk delete — owned by Phase 6
- [ ] RETR-06 (NEW): task-pattern fingerprint matching at search time — owned by Phase 6.5
- [ ] RETR-07 (NEW): cross-project query expansion default-ON — owned by Phase 6.5
- [ ] RETR-08 (NEW): reranker hard-required; bi-encoder fallback explicitly degraded-mode with telemetry — owned by Phase 6

**Curation (CUR):**
- [~] CUR-01..CUR-08: Phase 4 deliverables — partial-corrective-pending (Phase 4.1 supersedes)
- [ ] CUR-09 (NEW): MEMORY.md schema redesign — drop `## Entities` + `## Recent Threads`; add `## Lessons` + promote `## User Notes`
- [ ] CUR-10 (NEW): Lessons format — task-pattern indexed pointers
- [ ] CUR-11 (NEW): /endsession curation flow — Angel proposes 1-3 candidate Lessons/User Notes pointers; user accepts/edits/rejects
- [ ] CUR-12 (NEW): writer reach = 5/5 active projects via Angel heartbeat sweep; migration NEVER stomps existing user content
- [ ] CUR-13 (NEW): writer state-machine bug fix (duplicate USER EDITABLE markers eliminated; idempotent re-run produces byte-identical output)
- [ ] CUR-14 (NEW): mixed-precision `created_at_epoch` normalized to milliseconds across all artifact kinds
- [ ] CUR-15 (NEW): transcript_chunk reach verified — chunker runs for all sessions; live-fire confirms ≥1 chunk per session
- [ ] CUR-16 (NEW): `pointer_recall_log` table — owned by Phase 5.5
- [ ] CUR-17 (NEW): auto-archive dead pointers (90d zero retrievals + null helpful) — owned by Phase 5.5
- [ ] CUR-18 (NEW): auto-promote high-recall pointers (≥3 retrievals + helpful=true) — owned by Phase 5.5

**Framing (FRAM):**
- [ ] FRAM-01..FRAM-04: advisory voice in every surviving formatter — owned by Phase 7
- [ ] FRAM-05 (NEW): behavioral A/B for 1 week of real sessions; subjective scoring of agent-thinks-with-experience vs follows-rules — owned by Phase 7

**Lifecycle (LIFE):**
- [ ] LIFE-01..LIFE-04: scope detection, supersession edges, confidence decay — owned by Phase 3 merger

**Directive consumer surface (DIR-CONSUMER, NEW):**
- [ ] DIR-CONSUMER-01: PreToolUse hook surface — surfaces relevant directive as system-role observation BEFORE matching tool runs
- [ ] DIR-CONSUMER-02: `applies_to_paths` (glob) + `applies_to_commands` (regex) fields per directive
- [ ] DIR-CONSUMER-03: relevance threshold `helped/total ≥ 0.7` AND `total ≥ 10`; max 1 surface per tool call (highest-relevance wins)
- [ ] DIR-CONSUMER-04: production consumer count > 0 verifiable in DB telemetry

**Handoff (HAND, NEW):**
- [ ] HAND-01: hybrid YAML status header (`status:`, `phase:`) + ADR-style body
- [ ] HAND-02: writer outputs new shape; Phase 4.1's MEMORY.md `## Handoff` consumes header for programmatic queryability
- [ ] HAND-03: handoff pickup probe (SC#4) — soft-allow handoff-referenced reads; block exploratory glob/grep/Bash before first user-facing action

**Cache + Token (CACH/TOK, NEW):**
- [ ] TOK-01: session-start ≤500 tokens (tokenizer assertion on actual output)
- [ ] CACH-01: golden snapshot byte-identical across runs
- [ ] CACH-02: invariance under volatile-state mutation (clock change, session-ID change, host-env change must not change output bytes)
- [ ] CACH-03: pre-work hardening — clock leaks, session-ID strips, host-env normalization, stable tiebreakers, CRLF/BOM normalizer + `.gitattributes`

**Content-Quality (CONT, NEW):**
- [ ] CONT-01: mechanical scoring rubric — zero parsing-bug rows; ≥80% pointers project-specific; topics not session-IDs; pointer density ≥1/10 lines; handoff freshness
- [ ] CONT-02: SC#3 — score ≥80% on every active project's MEMORY.md
- [ ] CONT-03: scoring runs as CI on every PR for every active project

**Vesna behavioral suite (VESN, NEW):**
- [ ] VESN-01: corpus mined from real session histories across all active projects
- [ ] VESN-02: ~20 probes curated covering entity recall (3-5), constraint recall (3-5), handoff pickup (3), cross-project (3-5), lesson application (3-5), self-instrumented gap detection (2-3)
- [ ] VESN-03: SC#1 — Vesna pass rate ≥80%
- [ ] VESN-04: CI integration; runs on every PR; pass rate ≥80% required to merge

**Recall Observability (OBS, NEW):**
- [ ] OBS-01: per-session retrieval log (every search/recall captured with query, top-k, used-in-output, token cost)
- [ ] OBS-02: agent system prompt addition — narrate retrieval gaps + surfaced gold; visible by default, silent on demand
- [ ] OBS-03: visible token cost at /endsession (*"session-start spent N; recall added M; total X tokens"*)
- [ ] OBS-04: `/claudex-why` slash command + retrieval log for current session

**RL Ablation (ABL, NEW — replaces deprecated BENCH-08):**
- [ ] ABL-01: feature flag `CLAUDEX_DISABLE_RL_SCORING=1` bypasses Q-value multipliers in `hybrid-retrieval.ts` and skips `rl-trainer` ticks
- [ ] ABL-02: Vesna probe suite run with flag set; baseline run without flag; decision committed to `context/specs/V4_RL_ABLATION.md`
- [ ] ABL-03: edge case — if delta is exactly at -2pp, default to "keep RL" (conservative)

### Removed Requirements (2026-04-27 audit-driven)

- **BENCH-01 through BENCH-09** — DROPPED. Benchmarks not used in v4 (not as gates, not as floors, not as sanity). Harness on disk; runnable on demand; one-shot at v4 ship for archival record only.

### Out of Scope

- Ground-up rewrite — v4 is consolidation + behavioral reframe + targeted upgrades; 124 commits of v3 bug fixes stay
- `services/reranker.py` (BGE-v2-m3 on port 7439, `RerankerSupervisor`) — don't touch
- sqlite-vec integration and the 5 vec0 virtual tables — V15 foundation stays
- CC hook plumbing (`src/adapters/cc-hooks/`, 26 hooks) — working, leave alone
- Ollama arctic-embed2 embeddings (1024d) — infrastructure stays
- `lifecycle.ts` shared module (1466 lines) — reused across hooks + OpenClaw bridge
- Angel-as-subagent migration — discussed and parked until v4 stabilizes
- Agent Teams integration (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) — experimental API
- `conversation_turns` schema — raw turn storage is correct; new chunking pipeline layers on top
- **Public-release polish (LICENSE, install ergonomics, cross-platform audit, README rewrite, self-diagnosis tooling)** — v4.1 = Distribution as a dedicated follow-up milestone. v4 is "make it work better"; v4.1 is "make it installable by strangers."

## Context

- **Source brief:** `context/specs/CLAUDEX_V4_SCOPE.md` (session 51, authored by Grigorije + Crux 2026-04-19) + 2026-04-27 corrigendum
- **Audit evidence:** `.planning/audits/2026-04-27-v4-trajectory-audit.md`
- **Locked rebind proposal:** `.planning/audits/2026-04-27-v4-proposal.md`
- **Prior `.planning/`:** Archived to `.planning.archive.2026-04-20/` — was the "CC Source Upgrades" project, never started, unrelated to v4
- **Runtime substrate (unchanged):** SQLite at `~/.claudex/db/claudex.db`, V17 schema (50 tables — was 33), sqlite-vec embedded, Ollama snowflake-arctic-embed2 (1024d), BGE-reranker-v2-m3 cross-encoder (port 7439, Python service supervised by Angel's `RerankerSupervisor`)
- **Components:** CC Hooks (26 ephemeral Node scripts), Angel (persistent guardian, auto-spawned), OpenClaw Bridge (long-lived process)
- **User hardware:** Ryzen 9 9950X, 128GB RAM, RTX 5090 32GB — maximize parallelism, latency budget is generous

## Constraints

- **Benchmarks not used in v4.** Not as gates, not as floors, not as sanity floors. LongMemEval / LoCoMo / BENCH-09 — none of them. Harness stays runnable on disk for ad-hoc diagnostic + one-shot ship-time record. Re-introducing benchmark gates is the failure mode the audit caught — reject and point at `feedback_benchmarks_are_sanity_not_gates.md`.
- **SC#1 (Vesna ≥80%) is the primary gate** at every phase boundary that has behavioral exposure.
- **SC#2 (token budget ≤500 cache-stable) is hard** at Phase 5 close and beyond.
- **SC#3 (MEMORY.md content-quality ≥80%)** at Phase 4.1 close and every subsequent PR via CI.
- **SC#4 (one-turn handoff pickup)** at Phase 11 ship gate.
- **Test suite:** all v3 Vitest tests pass after every phase. Test count adjusts downward at Phase 9 to reflect deleted-module tests; no regression in remaining tests.
- **Cache stability (T5):** all surviving injected text stripped of timestamps, turn counts, session IDs, wall-clock references — any dynamic content kills prompt-cache hits (10× cost).
- **Commits:** atomic and revertible per phase. Phase 2 (V17 migration) and Phase 6 (RL stack drop, V18) are irreversible-data phases — DB backup to `~/.claudex/backups/pre-v4-{phase}-{ts}.db` required before drop commits, restore verified before drop runs.
- **Live-fire verification (cross-cutting):** writers and processors that produce side effects must include live-fire verification as blocking acceptance gate (Phase 4 methodology learning). Static tests are necessary but not sufficient.
- **No imperatives in any memory surface:** MEMORY.md, PreToolUse warnings, system-role primes — all observational. *"Similar prior situation: ..."* never *"Correct approach: ..."*
- **Build tool:** `bun run test` NOT `bun test` — `bun test` invokes Bun's native runner, not Vitest.
- **Hook safety:** Never call CC's CLIProxyAPI from a hook (deadlock). Ollama only.
- **Writers ship with consumers:** any phase that produces a writer without an active production consumer is not "shipped" by definition. Phase 3's directive_rule (2 rows in 5+ days, zero consumers) is the canonical anti-pattern.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Q1 (P0, 2026-04-19) Transcript chunking = LLM topic-detected boundaries | User chose quality over latency: "we have all the space in the world to do this right." | Locked. Angel runs LLM segmentation pass at `/endsession`; `artifact(kind='transcript_chunk')` carries `topic_label` + `turn_range` |
| Q2 (P0, 2026-04-19) MEMORY.md schema = sectioned markdown, importance-sorted, capped | Native CC convention | **Superseded by Q5 (2026-04-27)** — Entities + Recent Threads sections drop; Lessons + User Notes promote |
| Q3 (P0, 2026-04-19) Directive detection = regex + LLM confirm, threshold ≥0.7 | User's stated language pattern favors inclusion over strict precision | Locked. Calibrated to 0.50 joint precision (path B) post-relabel; `negation_dont` family tune owned by Phase 3 merger |
| Q4 (P0, 2026-04-19) `project_curated_context` = migrate to `artifact(kind='mental_model')` | Existing entries carry session provenance worth keeping | Locked. 9 mental_model rows flagged stale during P1 migration |
| Q5 (audit, 2026-04-27) MEMORY.md schema redesign | Audit T1 verified visible content regressions in production. Frequency-extracted entities are noise; recent-threads as session IDs is zero-info. Lessons indexed by task-pattern is what makes organic recall work. | Locked. Drop `## Entities` + `## Recent Threads`; add `## Lessons`; promote `## User Notes`. Owns Phase 4.1. |
| Q6 (audit, 2026-04-27) Goal: agent USES Claudex organically | User correction: *"Not feel organic, WORK organic with Claude Code! Agent should USE Claudex organically."* Verb is operative; this is a tool-use behavior, not a vibe metric. | Locked. Goal sentence updated across all v4 docs. Anchors SC#1-#4. |
| Q7 (audit, 2026-04-27) Success criteria SC#1-#4 replace benchmark gates | Benchmarks slipped from instruments into product values; gates didn't measure phase changes (LongMemEval doesn't read assembler; LoCoMo bypasses session-start; BENCH-09 contaminated). Vesna + content-quality + cache-stability + handoff-pickup measure what we actually care about. | Locked. SC#1 Vesna ≥80%, SC#2 ≤500 token cache-stable, SC#3 MEMORY.md content-quality ≥80%, SC#4 one-turn handoff pickup. |
| Q8 (audit, 2026-04-27) Benchmarks dropped entirely from v4 | User: *"do we really need any benchmarking at all at this point?"* Half-measure ("sanity floors") still costs compute, still creates target-creep pressure, still tempts number-watching. Vesna + content-quality + soak cover catastrophic-regression detection. | Locked. LongMemEval/LoCoMo/BENCH-09 not used. Harness on disk; runnable on demand; one-shot at v4 ship for archival record only. Re-introducing is the failure mode replaying. |
| Q9 (audit, 2026-04-27) Phase 3 + Phase 10 merge | Phase 3 ships writer (directive_rule) with zero consumers (2 rows in 5+ days). Lifecycle (scope, supersession, decay) belongs as one shippable unit with consumer surface (PreToolUse). Cross-cutting principle: writers ship with consumers. | Locked. New Phase 3 = directive detector + PreToolUse + lifecycle as one phase. Old Phase 10 absorbed. |
| Q10 (audit, 2026-04-27) Cross-project recall default-ON | User: *"between you and me there are no secrets ... methodology and knowledge are not [secret]."* | Locked. Cross-project task-pattern recall default-ON. Per-project opt-out via CLAUDE.md flag if needed later. Owns Phase 6.5. |
| Q11 (audit, 2026-04-27) Handoff format = hybrid YAML status header + ADR body | Current 372-line schema is dense and rigid. Hybrid: 2-line YAML for programmatic queryability (Phase 4.1's writer reads `status:` + `phase:`); ADR body for human readability. ~15 lines target. | Locked. Owns Phase 7.5. |
| Q12 (audit, 2026-04-27) Phase ordering = 4.1 first, then 5 | 4.1 first: agent has good MEMORY.md but injections still happening — content-quality scoring validates 4.1 mechanically. 5 first: injections gone but MEMORY.md still broken — agent has nothing to fall back on, higher risk. | Locked. 4.1 → 3 merged → 5 → 10 → 5.5 → 6+6.5 → 7+7.5 → 8 → 8.5 → 9 → 11. |

## Next Milestones

### v4.1 — Distribution (planned, follows v4.0 tag)

**Intent:** Make Claudex installable by strangers without diluting v4's behavioral focus. Triggered immediately after `v4.0.0` tag lands.

**Sketch (subject to refinement at v4.1 = Distribution `/gsd:new-milestone`):**
- LICENSE file (decision: MIT vs Apache 2.0 vs AGPL — copyleft consideration)
- `package.json` metadata — remove `private: true`, version, repo, keywords, engines
- Cross-platform audit — Mac/Linux path handling, hook scripts, file locks (currently Windows-first)
- Bootstrap script — one-command setup (Ollama, snowflake-arctic-embed2 pull, BGE reranker on 7439)
- Hardcoded path discovery — `~/Desktop/Projects/` is in MCP instructions; needs to be configurable
- README rewrite for outsiders — what Claudex does, why (the v4 thesis is the actual selling point), install, basic usage, troubleshooting
- `claudex doctor` self-diagnosis tool
- Onboarding fixture — install on a fresh VM, document every friction
- CHANGELOG + release notes for v4

**Why scoped separately:** Distribution work is cross-platform debugging + product polish, fundamentally different from v4's behavioral reframe. Combined scope would push v4 ship by weeks AND contaminate the focused work.

---

*Last updated: 2026-04-27 after audit-driven 16-phase rebind. Original spec at `context/specs/CLAUDEX_V4_SCOPE.md` preserved with 2026-04-27 corrigendum.*
