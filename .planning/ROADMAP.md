# Roadmap: Claudex v4

## Overview

Ten atomic phases move Claudex from v3's imperative push to v4's advisory pull. P0 (this crystallization) locks decisions; P1 consolidates nine knowledge tables into one artifact table under legacy views; P2 teaches Angel to detect directives; P3 curates the ≤25KB MEMORY.md index, kills auto-dream collisions, and **captures the BENCH-09 baseline** (pre-v4 agent-initiated retrieval frequency); P4 is the big benchmark gate — deleting nine injection sections, collapsing to ≤500 session-start tokens, and **proving BENCH-09 holds (the agent now pulls instead of relying on injection)** with an explicit fallback ladder if benchmarks regress; P5 simplifies retrieval; P6 rewrites framing to advisory voice; P6.5 gates RL-stack deletion on a deterministic LoCoMo ablation; **P7 sub-phases each module deletion separately (one commit per module, not one mega-commit)**; P8 adds directive-rule lifecycle with a held-out detector-recall sub-gate that owns the P2 follow-ups; P9 verifies BENCH-09 (the falsifiable "thinks again" thesis) and tags v4. Vesna becomes a smoke check, not a ship gate. **v4.1 = Distribution** is scaffolded in P9 close as a dedicated follow-up milestone (LICENSE, install ergonomics, cross-platform, README rewrite). Every phase has a rollback; P1 and P5 are backed by DB snapshots; LongMemEval stays ≥88% and LoCoMo never regresses >2pp per phase.

**Status legend:**
- `[ ]` Pending
- `[x]` Complete
- `[~]` Partial-with-followups — shipped at reduced acceptance with explicit follow-up tracked in a later phase

## Phases

- [x] **Phase 1: P0 — Crystallization** - Lock 4 design decisions and produce `.planning/`
- [x] **Phase 2: P1 — Artifact table unification** - V17 migration + legacy views, zero behavior change (completed 2026-04-20)
- [~] **Phase 3: P2 — Directive detector** - Regex + LLM-confirmed ingester writing `directive_rule` artifacts (partial-ship B, joint=0.50 on post-relabel fixture, completed 2026-04-22; held-out recall measurement + `negation_dont` tune owned by Phase 10 LIFE-04 sub-gate)
- [ ] **Phase 4: P3 — MEMORY.md curation + auto-dream guard** - Sectioned index at `/endsession`, sentinel write-guard
- [ ] **Phase 5: P4 — Kill legacy injection** - Delete 9 sections, ≤500 tokens, cache-stable, `initialUserMessage` prime
- [ ] **Phase 6: P5 — Retrieval simplification** - RRF + cross-encoder rerank only; delete the 6-multiplier chain
- [ ] **Phase 7: P6 — Framing rewrite** - Advisory voice across every surviving formatter
- [ ] **Phase 8: P6.5 — RL ablation gate** - Feature-flag deterministic go/no-go on RL deletion
- [ ] **Phase 9: P7 — Angel simplification** - Delete CARA/dream/skill/investigator; RL stack conditional
- [ ] **Phase 10: P8 — Rule lifecycle** - Scope detection, supersession edges, confidence decay
- [ ] **Phase 11: P9 — Final validation + cleanup** - Vesna test, drop legacy tables, tag v4

### Phase 1: P0 — Crystallization
**Goal**: Lock the 4 open design decisions and produce the `.planning/` directory
**Depends on**: Nothing (first phase)
**Requirements**: *(planning only — no v1 requirements implemented)*
**Success Criteria** (what must be TRUE):
  1. `.planning/PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `STATE.md`, `config.json` exist on disk
  2. Q1-Q4 decisions recorded in `PROJECT.md` Key Decisions table with rationale
  3. Stale-flagged `project_curated_context` entries identified for human review before P1 migration runs
**Plans**: TBD

Plans:
- [x] 01-01: Crystallize from `context/specs/CLAUDEX_V4_SCOPE.md`

### Phase 2: P1 — Artifact table unification
**Goal**: Collapse 7 legacy knowledge tables into `artifact(kind, ...)` with preserving views so every v3 caller keeps working
**Depends on**: Phase 1 (decisions locked, stale entries reviewed)
**Requirements**: STOR-01, STOR-02, STOR-03, STOR-04, STOR-05, STOR-07, STOR-08
**Success Criteria** (what must be TRUE):
  1. V17 migration creates `artifact` table with free-form `kind` column and `kind_registry`
  2. All rows from `learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`, `artifacts(entity_summary)` migrated inside a single transaction
  3. Legacy table names preserved as SQL views with unchanged shape; `SELECT` queries against them return identical data
  4. Stale `project_curated_context` rows flagged `status='stale'` rather than `status='active'` via keyword scan for `Gemma 4 31B`, `llama-server:8081`, `local llama-server`
  5. DB backup at `~/.claudex/backups/pre-v4-P1-{ts}.db` verified restorable before migration runs
  6. All 2020 Vitest tests pass; LongMemEval Oracle ≥90%; LoCoMo within 2pp of baseline
**Plans**: TBD

Plans:
- [ ] 02-01: TBD

### Phase 3: P2 — Directive detector
**Goal**: Detect user directives and accumulate them as `directive_rule` artifacts without changing injection
**Depends on**: Phase 2 (artifact table available)
**Requirements**: EXTR-01, EXTR-02, EXTR-03, EXTR-04
**Success Criteria** (what must be TRUE):
  1. `src/intelligence/directive-detector.ts` runs regex pass for emphasis signals then LLM confirmation at threshold ≥0.7
  2. Confirmed directives written as `artifact(kind='directive_rule', scope=...)` with LLM-classified scope
  3. Detector runs in Angel extraction phase before generic ingester; no injection-path changes
  4. Precision ≥90% measured against fixture sessions; starting threshold tuned during calibration
  5. No benchmark regression; 2020 tests pass
**Plans**: TBD

Plans:
- [x] 03-01: Detector core (extractDirectivesFromSession + regex families)
- [x] 03-02: Prompt assets (confirmation + scope-rubric + few-shot fixtures)
- [x] 03-03: Fixture corpus + LLM labeling + labeling review
- [x] 03-04: Angel heartbeat wiring (directive-detector phase before pattern-extractor)
- [x] 03-05: Precision harness + compare-runs + runbook decision tree
- [x] 03-06: Calibration + ship (partial-ship B at joint=0.50; 03-06-07/08 deferred)

### Phase 4: P3 — MEMORY.md curation + auto-dream guard
**Goal**: Angel writes a sectioned ≤25KB MEMORY.md at `/endsession` and the CC auto-dream write-guard is proven collision-proof
**Depends on**: Phase 2 (artifact table supplies entities, projects)
**Requirements**: CUR-01, CUR-02, CUR-03, CUR-04, CUR-08, STOR-06, EXTR-06, BENCH-09 (baseline)
**Success Criteria** (what must be TRUE):
  1. MEMORY.md produced with sections `## Entities`, `## Active Projects`, `## Recent Threads`, `## Handoff`, `## How to Query` respecting caps (15/5/5/1/1)
  2. Sort order importance DESC with recency tiebreaker; universal user memories included
  3. `autoDreamEnabled: false` enforced via `CLAUDEX_ENV_FILE`; sentinel comment guards MEMORY.md from overwrite
  4. Curation idempotent — re-running Angel's writer on unchanged inputs produces byte-identical output
  5. File size ≤25KB / 200 lines verified by checksum on next session-start
  6. Transcript chunking pipeline writes `artifact(kind='transcript_chunk')` with `topic_label` + `turn_range` at `/endsession`
  7. Write-time integrity defense (CUR-08) — sha256 read-back compare, alert + skip on external mutation, agents-don't-edit-above-sentinel rule documented
  8. **BENCH-09 baseline captured** — pre-v4 median `claudex_search` calls per non-trivial session measured on existing telemetry; value committed to `benchmarks/results/p3-postmigration/bench09-baseline.json`. Sets the floor (N) used by Phase 5+ gates.
  9. Still dual-injecting old sections; benchmarks remain ≥ P2 baseline
**Plans**: TBD

Plans:
- [ ] 04-01: TBD

### Phase 5: P4 — Kill legacy injection (BIG BENCHMARK GATE)
**Goal**: Remove 9 legacy injection sections, drop session-start to ≤500 tokens, UPS to ≤1KB, cache-stable; add `initialUserMessage` auto-prime
**Depends on**: Phase 4 (MEMORY.md replaces injected bulk; BENCH-09 baseline captured)
**Requirements**: INJ-01, INJ-02, INJ-03, INJ-04, INJ-05, INJ-06, INJ-07, BENCH-05, BENCH-06, BENCH-07, BENCH-09 (gate)
**Success Criteria** (what must be TRUE):
  1. Assembler `assembler.ts` deletes Proven Principles, Entity Summaries, Angel Opinions, Predicted Context, Curated Context, Experience Warnings auto-surface, Flow, Reference Layer, Materialization
  2. Assembler keeps Identity, Project (CLAUDE.md), Session Continuity, Checkpoint, GSD, MEMORY.md (native load)
  3. Session-start tokens ≤500 verified by tokenizer on real session-start output
  4. UPS per-turn payload ≤1KB verified on live turns; only dynamic signals carried
  5. All surviving injected text free of timestamps/turn-counts/session-IDs/wall-clock; cache-stable prefix proven by byte-identical repeat
  6. `initialUserMessage` auto-prime fires only when `ACTIVE.md` handoff exists
  7. Experience-warning content surfaces only on explicit query or path/command trigger
  8. **Behavioral gate (BENCH-09)**: post-P4 median `claudex_search` calls per non-trivial session ≥ baseline N captured in P3. If post-P4 < baseline, the agent has gone amnesic — falsifies the "thinks again" thesis.
  9. **Benchmark gate (with explicit fallback ladder)**: LongMemEval ≥88%; LoCoMo within 2pp of P3 baseline. **On violation, do not revert immediately** — escalate the ladder in order:
     - **L1**: Raise UPS budget 1KB → 2KB; re-run benchmarks. If recovers, ship at 2KB and document.
     - **L2**: Keep one injection section (start with Entity Summaries — highest signal density per token). Re-run. If recovers, ship with one section + spec the path to retire it.
     - **L3**: Dual-inject diagnostic mode — re-enable old sections alongside MEMORY.md for one full LongMemEval run, attribute the gap to specific deletion(s), then narrow-revert only the responsible section(s).
     - **L4**: Full revert. Phase 4 (MEMORY.md curation) needs measurable improvement before re-attempt — define "improvement" concretely (entity recall on Vesna-style probes, MEMORY.md size utilization, etc.) before the next attempt.
**Plans**: TBD

Plans:
- [ ] 05-01: TBD

### Phase 6: P5 — Retrieval simplification
**Goal**: Collapse hybrid-retrieval scoring to RRF → cross-encoder rerank → top-k; let the reranker do the work
**Depends on**: Phase 5 (injection is thin so retrieval quality becomes visible)
**Requirements**: RETR-01, RETR-02, RETR-03, RETR-04
**Success Criteria** (what must be TRUE):
  1. `hybrid-retrieval.ts` scores rows via RRF fuse of FTS5 + vec0 + recency, then cross-encoder rerank, then budget-gated top-k
  2. The 6-multiplier chain (`retrieval_multiplier × novelty × activation × q_value × ...`) removed from retrieval code paths
  3. RIF suppression and spread activation retained (measurable dedup value)
  4. MCP surface unchanged: `claudex_search`, `claudex_recall`, `claudex_events`, `claudex_store`, `claudex_message`
  5. DB backup at `~/.claudex/backups/pre-v4-P5-{ts}.db` before any schema drop
  6. LoCoMo ≥ P4 baseline − 2pp; LongMemEval ≥88%
**Plans**: TBD

Plans:
- [ ] 06-01: TBD

### Phase 7: P6 — Framing rewrite
**Goal**: Every surviving assembler formatter speaks in advisory voice — observation, not command
**Depends on**: Phase 6 (retrieval simplified; injection sections stabilized)
**Requirements**: FRAM-01, FRAM-02, FRAM-03, FRAM-04
**Success Criteria** (what must be TRUE):
  1. `sections.ts` formatters contain no `WARNING:`, no `**Correct approach:**`, no `Apply them proactively — they are always relevant`, no `supersedes CLAUDE.md on conflict`
  2. Experience-warning surface reframed as descriptive observation: *"Similar prior situation (session X): user wanted Y; outcome was Z."*
  3. `<experience-data>` wrap retained for injection isolation; inner content descriptive not imperative
  4. Manual inspection confirms no imperative framing across all formatters
  5. No benchmark regression (gate — if frame rewrite drops scores, models were leveraging imperative cues and mitigation needed)
**Plans**: TBD

Plans:
- [ ] 07-01: TBD

### Phase 8: P6.5 — RL ablation gate
**Goal**: Deterministic go/no-go on deleting the RL stack via feature-flag LoCoMo ablation
**Depends on**: Phase 7 (framing stable so any delta is attributable to scoring)
**Requirements**: BENCH-08
**Success Criteria** (what must be TRUE):
  1. Feature flag `CLAUDEX_DISABLE_RL_SCORING=1` bypasses Q-value multipliers in `hybrid-retrieval.ts` and skips `rl-trainer` ticks in heartbeat
  2. Full LoCoMo run with flag set; LoCoMo run without flag (baseline)
  3. Decision committed to `context/specs/V4_RL_ABLATION.md`:
     - If flagged LoCoMo ≥ baseline − 2pp: P7 clears RL deletion
     - If flagged LoCoMo drop > 2pp: RL is load-bearing — either keep stack and adjust scope or redesign with simpler learned signal
  4. Decision locked before P7 begins
**Plans**: TBD

Plans:
- [ ] 08-01: TBD

### Phase 9: P7 — Angel simplification (sub-phased)
**Goal**: Delete CARA, autonomous-investigator, dream, skill crystallization, cross-project consolidator, proactive curator, data-quality; conditionally delete RL stack per P6.5. **Each module deletion is its own commit**, gated by tests + a fast benchmark spot-check. A 4000-LOC mega-deletion in one commit would be unbisectable; per-module commits keep regressions attributable.
**Depends on**: Phase 8 (RL decision locked)
**Requirements**: CUR-05, CUR-06, CUR-07, EXTR-05, RETR-05
**Success Criteria** (what must be TRUE):
  1. Per-module deletion sub-phases land in order; each sub-phase: delete one module → vitest pass → LongMemEval Oracle spot-check (fast subset, ~30 min) ≥88% → atomic commit. No grouped deletions.
  2. Modules deleted (one per sub-phase): `cara-reasoning.ts` (9.1), `autonomous-investigator.ts` (9.2), `consolidator.ts::runDreamConsolidation` (9.3), `pattern-extractor.ts::crystallizePatternToSkill` (9.4), `cross-project-consolidator.ts` (9.5), `proactive-curator.ts` (9.6), `data-quality.ts` (9.7)
  3. **Conditional 9.8 (RL stack)** — only if P6.5 cleared: `retrieval-rl.ts`, `memrl-scorer.ts`, `rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`, `policy-registry.ts`, `policy_weights` table (V19). Same per-module discipline applies.
  4. Heartbeat tick count drops from ~20 phases to ~8; dropped phases: CARA, investigation, dream, skill crystallization, proactive curation, cross-project consolidation
  5. Associated tests deleted; 2020-count adjusted downward to reflect removed features; remaining tests all pass after every sub-phase
  6. Net LOC delta ~−3000 to −4000 lines for the umbrella phase total
  7. Full LongMemEval + LoCoMo run after the umbrella phase closes; no regression vs Phase 8 baseline
  8. BENCH-09 gate continues to hold across all sub-phases
**Plans**: TBD

Plans:
- [ ] 09-01: TBD (umbrella plan + sub-phase scaffolding)
- [ ] 09-02: Delete `cara-reasoning.ts` (sub-phase 9.1)
- [ ] 09-03: Delete `autonomous-investigator.ts` (sub-phase 9.2)
- [ ] 09-04: Delete `consolidator.ts::runDreamConsolidation` (sub-phase 9.3)
- [ ] 09-05: Delete `pattern-extractor.ts::crystallizePatternToSkill` (sub-phase 9.4)
- [ ] 09-06: Delete `cross-project-consolidator.ts` (sub-phase 9.5)
- [ ] 09-07: Delete `proactive-curator.ts` (sub-phase 9.6)
- [ ] 09-08: Delete `data-quality.ts` (sub-phase 9.7)
- [ ] 09-09: Conditional RL stack deletion (sub-phase 9.8) — only if P6.5 cleared
- [ ] 09-10: Umbrella close — full benchmark run, heartbeat tick recount, LOC delta verification

### Phase 10: P8 — Rule lifecycle
**Goal**: Bound directive-rule accumulation via scope, supersession, and confidence decay
**Depends on**: Phase 9 (Angel is lean so lifecycle code is isolated)
**Requirements**: LIFE-01, LIFE-02, LIFE-03, LIFE-04 (with sub-gate)
**Success Criteria** (what must be TRUE):
  1. Scope detection (`session | project | universal`) lands at ingestion from directive detector (already stored from P2; now actioned)
  2. Supersession edges — LLM contradiction check on new directive vs. existing active directives of the same scope; generates `supersedes_id` on confirmed contradiction
  3. Confidence decay — daily sweep reduces confidence for unreinforced rules; auto-archive below threshold
  4. Fixture sessions with contradictory directives resolve correctly (new supersedes old; decayed rule archives)
  5. **Sub-gate (prerequisite to SC#4)**: detector recall on a held-out fixture set ≥ N% (target 0.85, floor 0.70). Owns the `negation_dont`-family followup deferred from EXTR-04 (P2 partial-ship). Without this, supersession evaluates over silently-truncated input — looks correct while under-firing. Held-out set is built and labeled at the start of P8, NOT reused from P2's calibration corpus.
  6. No benchmark regression; BENCH-09 floor maintained
**Plans**: TBD

Plans:
- [ ] 10-01: TBD

### Phase 11: P9 — Final validation + cleanup
**Goal**: Ship v4 — verify thesis (BENCH-09), drop legacy tables if safe, tag the release
**Depends on**: Phase 10 (lifecycle live; all functional pieces present)
**Requirements**: BENCH-01, BENCH-02, BENCH-03, BENCH-09 (final), BENCH-04 (smoke)
**Success Criteria** (what must be TRUE):
  1. Full v3 test suite (adjusted for deletions) passes
  2. LongMemEval Oracle ≥88%; ideally ≥90%
  3. LoCoMo ≥70% target (stretch 80%+); no single phase regressed >2pp
  4. **BENCH-09 final**: post-v4 median `claudex_search` calls per non-trivial session ≥ 2× baseline N (target) or ≥ baseline N (floor). Falsification check on the v4 thesis. Captured over a 7-day window post-tag.
  5. Vesna smoke check — fresh session, `claudex_search("Vesna")` returns `entity_summary` in rank 1-3 without filesystem exploration. Reduced from ship-blocking to smoke check; failure logged but does not block tag if BENCH-09 passes.
  6. Legacy tables (`learnings`, `decisions`, `experience_patterns`, etc.) dropped *if and only if* zero-caller audit passes; otherwise views remain
  7. `CLAUDE.md` and `README.md` updated to reflect v4 architecture; out-of-date phrasing removed; banner added: *"v4.0 is internal infrastructure. v4.1 = Distribution will make it installable by strangers."*
  8. Git tag `v4.0.0` pushed
  9. Net LOC target of −8000 to −10000 lines verified
  10. v4.1 = Distribution milestone scaffolded (`.planning/` next-cycle stub committed) so the follow-up doesn't get forgotten
**Plans**: TBD

Plans:
- [ ] 11-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. P0 — Crystallization | 1/1 | Completed | 2026-04-19 |
| 2. P1 — Artifact table unification | 7/7 | Complete   | 2026-04-20 |
| 3. P2 — Directive detector | 6/6 | Partial-with-followups (path B) | 2026-04-22 |
| 4. P3 — MEMORY.md curation + auto-dream guard | 0/0 | Not started | - |
| 5. P4 — Kill legacy injection (GATE) | 0/0 | Not started | - |
| 6. P5 — Retrieval simplification | 0/0 | Not started | - |
| 7. P6 — Framing rewrite | 0/0 | Not started | - |
| 8. P6.5 — RL ablation gate | 0/0 | Not started | - |
| 9. P7 — Angel simplification | 0/0 | Not started | - |
| 10. P8 — Rule lifecycle | 0/0 | Not started | - |
| 11. P9 — Final validation + cleanup | 0/0 | Not started | - |
