# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** v4 makes the agent USE Claudex organically as part of how it works in Claude Code. Memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) are reached for the same way `Read` or `Grep` are used — natural extensions of reasoning, not a separate "fetch context" step that has to be remembered.

**Current focus:** Phase 8.5 COMPLETE 2026-04-30 — recall observability + self-instrumented agent shipped end-to-end across 6 plans. retrieval_log + cl100k_base counter + advisory-voice narration directive + /silent toggle + /endsession cost block + /claudex-why slash; OBS-01..OBS-04 closed; SC#2 cache-stability re-passes (12/12, budget 191/500); 2 Vesna probes (gap-detection + empty-surface) ship into the corpus. Phase 9 (Angel simplification) is next-unblocked per ROADMAP. End-of-week Phase 7 behavioral A/B verdict still due 2026-05-06.

## Current Position

**Current Phase:** 9
**Current Phase Name:** P7 — Angel simplification (sub-phased)
**Total Phases:** 16
**Current Plan:** 0 (planning not yet started)
**Total Plans in Phase:** TBD
**Status:** **PHASE 8.5 COMPLETE 2026-04-30.** Recall observability + self-instrumented agent shipped end-to-end across 6 plans / 6 atomic commits. (1) V22 `retrieval_log` + `session_flag` schema + helper module + `countTokensCl100k` (gpt-tokenizer); (2) advisory-voice narration directive (3 locked templates: empty / gold / ambiguous) + `/silent` toggle backed by V22 `session_flag`; (3) MCP server instrumentation: `claudex_search` + `claudex_recall` log every retrieval to `retrieval_log` with cl100k_base token cost; (4) `/endsession` token-cost CLI (`session-token-cost`) reads `retrieval_log` + existing telemetry(injection) rows, prints CONTEXT.md format block; (5) `/claudex-why` slash + CLI (`why`) renders chronological retrieval lines + aggregate footer; (6) 2 Vesna probes (gap-detection + empty-surface), SC#2 cache-stability gate re-PASSES 12/12 (budget 191/500), STATE/ROADMAP/REQUIREMENTS closed. OBS-01..OBS-04 marked `[x]`. Honest gaps: (a) Plan 04 falls back to `(unavailable)` when telemetry data is incomplete (acknowledged graceful-degrade per plan); (b) `/silent` v1 is agent-honoring-directive, not enforced — per-turn reminder is a follow-up if behavior shows the toggle is ineffective.
**Last Activity:** 2026-04-30
**Last Activity Description:** Phase 8.5 shipped end-to-end across 4 waves. W1: Plan 01 (V22 schema + retrieval-log module + cl100k counter; 18 files / 929 insertions / 38 deletions; 34 new tests, all migration tests updated 21→22) — commit 3ce3b08. W1: Plan 02 (narration-directive module + recall-server append + claudex_session toggle actions; 4 files; 15 tests) — commit e2f150e. W2: Plan 03 (recall-server search + recall instrumentation + _resolveActiveSessionId helper; 2 files; 11 tests) — commit 1ed271c. W3: Plan 04 (session-token-cost CLI + endsession skill update; 3 files; 11 tests) — commit 52d6956. W3: Plan 05 (why CLI + claudex-why skill; 2 files; 23 tests) — commit 44816c0. W4: Plan 06 (2 Vesna probes + integration test + STATE/ROADMAP/REQUIREMENTS + SUMMARY).
**Progress:** [██████████] 110%

Phase: 9 of 16 (P7 — Angel simplification, sub-phased)
Plan: 0 of TBD in current phase
Status: ready to plan
Last activity: 2026-04-30 — Phase 8.5 shipped end-to-end (OBS-01..OBS-04 closed)

Progress: [██████████░░░░░░] 56%

## Accumulated Context

### Decisions

Decisions logged in PROJECT.md Key Decisions table. Summary:

**P0 (2026-04-19) — original locks:**
- Q1 transcript chunking — LLM topic-detected boundaries
- Q2 MEMORY.md schema — sectioned markdown (superseded by Q5)
- Q3 directive threshold — regex + LLM-confirm, ≥0.7 starting
- Q4 project_curated_context — migrate to `artifact(kind='mental_model')`, flag stale entries

**Audit rebind (2026-04-27) — supersedes/extends P0:**
- Q5 MEMORY.md schema — drop `## Entities` + `## Recent Threads` (frequency-extraction noise); add `## Lessons` (task-pattern indexed pointers); promote `## User Notes`. Supersedes Q2.
- Q6 Goal — agent USES Claudex organically (verb, not vibe). Memory tools used like `Read`/`Grep`.
- Q7 Success criteria — SC#1 Vesna ≥80% (behavioral), SC#2 ≤500 token cache-stable (structural), SC#3 content-quality ≥80% (mechanical), SC#4 one-turn handoff pickup (continuity). Replace all benchmark-as-gate language.
- Q8 Benchmarks — DROPPED ENTIRELY. Not gates, not floors, not sanity. Harness on disk; runnable on demand; one-shot at v4 ship for archival record only.
- Q9 Phase 3 + Phase 10 merge — directive detector ships with PreToolUse consumer + lifecycle (scope, supersession, decay) as one unit.
- Q10 Cross-project recall default — ON. Methodology and knowledge cross-pollinate by default.
- Q11 Handoff format — hybrid (2-line YAML status header + ADR-style body). Replaces 372-line schema with ~15 lines.
- Q12 Phase ordering — 4.1 first (unblocks behavioral exercise of 5).

### Pending Todos

- (None blocking 4.1 planning. Audit T3-T6 verified; T8 ROADMAP rewrite complete.)

### Blockers/Concerns

(Audit-pending blockers from 2026-04-27 morning are resolved by the rebind.)

**Active concerns going into Phase 4.1 planning:**

- **MEMORY.md writer state-machine bug** — duplicate `<!-- USER EDITABLE -->` markers visible at line 42 of `~/.claude/projects/.../MEMORY.md` for CLAUDEXv3 right now. Real fix in `src/angel/memory-md-writer.ts` is part of 4.1 scope.
- **Mixed-precision `created_at_epoch`** — verified in T3: `mental_model`/`learning` rows store milliseconds (13 digits), `transcript_chunk` rows store seconds (10 digits). Structural data-quality bug. Normalize in 4.1.
- **transcript_chunk reach** — only 20 chunks in entire DB despite multi-day operation. Chunker may have low reach (similar pattern to MEMORY.md writer's 2/5-projects reach pre-bugfix-04-08). 4.1 must verify and fix.
- **Phase 3 still has 2 directive_rule rows** — writer ships, no consumer until Phase 3-merged ships PreToolUse hook. Status remains `[~]` until merge phase lands.

## Phase 9 sub-phases shipped

(In-flight — Phase 9 sub-phased per-module deletion across 8+1 sub-phases.)

- 9.2 (autonomous-investigator) — shipped 2026-04-30, Vesna 8/8
- 9.1 (cara-reasoning) — shipped 2026-04-30, Vesna 8/8
- 9.3 (consolidator dream) — shipped 2026-04-30, Vesna 8/8
- 9.4 (crystallizePatternToSkill) — shipped 2026-04-30, Vesna 8/8 (skill-writer.ts kept; bridgeCorrectionToSkill is a live consumer)
- 9.5 (cross-project-consolidator) — shipped 2026-04-30, Vesna 8/8 (cross-project canary 4/4 PASS)

## Session Continuity

Last session: 2026-04-29
Stopped at: Phase 7 shipped end-to-end. 3 plans, 3 SUMMARY files, 1 new test file (11/11 cases), 8/8 Vesna SC#1 probes PASS, behavioral A/B scaffold committed with pre-merge baseline filled in. End-of-week verdict due 2026-05-06.
Resume file: None (Phase 7 structurally complete; A/B verdict pending end-of-week; Phase 7.5 unblocked per ROADMAP)

### Phase 7 completion notes — 2026-04-29

All 3 plans landed across 3 waves (strictly serial per CONTEXT.md — all touch `src/assembly/sections.ts` or its outputs):

- **W1 (Plan 07-01) — Imperative-voice purge + advisory-voice rewrite.** Three formatters in `src/assembly/sections.ts` rewritten in-place with 3 atomic commits (one per substantive task):
  - `formatProvenPrinciplesSection` (sections.ts:105) — header reframed from `Apply them proactively — they are always relevant` (imperative footer) to `The following are patterns extracted from prior sessions across this project. Each entry pairs a recurring context with the lesson that emerged.` (descriptive provenance). Commit `312e8f5`.
  - `renderExperienceWarnings` (sections.ts:142) — escalation-prefix cascade (`CRITICAL ENFORCEMENT` / `ENFORCEMENT` / `WARNING` / `Critical` / `Important`) deleted; per-pattern shape rewritten to `### Past pattern: <ctx>` / `Observed approach: <anti>` / `Outcome learned: <lesson>` / `Surfaced X/Y times`. Strength signal carried by validation count, not ALL-CAPS prefix. `<experience-data>` wrap + framing preamble retained verbatim. Commit `7d61ed0`.
  - `formatPressureResponse` (sections.ts:519) — three zone strings rewritten from command to observation (`STOP NOW` / `Wrap up` / `Do NOT start` gone; `Zone: warning at X%. Observed pattern: …` shape replaces ALL-CAPS prefixes). ACTIVE.md is named as the conventional handoff target. Commit `b4f7bee`.

- **W2 (Plan 07-02) — Vesna purge probe + 6.5 gate re-run.** New test file `src/tests/integration/phase-7-advisory-voice.test.ts` ships 11 cases organized by formatter + cross-formatter regex sweep (FRAM-04 production probe) + `<experience-data>` wrap retention check (FRAM-03 carve-out). Phase 6.5 cross-project Vesna gate (`phase-6-5-cross-project-vesna.test.ts`) re-run: 4/4 PASS — zero retrieval regression, the rewrite isolated to framing as designed. Broader regression sweep: assembly 165/165, intelligence 801/801, phase-5-full-gate 7/7. SC#1 verdict: **8/8 probes PASS** (100% vs ≥80% floor). One Rule-3 deviation absorbed: initial fixture used `severity: 'high'` / `abstraction_level: 'general'` (invalid per `Severity` and `AbstractionLevel` exported unions); fixed inline. `07-VESNA-RESULT.md` committed. Commit `5bdef8a`.

- **W3 (Plan 07-03) — Behavioral A/B scaffold + STATE/ROADMAP/REQUIREMENTS update + phase close.** `07-BEHAVIORAL-AB.md` shipped with:
  - Section 1 (pre-merge baseline) filled in: imperative-frame surfaces seen frequently, how agent behavior felt under those framings, what the rewrite should subjectively shift.
  - Section 2 (week-of-use observation log) — empty template for user fill-in.
  - Section 3 (end-of-week subjective scoring) — table by session shape (debug / feature work / design discussion / endsession+handoff).
  - Section 4 (verdict + carve-outs) — pass/fail/extend per CONTEXT.md acceptance spec; investigate-don't-revert-on-weak-evidence rule; pre-locked carve-outs from `07-VESNA-RESULT.md`.

  Loose 1-week interpretation locked per CONTEXT.md (no env-flag toggle). End-of-week subjective verdict due 2026-05-06, signed by user; verdict commit closes FRAM-04's subjective dimension and updates ROADMAP Phase 7 row's status note.

REQUIREMENTS.md: FRAM-01..FRAM-04 all `[x]`; traceability row updated to `Complete (07-VESNA gate PASS 8/8 2026-04-29; scaffold pending end-of-week verdict)`.

ROADMAP.md: Phase 7 row updated to `3/3 Complete (structural; verdict pending end-of-week) — 2026-04-29`; Phase 7 detail section lists 3 plans with checkboxes; status note records structural close + verdict-due date.

Test counts:
- 11 net-new tests in `phase-7-advisory-voice.test.ts` (5 describe blocks: Proven Principles + Experience Warnings + Pressure Response + cross-formatter sweep + wrap retention)
- 0 non-llama regressions (20 baseline llama-server-supervisor failures unchanged per STATE.md)
- All Phase 5/6/6.5 lock-down tests still pass

Atomic commits:
- 312e8f5 — formatProvenPrinciplesSection header reframed (Plan 07-01 Task 1)
- 7d61ed0 — renderExperienceWarnings advisory shape (Plan 07-01 Task 2)
- b4f7bee — formatPressureResponse zone strings (Plan 07-01 Task 3)
- b74a161 — Plan 07-01 SUMMARY + roadmap progress
- 5bdef8a — Vesna purge probe + 07-VESNA-RESULT.md + Plan 07-02 SUMMARY
- (Plan 07-03 atomic phase-close commit pending below)

Phase 7.5 (handoff format redesign — replaces 372-line schema with hybrid YAML+ADR ~15 lines) now unblocked per ROADMAP dependency chain. Framing voice is locked structurally; the handoff is one of the surfaces that depends on framing being settled.

### Phase 6.5 completion notes — 2026-04-29

All 3 plans landed across 3 waves. RETR-06 + RETR-07 closed. Vesna SC#1 gate: 3/3 cross-project lesson-application probes pass (shadowban Lacuna→big-mozzy-v2, auth-token-expiry multi→third, schema-migration multi→Oracle). Each probe enforces a pre-flight `expect(prompt).not.toMatch(forbiddenWords)` lexical-leakage assertion so passes are genuinely perceptual, not FTS5 surface match.

V21 schema migration:
- New sidecar table `artifact_task_pattern` (PK on artifact_id; columns: task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source CHECK enum write_time/heartbeat_backfill). Pattern mirrors Phase 4.1's `critical_rules_multi_project` sidecar — works in both pre-V17 (real artifacts table) and post-V17 (view + INSTEAD OF triggers) environments.
- Telemetry CHECK enum extended with `'cross_project_ambiguous'` (logged for cosine 0.70-0.85 band) and `'cross_project_query_expansion'` (one row per claudex_search expansion call).

Architecture B partner ships:
- `src/intelligence/tier-utils.ts` — extracted shared TTL/decay/jitter/variant primitives.
- `src/intelligence/critical-reminders.ts` — refactored to delegate to tier-utils (no behavior change; 50/50 existing tests pass).
- `src/intelligence/experience-tier.ts` — parallel scorer with 200-token budget (≤ Critical Reminders' 300), K=3 top-K, deterministic tiebreak (score DESC, id ASC) for cache stability.
- `src/core/cross-project-equivalence.ts` — HYBRID equivalence (Stage 1 telemetry-handle ≥3 + Stage 2 cosine ≥0.85 with 0.70-0.85 ambiguous logging).
- Assembler P4.06 wire-in in `assembleRegularPrompt` between Critical Reminders (4a.5) and Codebase Index (4a.7).

claudex_search query expansion:
- `src/core/task-shape-detector.ts` — regex verb+domain detector + Jaccard against shape_vocabulary canonical values.
- `src/core/cross-project-search.ts` — `expandSearchCrossProject` reuses Phase 6's consolidated `computeArtifactScore` with synthetic rrfScore=1.0; matched cross-project results merge inline into `claudex_search.results[]` with `*from project X:*` italic prefix in the `summary` field.
- `src/shared/claude-md-flags.ts` — per-project opt-out parser (`claudex.cross_project_search: false` line in CLAUDE.md).
- MCP surface canonical fixture unchanged (RETR-04 lock from Phase 6 holds).

Heartbeat backfill verified on live DB copy (8942 artifacts, 14394 telemetry rows): 100% coverage of 8686 relevant artifacts in 45 ticks; 32% real-fingerprint hit rate; 5931 abstain sentinels; idempotent post-convergence.

Atomic commits:
- 3b7df19 — V21 schema substrate (Plan 01 Task 1)
- d8ca71a — task-pattern classifier + write-time + heartbeat backfill (Plan 01 Tasks 2+3)
- 66fe3cb — HYBRID equivalence + Experience Tier + tier-utils extraction (Plan 02)
- (Plan 03 commit pending below)

Test counts:
- 94 net-new tests across 6 new test files (8 V21 + 20 classifier + 17 equivalence + 14 experience-tier + 4 cache-stability + 17 task-shape + 10 cross-project-expansion + 4 Vesna)
- 0 non-llama regressions in full suite (2990/3010 pass; 20 baseline llama failures unchanged per STATE.md)
- All Phase 5/6 lock-down tests still pass: phase-5-full-gate (7/7), phase-6-mcp-surface-unchanged (9/9), phase-6-rif-spread-retained (8/8), phase-6-reranker-fallback-visibility (9/9), phase-4-1-perceptual-similarity-probes (4/4), critical-reminders (50/50)

Phase 7 (advisory voice rewrite) is unblocked but not coupled — the Experience Tier already speaks in advisory voice via the locked CONTEXT.md template ("Prior similar task in project X: salience. Decision was D; outcome was O.").

### Phase 4.1 completion notes — 2026-04-29

All 9 plans landed in 5 waves:
- W1 (Plans 01/02/03): V18 schema migration + epoch-utils helper; transcript-chunker ms-precision fix + reach investigation; line-anchored marker matcher fixes CUR-13.
- W2 (Plans 04/06): Lesson types/writer/reader substrate; user-content migration with 3 production fixtures (Lacuna/Oracle/Nexus).
- W3 (Plans 05/08): MEMORY.md restructure (entities/threads dropped, ## Lessons added); /endsession lesson proposer + 2-of-5 process_* trigger.
- W4 (Plan 07): Bridge sweeps — feedback→critical_rules + multi_project_count sidecar + shape vocab promotion + +2 CR Tier boost.
- W5 (Plan 09): Live-fire behavioral gate (5 tests PASS); SC#3 mechanical scorer; perceptual-similarity probe set for Phase 6.5; soak script PASS.

Sidecar fallback used for multi_project_count storage per planner pre-authorization (V17 view UPDATE doesn't compose cleanly for the data column). Sidecar table critical_rules_multi_project keyed by (project, normalized_rule_text) works in both pre-V17 and post-V17 environments.

CUR-15 status: PARTIALLY DEFERRED. Precision side closed (writer fix + read-time normalization). Reach backfill for 107-session enqueue gap recommended as a follow-up plan (Phase 5b reliability concern).

Plan 08 Task 3 (skill wire-up): DEFERRED TO OPERATOR per CONTEXT.md authorization. Library is shipped; /endsession skill UX wiring needs separate design discussion.

Test counts:
- ~71 new tests across Phase 4.1 (lesson writer/reader + memory-md-writer regressions + bridge sweeps + critical-reminders boost + integration)
- 0 non-llama regressions (20 pre-existing llama-server-supervisor failures unchanged per STATE.md)
- Soak script verified PASS

Audit evidence: `.planning/audits/2026-04-27-v4-trajectory-audit.md` (preserved as evidence trail).
Locked proposal: `.planning/audits/2026-04-27-v4-proposal.md` (basis for the rebind).

### Phase 4 (P3) close — corrective pending notice

Phase 4 closed 2026-04-26 with PASS on benchmarks that did not measure the deliverable (LongMemEval/LoCoMo don't read MEMORY.md). Live MEMORY.md content shipped with visible regressions: `entity:-` (literal quote), `entity:--2--1` (shell redirect), 50% Recent Threads with topic = session ID, duplicate USER EDITABLE markers, writer reach 2/5 active projects (pre 04-08 fix). Methodology learning: static tests are necessary but not sufficient for writer/processor components — live-fire verification is now a v4 cross-cutting principle.

**Phase 4 status: `[~]` partial-corrective-pending. Phase 4.1 supersedes its acceptance.**

### Phase 4 (P3) completion notes — 2026-04-26

(Preserved as historical record. Acceptance superseded by Phase 4.1.)

All gates PASSED in the v3-era framework: LongMemEval 89.6% (then-floor ≥88%), LoCoMo 62.3% new anchor (+6.8pp over 55.5%), soak 8/8 PASS, test suite 2577/2597 (20 pre-existing llama-server-supervisor failures unchanged), BENCH-09 baseline captured at median=1.

Three inline bugfixes shipped alongside four planned plans:
- 04-06: Angel resilience — `stdio:'ignore'` child spawns caused silent heartbeat crashes; MEMORY.md was never written because heartbeat phase died without trace.
- 04-07: V17 migration idempotency — `initializeSchema` ran V16-era DDL on post-V17 DBs; 3.5 days of hook data lost before diagnosis.
- 04-08: memory-md-writer project ID resolution — `computeMemoryMdPath` skipped `resolveProjectPath`, producing wrong slugs on Windows; CLAUDEXv3 MEMORY.md was 17 days stale; zero projects had received valid MEMORY.md before fix.

All three failures passed full static test suite. All three caught by live-fire / soak protocol. **Methodology learning made cross-cutting principle 5 in v4 rebind.**

### Phase 3 (P2) completion notes — 2026-04-22

(Preserved as historical record. Phase 3 status remains `[~]` partial-with-followups; merging with Phase 10 in the rebind.)

Directive detector shipped partial-B at joint_precision=0.50 on post-relabel fixture. Six plans landed across sessions 47-54: detector core + prompt assets + fixture corpus + Angel heartbeat wiring + precision harness + calibration-and-ship. Full iteration log in `.planning/phases/03-p2-directive-detector/03-CALIBRATION.md`.

**Audit finding (2026-04-27):** Phase 3 ships with **2 directive_rule rows in entire DB after 5+ days of live operation** (verified via DB query in T2 audit). Zero production consumers — outputs feed Experience Warnings + Curated Context which Phase 5 deletes. The "Zero injection-path changes" framing in the original Phase 3 SUMMARY is the writer-without-consumer anti-pattern. Phase 3 + Phase 10 merge resolves this — directive detector ships with PreToolUse consumer + lifecycle as one unit.

### Phase 2 (P1) completion notes — 2026-04-20

(Preserved as historical record. T3 audit verified Phase 2 clean.)

6 legacy knowledge tables unified into single `artifact(kind, ...)` kernel + JSON sidecar table via V17 migration. Legacy tables survive as views + INSTEAD OF triggers; Phase B atomic-tx ships through backup-gated + stale-review-gated + validation-gated pipeline.

**Retention notes (CRITICAL — do not drop before Phase 11):**
- `learnings_old`, `decisions_old`, `experience_patterns_old`, `angel_opinions_old`, `critical_rules_old`, `project_curated_context_old` — 6 renamed legacy tables — survive P1→Phase 11 as migration backstops.
- `legacy_id_map(legacy_table, legacy_id, new_uuid)` — translation table for integer-legacy-id ↔ new UUID. Survives P1→Phase 11.

**T3 audit verification (2026-04-27):** schema_version=17, backups exist (332MB, restorable), legacy `_old` tables intact at 1052 rows total (191 + 126 + 76 + 130 + 81 + 448), idempotency held after 04-07 inline bugfix.
