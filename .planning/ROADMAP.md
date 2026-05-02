# Roadmap: Claudex v4

## Overview

Sixteen phases (rebalanced 2026-04-27 from the original eleven). v4's goal: **the agent USES Claudex organically as part of how it works in Claude Code** — memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) reached for the same way `Read` or `Grep` are used, as natural extensions of reasoning, not a separate "fetch context" step that has to be remembered.

Phase 1 (P0 crystallization, ✅) and Phase 2 (P1 artifact unification, ✅, T3 verified) are foundation. Phase 3 (P2 directive detector, [~] partial-with-followups) ships outputs that need a consumer surface — merged with the original Phase 10 (P8 rule lifecycle) into one shippable unit. Phase 4 (P3 MEMORY.md curation) is `[~]` partial-corrective-pending — its flagship deliverable shipped with visible content regressions, superseded by **new Phase 4.1** which redesigns the surface (drops `## Entities` + `## Recent Threads`, adds `## Lessons` indexed by task-pattern, promotes user-curated `## User Notes`). Phase 5 (P4 kill legacy injection) executes with new gates — token budget ≤500 cache-stable, MEMORY.md content-quality, expanded Vesna probes — never benchmarks. **New Phase 5.5** ships the curation feedback loop (pointers earn place by use; dead pointers prune). Phase 6 (P5 retrieval simplification) keeps the deletion but adds per-multiplier ablation before bulk delete. **New Phase 6.5** ships cross-project task-pattern recall (the shadowban mechanism). Phase 7 (P6 framing rewrite, advisory voice) executes. **New Phase 7.5** redesigns the handoff format (hybrid YAML status header + ADR body). Phase 8 (P6.5 RL ablation gate) keeps deterministic A/B. **New Phase 8.5** ships recall observability + self-instrumented agent (visible token cost, `claudex why?` surface). Phase 9 (P7 Angel simplification) sub-phases per-module deletion (T6 verified all consumers are in `assembler.ts` which Phase 5 deletes). **New Phase 10** promotes Vesna probe suite from smoke check to central validation (~20 probes, CI-gated). Phase 11 (P9 final validation) tags v4 against SC#1-#4.

**Benchmarks (LongMemEval, LoCoMo, BENCH-09) are not used in v4** — not as gates, not as floors, not as sanity checks. Harness on disk for ad-hoc + one-shot ship-time record only. Real validation is SC#1 (Vesna ≥80%), SC#2 (≤500 token cache-stable), SC#3 (MEMORY.md content-quality ≥80%), SC#4 (one-turn handoff pickup).

**Status legend:**
- `[ ]` Pending
- `[x]` Complete
- `[~]` Partial-with-followups — shipped at reduced acceptance with explicit follow-up tracked in a later phase

## Phases

- [x] **Phase 1: P0 — Crystallization** — Lock 4 design decisions and produce `.planning/` (completed 2026-04-19)
- [x] **Phase 2: P1 — Artifact unification** — V17 migration + legacy views, zero behavior change (completed 2026-04-20; T3 verified clean 2026-04-27)
- [~] **Phase 3: P2 + P8 merge — Directive detector + lifecycle + PreToolUse consumer** — Detector shipped 2026-04-22 (partial-B); merger with original P8 lifecycle scheduled (writer ships with consumer + supersession + decay as one unit)
- [~] **Phase 4: P3 — MEMORY.md curation** — Closed 2026-04-26 with visible content regressions; **superseded by Phase 4.1**
- [x] **Phase 4.1: MEMORY.md content redesign + Lessons section** — COMPLETE 2026-04-29. Drop Entities + Recent Threads; add Lessons (task-pattern indexed); promote User Notes; writer state-machine fix; mixed-precision timestamp normalization. CUR-15 reach partial-defer (precision closed; backfill recommended as follow-up)
- [x] **Phase 5: P4 — Kill legacy injection** — COMPLETE 2026-04-29. 10 sections deleted across Tiers A/B/C (~320 LOC); codebase_index relocated to UPS; CACH-03 hardening; SC#1-#4 PASS (SC#1 proxy pending Phase 10)
- [x] **Phase 5.5: Curation feedback loop** — `pointer_recall_log`; auto-archive dead pointers; auto-promote high-recall pointers
- [x] **Phase 6: P5 — Retrieval simplification + per-multiplier ablation** — COMPLETE 2026-04-29. Consolidated 7-multiplier scoring into one `computeArtifactScore` function; per-multiplier A/B run (0pp delta at N=11 → consolidation, not aggressive deletion, per CONTEXT.md default-conservative axiom); cross-encoder reranker hard-required with telemetry + session-start visibility surface; sync↔async qMultiplier mismatch fixed in passing. Aggressive deletion deferred to a post-Phase-10 follow-up plan when the larger Vesna suite resolves below ~5pp.
- [x] **Phase 6.5: Cross-project task-pattern recall** (2026-04-29) — Task-pattern fingerprinting; cross-project default-ON; surfaces as observational context. RETR-06 + RETR-07 closed; SC#1 Vesna 3/3.
- [x] **Phase 7: P6 — Framing rewrite** — Advisory voice across every surviving formatter; manual A/B on real sessions for 1 week
- [x] **Phase 7.5: Handoff format redesign** — COMPLETE 2026-04-29. Hybrid YAML status header + ADR body shipped; renderHandoff rewritten to one-line summary; ACTIVE.md migrated; 3 Vesna probes (active/paused/archived) PASS; HAND-01 + HAND-02 closed (HAND-03 deferred to Phase 11)
- [x] **Phase 8: P6.5 — RL ablation gate** — Feature-flag deterministic go/no-go on RL deletion (decision by behavioral observation, not benchmark) — **CLOSED 2026-04-29 verdict DELETE_ALLOWED**
- [x] **Phase 8.5: Recall observability + self-instrumented agent** — COMPLETE 2026-04-30. retrieval_log + cl100k counter + narration directive (advisory voice) + /silent toggle + /endsession cost block + /claudex-why slash; 2 Vesna probes pass; SC#2 cache-stability re-passes (12/12, budget 191/500).
- [x] **Phase 9: P7 — Angel simplification** — COMPLETE 2026-04-30. Per-module deletion across 8 sub-phase atomic commits + 1 close commit. Aggregate LOC −6021. Vesna SC#1 PASS at 32/32 (100%). Heartbeat tick comments 38→28. Phase 8 verdict DELETE_ALLOWED honored in 9.8 (RL stack + V23 migration). CUR-05/06/07, EXTR-05, RETR-05 closed.
- [x] **Phase 10: Vesna probe suite as central validation** — COMPLETE 2026-04-30. 17 probes across 6 categories at 100% pass rate; CI-gated via `.github/workflows/vesna.yml`; harness at `src/benchmark/vesna/`.
- [x] **Phase 11: P9 — Final validation against SC#1-#4** — COMPLETE 2026-04-30. All four SCs PASS with explicit evidence; STOR-04 closed (V24 dropped 6 legacy `*_old` tables after zero-caller audit); benchmark vibe-check archival cite within drift; **v4.0.0 tagged**; v4.1 Distribution stub committed.

## v4.0.0 SHIPPED

v4.0 is internal infrastructure. v4.1 = Distribution will make it installable by strangers. Validation roll-up: `.planning/phases/11-p9-final-validation/11-V4-VALIDATION.md`. Next milestone planning: `.planning/v4.1-distribution/STUB.md`.

---

# Roadmap: Claudex v4.1 — Distribution

## Overview (v4.1)

Six phases continuing from Phase 11. v4.1's goal: **a stranger clones Claudex, follows the README, and has a working session in <30 minutes with no insider knowledge.** Then ship to `github.com/grigorijejakisic/claudex` public.

Phase 12 (Metadata + License + README foundation) ships the small, no-dependency artifacts that establish the repo as MIT-licensed and externally legible — LICENSE, package.json polish, README "what is this / why / who for", CHANGELOG, CONTRIBUTING. Phase 13 (Cross-platform code audit) sweeps the source tree for path/hook/lock/subprocess/line-ending portability — code-only work, no human VM testing yet. Phase 14 (Bootstrap install + configurable paths) builds the one-command setup, replaces the hardcoded `~/Desktop/Projects/` reference with `CLAUDEX_PROJECTS_DIR`, and proves first-session UX works end-to-end. Phase 15 (`claudex doctor` diagnostics) ships the self-diagnosis surface — Bun version, Ollama state, port 7439, DB schema, hook registration, Angel heartbeat. Phase 16 (Onboarding verification + README polish) is the **HITL-pending phase** — actual fresh-VM installs on macOS, Ubuntu 24.04, Windows 11, with each friction point resolved as code fix / doctor check / README troubleshooting entry. Quick Start and Troubleshooting docs finalize here because INST + DIAG must already be alive. Phase 17 (Public ship) creates the public remote, pushes history + tags, cuts the v4.1.0 GitHub release, and applies repo metadata + branch protection.

**Locked decisions (2026-04-30 milestone kickoff):**
- License MIT
- Platforms Windows + Mac + Linux full audit
- Harness Claude Code only
- Self-host only
- Public ship target `github.com/grigorijejakisic/claudex`

**HITL constraint flag:** Phase 16 success criteria (PLAT-06/07/08 fresh-VM installs + VER-01..05 onboarding fixtures + <30-min target measurement) require **operator-driven VM testing on Mac/Linux/Windows**. The roadmap structures these as HITL-pending tasks with operator-runnable harnesses, parallel to how Phase 11 SC#4 was structured (synthetic probes + live trials operator-runnable). Plan-phase will produce explicit operator runbooks; the phase closes once operator returns each platform's fixture filled in.

## Phases (v4.1)

- [x] **Phase 12: Metadata + License + README foundation** — LICENSE (MIT) + package.json polish + README v1 (what/why/who) + CHANGELOG + CONTRIBUTING (completed 2026-04-30)
- [x] **Phase 13: Cross-platform code audit** — paths / hooks / file locks / subprocess / line endings made portable across Windows + Mac + Linux (completed 2026-04-30)
- [x] **Phase 14: Bootstrap install + configurable paths** — one-command `bun run setup`, Ollama + arctic-embed2 + BGE reranker boot, `CLAUDEX_PROJECTS_DIR` replaces hardcoded `~/Desktop/Projects/`
- [x] **Phase 15: `claudex doctor` diagnostics** — self-diagnosis: Bun version, Ollama state, port 7439, DB schema, hook registration, Angel heartbeat (completed 2026-05-02)
- [ ] **Phase 16: Onboarding verification + README polish** — HITL fresh-VM installs on macOS / Ubuntu 24.04 / Windows 11; <30-min target measured; Quick Start + Troubleshooting finalized
- [ ] **Phase 17: Public ship to grigorijejakisic/claudex** — remote + history + tags + GitHub release + topics + badges + branch protection

## Phase Details

### Phase 1: P0 — Crystallization
**Goal:** Lock the 4 open design decisions and produce `.planning/`
**Depends on:** Nothing (first phase)
**Requirements:** *(planning only — no v1 requirements implemented)*
**Success Criteria:**
  1. `.planning/PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `STATE.md` exist
  2. Q1-Q4 decisions recorded in `PROJECT.md` Key Decisions table with rationale
  3. Stale-flagged `project_curated_context` entries identified for human review before P1 migration runs

Plans:
- [x] 01-01: Crystallize from `context/specs/CLAUDEX_V4_SCOPE.md`

### Phase 2: P1 — Artifact unification
**Goal:** Collapse 7 legacy knowledge tables into `artifact(kind, ...)` with preserving views so every v3 caller keeps working
**Depends on:** Phase 1
**Requirements:** STOR-01 through STOR-08
**Success Criteria:**
  1. V17 migration creates `artifact` table with free-form `kind` column and `kind_registry`
  2. All rows from `learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`, `artifacts(entity_summary)` migrated inside a single transaction
  3. Legacy table names preserved as SQL views with unchanged shape
  4. Stale `project_curated_context` rows flagged `status='stale'`
  5. DB backup at `~/.claudex/backups/pre-v4-P1-{ts}.db` verified restorable
  6. All 2020 Vitest tests pass

Plans:
- [x] 02-01..02-07 (all complete; T3 audit 2026-04-27 verified schema_version=17, backups exist, legacy `_old` tables intact at 1052 rows)

### Phase 3: P2 + P8 merge — Directive detector + lifecycle + PreToolUse consumer
**Goal:** Detect user directives, ship them with a decision-time advisory consumer surface AND with lifecycle (scope, supersession, decay) as one shippable unit
**Depends on:** Phase 2 (artifact table available)
**Requirements:** EXTR-01..EXTR-04, LIFE-01..LIFE-04, DIR-CONSUMER-01..DIR-CONSUMER-04 (new)
**Success Criteria:**
  1. `src/intelligence/directive-detector.ts` runs regex pass + LLM confirmation; precision held-out recall ≥0.85 (target) / ≥0.70 (floor)
  2. Confirmed directives written as `artifact(kind='directive_rule', scope=...)` with LLM-classified scope ∈ {session, project, universal}
  3. **PreToolUse hook surface live in production** — surfaces relevant directive as system-role observation BEFORE matching tool runs, with `applies_to_paths` (glob) and `applies_to_commands` (regex) fields per directive
  4. Relevance threshold: `helped/total ≥ 0.7` AND `total ≥ 10`. Max 1 surface per tool call (highest-relevance wins)
  5. Lifecycle live: scope detection at ingestion; supersession edges via LLM contradiction check; confidence decay daily sweep; auto-archive below threshold
  6. **Production consumer count > 0** — verifiable in DB telemetry. Without this, Phase 3 is not "shipped" by definition (cross-cutting principle 1: writers ship with consumers).
  7. Vesna probe coverage: at least 2 probes verifying directive surfaces correctly at decision time

**Plans:**
- [x] 03-01..03-06 (detector + harness + heartbeat wiring; partial-B shipped 2026-04-22)
- [ ] 03-07: PreToolUse hook design + implementation
- [ ] 03-08: Lifecycle (scope detection action + supersession + decay)
- [ ] 03-09: Held-out recall measurement + tune `negation_dont` family
- [ ] 03-10: Merge ship — verify directive_rule production consumer count > 0

### Phase 4: P3 — MEMORY.md curation
**Status:** `[~]` partial-corrective-pending. Closed 2026-04-26 with visible content regressions verified by audit T1 (entity:-, entity:--2--1, 50% session-IDs as topics, duplicate markers, writer reach 2/5 projects). **Phase 4.1 supersedes its acceptance.**

**Plans:**
- [x] 04-01..04-08 (writer + chunker + auto-dream guard + heartbeat wiring + phase-gate + 3 inline bugfixes)

### Phase 4.1: MEMORY.md content redesign + Lessons section (NEW)
**Goal:** Redesign what the writer produces. Drop frequency-extracted noise; add curated `## Lessons` section indexed by task-pattern; promote user-authored `## User Notes`; fix writer state-machine bugs; reach=5/5 active projects.
**Depends on:** Phase 4 (existing writer infrastructure to refactor)
**Requirements:** CUR-09..CUR-15 (new — see REQUIREMENTS.md), STOR-09 (new — task-pattern column on artifacts)
**Success Criteria:**
  1. New schema implemented: `## Active Projects` (auto factual) + `## Handoff` (auto from ACTIVE.md frontmatter) + `## How to Query` (static) + sentinel + `## Lessons` (curated, task-pattern indexed) + `## User Notes` (user-curated verbatim)
  2. **Removed:** `## Entities` (frequency extraction noise), `## Recent Threads` (50% session-IDs as topics)
  3. **Lessons format:** each pointer carries `task_pattern` tag + one-line salience (e.g., `[60-poll shadowban — backend X](project_backendx_shadowban.md) — 60 polls/window = 15min IP ban — task-pattern: scraping rate-limits`)
  4. Curation flow at `/endsession`: Angel reads Session Memory file (`~/.claude/sessions/<id>/.session-memory.md`) + conversation_turns; proposes 1-3 candidate Lessons / User Notes pointers; user accepts/edits/rejects in brief prompt
  5. **Reach = 5/5 active projects.** Writer runs for ALL active projects on Angel heartbeat sweep, not just current session's project. Lacuna/Oracle/Nexus get auto-managed `## Active Projects` + `## Handoff` blocks prepended; existing manual pointer-indexes migrate verbatim into `## User Notes`. Migration NEVER stomps existing user content.
  6. Writer state-machine bug fixed (duplicate `<!-- USER EDITABLE -->` markers eliminated; idempotent re-run produces byte-identical output)
  7. Mixed-precision `created_at_epoch` normalized to milliseconds across all artifact kinds
  8. transcript_chunk reach verified — chunker runs for all sessions; live-fire confirms ≥1 chunk per session
  9. **Live-fire gate (cross-cutting principle 5):** writer must produce valid output for all 5 active projects in soak before merge. Content-quality score (SC#3 rubric) ≥80% on every project.
  10. **SC#3 — MEMORY.md content-quality ≥80%** on every active project. Mechanical scoring (zero parsing bugs; ≥80% pointers project-specific; topics not session-IDs; pointer density ≥1/10 lines; handoff freshness)
  11. Vesna probes pass for entity recall + handoff pickup against new MEMORY.md schema

**Plans:** 9 plans in 5 waves — all COMPLETE 2026-04-29:
- [x] 04.1-01-PLAN.md — V18 schema migration + read-time epoch normalization (W1)
- [x] 04.1-02-PLAN.md — transcript-chunker timestamp fix + reach investigation (W1; CUR-15 reach partial-defer)
- [x] 04.1-03-PLAN.md — memory-md-writer state-machine bug fix (CUR-13) (W1)
- [x] 04.1-04-PLAN.md — Lesson file writer + frontmatter schema (3 types) (W2)
- [x] 04.1-05-PLAN.md — MEMORY.md restructure: drop Entities/Threads, add ## Lessons (W3)
- [x] 04.1-06-PLAN.md — User-authored MEMORY.md migration (Lacuna/Oracle/Nexus preservation) (W2)
- [x] 04.1-07-PLAN.md — Angel heartbeat sweeps: feedback density → critical_rules + multi_project_count + shape vocab (W4; sidecar fallback used)
- [x] 04.1-08-PLAN.md — /endsession Angel curation flow: lesson + user-notes proposals (W3; skill wire-up deferred to operator)
- [x] 04.1-09-PLAN.md — Behavioral live-fire gate: feedback→rule probe + multi-project boost + content-quality scorer (W5)

### Phase 5: P4 — Kill legacy injection
**Goal:** Delete 9 legacy injection sections; session-start ≤500 tokens cache-stable; UPS ≤1KB; `initialUserMessage` prime
**Depends on:** Phase 4.1 (MEMORY.md must be working before injection dies, or agent has no fallback)
**Requirements:** INJ-01..INJ-07, CACH-01..CACH-03 (new — cache stability), TOK-01 (new — token budget)
**Success Criteria:**
  1. Assembler `assembler.ts` deletes Proven Principles, Entity Summaries auto-surface, Angel Opinions, Predicted Context, Curated Context, Experience Warnings auto-surface, Flow, Reference Layer, Materialization
  2. Assembler keeps Identity, Project (CLAUDE.md), Session Continuity, Checkpoint, GSD, MEMORY.md (native load)
  3. **SC#2 — token budget + cache stability:** session-start ≤500 tokens (tokenizer assertion). 3-layer cache test: (a) tokenizer assert, (b) golden snapshot byte-identical, (c) invariance under volatile-state mutation (clock change, session-ID change, host-env change must not change output bytes). Hard.
  4. UPS per-turn payload ≤1KB; only dynamic signals carried
  5. `initialUserMessage` auto-prime (system-role) fires only when handoff frontmatter `status: active` AND `phase` matches `STATE.md`. NOT mtime-gated.
  6. Pre-work hardening (5.0 sub-tasks) lands before deletion: clock leaks (3 sites: `assembler.ts:572,:657,:447`), session-ID strips (2: `sections.ts:859,:1005`), host-env normalization (2: `sections.ts:635`, `assembler.ts:646`), stable tiebreakers (4: `learnings.ts:60`, `artifacts.ts:178/:212`, `codebase-indexer.ts:306`, `state-reader.ts:109`), CRLF/BOM normalizer + `.gitattributes * text eol=lf`, STATE.md parser extension (extract phase name + number), handoff frontmatter spec (canonical `status`, `phase`).
  7. Tier-based deletion (A: Flow/Reference/Materialization → B: Predicted/Opinions/Principles → C: Entity Summaries/Curated/Experience Warnings auto-surface). Vesna + content-quality + cache-stability run at each tier boundary.
  8. **SC#1 — Vesna probe pass ≥80%** at Phase 5 close (entity recall, constraint recall, handoff pickup probes especially)
  9. **No benchmark gate.** LongMemEval/LoCoMo not run as part of Phase 5 acceptance. (See PROJECT.md Constraints — benchmarks not used in v4.)

**Fallback ladder** (triggered on real signals: cache snapshot diff, token budget violation, Vesna pass-rate <80%, content-quality <80%):
- L1: raise UPS budget 1KB → 2KB; re-run Vesna. Autonomous IF UPS budget split from session-start budget first.
- L2: keep one injection section (highest-signal-density first; manual review). Reset L1's UPS bump.
- L3: dual-inject diagnostic mode via env flag `CLAUDEX_P4_INJECTION_MODE=lean|entity_only|dual` ("Ghost Code" pattern). NOT branch checkout. Run targeted Vesna probes lean vs dual to attribute which section(s) carry recall load. Funeral PR deletes legacy after gate passes.
- L4: full revert to Phase 4.1 candidate. Pre-condition: MEMORY.md content-quality must show measurable improvement before next attempt (operationalized as SC#3 score delta).

**Plans:** 9 plans in 8 waves — all COMPLETE 2026-04-29:
- [x] 05-01-PLAN.md — Pre-flight backup + CACH-03 hardening (14 sites) + scope-decisions doc + Vesna baseline
- [x] 05-02-PLAN.md — 3-layer cache-stability test harness (4 scenarios × 3 layers; gpt-tokenizer)
- [x] 05-03-PLAN.md — Tier A deletion (Flow, Reference Layer, Materialization) + Tier A gate PASS
- [x] 05-04-PLAN.md — Tier B deletion (Predicted, Opinions, Principles session-start, project_overview) + Tier B gate PASS
- [x] 05-05-PLAN.md — Tier C deletion (Entity Summaries, Curated, Experience Warnings auto) + Tier C gate PASS
- [x] 05-06-PLAN.md — Move codebase_index from session-start to UPS; UPS ≤1KB enforced
- [x] 05-07-PLAN.md — initialUserMessage rewrite (frontmatter contract, default-on, EXACT phase match) + SC#4 integration test
- [x] 05-08-PLAN.md — Experience-warning reactive trigger helpers (4 functions + 22 tests; hook wire-up deferred)
- [x] 05-09-PLAN.md — Phase close: full SC#1-#4 gate + soak + final verdict PASS + STATE/ROADMAP update

### Phase 5.5: Curation feedback loop (NEW)
**Goal:** Pointers earn their place by use. Self-corrects bias toward generic-noun extraction.
**Depends on:** Phase 5 (deletion done; recall traffic stabilized)
**Requirements:** CUR-16..CUR-18 (new)
**Success Criteria:**
  1. [x] New table: `pointer_recall_log(pointer_id, session_id, retrieved_at, helpful_yn, query)`. Recorded when retrieval surfaces a Lesson/User-Notes pointer.
  2. [x] At `/endsession`, Angel shows user pointers retrieved this session in suggestion flow + asks `helpful_yn` (light tap, not friction).
  3. [x] Auto-archive: pointer with 0 retrievals in 90d AND `helpful_yn = null` → moved out of MEMORY.md index (artifact preserved in DB).
  4. [x] Auto-promote: pointer with ≥3 retrievals + `helpful_yn = true` → moved to high-salience top of section.
  5. [x] Vesna probe: lifecycle simulation (high-recall pointer survives 30d simulated; never-touched pointer archives).

**Plans:** 5 plans in 3 waves — all COMPLETE 2026-04-29:
- [x] 05.5-01-PLAN.md — V19 schema + pointer-recall helpers + lesson frontmatter updater (W1)
- [x] 05.5-02-PLAN.md — claudex_recall MCP wiring (extractLessonRef + handler patch) (W2)
- [x] 05.5-03-PLAN.md — /endsession pointer-feedback CLIs + skill Step 1d (W2)
- [x] 05.5-04-PLAN.md — heartbeat curation-feedback sweeps (archive + promote) (W3a)
- [x] 05.5-05-PLAN.md — Vesna lifecycle probe + roadmap close (W3b)

### Phase 6: P5 — Retrieval simplification + per-multiplier ablation
**Goal:** Collapse hybrid-retrieval scoring to RRF → cross-encoder rerank → top-k. Justify the deletion with per-multiplier A/B before bulk delete.
**Depends on:** Phase 5 (injection thin enough that retrieval quality is visible)
**Requirements:** RETR-01..RETR-04
**Success Criteria:**
  1. **Per-multiplier ablation BEFORE bulk delete:** one A/B per multiplier (`novelty`, `activation`, `q_value`, `recency`, etc.) measured against a Vesna probe subset. Results committed to `.planning/phases/06/06-MULTIPLIER-ABLATION.md`. Drop multipliers with ≤1pp Vesna delta; keep load-bearing ones.
  2. `hybrid-retrieval.ts` simplified per ablation results: minimum RRF(FTS5 + vec0 + recency) → cross-encoder rerank → budget-gated top-k.
  3. **Reranker hard-required.** BGE-v2-m3 cross-encoder must be alive for production retrieval; bi-encoder fallback explicitly degraded-mode (telemetry counter `reranker_fallback_fired` increments visibly).
  4. RIF suppression and spread activation retained (light + measurably useful for dedup).
  5. MCP surface unchanged: `claudex_search`, `claudex_recall`, `claudex_events`, `claudex_store`, `claudex_message`.
  6. DB backup at `~/.claudex/backups/pre-v4-P5-{ts}.db` before any schema drop.
  7. Vesna pass rate maintained (SC#1).

**Plans:** TBD

### Phase 6.5: Cross-project task-pattern recall (NEW)
**Goal:** Make the shadowban example mechanically work — task-similar prior findings surface across projects during framing.
**Depends on:** Phase 6 (retrieval simplified; cross-encoder load-bearing)
**Requirements:** RETR-06, RETR-07 (RETR-05 + RETR-08 closed by Phase 6)
**Success Criteria:**
  1. Task-pattern fingerprint stored on artifacts of `kind ∈ {mental_model, learning, experience_pattern, workspace_fact, lesson}`. Auto-classified at write time by Angel's segmentation. Short tag (`scraping rate-limits`, `auth flow design`, `live-fire vs static-test`, etc.).
  2. `claudex_search` query expansion: when query is task-shaped (verb + domain noun), expand to also search cross-project artifacts where task-pattern fingerprint matches via cosine + rerank.
  3. Cross-project search **default-ON** per locked decision Q10. Per-project opt-out via CLAUDE.md flag (no opt-out implemented unless requested).
  4. Surface: cross-project lessons surface as observational context (*"prior similar task in project X found Y"*), never as imperatives.
  5. Vesna probe coverage: at least 3 cross-project lesson-application probes (canonical: shadowban-from-Lacuna applies to investigate-another-backend task in big-mozzy-v2 or oracle).

**Plans:** 3 plans in 3 waves (executed 2026-04-29)
- [x] 06.5-01-PLAN.md (2026-04-29) — Pre-flight backup + V21 schema (artifact_task_pattern sidecar) + Angel write-time + heartbeat backfill classifier
- [x] 06.5-02-PLAN.md (2026-04-29) — HYBRID cross-project equivalence (Stage 1 telemetry + Stage 2 cosine ≥0.85) + Experience Tier scorer at assembler P4.06 + tier-utils Architecture B extraction
- [x] 06.5-03-PLAN.md (2026-04-29) — claudex_search task-shape detection + cross-project query expansion (default-ON, CLAUDE.md opt-out) + Vesna SC#1 gate (3/3 cross-project probes) + STATE/ROADMAP/REQUIREMENTS close

**Status:** PHASE 6.5 COMPLETE 2026-04-29.

### Phase 7: P6 — Framing rewrite
**Goal:** Every surviving formatter speaks in advisory voice — observation, not command
**Depends on:** Phase 6.5 (retrieval + cross-project stable so framing changes are isolatable)
**Requirements:** FRAM-01..FRAM-04
**Success Criteria:**
  1. `sections.ts` formatters contain no `WARNING:`, no `**Correct approach:**`, no `Apply them proactively — they are always relevant`, no `supersedes CLAUDE.md on conflict`
  2. Experience-warning surface (when agent explicitly queries) reframed as descriptive observation: *"Similar prior situation (session X): user wanted Y; outcome was Z."*
  3. `<experience-data>` wrap retained for injection isolation; inner content descriptive not imperative
  4. Manual inspection confirms no imperative framing across all formatters
  5. **Behavioral A/B for 1 week of real sessions:** subjective scoring of whether agent behavior shifts on advisory framing (does the agent feel like it's thinking with prior experience or following rules?). User-led review at week's end. Documented in `.planning/phases/07-p6-framing-rewrite-advisory-voice/07-BEHAVIORAL-AB.md`.
  6. Vesna pass rate maintained (SC#1).

**Plans:** 3 plans in 3 waves — all COMPLETE 2026-04-29:
- [x] 07-01-PLAN.md — Imperative-voice purge + advisory-voice rewrite for surviving formatters in `src/assembly/sections.ts` (W1)
- [x] 07-02-PLAN.md — Vesna purge probe + Phase 6.5 cross-project gate re-run + 07-VESNA-RESULT.md (W2)
- [x] 07-03-PLAN.md — Behavioral A/B scaffold + STATE/ROADMAP/REQUIREMENTS update + phase close (W3)

**Status:** PHASE 7 STRUCTURALLY COMPLETE 2026-04-29. SC#1 Vesna gate PASS at 8/8 probes (FRAM-04 + Phase 6.5 cross-project re-run, no retrieval regression). FRAM-01..FRAM-04 closed. End-of-week behavioral A/B verdict due 2026-05-06; signed by user; updates this row's status note when filed. Phase 7.5 unblocked.

### Phase 7.5: Handoff format redesign (NEW)
**Goal:** Replace 372-line frontmatter-rigid handoff schema with hybrid YAML status header + ADR body. ~15 lines target.
**Depends on:** Phase 7 (framing voice locked; handoff is one of the surfaces)
**Requirements:** HAND-01..HAND-03 (new)
**Success Criteria:**
  1. New schema:
     ```yaml
     ---
     status: active
     phase: <N>
     ---
     # <date> — <topic>

     **What we found:** ...
     **What we decided:** ...
     **What's next:** ...
     **Where to look:** ...
     ```
  2. Writer in `src/angel/handoff-writer.ts` (or equivalent) outputs the new shape; Phase 4.1's MEMORY.md `## Handoff` section consumes the YAML header for programmatic queryability.
  3. Migration: existing handoff (`context/handoffs/ACTIVE.md`) re-formatted to new shape; old content preserved in archive subdirectory.
  4. Vesna handoff-pickup probes pass against new format.

**Plans:**
- [x] 07.5-01-PLAN.md — Handoff schema module: writer, reader, validator (Wave 1, complete 2026-04-29 — commit f80ee29)
- [x] 07.5-02-PLAN.md — MEMORY.md `## Handoff` rewrite + ACTIVE.md migration (Wave 2, complete 2026-04-29 — commit b25cc20)
- [x] 07.5-03-PLAN.md — Vesna handoff-pickup probes + phase-close gate (Wave 3, complete 2026-04-29)

**Closed:** see `.planning/phases/07.5-handoff-format-redesign/07.5-SUMMARY.md`

### Phase 8: P6.5 — RL ablation gate
**Goal:** Deterministic go/no-go on deleting the RL stack, decided by behavioral observation (Vesna), not benchmark
**Depends on:** Phase 7.5 (all upstream behavior stable)
**Requirements:** ABL-01..ABL-03 (new — replaces deprecated BENCH-08)
**Success Criteria:**
  1. Feature flag `CLAUDEX_DISABLE_RL_SCORING=1` bypasses Q-value multipliers in `hybrid-retrieval.ts` and skips `rl-trainer` ticks in heartbeat
  2. Run Vesna probe suite with flag set; run baseline without flag.
  3. Decision committed to `context/specs/V4_RL_ABLATION.md`:
     - If flagged Vesna pass rate ≥ baseline -2pp: Phase 9 clears RL deletion
     - If flagged Vesna drops >2pp: RL is load-bearing — either keep stack and adjust scope or redesign with simpler learned signal
  4. Decision locked before Phase 9 begins
  5. Edge case: if delta is exactly at -2pp, default to "keep RL" (conservative). Document, revisit after Phase 9.

**Plans:**
  - 08-01: Env-flag gate across RL surface (ABL-01) — DONE 2026-04-29
  - 08-02: A/B Vesna probe harness — flagged vs baseline (ABL-02) — DONE 2026-04-29
  - 08-03: Decision lock in V4_RL_ABLATION.md + phase close (ABL-03) — DONE 2026-04-29

**Status:** CLOSED 2026-04-29 — verdict: DELETE_ALLOWED
**Decision artifact:** `context/specs/V4_RL_ABLATION.md`

### Phase 8.5: Recall observability + self-instrumented agent (NEW)
**Goal:** Agent + user can see what memory did, what worked, what cost. Visible token cost forces discipline; mid-session debug surface enables ad-hoc inspection.
**Depends on:** Phase 8 (retrieval stack stable)
**Requirements:** OBS-01..OBS-04 (new)
**Success Criteria:**
  1. Per-session retrieval log: every `claudex_search` / `claudex_recall` invocation captured with query, top-k results, which were used in subsequent agent output, token cost.
  2. Agent system prompt addition (advisory voice): when retrieval returns nothing useful, narrate (*"no prior experience on this — going in cold"*); when retrieval returns gold, narrate (*"checking shadowban research from Lacuna … found, applying"*). Visible by default, silent on demand.
  3. Visible token cost at `/endsession`: *"session-start spent N tokens; recall added M tokens; total memory cost X tokens."*
  4. Slash command `/claudex-why` (or equivalent) shows retrieval log for current session.
  5. Vesna probes verify self-instrumentation (*"when agent had relevant prior experience, did it surface during framing?"*).

**Plans:** 6 plans in 4 waves — all COMPLETE 2026-04-30:
- [x] 08.5-01-PLAN.md — V22 retrieval_log + helper module + countTokensCl100k (W1)
- [x] 08.5-02-PLAN.md — narration directive + /silent toggle (W1)
- [x] 08.5-03-PLAN.md — claudex_search + claudex_recall instrumentation (W2)
- [x] 08.5-04-PLAN.md — /endsession token-cost CLI (W3)
- [x] 08.5-05-PLAN.md — /claudex-why slash + CLI (W3)
- [x] 08.5-06-PLAN.md — Vesna probes + cache-stability re-gate + phase close (W4)

**Status:** PHASE 8.5 COMPLETE 2026-04-30. SC#2 cache-stability gate PASS at 12/12 (budget 191/500). OBS-01..OBS-04 closed. Phase 9 unblocked.

### Phase 9: P7 — Angel simplification (sub-phased)

> Phase 8 verdict was **DELETE_ALLOWED** (2026-04-29). Sub-phase 9.8 is **scheduled** accordingly. See `context/specs/V4_RL_ABLATION.md` for evidence.

**Goal:** Delete CARA, autonomous-investigator, dream consolidation, skill crystallization, cross-project consolidator, proactive curator, data-quality. T6 audit (2026-04-27) verified all consumers are in `assembler.ts` (Phase 5 deletion target) — these are dead-infrastructure cleanup, not cognitive-capacity cuts.
**Depends on:** Phase 8 (RL decision locked) AND Phase 5 (consumer deletions live)
**Requirements:** CUR-05, CUR-06, CUR-07, EXTR-05, RETR-05 (legacy numbering preserved)
**Success Criteria:**
  1. Per-module deletion sub-phases land in order; each sub-phase: delete one module → vitest pass → Vesna probe spot-check → atomic commit. No grouped deletions.
  2. Modules deleted (one per sub-phase): `cara-reasoning.ts` (9.1), `autonomous-investigator.ts` (9.2), `consolidator.ts::runDreamConsolidation` (9.3), `pattern-extractor.ts::crystallizePatternToSkill` (9.4), `cross-project-consolidator.ts` (9.5), `proactive-curator.ts` (9.6), `data-quality.ts` (9.7)
  3. **Conditional 9.8 (RL stack)** — only if Phase 8 cleared: `retrieval-rl.ts`, `memrl-scorer.ts`, `rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`, `policy-registry.ts`, `policy_weights` table (V19).
  4. Heartbeat tick count drops from ~20 phases to ~8.
  5. Associated tests deleted; remaining tests all pass after every sub-phase.
  6. Net LOC delta ~−3000 to −4000 lines.
  7. Vesna pass rate maintained at every sub-phase (SC#1).

**Plans:** 9 plans in 9 waves — all COMPLETE 2026-04-30:
- [x] 09-01-PLAN.md — sub-phase 9.2: delete autonomous-investigator.ts (Wave 1, commit 3409608)
- [x] 09-02-PLAN.md — sub-phase 9.1: delete cara-reasoning.ts (Wave 2, commit c751f73)
- [x] 09-03-PLAN.md — sub-phase 9.3: delete consolidator dream surface (Wave 3, commit 3be2357)
- [x] 09-04-PLAN.md — sub-phase 9.4: delete crystallizePatternToSkill (Wave 4, commit 5a21d82; skill-writer.ts kept per consumer audit)
- [x] 09-05-PLAN.md — sub-phase 9.5: delete cross-project-consolidator.ts (Wave 5, commit 748228a; cross-project canary 4/4)
- [x] 09-06-PLAN.md — sub-phase 9.6: delete proactive-curator.ts (Wave 6, commit 00eaa65)
- [x] 09-07-PLAN.md — sub-phase 9.7: delete data-quality.ts (Wave 7, commit 0c63307)
- [x] 09-08-PLAN.md — sub-phase 9.8: delete RL stack + V23 migration (Wave 8, commit 7315433; policy-registry.ts kept per T6 audit error)
- [x] 09-09-PLAN.md — Phase 9 close (Wave 9, this commit; Vesna 32/32, REQUIREMENTS/STATE/ROADMAP/SUMMARY/VESNA-RESULT updated)

**Status:** PHASE 9 COMPLETE 2026-04-30. SC#1 Vesna PASS at 32/32 integration probes (100%); per-sub-phase 8-probe spot-check 8/8 throughout. Aggregate LOC −6021 (target was −3000 to −4000; exceeded due to migration test bumps and obsolete phase-8-rl-ablation.test.ts). Heartbeat tick comments 38→28. CUR-05/06/07, EXTR-05, RETR-05 closed. Phase 10 unblocked. See `.planning/phases/09-p7-angel-simplification/09-SUMMARY.md`.

### Phase 10: Vesna probe suite as central validation (NEW — promoted from smoke check)
**Goal:** Behavioral validation is a first-class deliverable, not Phase 11 footnote. Mine ~20 probes from real session histories across all active projects; CI-gate.
**Depends on:** Phase 5 (Phase 5 + 4.1 must be live so probes run against real v4 surface). Schedulable parallel with later phases.
**Requirements:** VESN-01..VESN-04 (new)
**Success Criteria:**
  1. Probe corpus mined from session histories across all active projects (claudex-v3, lacuna-betting, oracle, big-mozzy-v2, desktop-01dcc792, nexus-e53c6c93). Each retrieval moment in real history becomes a candidate probe.
  2. Curated to ~20 probes covering: entity recall (3-5), constraint recall (3-5), handoff pickup (3), cross-project (3-5), lesson application (3-5), self-instrumented gap detection (2-3).
  3. CI integration: probe suite runs on every PR via `bun run vesna` or equivalent. Pass rate ≥80% required to merge.
  4. Probes maintained alongside code: `src/benchmark/vesna/probes/*.json` + harness in `src/benchmark/vesna/`.
  5. Documented probe authoring guide in `src/benchmark/vesna/README.md`.

**Plans:** 5 plans in 3 waves — all COMPLETE 2026-04-30:
- [x] 10-01-PLAN.md — Harness core: schema, loader, setup-step DSL, evaluator, three-trial runner, CLI, `bun run vesna` script (W1)
- [x] 10-02-PLAN.md — Migrate 5 existing probes to canonical schema + 3 buffer placeholders (W2)
- [x] 10-03-PLAN.md — Author 6 new probes (3 entity-recall + 3 constraint-recall) mined from real sessions (W2)
- [x] 10-04-PLAN.md — Author 6 new probes (3 cross-project + 3 lesson-application) mined from real sessions (W2)
- [x] 10-05-PLAN.md — GitHub Actions workflow + authoring guide README + phase close (W3)

**Status:** PHASE 10 COMPLETE 2026-04-30. SC#1 surface shipped (Phase 11 runs the gate). 20-probe corpus locked at canonical distribution (entity 3 + constraint 3 + handoff 3 + cross-project 3 + lesson-application 3 + self-instrumented 2 + buffer 3). Phase-close run: 17/17 PASS at 100%/100%. CI gate live in `.github/workflows/vesna.yml`. Phase 11 unblocked. See `.planning/phases/10-vesna-probe-suite-central-validation/10-CLOSE-SUMMARY.md`.

### Phase 11: P9 — Final validation against SC#1-#4
**Goal:** Ship v4. Tag against the four success criteria.
**Depends on:** Phase 10 (Vesna live as central validation)
**Requirements:** All SC#1-#4 mechanisms live (VESN, CACH, TOK, CONT, HAND).
**Success Criteria:**
  1. **SC#1 — Vesna probe pass ≥80%** across full ~20-probe suite, every category, every active project.
  2. **SC#2 — Token budget ≤500 cache-stable** (3-layer test passes).
  3. **SC#3 — MEMORY.md content-quality ≥80%** across all 5 active projects (mechanical scoring).
  4. **SC#4 — One-turn handoff pickup** verified on 3 cold-start sessions across 3 different projects (no exploratory glob/grep/Bash before first user-facing action; handoff-referenced reads allowed).
  5. Full v3 test suite (adjusted for Phase 9 deletions) passes.
  6. Legacy `_old` tables dropped IF zero-caller audit passes; otherwise views remain.
  7. `CLAUDE.md` and `README.md` updated to reflect v4 architecture; benchmark language removed; banner: *"v4.0 is internal infrastructure. v4.1 = Distribution will make it installable by strangers."*
  8. **One-shot benchmark vibe-check:** run LongMemEval and LoCoMo once, record numbers in commit message for archival reference. **Numbers do not gate ship.** If they regress dramatically, investigate; otherwise log and proceed.
  9. Git tag `v4.0.0` pushed.
  10. v4.1 = Distribution milestone scaffolded (`.planning/` next-cycle stub committed).

**Plans:** TBD

---

## Phase Details (v4.1)

### Phase 12: Metadata + License + README foundation
**Goal:** Establish Claudex as an MIT-licensed, externally legible repository — strangers landing on the GitHub page understand what it is, who it's for, and how to read its history before they ever try to install.
**Depends on:** v4.0 SHIPPED (Phase 11 complete)
**Requirements:** LIC-01, LIC-02, LIC-03, DOC-01, DOC-02, DOC-05, DOC-06
**Success Criteria:**
  1. `LICENSE` file exists at repo root containing MIT license text with copyright `2026 Grigorije Jakisic`; `package.json` declares `"license": "MIT"` (LIC-01, LIC-02 component)
  2. `package.json` advertises the project as a public package: `"private": true` removed, `"version": "4.1.0"` set, `"repository"`, `"bugs"`, `"homepage"`, `"keywords"`, and `"engines": { "bun": ">=1.3" }` populated and consistent with the public ship target (LIC-02, LIC-03)
  3. `README.md` at repo root introduces Claudex in plain English in <500 words, includes a "Why Claudex" section that conveys the v4 thesis (organic memory tool use) with one concrete example, and is the entry point for human readers — CLAUDE.md remains for the agent (DOC-01, DOC-02)
  4. `CHANGELOG.md` at repo root documents v4.0.0 (16-phase summary + SC#1-#4 evidence) sourced from `.planning/phases/11-p9-final-validation/11-V4-VALIDATION.md` (DOC-05)
  5. Contributing surface exists — either `CONTRIBUTING.md` at repo root or a README section — covering development setup, `bun run test` (NOT `bun test`), commit conventions, and where to find architectural docs (DOC-06)

**Plans:** 5/5 plans complete

### Phase 13: Cross-platform code audit
**Goal:** A reader on macOS or Linux can clone the repo, run the test suite, and have hooks/locks/subprocess/path handling work without modification — the codebase stops assuming Windows-only conventions.
**Depends on:** Phase 12 (repo is now externally legible; portability work happens against a known-public surface)
**Requirements:** PLAT-01, PLAT-02, PLAT-03, PLAT-04, PLAT-05
**Success Criteria:**
  1. Path handling across `src/` uses `path.join` / `path.resolve` exclusively — exhaustive audit closed with zero hardcoded `\\` separators or platform-specific separators in source (PLAT-01)
  2. Hook scripts in `src/adapters/cc-hooks/` execute on Mac and Linux without modification — correct shebangs, no PowerShell-only constructs, file-permission handling cross-platform (PLAT-02)
  3. File-lock teardown works on Mac/Linux — Windows `taskkill` paths complemented by signal-based termination on Unix; hook-deadlock prevention preserved (PLAT-03)
  4. Subprocess spawning works cross-platform — no `cmd /c` chains; uses Node `spawn` or Bun `$` portably across Windows + Mac + Linux (PLAT-04)
  5. Line endings normalized via `.gitattributes` — LF for source files, CRLF for `.bat` scripts; existing CRLF/BOM normalizer from Phase 5's CACH-03 hardening preserved (PLAT-05)
  6. Full Vitest suite (`bun run test`) passes on Windows after the audit; cross-platform behavior verified by code review and existing tests — actual fresh-VM runs on Mac/Linux deferred to Phase 16 (HITL)

**Plans:** 5/5 plans complete
- [x] 13-01: PLAT-01 path-handling audit (read-only) — 0 fix-needed across 39 keep-with-reason hits
- [x] 13-02: PLAT-02 + PLAT-04 hook + subprocess audit (read-only) — 0 PowerShell constructs in hooks; single fix-needed (heartbeat.ts:202)
- [x] 13-03: PLAT-03 process-control abstraction — src/shared/process-control.ts + 8 unit tests; 0 taskkill callsites needed migration (forward-looking parity)
- [x] 13-04: PLAT-01 + PLAT-02 + PLAT-04 fix execution — single fix applied (heartbeat.ts:202 shell-string execSync → 3-step execFileSync array args); final audit report
- [x] 13-05: PLAT-05 .gitattributes extension + phase close — extended baseline with per-extension rules; experience-patterns.ts renormalized CRLF→LF; STATE/ROADMAP/REQUIREMENTS marked

**Status:** PHASE 14 COMPLETE 2026-05-01. SC#1 Vesna PASS at 17/17 (100%). bun run test 3147 + 20 baseline llama-server-supervisor failures unchanged from v4.0.0. INST-01..07 closed (19 of 44 v4.1 reqs done). Phase 15 unblocked.

### Phase 14: Bootstrap install + configurable paths
**Goal:** A stranger runs one command from a clean clone and ends up with Ollama running, the embedding model pulled, the BGE reranker alive on port 7439, hooks registered, and Claude Code producing working assembly within their first user turn.
**Depends on:** Phase 13 (cross-platform code audit complete; bootstrap can target all three OSes)
**Requirements:** INST-01, INST-02, INST-03, INST-04, INST-05, INST-06, INST-07
**Success Criteria:**
  1. `bun run setup` (and/or `./install.sh`) runs end-to-end from a clean clone, returns exit 0 on success, and is idempotent — re-running it doesn't break a working install (INST-01)
  2. Ollama prerequisite is detected; if missing, bootstrap prints platform-specific install instruction (Homebrew / apt / Windows installer) and exits 1 with actionable guidance (INST-02)
  3. `snowflake-arctic-embed2` model is pulled via Ollama (idempotent — skipped if already pulled); pull completion verified before bootstrap returns success (INST-03)
  4. BGE reranker service starts on port 7439 (Python venv + dependencies + boot supervised by Angel's `RerankerSupervisor`); if any step fails, bootstrap prints actionable failure message naming the failing step (INST-04)
  5. Hardcoded `~/Desktop/Projects/` reference replaced with `CLAUDEX_PROJECTS_DIR` environment variable (default: `~/Projects/` cross-platform); MCP server registration uses the configurable directory; existing `~/.claudex/projects.json` migrates to new path conventions without losing entries (INST-05, INST-06)
  6. First-session UX verified: after `bun run setup`, opening Claude Code in any registered project produces a working session-start assembly within 1 user turn — no manual steps, no missing context (INST-07)

**Plans:** 14-01 (projects-dir helper + audit), 14-02 (callsite refactor), 14-03 (bootstrap steps), 14-04 (install wrappers), 14-05 (verify + close)
**Closed:** 2026-05-01

### Phase 15: `claudex doctor` diagnostics
**Goal:** When a stranger's install breaks, they run one command and learn exactly what's wrong and how to fix it — no GitHub issue required, no prior knowledge of which process owns which port.
**Depends on:** Phase 14 (bootstrap exists; doctor checks the prereqs that bootstrap installs)
**Requirements:** DIAG-01, DIAG-02, DIAG-03, DIAG-04, DIAG-05, DIAG-06, DIAG-07, DIAG-08
**Success Criteria:**
  1. `bun run doctor` command exists, is documented in README, and returns exit 0 if every check passes / exit 1 with actionable per-check error if any fails (DIAG-01, DIAG-08)
  2. Doctor reports Bun version with pass/fail against `>=1.3` floor; missing Bun produces install-instruction output (DIAG-02)
  3. Doctor reports Ollama state — process running + `snowflake-arctic-embed2` model pulled — and emits actionable remediation when either condition fails (DIAG-03)
  4. Doctor probes BGE reranker on port 7439 via HTTP and reports reachability with response status (DIAG-04)
  5. Doctor inspects `~/.claudex/db/claudex.db` — file exists + schema version matches build's expected migration version — and surfaces backup/restore guidance when mismatched (DIAG-05)
  6. Doctor reads Claude Code settings, confirms Claudex hooks are registered, and reports any missing hook by name (DIAG-06)
  7. Doctor checks Angel process liveness via PID file + heartbeat freshness from `telemetry`; stale heartbeat surfaces as a fail with restart guidance (DIAG-07)

**Plans:** TBD

### Phase 16: Onboarding verification + README polish
**Goal:** Three actual humans (operator-driven) install Claudex from a clean clone on macOS, Ubuntu 24.04, and Windows 11 fresh VMs, every friction point gets resolved, and the README's Quick Start + Troubleshooting sections reflect what the install actually feels like.
**Depends on:** Phase 15 (doctor exists; friction points can be triaged into "fix code / add doctor check / document in README")
**Requirements:** PLAT-06, PLAT-07, PLAT-08, VER-01, VER-02, VER-03, VER-04, VER-05, DOC-03, DOC-04
**HITL constraint:** PLAT-06/07/08 + VER-01..05 require **operator-driven fresh-VM runs** on macOS, Ubuntu 24.04 LTS, and Windows 11. Plan-phase will produce per-platform operator runbooks; the phase closes once all three fixtures are filled in. Structure mirrors Phase 11 SC#4 (synthetic Vesna 3/3 + 3 cold-start trials operator-runnable).
**Success Criteria:**
  1. Three onboarding fixtures land at `docs/onboarding/macos.md`, `docs/onboarding/linux.md`, `docs/onboarding/windows.md` — each records every friction encountered installing on its respective fresh VM, including the total elapsed time (VER-01, VER-02, VER-03, VER-05)
  2. End-to-end install verified on macOS (latest stable), Ubuntu 24.04 LTS, and Windows 11 fresh VMs; the Windows run is the regression check against the development platform (PLAT-06, PLAT-07, PLAT-08)
  3. Every friction point in the three fixtures is closed as one of: a code fix, a new doctor check, or a README troubleshooting entry — none left "open" or "wontfix" without explicit operator sign-off (VER-04)
  4. The <30-minute install target is measured on each platform and met; if a platform exceeds 30 minutes, the regression is documented and either resolved (preferred) or flagged on the fixture as an explicit residual (VER-05)
  5. README Quick Start section walks the reader from clone → `bun run setup` → open Claude Code → working session in <30 minutes, with the actual commands and expected output the operator saw on each platform (DOC-03)
  6. README Troubleshooting section covers the canonical install failures: Ollama not running, port 7439 dead, Bun version mismatch, hook registration failure — each with the doctor command that detects it and the operator action that fixes it (DOC-04)

**Plans:** TBD

### Phase 17: Public ship to grigorijejakisic/claudex
**Goal:** Tag v4.1.0, push the complete history to `github.com/grigorijejakisic/claudex` public, cut the GitHub release, and apply repo metadata + branch protection — the milestone closes the moment a stranger can find the repo via search and clone it.
**Depends on:** Phase 16 (onboarding verified across all three platforms; <30-min target met)
**Requirements:** REL-01, REL-02, REL-03, REL-04, REL-05, REL-06, REL-07
**Success Criteria:**
  1. Public GitHub remote is configured pointing at `github.com/grigorijejakisic/claudex` and the initial push includes complete master history plus all tags (v4.0.0 + v4.1.0); `git ls-remote` confirms parity with local (REL-01, REL-02)
  2. `v4.1.0` annotated git tag is created, signed if signing is enabled, and pushed to the public remote (REL-03)
  3. GitHub release for v4.1.0 is published with notes derived from `CHANGELOG.md` — release page is reachable, displays the v4.1 narrative, and links to the v4.0.0 archive (REL-04)
  4. Repository topics applied via GitHub UI/API for discoverability (final list confirmed at ship time from candidates: `claude-code`, `mcp`, `agent-memory`, `llm-tools`, `typescript`, `bun`); topics visible on the public repo page (REL-05)
  5. README badges (license, version, build status) render correctly on the public GitHub page — the Vesna CI workflow from Phase 10 reports green; license + version badges link to canonical sources (REL-06)
  6. Branch protection rule for the Vesna CI gate is applied via GitHub UI on the public repo (carries forward the manual step deferred from Phase 10 close) — main is protected, Vesna check is required (REL-07)

**Plans:** TBD

## Progress

**Execution Order:**
Phases execute in numeric order with decimal phases interleaved per their numeric position:
1 → 2 → 3 (merge) → 4 (closed, superseded) → 4.1 → 5 → 5.5 → 6 → 6.5 → 7 → 7.5 → 8 → 8.5 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17

Phase 9 may be scheduled parallel to 6/7 once Phase 5 ships (T6 verified safe). Phase 10 may be scheduled parallel to 5.5/6 once 4.1 + 5 are live. v4.1 phases 12-17 execute strictly serial — each depends on its predecessor's output to be installable / auditable.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. P0 — Crystallization | 1/1 | Complete | 2026-04-19 |
| 2. P1 — Artifact unification | 7/7 | Complete (T3 verified 2026-04-27) | 2026-04-20 |
| 3. P2 + P8 merge — Directive detector + lifecycle + PreToolUse | 6/10 | Partial-with-followups (path B); merger pending | 2026-04-22 (partial) |
| 4. P3 — MEMORY.md curation | 8/8 | Partial-corrective-pending (4.1 supersedes) | 2026-04-26 |
| 4.1. MEMORY.md content redesign + Lessons | 9/9 | Complete | 2026-04-29 |
| 5. P4 — Kill legacy injection | 9/9 | Complete | 2026-04-29 |
| 5.5. Curation feedback loop | 5/5 | Complete | 2026-04-29 |
| 6. P5 — Retrieval simplification + per-multiplier ablation | 0/0 | Not started | - |
| 6.5. Cross-project task-pattern recall | 0/0 | Not started | - |
| 7. P6 — Framing rewrite | 3/3 | Complete (structural; verdict pending end-of-week) | 2026-04-29 |
| 7.5. Handoff format redesign | 0/0 | Not started | - |
| 8. P6.5 — RL ablation gate | 0/0 | Not started | - |
| 8.5. Recall observability + self-instrumented agent | 6/6 | Complete | 2026-04-30 |
| 9. P7 — Angel simplification | 9/9 | Complete | 2026-04-30 |
| 10. Vesna probe suite (central validation) | 5/5 | Complete | 2026-04-30 |
| 11. P9 — Final validation against SC#1-#4 | 0/0 | Not started | - |
| 12. Metadata + License + README foundation | 5/5 | Complete   | 2026-04-30 |
| 13. Cross-platform code audit | 5/5 | Complete | 2026-04-30 |
| 14. Bootstrap install + configurable paths | 0/0 | Not started | - |
| 15. `claudex doctor` diagnostics | 0/0 | Not started | - |
| 16. Onboarding verification + README polish | 0/0 | Not started | - |
| 17. Public ship to grigorijejakisic/claudex | 0/0 | Not started | - |
