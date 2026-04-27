# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-19)

**Core value:** Memory stops acting like rules — the agent thinks again, pulling curated artifacts on demand instead of blindly following injected imperatives.
**Current focus:** Phase 4: P3 — MEMORY.md curation + auto-dream guard

## Current Position

**Current Phase:** 5
**Current Phase Name:** P4 — Kill legacy injection
**Total Phases:** 11
**Current Plan:** 0
**Total Plans in Phase:** TBD (replan pending audit)
**Status:** **PAUSED 2026-04-27 pending v4 trajectory audit (phases 1-11).** Phase 5 discuss step ran but produced a CONTEXT.md whose decisions were superseded by mid-session findings; planning paused before plan-phase. See `context/handoffs/ACTIVE.md` and `.planning/audits/2026-04-27-v4-trajectory-audit.md`.
**Last Activity:** 2026-04-27
**Last Activity Description:** Phase 5 design discussion surfaced gating-story problems (LongMemEval/LoCoMo don't exercise the assembler; BENCH-09 metric contaminated; MEMORY.md content quality issues visible right now). User reframed: benchmarks are sanity, not gates. Audit of all 11 phases (shipped + planned) is the next session's main work.
**Progress:** [████░░░░░░] 36% (un-banked — Phase 4 close validity is part of the audit)

Phase: 5 of 11 (P4 — Kill legacy injection — PAUSED for audit)
Plan: 0 of TBD in current phase
Status: v4 trajectory audit pending (1-11)
Last activity: 2026-04-27 — Phase 5 planning paused; audit framework + handoff written

Progress: [████░░░░░░] 36%

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table. Summary of locked decisions from P0:
- **Q1 transcript chunking** — LLM topic-detected boundaries (quality over latency)
- **Q2 MEMORY.md schema** — sectioned markdown, importance-sorted, capped at 15/5/5/1/1 entries per section
- **Q3 directive threshold** — regex + LLM-confirm, starting ≥0.7 (tuned in P2)
- **Q4 project_curated_context** — migrate to `artifact(kind='mental_model')`, flag stale entries as `status='stale'`

### Pending Todos

- (None blocking Phase 5. `project_curated_context` stale-flagging completed during P1 migration — 9 mental_model rows flagged `status='stale'` per stale-review.md. Human review was a P0 deliverable per Phase 2 SUMMARY.)

### Blockers/Concerns

**AUDIT PENDING — these supersede prior Phase 5 concerns until audit closes:**

- **Phase 4 MEMORY.md content quality is junk in the live system right now.** `entity:-` (literal `"` quote as entity), `entity:--2--1` (shell redirect `" 2>&1` as entity), `Recent Threads` with topic = session ID, stale Handoff section (was 17 days stale until session 2026-04-27 noticed), duplicated `<!-- USER EDITABLE -->` markers. Phase 4 reported PASS on benchmarks that don't actually test MEMORY.md. Cannot rely on MEMORY.md as Phase 5's replacement context surface until content quality is fixed.
- **Benchmarks don't measure assembler changes.** Verified by codex grep: LongMemEval (`src/benchmark/longmemeval-harness.ts:212`) uses bespoke `retrieveContext`, not production retrieval. LoCoMo calls `hybridSearchAsync` but bypasses `assembleFullContext`. Phase 5's ROADMAP gates are wrong-fit; the L1..L4 ladder triggers on metrics that can't move.
- **BENCH-09 metric is contaminated.** `retrieval_events` is written by assembly-time materialization in `src/assembly/assembler.ts:607` and `:1021`. Phase 5 deletion mechanically drops the metric. Plus: baseline threshold `≥10 user_framing events` is mathematically impossible because `recordUserFraming` caps at 3/session.
- **Phase 3 directive_rule artifact consumers may be deleted by Phase 5.** Phase 3 ships outputs that feed Experience Warnings and Curated Context (both Phase 5 deletion targets). Need to verify what reads `directive_rule` post-Phase 5 before deletion lands.
- **Phase 9 cognitive-layer deletion (-3 to -4k LOC) is a leap of faith.** Deletes CARA, dream consolidation, skill crystallization, etc. Without quality audit of what they currently produce, deletion premature.
- **Phase 11 LoCoMo growth path (62.3% → 70%+ target) is unspecified.** Roadmap doesn't say which phases drive the +8pp growth. Math may not reach target.

## Session Continuity

Last session: 2026-04-27 (e0d0a138)
Stopped at: Phase 5 planning paused; v4 audit framework written.
Resume file: `context/handoffs/ACTIVE.md` (rewritten 2026-04-27).
Audit evidence: `.planning/audits/2026-04-27-v4-trajectory-audit.md`.

### Phase 4 (P3) completion notes — 2026-04-26

**Phase 4 (P3 — MEMORY.md curation + auto-dream guard) closed 2026-04-26.**

All gates PASS: LongMemEval 89.6% (floor ≥88%), LoCoMo 62.3% new anchor (+6.8pp over pre-migration 55.5%), soak 8/8 PASS, test suite 2577/2597 (20 pre-existing llama-server-supervisor failures unchanged), BENCH-09 baseline captured at median=1.

**Three inline bugfixes shipped alongside the four planned delivery plans:**
- 04-06: Angel resilience hardening — `stdio:'ignore'` child spawns caused silent heartbeat crashes; MEMORY.md was never written because the heartbeat phase died without trace.
- 04-07: V17 migration idempotency — `initializeSchema` ran V16-era DDL on post-V17 DBs, causing SQLite to throw on `CREATE INDEX ... ON <view>`; 3.5 days of hook data lost before diagnosis.
- 04-08: memory-md-writer project ID resolution — `computeMemoryMdPath` skipped `resolveProjectPath`, producing wrong slugs on Windows; CLAUDEXv3 MEMORY.md was 17 days stale; zero projects had received a valid MEMORY.md.

All three failures passed the full static test suite. All three were caught by the live-fire / soak protocol.

**Methodology learning established:** Static tests are necessary but not sufficient for writer/processor components that produce side effects. Any plan that ships such a component must include a live-fire verification step as a blocking acceptance gate. The `verify-soak.cjs` verifier is the template.

**BENCH-09 baseline:** median=1 claudex_search call per non-trivial session, n=122 sessions over 30 days. Floor for Phase 5 gate.

**Phase 5 (P4 — Kill legacy injection)** is next. It is the highest-risk phase of v4. Start with `/gsd:plan-phase 5`. Read ROADMAP.md Phase 5 success criteria and the L1..L4 fallback ladder before writing the PLAN. Confirm DB backup (STOR-08) before any assembler commits.

### Phase 3 (P2) completion notes — 2026-04-22

**Directive detector shipped partial-B at joint_precision=0.50 on post-relabel fixture.** Six plans landed across sessions 47-54: detector core + prompt assets + fixture corpus + Angel heartbeat wiring + precision harness + calibration-and-ship. Full iteration log in `.planning/phases/03-p2-directive-detector/03-CALIBRATION.md`.

**Calibration journey:** joint 0.353 (baseline) → 0.391 (scope few-shot) → 0.455 (prompt rewrite) → [escalation + label audit + gate lowered 0.90→0.75 + 12-case hand re-label] → 0.500 (cycle3_diag post-relabel) → 0.500 (cycle4 negation tune, reverted). Path B chosen on the evidence that scope precision 0.889 is ship-quality for P8's primary consumer contract; remaining `negation_dont` family gaps are deferred to P8 as a tunable follow-up with a held-out test set.

**What actually ships:**
- `src/intelligence/directive-detector.ts` — 2-stage (regex + LLM-confirm) directive extractor writing `artifact(kind='directive_rule', scope ∈ {session, project, universal}, polarity ∈ {prescriptive, prohibitive})` rows.
- Angel heartbeat runs the detector BEFORE the generic pattern-extractor per Plan 03-04.
- Passive annotations (`data.possible_contradicts`, `data.related_to`, `data.related_cosine`) for dedup-shortlist hits, feeding P8's supersession/contradiction logic.
- **Zero injection-path changes** — `git diff 32779b3..HEAD -- src/assembler/ src/hooks/session-start.ts src/core/sections.ts` is empty.
- Harness observability hardening (commit `3ddd183`): `harness_pid=<pid>` first-line, `--heartbeat-ms` flag, `--limit=<N>` flag, success-signal doc. Killed the 3-silent-death observer-error class permanently.

**Deferred to post-ship follow-ups (NOT blockers):**
- 03-06-07 benchmark gate (LongMemEval + LoCoMo) — blocks on task #23 (post-V17 baseline still stalled).
- 03-06-08 live-tick integration confirm — requires Angel ticks against real sessions before `directive_rule` rows appear in the live DB.
- `llama-server-supervisor.test.ts` has 20 pre-existing test failures (since commit `c84dd61`, 45+ commits before Phase 3) — not a P2 regression, tracked as separate tech-debt.

**P8 tune-queue starter set** (in CALIBRATION.md `## Follow-ups for P8`): retune `negation_dont` family with held-out test set; fixture expansion to 30 sessions; universal-scope second-pass via stubbed scope-rubric prompt; reinforcement_count distribution telemetry.

### Phase 2 (P1) completion notes — 2026-04-20

**6 legacy knowledge tables unified into a single `artifact(kind, ...)` kernel + JSON sidecar table via V17 migration.** Legacy tables survive as views + INSTEAD OF triggers; Phase B atomic-tx Phase ships a typed RunnerResult through a backup-gated + stale-review-gated + validation-gated pipeline.

**Retention notes (CRITICAL — do not drop before Phase 11/P9):**
- `learnings_old`, `decisions_old`, `experience_patterns_old`, `angel_opinions_old`, `critical_rules_old`, `project_curated_context_old` — the 6 renamed legacy tables — survive P1→P9 as migration backstops. Do NOT drop before Phase 11.
- `legacy_id_map(legacy_table, legacy_id, new_uuid)` — translation table for integer-legacy-id ↔ new UUID. Survives P1→P9 for view ↔ caller id translation. Do NOT drop before Phase 11.
- `artifacts`, `artifacts_fts`, `vec_artifacts`, `artifact_links` — untouched by P1 (Amendment 1). Entity_summary migration deferred to P5 or P9.

**Retired in P1 (Amendment 4):**
- `learnings_fts` — retired; replaced by `artifact_fts` filtered on `kind='learning'`.
- `experience_patterns_fts` — retired; replaced by `artifact_fts` filtered on `kind='experience_pattern'`.

**Dormant-storage pattern:** `migrateV16toV17` is called from `initializeSchema` and creates the artifact kernel + `artifact_fts` + `legacy_id_map` + `artifact_embeddings` vec0 as empty dormant storage. The actual data migration (rename legacy tables + copy rows + create views + flag stale + install triggers) runs only through the explicit `migrate:v17:apply` CLI path.

**Schema version:** 17 (bumped from 16 inside the runner's atomic tx; not bumped by the dormant-storage init-time call).

**Live V17 migration APPLIED 2026-04-20T10:39Z.** 1052 rows migrated across 6 kinds (191 learning + 126 decision + 76 experience_pattern + 130 angel_opinion + 81 critical_rule + 448 mental_model). 9 mental_model rows flagged stale per stale-review.md. `user_version = 17`. legacy_id_map has 976 rows (experience_patterns preserve UUID, no map entry). All 6 `{name}_old` backstop tables present with matching counts. Angel restarted (PID 7812 via session-start hook auto-respawn). End-to-end INSERT/SELECT/DELETE via legacy `learnings` view confirmed working with round-trip through INSTEAD OF triggers. Backup: `~/.claudex/backups/pre-v4-P1-1776681458021.db` (332 MB, sha256 3680d8dcd68dc396...).

**Benchmark post-migration:** Harness config fixed (commit 01e80c7 — defaults flipped to deepseek-coder-v2:16b via Ollama to match 2026-03-28 baseline conditions; env-var overrides exposed). deepseek-coder-v2:16b pulled locally (8.9 GB). Harnesses relaunched async at 2026-04-20T12:27; logs under `benchmarks/results/p1-postmigration/longmemeval-v17-*.log` and `locomo-v17-*.log`. Realistic runtime: LongMemEval ~10h, LoCoMo ~4-6h. Results will be recorded in a follow-up when they return. CLIProxy-based Claude-model path not reproducible (proxy serves only Gemini + GPT); LoCoMo 55.5% baseline not directly comparable — new deepseek anchor is the forward reference.
