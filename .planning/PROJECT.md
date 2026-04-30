# Claudex

## What This Is

Claudex is a persistent memory system for LLM coding agents. **v4.0.0 SHIPPED 2026-04-30** — the behavioral reframe of v3 closed with a 16-phase rebalance, all four success criteria passing (Vesna 100%, cache-stable 12/12, MEMORY.md content quality 90 across 6 projects, handoff pickup 3/3). v4 is internal infrastructure; the agent USES Claudex organically as a working-thought tool in Claude Code. Built on SQLite + sqlite-vec + Ollama embeddings + BGE-reranker-v2-m3.

**Current milestone: v4.1 — Distribution.** Make Claudex installable by strangers and ship to public GitHub.

## Core Value

**v4 makes the agent USE Claudex organically as part of how it works in Claude Code.** Memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) get reached for the same way `Read` or `Grep` are used — natural extensions of reasoning, not a separate "fetch context" step that has to be remembered. Memory stops acting like rules; the agent stops following injected imperatives and starts using Claudex as a tool of working thought.

**Canonical example (user-articulated 2026-04-27):** if last session we discovered *"60 HTTP polls to backend X = 15-min IP shadowban"*, and this session user says *"investigate another backend for intel gathering,"* the agent should automatically (1) recognize this is rate-limit-research-shaped work, (2) recall the shadowban finding, (3) apply it to scoping — all without being told to query memory.

## Current Milestone: v4.1 — Distribution

**Goal:** Make Claudex installable by strangers in <30 minutes from a clean clone, with no insider knowledge required, and ship to `grigorijejakisic/claudex` public GitHub.

**Locked decisions (2026-04-30 milestone kickoff):**
- **License:** MIT
- **Platforms:** Windows + Mac + Linux (full cross-platform audit)
- **Harness:** Claude Code only (Cursor/Zed/etc deferred to future milestone)
- **Distribution:** Self-host only (no hosted/SaaS variant)
- **Public ship target:** `github.com/grigorijejakisic/claudex`

**Target features (subject to refinement when REQUIREMENTS.md is generated):**
- LICENSE file (MIT) at repo root
- `package.json` polish (remove `private: true`; add license, repo, version, keywords, engines)
- README rewrite — entry point for humans, not the agent (CLAUDE.md stays for the agent)
- Cross-platform audit — paths, hooks, file locks, subprocess spawning, line endings on Mac/Linux
- Bootstrap script — one-command setup (Ollama install + arctic-embed2 pull + BGE reranker on 7439)
- Hardcoded path discovery — `~/Desktop/Projects/` reference in MCP instructions made configurable
- `claudex doctor` self-diagnosis — reports prereq status (Bun version, Ollama running, port 7439 alive, DB schema version, hooks registered)
- Onboarding fixture — install on a fresh VM (Mac + Linux + Windows), document every friction point as test cases
- CHANGELOG + release notes for v4
- Public push to `grigorijejakisic/claudex` (final ship action)

**Out of scope for v4.1:**
- Multi-harness support (Cursor/Zed adapters) — separate future milestone
- Hosted/SaaS variant — separate future milestone
- v5 episodic memory architecture — separate future milestone (research at `.planning/research/2026-04-30-v5-episodic-memory.md`)
- Internal v4 deferrals from REQUIREMENTS.md (STOR-09 task-pattern fingerprint, EXTR-04/06 partials, LIFE-01..04, DIR-CONSUMER-01..02, FRAM-05 A/B verdict) — triaged into v4.2 or remain on the v4.1 carry-forward list per `.planning/v4.1-distribution/STUB.md`

## Requirements

### Validated

**v4.0 (SHIPPED 2026-04-30, tag v4.0.0, commit f8f617c)** — All categories below shipped and gated through SC#1-#4. See `.planning/phases/11-p9-final-validation/11-V4-VALIDATION.md` for evidence rollup.

- ✓ STOR-01..STOR-08 (artifact unification, V17 migration, T3 verified) — Phase 2
- ✓ EXTR-01..EXTR-03 (directive detector core + Angel wiring) — Phase 3
- ✓ EXTR-05 (semantic ingester via Angel) — Phase 9 (deletion path)
- ✓ INJ-01..INJ-07 (session-start ≤500 tokens, cache-stable) — Phase 5
- ✓ RETR-01..RETR-08 (RRF + cross-encoder rerank, ablation, cross-project, hard-required) — Phases 6 + 6.5
- ✓ CUR-09..CUR-15 (MEMORY.md schema redesign, Lessons section, writer reach + state-machine fix, mixed-precision normalization) — Phase 4.1
- ✓ CUR-16..CUR-18 (pointer_recall_log, auto-archive, auto-promote) — Phase 5.5
- ✓ FRAM-01..FRAM-04 (advisory voice across formatters) — Phase 7
- ✓ HAND-01..HAND-02 (hybrid YAML status header + ADR body, MEMORY.md handoff consumer) — Phase 7.5
- ✓ ABL-01..ABL-03 (RL ablation gate, verdict DELETE_ALLOWED) — Phase 8
- ✓ OBS-01..OBS-04 (retrieval log, narration directive, /endsession cost block, /claudex-why) — Phase 8.5
- ✓ VESN-01..VESN-04 (probe corpus, ~20 probes, CI-gated ≥80%) — Phase 10
- ✓ TOK-01, CACH-01..CACH-03 (token budget + cache-stability hardening) — Phase 5 + Phase 8.5 re-gate
- ✓ CONT-01..CONT-03 (mechanical content-quality scoring, SC#3 gate, CI integration) — Phase 4.1 + Phase 11
- ✓ STOR-04 (legacy *_old tables dropped via V24 after zero-caller audit) — Phase 11

**v4 deferrals (carry-forward — see `.planning/v4.1-distribution/STUB.md`):**
- [~] EXTR-04 — detector precision held-out recall measurement, `negation_dont` family tune
- [~] EXTR-06 — transcript chunking via LLM topic-segmentation (Phase 4.1 partial)
- [~] STOR-09 — task-pattern fingerprint column on artifact kinds (write-time auto-classification)
- [~] LIFE-01..LIFE-04 — directive lifecycle (scope detection, supersession, decay, accumulation)
- [~] DIR-CONSUMER-01..DIR-CONSUMER-02 — PreToolUse hook surface for directives
- [~] FRAM-05 — week-of-use behavioral A/B subjective verdict (due 2026-05-06)
- [~] HAND-03 — handoff pickup probe (SC#4 live trials operator-runnable; synthetic 3/3 already shipped)

### Active

**v4.1 — Distribution requirements** to be defined in `REQUIREMENTS.md`. Categories tracked there.

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

---

*Last updated: 2026-04-30 after v4.0.0 ship + v4.1 milestone kickoff. v4 requirements moved to Validated; v4.1 Distribution scope captured in `## Current Milestone` section. Original spec at `context/specs/CLAUDEX_V4_SCOPE.md` preserved with 2026-04-27 corrigendum.*
