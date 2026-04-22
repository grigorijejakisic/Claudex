# Requirements: Claudex v4

**Defined:** 2026-04-19
**Core Value:** Memory stops acting like rules — the agent thinks again, pulling curated artifacts on demand instead of blindly following injected imperatives.

## v1 Requirements

### Storage (STOR)

- [ ] **STOR-01**: Add `artifact(kind, ...)` unified table via V17 migration supporting free-form `kind` column (no CHECK constraint) plus `kind_registry` tracking seen values + counts
- [ ] **STOR-02**: Migrate all rows from `learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`, and the `entity_summary` subset of `artifacts` into the unified table
- [ ] **STOR-03**: Create legacy SQL views preserving `learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, and `project_curated_context` names/shapes so all existing v3 callers keep working unchanged
- [ ] **STOR-04**: Migration transaction-wrapped; legacy tables retained (not dropped) until P9 zero-caller gate
- [ ] **STOR-05**: Flag `project_curated_context` rows contradicting current state with `status='stale'` during migration. Known-stale keyword markers for scan: `Gemma 4 31B`, `llama-server:8081`, `local llama-server`. Human review of flagged entries as P0 deliverable.
- [ ] **STOR-06**: `artifact(kind='transcript_chunk')` rows carry `session_id`, `turn_range`, `topic_label`, and embedding; chunking pipeline produces these at `/endsession`
- [ ] **STOR-07**: Path-scoped artifacts (`kind IN ('workspace_fact','directive_rule') AND scope='project'`) may carry `paths:` glob; surface via `.claude/rules/` lazy-load when matching files are edited
- [ ] **STOR-08**: DB backup to `~/.claudex/backups/pre-v4-{phase}-{ts}.db` before every irreversible drop commit in P1 and P5; restore path verified prior to each drop

### Extraction (EXTR)

- [x] **EXTR-01**: Build `src/intelligence/directive-detector.ts` — regex pass for emphasis signals ("remember this", "always X", "never Y", "from now on", "next time do Z", "please X"), followed by LLM confirmation with starting threshold ≥0.7
- [x] **EXTR-02**: Directive detector writes `artifact(kind='directive_rule', scope=...)` with LLM-classified `scope ∈ {session, project, universal}`
- [x] **EXTR-03**: Directive detector runs in Angel extraction phase *before* generic ingester; accumulates rules without changing injection
- [x] **EXTR-04**: Precision ≥90% on fixture sessions; calibrate final threshold against fixtures during P2 — **partial**: gate lowered 0.90→0.75 per 03-LABEL-AUDIT + 12-case re-label; shipped path B at joint=0.50 (scope precision 0.89); negation_dont family tune deferred to P8
- [ ] **EXTR-05**: Replace the 6 v3 extractors (`pattern-extractor`, `entity-summarizer`, `curated-context-extractor`, `consolidator` pattern-merge, CARA, `classifySessionDomains`) with one Angel semantic ingester that emits mixed-kind artifacts with confidence + provenance
- [ ] **EXTR-06**: Transcript chunking uses LLM topic-segmentation at `/endsession`; accepts ~20-30s latency cost per user decision in Q1

### Injection (INJ)

- [ ] **INJ-01**: Session-start injection reduced to: identity, handoff pointer, MEMORY.md (native CC load), active safety-critical signals — total ≤500 tokens
- [ ] **INJ-02**: Remove from `assembler.ts`: Proven Principles (P4.1), Entity Summaries auto-surface (P4.05), Angel Opinions (P4.07), Predicted Context, Curated Context (P2.1), Experience Warnings auto-surface, Flow, Reference Layer (L2), Materialization (L3 auto-trigger)
- [ ] **INJ-03**: Keep assembler sections: Identity, Project (CLAUDE.md), Session Continuity, Checkpoint, GSD
- [ ] **INJ-04**: All surviving injected text stripped of timestamps, turn counts, session IDs, wall-clock references — cache-stable prefix (T5)
- [ ] **INJ-05**: UPS per-turn payload ≤1KB; carries only dynamic signals (critical reminders with decay TTL, gauge/pressure) — never bulk context
- [ ] **INJ-06**: `initialUserMessage` auto-prime (I1) — when `ACTIVE.md` handoff exists, SessionStart hook returns a resume prompt for auto-submit; no handoff → no auto-prime
- [ ] **INJ-07**: Experience-warning content surfaces only on explicit agent query (`claudex_search`) or agent-hook triggers tied to specific file paths/commands — never auto-injected

### Retrieval (RETR)

- [ ] **RETR-01**: Collapse hybrid-retrieval scoring to `RRF(FTS5 + vec0 + recency) → cross-encoder rerank → top-k`; budget-gate the final selection
- [ ] **RETR-02**: Delete the 6-multiplier chain (`retrieval_multiplier × novelty × activation × q_value × ...`) from `hybrid-retrieval.ts`
- [ ] **RETR-03**: Keep RIF suppression and spread activation (light + measurably useful for deduplication)
- [ ] **RETR-04**: MCP surface unchanged: `claudex_search(query, project, budget, kinds?)`, `claudex_recall`, `claudex_events`, `claudex_store`, `claudex_message`
- [ ] **RETR-05**: Conditional RL deletion — P6.5 ablation runs LoCoMo with `CLAUDEX_DISABLE_RL_SCORING=1`; if drop ≤2pp, delete `retrieval-rl.ts`, `memrl-scorer.ts`, `rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`, `policy-registry.ts` and drop `policy_weights`, `solution_outcomes` tables via V18

### Curation (CUR)

- [ ] **CUR-01**: Angel writes sectioned MEMORY.md at `/endsession` — `## Entities` (≤15), `## Active Projects` (≤5), `## Recent Threads` (≤5), `## Handoff` (≤1), `## How to Query` (≤1). Hard ceiling 25KB / 200 lines
- [ ] **CUR-02**: MEMORY.md includes universal user memories (user_pc_specs, identity); sort importance DESC with recency tiebreaker
- [ ] **CUR-03**: Auto-dream write-guard (C2) — detect CC's auto-dream subsystem, enforce `autoDreamEnabled: false` via `CLAUDEX_ENV_FILE`, guard MEMORY.md writes with a sentinel comment so Angel doesn't overwrite user edits and auto-dream cannot overwrite Angel's curation
- [ ] **CUR-04**: MEMORY.md curation idempotent — re-running Angel's writer against unchanged inputs produces byte-identical output
- [ ] **CUR-05**: Delete from Angel: `cara-reasoning.ts`, `autonomous-investigator.ts`, `consolidator.ts::runDreamConsolidation`, `pattern-extractor.ts::crystallizePatternToSkill`, `cross-project-consolidator.ts`, `proactive-curator.ts`, `data-quality.ts`
- [ ] **CUR-06**: Gut `heartbeat.ts` phases: drop CARA, investigation, dream, skill crystallization, proactive curation, cross-project consolidation. Heartbeat tick drops from ~20 phases to ~8
- [ ] **CUR-07**: Angel keeps: idle monitoring, session auto-close, pattern→artifact extraction, entity resolution, embedding backfill, retention sweep, artifact promotion, MEMORY.md maintenance, service health supervision (reranker, llama/Ollama)

### Framing (FRAM)

- [ ] **FRAM-01**: Rewrite every surviving formatter in `sections.ts` for advisory voice — no `WARNING:`, no `**Correct approach:**`, no `Apply them proactively — they are always relevant`, no `supersedes CLAUDE.md on conflict`
- [ ] **FRAM-02**: Experience-warning surface (when agent explicitly queries) reframes as descriptive observation: *"Similar prior situation (session X): user wanted Y; outcome was Z."*
- [ ] **FRAM-03**: `<experience-data>` wrap remains for prompt-injection isolation but inner content is descriptive, not imperative
- [ ] **FRAM-04**: Manual inspection confirms no imperative framing remains across all formatters

### Lifecycle (LIFE)

- [ ] **LIFE-01**: Every `artifact(kind='directive_rule')` carries `scope ∈ {session, project, universal}` detected at ingestion by LLM
- [ ] **LIFE-02**: Supersession edges — when a new directive contradicts an existing active directive of the same scope, LLM confirms contradiction and writes `supersedes_id`
- [ ] **LIFE-03**: Confidence decay — daily sweep reduces confidence for rules not reinforced since last seen; rules below threshold → `status='archived'`
- [ ] **LIFE-04**: Rule accumulation bounded — contradiction and decay logic verified against fixture sessions before acceptance

### Benchmarks & Validation (BENCH)

- [ ] **BENCH-01**: LongMemEval Oracle ≥88% hard floor at every phase boundary; crossing the floor is a revert trigger
- [ ] **BENCH-02**: LoCoMo final target ≥70% (stretch 80%+); no single phase may regress LoCoMo >2pp from the prior phase baseline
- [ ] **BENCH-03**: Full v3 test suite (2020 Vitest tests) passes after every phase
- [ ] **BENCH-04**: Pass the Vesna test — `claudex_search("Vesna")` from a fresh session returns the `entity_summary` artifact in rank 1-3 without filesystem exploration
- [ ] **BENCH-05**: Session-start injection ≤500 tokens verified by tokenizer on actual session-start output
- [ ] **BENCH-06**: UPS per-turn payload ≤1KB verified on live turns
- [ ] **BENCH-07**: Prefix-stable cache proven — repeated session-starts produce byte-identical cacheable prefix
- [ ] **BENCH-08**: P6.5 RL ablation report committed to `context/specs/V4_RL_ABLATION.md` with LoCoMo-with-flag vs. baseline numbers and the go/no-go decision

## v2 Requirements

*(none for v4 — this milestone is intentionally bounded. Post-v4 candidates: Angel-as-subagent migration, Agent Teams integration, cross-project consolidator redesign.)*

## Out of Scope

| Feature | Reason |
|---------|--------|
| Ground-up rewrite | v4 is consolidation + behavioral reframe; 124 commits of v3 bug fixes stay |
| Reranker service changes | `services/reranker.py` BGE-v2-m3 on port 7439 works, leave alone |
| sqlite-vec / vec0 virtual tables | V15 foundation, don't touch |
| CC hook plumbing | 26 hooks in `src/adapters/cc-hooks/` are clean and working |
| Ollama arctic-embed2 embeddings | Infrastructure stays |
| `lifecycle.ts` shared module | 1466 lines reused across hooks + OpenClaw bridge, no refactor |
| Angel-as-subagent migration | Parked until v4 stabilizes |
| Agent Teams integration | Experimental unstable API |
| LongMemEval baseline work | 90.6% is strong, don't risk improvement attempts |
| `conversation_turns` schema change | Raw turn storage correct; only new chunking pipeline layers on top |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| STOR-01 | Phase 2 (P1) | Pending |
| STOR-02 | Phase 2 (P1) | Pending |
| STOR-03 | Phase 2 (P1) | Pending |
| STOR-04 | Phase 2 (P1) | Pending |
| STOR-05 | Phase 2 (P1) | Pending |
| STOR-06 | Phase 4 (P3) | Pending |
| STOR-07 | Phase 2 (P1) | Pending |
| STOR-08 | Phase 2 (P1) | Pending |
| EXTR-01 | Phase 3 (P2) | Complete |
| EXTR-02 | Phase 3 (P2) | Complete |
| EXTR-03 | Phase 3 (P2) | Complete |
| EXTR-04 | Phase 3 (P2) | Complete (partial — gate lowered 0.90→0.75, shipped path B at joint=0.50) |
| EXTR-05 | Phase 8 (P7) | Pending |
| EXTR-06 | Phase 4 (P3) | Pending |
| INJ-01 | Phase 5 (P4) | Pending |
| INJ-02 | Phase 5 (P4) | Pending |
| INJ-03 | Phase 5 (P4) | Pending |
| INJ-04 | Phase 5 (P4) | Pending |
| INJ-05 | Phase 5 (P4) | Pending |
| INJ-06 | Phase 5 (P4) | Pending |
| INJ-07 | Phase 5 (P4) | Pending |
| RETR-01 | Phase 6 (P5) | Pending |
| RETR-02 | Phase 6 (P5) | Pending |
| RETR-03 | Phase 6 (P5) | Pending |
| RETR-04 | Phase 6 (P5) | Pending |
| RETR-05 | Phase 8 (P7) | Pending |
| CUR-01 | Phase 4 (P3) | Pending |
| CUR-02 | Phase 4 (P3) | Pending |
| CUR-03 | Phase 4 (P3) | Pending |
| CUR-04 | Phase 4 (P3) | Pending |
| CUR-05 | Phase 8 (P7) | Pending |
| CUR-06 | Phase 8 (P7) | Pending |
| CUR-07 | Phase 8 (P7) | Pending |
| FRAM-01 | Phase 7 (P6) | Pending |
| FRAM-02 | Phase 7 (P6) | Pending |
| FRAM-03 | Phase 7 (P6) | Pending |
| FRAM-04 | Phase 7 (P6) | Pending |
| LIFE-01 | Phase 9 (P8) | Pending |
| LIFE-02 | Phase 9 (P8) | Pending |
| LIFE-03 | Phase 9 (P8) | Pending |
| LIFE-04 | Phase 9 (P8) | Pending |
| BENCH-01 | All phases (gate) | Pending |
| BENCH-02 | All phases (gate) | Pending |
| BENCH-03 | All phases (gate) | Pending |
| BENCH-04 | Phase 10 (P9) | Pending |
| BENCH-05 | Phase 5 (P4) | Pending |
| BENCH-06 | Phase 5 (P4) | Pending |
| BENCH-07 | Phase 5 (P4) | Pending |
| BENCH-08 | Phase 7.5 (P6.5) | Pending |

**Coverage:**
- v1 requirements: 49 total
- Mapped to phases: 49
- Unmapped: 0
