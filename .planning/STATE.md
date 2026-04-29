# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** v4 makes the agent USE Claudex organically as part of how it works in Claude Code. Memory tools (`claudex_search`, `claudex_recall`, `claudex_events`) are reached for the same way `Read` or `Grep` are used — natural extensions of reasoning, not a separate "fetch context" step that has to be remembered.

**Current focus:** Phase 4.1 COMPLETE 2026-04-29. Phase 5 unblocked.

## Current Position

**Current Phase:** 4.1 (COMPLETE)
**Current Phase Name:** MEMORY.md content redesign + Lessons section
**Total Phases:** 16 (was 11; rebalanced 2026-04-27 per audit)
**Current Plan:** 9
**Total Plans in Phase:** 9
**Status:** **PHASE 4.1 COMPLETE 2026-04-29.** All 9 plans landed across 5 waves. Behavioral live-fire gate PASSING (5 invariants); SC#3 mechanical scorer implemented; perceptual-similarity probe set checked in for Phase 6.5; soak script verifies end-to-end. ~71 new tests added; 0 non-llama regressions (20 pre-existing llama-server failures unchanged). CUR-15 reach partially deferred per planner pre-authorization (precision closed; reach backfill is a follow-up plan).
**Last Activity:** 2026-04-29
**Last Activity Description:** Phase 4.1 shipped. V18 schema (shape_vocabulary, shape_candidates, critical_rules_multi_project sidecar). Lesson taxonomy (feedback / project / process). MEMORY.md restructure (entities/threads dropped, ## Lessons added). Bridge (feedback density-3 → system-promoted critical_rules + multi-project +2 boost). /endsession lesson proposer with 2-of-5 process_* trigger. Live-fire gate PASS.
**Progress:** [██████████] 100%

Phase: 4.1 of 16 (MEMORY.md content redesign + Lessons section — COMPLETE)
Plan: 9 of 9 in current phase
Status: complete; ready for next phase
Last activity: 2026-04-29 — Phase 4.1 shipped end-to-end

Progress: [██████░░░░░░░░░░] 31%

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
Stopped at: Phase 4.1 shipped end-to-end. 9 plans, 9 SUMMARY files, ~71 new tests, behavioral live-fire gate PASS.
Resume file: None (Phase 4.1 complete; ready for Phase 4.2 or next phase per ROADMAP)

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
