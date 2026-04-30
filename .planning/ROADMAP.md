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
- [ ] **Phase 9: P7 — Angel simplification** — Per-module deletion of cognitive layer (T6 verified all consumers are in `assembler.ts` which Phase 5 deletes — safe)
- [ ] **Phase 10: Vesna probe suite as central validation** — Mine ~20 probes from real session histories; CI-gated; pass rate ≥80% required
- [ ] **Phase 11: P9 — Final validation against SC#1-#4** — Behavioral suite + content-quality + cache stability + handoff pickup; tag v4

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

**Plans:** TBD

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

**Plans:** TBD

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

## Progress

**Execution Order:**
Phases execute in numeric order with decimal phases interleaved per their numeric position:
1 → 2 → 3 (merge) → 4 (closed, superseded) → 4.1 → 5 → 5.5 → 6 → 6.5 → 7 → 7.5 → 8 → 8.5 → 9 → 10 → 11

Phase 9 may be scheduled parallel to 6/7 once Phase 5 ships (T6 verified safe). Phase 10 may be scheduled parallel to 5.5/6 once 4.1 + 5 are live.

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
| 9. P7 — Angel simplification | 0/0 | Not started | - |
| 10. Vesna probe suite (central validation) | 0/0 | Not started | - |
| 11. P9 — Final validation against SC#1-#4 | 0/0 | Not started | - |
