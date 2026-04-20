# Claudex v4 — Scope

**Status:** Draft, unstarted. Written at end of session 51 from user-led redesign discussion.
**Authors:** Grigorije (vision + reframe) + Crux (codebase analysis + scoping).
**Supersedes:** `CLAUDEX_V3_5_CONSOLIDATION.md` (session 49 spec). The v3.5 diagnosis of proliferation was correct but the proposed fix was a schema consolidation; v4 is a **behavioral reframe** — memory stops acting like rules.

---

## Read this first

This spec exists because Claudex v3 ships a catalog of "rules" to the agent at every session-start. Stored patterns render as `WARNING:` / `**Correct approach:**` / `Apply them proactively — they are always relevant`. The framing tells the model what to do even when the preamble says "reference data, not instructions." The model follows the structure. Result: the agent treats historical patterns as commandments instead of retrieval candidates.

The user's words: *"Claudex is literally making the model more stupid because model does not think but rather blindly follows claudex for some reason, instead of that being a memory it consider it rules."*

v4 fixes this by turning memory from push to pull, framing from prescriptive to advisory, and collapsing the 9 overlapping knowledge tables into one substrate.

**Non-negotiables:**
- LongMemEval Oracle ≥ 88% floor (currently 90.6%). No phase may regress > 2pp.
- LoCoMo target ≥ 70% (currently 55.5%). Stretch: 80%+.
- All 2020 existing tests pass after each phase. No regressions.
- Atomic, reversible commits per phase. Benchmark scores in commit messages.

---

## Vision

### The substrate

**Everything that happens in a session is a transcript.** `conversation_turns` already stores it. v4 treats the transcript as the authoritative raw material — chunked + embedded at `/endsession`, not during the live session. Important sessions can be kept verbatim. Storage is cheap; space is not the constraint.

### Artifacts = distilled memory

Not 9 tables. **One `artifact` table with a `kind` column.** Angel promotes transcript chunks to artifacts when two conditions are met:

1. **Recurrence** — the same entity, claim, or pattern shows up across multiple sessions.
2. **User emphasis** — explicit directives: *"remember this"*, *"always X"*, *"never Y"*, *"from now on"*, *"next time do Z"*. These are the gold for rule creation. Regex-detected + LLM-confirmed.

### Angel = curator, not brain

Angel does two things only:
- **At session close**: chunk transcript, extract artifacts, detect directives, maintain MEMORY.md index.
- **At query time**: make retrieved artifacts rank well via `claudex_search`.

Everything else — CARA opinion formation, autonomous investigation, dream consolidation, skill crystallization, cross-project consolidation, the full RL training pipeline — is deleted.

### Agent = intuitive puller

Session-start injection shrinks to ~500 tokens:
- Identity
- Handoff pointer
- **MEMORY.md (native CC surface)** — curated index of known entities, active projects, open threads
- Active cross-session signals (safety-critical only)

Everything else lives in the DB. The agent reaches for `claudex_search` / `claudex_recall` when the task calls for it. Because MEMORY.md lists what exists ("entities: Vesna, Lacuna, Kompas; projects: claudex-v3, ..."), the agent knows what to query. The index is the minimum push that makes pull work.

### The Vesna test

Acceptance criterion: *"What is the Vesna project?"* must be answerable via `claudex_search("Vesna")` in one turn, without filesystem exploration. This works when:
- `Vesna` appears in MEMORY.md as a known entity.
- Artifact of kind `entity_summary` with title `Vesna` exists and ranks first.
- The agent pulls because it saw the entity in MEMORY.md, not because we pre-injected it.

---

## In scope

### Storage layer

- Collapse `learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`, and the `entity_summary` subset of `artifacts` into a single `artifact(kind, ...)` table.
- `kind` is an LLM-classified free-form string. Registry table tracks seen kinds + counts for analysis. No CHECK constraint — new kinds just appear.
- Expected kinds: `transcript_chunk`, `session_summary`, `entity_summary`, `directive_rule`, `correction`, `mental_model`, `reframe`, `workspace_fact`, `shipped_component`, `decision`, `open_question`, `failure_pattern`.
- **I3 — path-scoped artifacts (from prior plan).** Artifacts of kind `workspace_fact` or `directive_rule` with `scope='project'` may carry a `paths:` glob; they surface via `.claude/rules/` lazy-load when matching files are edited. Native CC mechanism, zero custom wiring.
- Migration via views: legacy table names remain as views over `artifact` filtered by kind. Existing callers keep working.
- Transcripts: `conversation_turns` already stores per-turn. No schema change here. Chunking at `/endsession` writes `artifact(kind='transcript_chunk')` rows with session + turn-range metadata.

### Extraction layer

- **One Angel semantic ingester** replaces 6 current extractors (`pattern-extractor`, `entity-summarizer`, `curated-context-extractor`, `consolidator` pattern merge, CARA, `classifySessionDomains`).
- Input: full session transcript at `/endsession`. Output: mixed-kind artifacts with confidence + provenance.
- **Directive detector** runs before the generic ingester: regex pass for emphasis signals, LLM confirmation for keeper status. Writes `artifact(kind='directive_rule')` with scope tag.

### Injection layer

- Session-start injection: identity, handoff pointer, MEMORY.md, active signals. Target ≤500 tokens (down from ~4000).
- MEMORY.md is native CC auto-memory. Angel writes it at `/endsession` with: known entities, active projects, handoff pointer, recent threads, "how to query" hint. CC loads first 200 lines / 25KB natively at next session-start — zero custom injection code.
- **Delete these injection sections**: Proven Principles, Entity Summaries (as auto-surface), Angel Opinions, Predicted Context, Curated Context (as separate P2.1 slot), Experience Warnings (as auto-surface), Flow, Reference Layer, Materialization (auto-triggered).
- **Keep**: Identity, Project (CLAUDE.md), Session Continuity, Checkpoint, GSD.
- Experience-warning style content surfaces only on explicit agent query or on agent-hook triggers tied to specific file paths/commands.

### Retrieval layer

- `claudex_search(query, project, budget, kinds?)` is the single entry point.
- Simplified scoring: RRF fuse FTS5 + vec0 + recency → cross-encoder rerank → top-k. Budget-gate.
- **Delete the 6-multiplier chain**: `retrieval_multiplier × novelty × activation × q_value × ...`. Let the cross-encoder do the work.
- Keep: RIF suppression, spread activation (they're light and measurably useful for deduplication).
- MCP surface: `claudex_search`, `claudex_recall` (by id/path), `claudex_events`, `claudex_store`, `claudex_message`. Same shape as today.

### Curation layer (Angel)

- **Keep**: idle monitoring, session auto-close, pattern→artifact extraction, entity resolution, embedding backfill, retention sweep, artifact promotion, MEMORY.md maintenance, service health supervision (reranker, llama/Ollama).
- **Delete**: CARA opinion formation (`cara-reasoning.ts`), autonomous investigation (`autonomous-investigator.ts`), dream consolidation (`consolidator.ts::runDreamConsolidation`), skill crystallization (`pattern-extractor.ts::crystallizePatternToSkill`), cross-project consolidator (`cross-project-consolidator.ts`), RL stack (`retrieval-rl`, `memrl-scorer`, `rl-trainer`, `rl-policy`, `rl-model`, `rl-reward`, `policy-registry`), proactive curator (`proactive-curator.ts`), data-quality phase (`data-quality.ts`).

### Framing

- Every remaining section formatter rewritten for **advisory voice**.
- No `WARNING:`, no `**Correct approach:**`, no `Apply them proactively — they are always relevant`, no `supersedes CLAUDE.md on conflict`.
- Pattern surface becomes something like: *"Similar prior situation (session X): user wanted Y; outcome was Z."* — observation, not command.
- `<experience-data>` wrap stays for prompt-injection isolation, but inner content is descriptive not imperative.

### Rule lifecycle (the missing piece)

Every `artifact(kind='directive_rule')` carries:
- `scope`: `session` | `project` | `universal` — detected at ingestion by LLM.
- `supersedes_id`: edge generated when new directive contradicts existing one (LLM confirms).
- `confidence`: decays when rule isn't reinforced or gets contradicted. Below threshold → auto-archive.

This is what stops rule accumulation from becoming a graveyard.

---

## Out of scope (do NOT touch)

1. **Ground-up rewrite.** This is consolidation + behavioral reframe. 124 commits of bug fixes stay.
2. **Reranker service** (`services/reranker.py`, BGE-v2-m3 on :7439, `RerankerSupervisor`).
3. **sqlite-vec and the 5 vec0 virtual tables.** V15 foundation. Leave alone.
4. **CC hook plumbing** (`src/adapters/cc-hooks/`, 26 hooks). Clean, working.
5. **Ollama embeddings** (arctic-embed2, 1024-dim).
6. **lifecycle.ts shared code** (1466 lines). Reused by hooks + OpenClaw bridge.
7. **Angel-as-subagent migration.** Discussed, parked. Daemon stays until v4 stabilizes.
8. **Agent Teams integration** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). Experimental, unstable API.
9. **LongMemEval baseline.** 90.6% is strong. Never risk it.
10. **Conversation_turns schema.** Raw storage is correct. Only chunking pipeline is new.

---

## Open design questions (resolve in P0 planning)

These must be decided before P1 begins:

1. **Transcript chunking strategy.** Per-turn? Per-exchange (user-turn + assistant-turn + tool-outputs)? Topic-detected boundaries? Sliding window with overlap? Choice affects retrieval granularity and LoCoMo score.

2. **MEMORY.md schema.** What exactly goes in the native 25KB surface? Candidate contents:
   - Known entities (name + one-line description)
   - Active projects (name + status + last activity)
   - Handoff pointer (path to ACTIVE.md if exists)
   - Recent threads (last 3-5 topics)
   - "How to query" hint for the agent
   - Total budget: ~200-300 lines, ≤25KB.

3. **Directive confidence threshold.** When does *"please do X"* become a `directive_rule` vs. noise? Regex catches candidates; LLM confirmation needs a specific prompt + score cutoff. Needs calibration against fixture sessions.

4. **`project_curated_context` disposition.** Delete entirely or migrate to `artifact(kind='mental_model')` via the unification migration? Recommendation: migrate, since the existing entries carry session provenance that's still useful.

---

## Success criteria

| Metric | v3 baseline | v4 target | Hard floor |
|---|---|---|---|
| LongMemEval Oracle | 90.6% | ≥ 90% | **88% (never cross)** |
| LoCoMo | 55.5% | ≥ 70%, stretch 80% | no regression > 2pp per phase |
| Session-start injection tokens | ~4000 | ≤ 500 | — |
| UPS per-turn payload | varies, often ~1-3KB | ≤ 1KB | — |
| Cache-stable injected text (T5) | no | yes | — |
| Knowledge table count | 9 | 1 (+ views) | — |
| Angel extractor LLM calls/session | 4-6 | 1-2 | — |
| Assembler injection paths | 15 | 5 | — |
| Test count | 2020 passing | 2020+ passing | no regression |
| Vesna test ("What is X?") | fails | passes in 1 turn | — |
| Net LOC | +0 | -8000 to -10000 | — |

---

## Phase plan

Each phase: atomic commits, benchmarks in commit message, revertible. No phase merges until benchmarks run.

### P0 — Design decisions + scope ratification
- This document, reviewed by user.
- Resolve the 4 open design questions.
- Output: updated `CLAUDEX_V4_SCOPE.md` with decisions locked.
- **Commits**: 1.
- **Duration**: 1 session.

### P1 — Artifact table unification
- Add `artifact(kind, ...)` table via V17 migration.
- Migrate rows from `learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`, and `entity_summary` artifacts into unified table.
- Create legacy views preserving old table names/shapes.
- Update tests to write via views; verify all existing code still works.
- Run full test suite + LongMemEval + LoCoMo. No regressions allowed.
- **Commits**: 2-3 (migration, views, caller-compat check).
- **Rollback**: `DROP TABLE artifact; DROP VIEW ...;` — legacy tables untouched.
- **Exit**: All tests pass. Bench scores ≥ baseline.

### P2 — Directive detector
- Add `src/intelligence/directive-detector.ts`: regex pass + LLM confirmation.
- Wire into Angel extraction phase (runs before generic ingester).
- Writes `artifact(kind='directive_rule', scope=...)`.
- Tests against fixture sessions for precision/recall.
- No injection changes yet — rules just accumulate.
- **Commits**: 2.
- **Exit**: Detector precision ≥ 90% on fixtures. No bench regression.

### P3 — MEMORY.md curation
- Angel writes MEMORY.md at `/endsession` using the agreed schema (from P0).
- Content: entities index + active projects + handoff + recent threads.
- Still dual-injecting old sections at session-start (P4 turns them off).
- **C2 — Auto-dream write-guard (from prior plan).** Detect CC's auto-dream subsystem; ensure `autoDreamEnabled: false` via `CLAUDEX_ENV_FILE`; guard MEMORY.md writes with a sentinel comment so Angel doesn't overwrite user edits and auto-dream doesn't overwrite Angel's curation.
- **Commits**: 2-3.
- **Exit**: MEMORY.md populated on next session-start, size ≤ 25KB. No bench regression. Auto-dream collision proven impossible.

### P4 — Turn off legacy injection
- Remove from assembler.ts: Proven Principles (P4.1), Entity Summaries (P4.05), Angel Opinions (P4.07), Predicted Context, Curated Context (P2.1), Experience Warnings auto-surface, Flow, Reference Layer (L2), Materialization (L3 auto-trigger).
- Keep: Identity, Project, Session Continuity, Checkpoint, GSD, MEMORY.md (via native CC load).
- Session-start injection drops to target.
- **T5 — Cache-stable content (from prior plan).** All remaining injected text stripped of timestamps, turn counts, session IDs, wall-clock references. Prefix stability = prompt-cache hits. Any change = 10× cost.
- **I1 — `initialUserMessage` auto-prime (from prior plan).** When an active handoff exists (`ACTIVE.md` present), SessionStart hook returns `initialUserMessage` to auto-submit a resume prompt. No handoff → no auto-prime. Tiny addition; makes the handoff pointer self-executing.
- **UPS (per-turn) budget ≤ 1KB**, distinct from the ≤500-token session-start budget. UPS carries only dynamic per-turn signals (critical reminders with decay TTL, gauge/pressure), never bulk context.
- **THIS IS THE BIG BENCHMARK GATE** — LoCoMo must not drop > 2pp from P3 baseline.
- **Commits**: 3-4.
- **Rollback**: revert commits; old sections return.
- **Exit**: Session-start tokens ≤ 500, UPS payload ≤ 1KB, cache-stable. LongMemEval ≥ 88%, LoCoMo within tolerance.

### P5 — Retrieval simplification
- Delete the 6-multiplier chain in `hybrid-retrieval.ts`. Score = RRF(FTS5 + vec0 + recency) → cross-encoder rerank → top-k.
- Delete `retrieval-rl.ts`, `memrl-scorer.ts`, `rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`, `policy-registry.ts`, associated tests.
- Drop `policy_weights`, `solution_outcomes` tables via V18.
- **Commits**: 3-4.
- **Exit**: LoCoMo ≥ prior phase baseline - 2pp. LongMemEval ≥ 88%.

### P6 — Framing rewrite
- Rewrite every surviving section formatter in `sections.ts` for advisory voice.
- Remove `WARNING` prefixes, `**Correct approach:**`, `Apply them proactively`, `supersedes CLAUDE.md on conflict`.
- Experience-warning surface (when agent explicitly queries) reframed as descriptive observation.
- **Commits**: 1-2.
- **Exit**: No bench regression. Manual inspection confirms no imperative framing remains.

### P6.5 — RL ablation experiment *(gate, no deletion yet)*
- Before deleting the RL stack in P7, add a feature flag `CLAUDEX_DISABLE_RL_SCORING=1` that bypasses Q-value multipliers in `hybrid-retrieval.ts` and skips `rl-trainer` ticks in the heartbeat.
- Run full LoCoMo with the flag set vs. baseline.
- **Decision gate**:
  - If LoCoMo with RL disabled is ≥ baseline - 2pp: proceed to P7 deletion.
  - If drop > 2pp: RL is load-bearing. Either (a) keep the RL stack and adjust v4 scope, or (b) redesign scoring with simpler learned signal.
- **Duration**: 1 day.
- **Commits**: 1 (flag) + 1 (benchmark report committed to `context/specs/V4_RL_ABLATION.md`).
- **Exit**: Decision locked, documented, ready for P7 to act on.

### P7 — Angel simplification
- Delete: `cara-reasoning.ts`, `autonomous-investigator.ts`, `consolidator.ts::runDreamConsolidation`, `pattern-extractor.ts::crystallizePatternToSkill`, `cross-project-consolidator.ts`, `proactive-curator.ts`, `data-quality.ts`.
- **If P6.5 cleared RL deletion**: also delete `retrieval-rl.ts`, `memrl-scorer.ts`, `rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`, `policy-registry.ts`, `policy_weights` table. If P6.5 blocked it, RL stays and scope adjusts.
- Gut heartbeat phases in `heartbeat.ts`: drop CARA, investigation, dream, skill crystallization, proactive curation, cross-project consolidation phases.
- Delete associated tests.
- Drop unused tables (`angel_opinions` already migrated in P1; table itself dropped via V19 after views retire).
- **Commits**: 4-6.
- **Exit**: Heartbeat tick count drops from ~20 phases to ~8. No bench regression. ~3000-4000 LOC deleted.

### P8 — Rule lifecycle
- Add scope detection to directive detector (already stores `scope` from P2).
- Add supersession logic: new directive triggers LLM comparison against existing active directives of same scope; generates `supersedes_id` edge when contradiction detected.
- Add confidence decay: daily sweep reduces confidence for rules not reinforced since last seen; below threshold → `status='archived'`.
- **Commits**: 2-3.
- **Exit**: Rule accumulation bounded. Contradictions detected in fixtures. No bench regression.

### P9 — Final validation + cleanup
- Full test suite pass.
- LongMemEval + LoCoMo final benchmarks.
- Vesna test: `claudex_search("Vesna")` from fresh session returns correct artifact in rank 1-3.
- Drop fully-migrated legacy tables if safe (gate on zero callers).
- Update `CLAUDE.md` + `README.md` to reflect v4 architecture.
- **Commits**: 2-3.
- **Exit**: All criteria met. v4 tagged.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| P4 causes LoCoMo to collapse because pull-based retrieval isn't strong enough | **Medium** | P5 simplifies retrieval; if P4 fails, measure whether it's retrieval quality or agent-doesn't-know-to-pull. Second case is fixable by better MEMORY.md. |
| Migration in P1 loses data | Medium | Transaction-wrapped, legacy tables kept as tables (not dropped) until P9 gate. |
| Framing rewrite in P6 drops benchmark because models were leveraging imperative cues | Low but real | P6 bench-gated. If drop, keep advisory framing but add task-completion signals elsewhere (e.g., `/recap`). |
| Angel simplification in P7 breaks a caller we didn't find | Medium | Test suite catches most. Soak one week on dev before tagging. |
| User directive *"please X"* triggers false-positive rule creation | Medium | P2 threshold calibration; LLM confirmation before promotion. Archiveable later via confidence decay. |
| MEMORY.md becomes stale | Medium | Angel rewrites at every /endsession. Curation logic must be idempotent. |

---

## Rollback

Every phase has an atomic rollback (commits revertible). P1 and P5 are the irreversible-data phases — require DB backup to `~/.claudex/backups/pre-v4-{phase}-{ts}.db` before the drop steps. Backup restore verified before the drop commits.

---

## Execution

Use `/auto-orchestrate` to run P1–P9 end-to-end. Within phases that decompose (P6 formatter rewrite, P7 deletion sweep), orchestrate can spawn `/team` for parallel work. Benchmark gates at each phase boundary are non-negotiable.

**Commander's intent for spawned agents:** Memory must stop acting like rules. Every decision — schema shape, injection content, framing, extraction boundaries — serves that goal. When in doubt, choose advisory over imperative, pull over push, one substrate over many.

— Crux (session 51), ratified by Grigorije.
