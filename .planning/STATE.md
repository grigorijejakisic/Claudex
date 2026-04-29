# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** v4 makes the agent USE Claudex organically as part of how it works in Claude Code. Memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) are reached for the same way `Read` or `Grep` are used — natural extensions of reasoning, not a separate "fetch context" step that has to be remembered.

**Current focus:** Phase 6.5 COMPLETE 2026-04-29. Phase 7 (framing rewrite — advisory voice) unblocked.

## Current Position

**Current Phase:** 6.5 (COMPLETE)
**Current Phase Name:** Cross-project task-pattern recall
**Total Phases:** 16
**Current Plan:** 3
**Total Plans in Phase:** 3
**Status:** Phase complete — ready for verification
**Last Activity:** 2026-04-29
**Last Activity Description:** Phase 6.5 shipped end-to-end. V21 migration. Sidecar `artifact_task_pattern` table (mirrors Phase 4.1 `critical_rules_multi_project` pattern). Regex-first task-pattern classifier with abstain-allowed semantics + heartbeat backfill (45 ticks to 100% coverage on 8686 relevant artifacts; 32% real-fingerprint hit rate). HYBRID equivalence (Stage 1 ≥3 handles + Stage 2 cosine ≥0.85 with 0.70-0.85 ambiguous logging). Experience Tier scorer (Architecture B parallel to critical-reminders) with locked weight matrix and deterministic tiebreak. claudex_search task-shape detection (regex verb+domain+vocab Jaccard) + cross-project query expansion (default-ON with CLAUDE.md opt-out). Vesna SC#1 gate 3/3. tier-utils.ts extraction enforces "shared infrastructure, separate scorers" Architecture B principle.
**Progress:** [██████████] 102%

Phase: 6.5 of 16 (Cross-project task-pattern recall — COMPLETE)
Plan: 3 of 3 in current phase
Status: complete; ready for next phase (7 framing rewrite — advisory voice)
Last activity: 2026-04-29 — Phase 6.5 shipped end-to-end

Progress: [██████████░░░░░░] 47%

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

## Session Continuity

Last session: 2026-04-29
Stopped at: Phase 6.5 shipped end-to-end. 3 plans, 3 SUMMARY files, 94 net-new tests, Vesna SC#1 gate 3/3 PASS.
Resume file: None (Phase 6.5 complete; ready for Phase 7 framing rewrite per ROADMAP)

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
