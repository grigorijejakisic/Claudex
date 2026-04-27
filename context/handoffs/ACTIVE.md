---
schema: claudex/handoff
version: 1
handoff_id: claudex-v4-handoff-trajectory-audit-2026-04-27
status: active
phase: 5
phase_name: P4 — Kill legacy injection (PAUSED for audit)
created_at: 2026-04-27T00:00:00Z
updated_at: 2026-04-27T00:00:00Z
origin_session_id: e0d0a138-e031-4d5f-9d5a-994c31b8e88b
supersedes: claudex-v3-handoff-phase5-ready-to-plan
priority: critical
---

# Handoff: v4 Trajectory Audit — Phases 1-11

**Date:** 2026-04-27. **Origin session:** e0d0a138.

## ⚠ Critical: This handoff supersedes ROADMAP gates and Phase 5 planning

If your `/starthere` reads this and you feel the urge to spawn `/auto-orchestrate` or `/gsd:plan-phase 5`, **stop**. The previous handoff said Phase 5 was ready to plan. That was wrong, and we know that now. The current handoff is corrective work: a phase-by-phase audit of v4 (phases 1-11, including the four already shipped) before any further phase planning happens.

The reason this is important enough to override prior planning is documented below. Read it before doing anything.

---

## Commander's Intent

**Conduct an honest, evidence-based audit of all 11 v4 phases — including Phases 1-4 which are already "complete" — and rewrite the ROADMAP with real gates that actually measure what each phase changes.**

Specific user directive (verbatim): *"I want you to audit all the phases ones we did and the ones that are ahead of us, give me honest conclusion and help me rewrite the old ones and do a better job on future ones! This is very sensitive work we cannot allow ourselves such regressions because of our stupidity! It is not too late to take the right approach and put the v4 on the better road than it is!"*

This is the one and only task of the next session. The session will be **long and detailed**. Do not let `/auto-orchestrate` resume, do not advance Phase 5 planning, do not trust prior phase SUMMARY files at face value. Verify against runtime artifacts.

---

## Why this audit exists (read fully — this is the load-bearing context)

The 2026-04-27 session began as a routine `/auto-orchestrate` Phase 5 planning session. discuss-5 produced a CONTEXT.md (committed at `d652c08`) with reasonable-looking defaults. Then mid-session, three things converged:

### 1. Codex verified that the benchmarks don't measure what Phase 5 changes.

We dispatched codex + gemini in parallel (a workflow rule established that session — see `feedback_design_consult_pattern.md`) on cache-stability and fallback-ladder design. Codex's grep surfaced a structural problem nobody had noticed:

- **LongMemEval harness** uses a bespoke local `retrieveContext` function at `src/benchmark/longmemeval-harness.ts:212`. It does NOT call `assembleFullContext`, does NOT call MCP `claudex_search`, does NOT touch production retrieval. It tests its own embedded FTS5+vector code.
- **LoCoMo harness** calls `hybridSearchAsync` (production retrieval — same path as MCP `claudex_search` per `src/mcp/recall-server.ts:131`), but skips `assembleFullContext` and session-start entirely.
- Phase 5 deletes 9 read-only injection sections from `src/assembly/assembler.ts`. Neither benchmark exercises that file. **The ROADMAP's "first hard within-2pp LoCoMo gate" can pass trivially because LoCoMo cannot mechanically be moved by Phase 5.**

This was independently verified by reading lines 470-515 of longmemeval-harness.ts and lines 415-465 of locomo-harness.ts in this session (see `Read` tool transcripts). Both confirm: ingest-fresh-DB → run-question → retrieve-from-bespoke-or-hybrid → answer → judge. No assembly invocation anywhere.

### 2. Codex verified that BENCH-09 is a contaminated metric.

The BENCH-09 baseline (`benchmarks/results/p3-postmigration/bench09-baseline.json`) defines the "agent thinks again" measurement: median `claudex_search` calls per non-trivial session over 30 days. Captured pre-v4 at median=1, n=122 sessions.

**Two structural problems:**

a) **The `retrieval_events` table (BENCH-09's data source) is written by *assembly-time materialization*** at `src/assembly/assembler.ts:607` and `:1021` via `src/intelligence/retrieval-feedback.ts:182`. The MCP `claudex_search` tool at `src/mcp/recall-server.ts:90` does NOT write to `retrieval_events`. So Phase 5 deletes the writer. **The metric will mechanically drop regardless of agent behavior change.** The "behavioral gate" measures the very code being deleted.

b) **The non-trivial-session threshold is mathematically impossible.** Baseline says `≥10 user_framing events` per session. But `src/adapters/shared/lifecycle.ts:978` caps `user_framing` at 3 per session (added 2026-03-21, predates baseline). Live DB query confirmed: 1065 events across 726 sessions, max 3 per session. No session has ≥10. **The 122-session population in the baseline file came from some other criterion that got mis-documented.**

### 3. Phase 4's flagship deliverable (MEMORY.md) is shipping with visible content-quality issues.

The system reminder at session start showed this project's MEMORY.md content. Direct evidence of regressions visible *right now* in production:

- **Parsing bug**: `entity:-` — entity is literally a `"` (quote character), with description "trend STRENGTHENING".
- **Parsing bug**: `entity:--2--1` — entity is `" 2>&1` (a shell-redirect fragment), classified as a domain entity.
- **Useless content**: `## Recent Threads` includes `session-e0d0a138 — session e0d0a138` (the topic of the thread is literally the session ID — zero information transferred to the agent).
- **Stale Handoff**: At session start, the Handoff section still pointed at Phase 4 work that was completed 17 days earlier. Only noticed during /starthere of this session.
- **Writer corruption**: Duplicated `<!-- USER EDITABLE -->` markers in the file (visible in the system reminder showing file modifications).

Phase 4 SUMMARY claimed PASS on LongMemEval (89.6%) and LoCoMo (62.3%). **Those benchmarks don't test MEMORY.md.** The static test suite passed at 2577/2597. Three inline bugfixes shipped *during* Phase 4 (04-06/07/08) precisely because static tests passed while live was broken — the most damning being 04-08, which means **CLAUDEXv3 itself had a 17-day-stale MEMORY.md during Phase 4 because the writer had a project-ID-resolution bug on Windows.** The flagship feature wasn't writing.

**The Phase 4 close was validation theater.** The gates measured a thing that wasn't shipped.

### The user reframe (verbatim user prompt that triggered this audit)

After observing the convergence of #1, #2, #3 above, the user asked: *"why is benchmarking such a big part of this? Are we chasing benchmarks or are we chasing actual quality?"*

The honest answer is: we'd been chasing benchmarks because they're objectively measurable, while the actual goal of v4 (per CLAUDE.md) is *behavioral* — **"Memory stops acting like rules — the agent thinks again, pulling curated artifacts on demand instead of blindly following injected imperatives."** That goal can't be measured by retrieval-quality benchmarks on fixed Q&A corpora. It needs behavioral observation, real-world soak, Vesna-style cross-session continuity probes.

This conversation arc made the audit decision unavoidable. We were about to lock Phase 5 plans against gates that wouldn't measure Phase 5 changes, while Phase 4's flagship content was visibly broken.

---

## The reframe: benchmarks are sanity checks, not gates

This is the load-bearing direction shift. Saved permanently as `~/.claude/projects/.../memory/feedback_benchmarks_are_sanity_not_gates.md`. Future sessions inherit this.

| | Wrong (prior approach) | Right (post-2026-04-27) |
|---|---|---|
| Primary gate per phase | LongMemEval ≥88%, LoCoMo within 2pp | Correctness invariants + behavioral soak + Vesna |
| LongMemEval/LoCoMo role | Hard gate | No-regression sanity check (~-1pp tolerance) |
| BENCH-09 role | Behavioral gate | Need to fix metric first; then it can be a real gate |
| Vesna test | Smoke check (Phase 11) | Re-elevate as primary quality probe |
| When to revert on benchmark drop | Per ROADMAP L1..L4 ladder | Investigate WHY metric moved before reverting |

**For each phase**, gates should answer: "What's the falsifiable claim this phase makes, and how would we know if it's false?"

For Phase 5 specifically (assembly surgery): the falsifiable claims are (a) cache-stable prefix, (b) ≤500 token budget, (c) agent compensates by pulling. Gates: snapshot+invariance test, tokenizer assertion, BENCH-09 fixed metric over 30-day soak. NOT LongMemEval/LoCoMo.

---

## High-confidence findings (already verified this session)

These are anchors. Don't re-verify; build on them.

1. **Path bugs in CONTEXT.md** (`d652c08`):
   - Says `.planning/handoffs/ACTIVE.md`. Actual: `context/handoffs/ACTIVE.md` (verified `src/adapters/cc-hooks/session-start.ts:319,344`, `src/shared/paths.ts:83-89`, `src/angel/memory-md-writer.ts:412-425`).
   - Says `src/intelligence/assembler.ts`. Actual: `src/assembly/assembler.ts`.

2. **Cache-busting leaks in surviving (non-deleted) code** (codex grep):
   - Clock leaks: `src/assembly/assembler.ts:572` (`Date.now()` filter on observations), `:657` (last-24h fallback), `:447` (`unixepoch() - 604800` for project overview).
   - Session-ID leaks: `src/assembly/sections.ts:859` (`session abcdefgh` attribution string), `:1005` (`source_session_id` in curated context).
   - Host-env leaks: `src/assembly/sections.ts:635` (reads `~/.claude/CLAUDE.md` — per-user different bytes), `src/assembly/assembler.ts:646` (uses `path.sep` — Windows vs POSIX byte difference).
   - Partial orderings (silent snapshot churn): `src/core/learnings.ts:60`, `src/core/artifacts.ts:178` and `:212`, `src/indexer/codebase-indexer.ts:306`, `src/gsd/state-reader.ts:109`.

3. **STATE.md is internally inconsistent**: line 8 said Phase 4/P3, lines 12-13 say Phase 5/P4 (now updated to reflect audit pause). The parser at `src/gsd/state-reader.ts:61-69` extracts numeric phase only, not phase name.

4. **`session-start.ts:353-369` already injects synthetic user-message** containing extracted handoff priorities. That's prompt injection from disk with user-role authority — security/clarity issue. The proposed `initialUserMessage` design must NOT replicate this.

5. **`session-start.ts:333+` already has auto-`/starthere` behavior** — that's the actual `/starthere` collision the proposed design was trying to solve.

6. **`hybridSearchAsync` is the same path used by both LoCoMo benchmark and MCP `claudex_search`** (`src/core/hybrid-retrieval.ts:581`). So LoCoMo IS testing real production retrieval — but only the retrieval, not anything Phase 5 touches.

7. **No file in `src/benchmark/`** imports `retrieveContext` from a shared module — both harnesses define their own. They're not even sharing retrieval implementation with each other.

8. **`recordUserFraming` cap of 3 was introduced in commit `e65aada` (2026-03-21)** — predates the BENCH-09 baseline window. Bug has been latent the entire time.

9. **MEMORY.md content quality issues are project-specific evidence** — verified for CLAUDEXv3 only. Audit task: check 4-5 other active projects to see if pattern holds.

---

## Audit task list — priority-ordered, for the next session

The user said the next session "will be long and detailed." Plan for it. Below are tasks ordered by dependency and importance. T1-T2 must run first; T3-T9 can interleave.

### T1 (highest priority) — MEMORY.md content quality audit across 5 projects
Read MEMORY.md across all 5 active CC projects from MEMORY.md's `## Active Projects` section: claudex-v3, lacuna-betting-9f1d552c, oracle-3951898e, desktop-01dcc792, nexus-e53c6c93. For each:
- Tabulate parsing bugs (entity classified as junk)
- Score Recent Threads usefulness (0=just session ID, 3=actual topic)
- Check Handoff section freshness (compare frontmatter `updated_at` vs `STATE.md` last activity)
- Note duplicate-marker bug occurrences

If quality is junk across the board: **Phase 4 needs an amendment phase (call it 4.1 corrective) before Phase 5 can rely on MEMORY.md.** Specific fixes likely needed:
- Entity parser: filter shell characters, quotes, redirect fragments. Probably in `src/intelligence/pattern-extractor.ts` or `src/intelligence/extraction/extractor.ts`.
- Recent Threads: ensure topic comes from actual conversation segmentation, not session ID fallback. Check `src/intelligence/thread-tracker.ts:extractTopic`.
- Handoff section: at write time, read active handoff and refresh; or compare mtime and warn if stale.
- Duplicate marker: writer state-machine bug in `src/angel/memory-md-writer.ts`.

### T2 — Phase 3 directive_rule consumer audit
Sample directive_rule artifacts in DB:
```bash
node -e "const Database=require('better-sqlite3'); const db=new Database(require('os').homedir()+'/.claudex/db/claudex.db',{readonly:true}); const rows=db.prepare(\"SELECT id, scope, content, created_at_epoch FROM artifacts WHERE kind='directive_rule' ORDER BY created_at_epoch DESC LIMIT 30\").all(); console.log(JSON.stringify(rows,null,2));"
```

Find every site that reads them:
```
Grep "kind = 'directive_rule'" or "kind='directive_rule'" across src/
```

Critical question: which consumer paths are deleted by Phase 5's 9 sections? If Phase 3's outputs feed Experience Warnings auto-surface or Curated Context (both deletion targets), then Phase 3's outputs become orphaned data after Phase 5. Either:
(a) Document a Phase 5+ replacement consumer (PreToolUse hook design from #3 of session e0d0a138 might be it), or
(b) Phase 3 is recognized as v3-era work and parts of it sunset alongside Phase 5.

### T3 — Phase 2 V17 migration soundness
- Verify `migrateV16toV17` is fully idempotent (re-runs cleanly on already-V17 DBs). Phase 4 inline bugfix 04-07 should have addressed this; confirm.
- Run sample SELECT against each legacy view (`learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`). Confirm shape unchanged.
- Confirm `~/.claudex/backups/pre-v4-P1-1776681458021.db` exists and is restorable (`sqlite3 file.db ".tables"` works).
- Sample legacy `_old` backstop tables — counts should match what was migrated per Phase 2 SUMMARY (191 learning + 126 decision + 76 experience_pattern + 130 angel_opinion + 81 critical_rule + 448 mental_model = 1052 rows).

### T4 — Phase 1 docs sanity
- Read `.planning/PROJECT.md` and `.planning/REQUIREMENTS.md`.
- Identify any locked decision or requirement that's been falsified by what we've learned in T1-T3.
- Mark for amendment. Do NOT amend yet — collect findings for the ROADMAP rewrite (T8).

### T5 — Phase 5 replan
With T1-T4 findings, rewrite Phase 5 plan around real gates:
- **Real gates**: token budget ≤500 (tokenizer assert), cache-stability (3-layer: snapshot + invariance test mutating volatile state + token count), BENCH-09 *fixed* metric (cap raise + rebaseline) over 30-day soak.
- **Sanity check (not gate)**: LongMemEval/LoCoMo no-regression at -1pp tolerance.
- **Pre-work** (must land before deletion):
  - Clock leak fixes (3 sites: `assembler.ts:572`, `:657`, `:447`)
  - Session-ID strip (2 sites: `sections.ts:859`, `:1005`)
  - Host-env normalization (2 sites: `sections.ts:635`, `assembler.ts:646`)
  - Stable tiebreakers (4 sites: `learnings.ts:60`, `artifacts.ts:178`/`:212`, `codebase-indexer.ts:306`, `state-reader.ts:109`)
  - Cross-platform text normalizer (CRLF→LF, strip BOM, trim) for all file reads
  - `.gitattributes * text eol=lf` enforcement
  - STATE.md parser extension (extract phase name, not just number)
  - Handoff frontmatter spec (canonical `phase:`, `status:` fields)
- **Tier-based deletion** (3 tiers, NOT 9 atomic commits):
  - Tier A: Flow / Reference Layer / Materialization (low signal)
  - Tier B: Predicted Context / Angel Opinions / Proven Principles
  - Tier C: Entity Summaries / Curated Context / Experience Warnings auto-surface (high signal)
  - Full LongMemEval Oracle at each tier boundary as smoke alarm only
  - LoCoMo only at umbrella close + Tier B circuit breaker
- **`initialUserMessage` prime** (the verified design from session e0d0a138):
  - Format: `[SYSTEM] Active handoff for current phase: P{N} — {Name}. Read context/handoffs/ACTIVE.md before acting.`
  - Authority: system-role, NOT synthetic user
  - Stale guard: handoff frontmatter `status: active` AND `phase` matches `STATE.md`. No mtime gate.
  - Slash-command skip: REMOVED (unimplementable at SessionStart)
  - Replace with: kill existing auto-`/starthere` behavior in `session-start.ts:333+`
- **Experience-warning trigger** (the verified design):
  - PreToolUse hook with `applies_to_paths` (glob) + `applies_to_commands` (regex) fields per warning
  - Surface at tool-call decision time, not UPS keyword regex
  - Relevance threshold: `helped/total ≥ 0.7` AND `total ≥ 10`
  - Max 1 warning per tool call
  - v1 advisory only; v2 blocking deferred
- **L1..L4 ladder restructure**:
  - Trigger on real signals (cache snapshot diff, token budget violation, BENCH-09 30d median <floor), NOT Oracle/LoCoMo
  - L1 (raise UPS budget): autonomous IF UPS budget split from session-start budget first
  - L2 (keep Entity Summaries): manual review, reset L1's UPS bump
  - L3 (Ghost Code dual-inject): env flag `CLAUDEX_P4_INJECTION_MODE=lean|entity_only|dual`, NOT branch checkout. Compatibility module imports legacy blocks only in `dual` mode. Funeral PR deletes legacy after gate passes.
  - L4 (full revert): only after L3 attribution clearly shows reversion is right call. Define "MEMORY.md curation must show measurable improvement" as a real metric tied to T1's content quality scoring.
  - Pre-land vs post-land split: Oracle/LoCoMo and cache-stability are pre-land gates; BENCH-09 30-day is post-land monitoring with separate incident workflow.
  - L3 attribution: "Recovery Question" diff (lean vs dual), then targeted ablation on subset, revert top 1-2 sections accounting for ≥80% of rescue. Track tool-use count per question to detect "Tool Apathy" vs context need.

### T6 — Phase 9 cognitive-layer deletion risk audit
For each module slated for deletion in Phase 9, sample its current outputs in DB and find consumers:
- `cara-reasoning.ts` — opinions go to `angel_opinions` (legacy view) → who reads them?
- `consolidator.ts::runDreamConsolidation` — dream-extracted patterns → where stored, who reads?
- `pattern-extractor.ts::crystallizePatternToSkill` — crystallized skills → are they consulted?
- `cross-project-consolidator.ts`, `proactive-curator.ts`, `data-quality.ts`, `autonomous-investigator.ts` — same pattern.

If a deletion target's output is consumed by a path Phase 5 doesn't delete, deletion may break that consumer. If a deletion target's output is consumed only by paths already deleted, deletion is safe (but verify the consumer was actually using it usefully — Phase 4 entity_summary content shows the cognitive layer's output quality is suspect).

### T7 — Phase 11 LoCoMo growth math
Build a per-phase LoCoMo expectation table:
- Phase 5: expected delta = 0pp (verified can't move LoCoMo)
- Phase 6: ?? (retrieval simplification — could go either way)
- Phase 7: ?? (framing rewrite)
- Phase 8: deterministic feature-flag A/B
- Phase 9: ?? (mostly orthogonal but could break if a deleted module fed retrieval)
- Phase 10: ?? (rule lifecycle — minor)

If sum ≠ +8pp (62.3 → 70%+), the roadmap target is unreachable. Either find the source of growth, lower the target, or cut a phase that's dragging.

### T8 — ROADMAP rewrite
After T1-T7, rewrite ROADMAP success criteria for all 11 phases:
- Phase 1: re-confirm or amend after T4 findings
- Phase 2: amend if T3 finds latent issues
- Phase 3: amend with consumer disposition (does it survive Phase 5?)
- Phase 4: insert 4.1 corrective if T1 shows junk content quality
- Phase 5: replace gates with real ones (per T5)
- Phase 6+: redefine each phase's gates in terms of falsifiable claims, not LongMemEval/LoCoMo theater
- Replace "first hard within-2pp LoCoMo gate" framing wherever it appears

### T9 — Phase 4 corrective decision
Decide: amend Phase 4 in place vs Phase 4.1 corrective sub-phase. Pros/cons:
- **In-place amendment**: ROADMAP marks Phase 4 [~] partial-with-followups, points at fix tasks. Smaller scaffold cost. But may lose accountability for "Phase 4 shipped junk."
- **Phase 4.1 corrective**: Insert decimal phase via `/gsd:insert-phase` between Phase 4 and Phase 5. Clean scaffold, explicit corrective work, separate SUMMARY. More structurally honest.

The user's tone ("we cannot allow ourselves such regressions because of our stupidity") suggests structural honesty matters here. Lean toward Phase 4.1.

---

## Decisions captured during 2026-04-27 design discussion

These were locked across gray areas #1-#6 before the audit decision was made. They may be superseded by audit findings, but they're recorded so future-you doesn't redo the codex/gemini consults that surfaced them.

### #1 — Deletion sequencing
**Locked:** 3-tier deletion (A: Flow/Reference/Materialization; B: Predicted/Opinions/Principles; C: Entity-Summaries/Curated/Experience-auto-surface). Full Oracle at each tier boundary. LoCoMo at umbrella close + Tier B circuit breaker. NOT 9 atomic commits (5 days compute is unaffordable) and NOT one big PR (no bisectability).

### #2 — `initialUserMessage` prime
**Locked:** `[SYSTEM]` directive pointer + 1 line phase context. Authority is system-role. Stale guard via `status: active` + `phase` match in handoff frontmatter (no OR with mtime). Slash-command skip REMOVED (unimplementable at SessionStart). Replace with killing existing auto-`/starthere` in `session-start.ts:333+`.

Pre-work surfaced: STATE.md parser must extract phase name, STATE.md content must be fixed (currently split-brain), handoff frontmatter must add canonical `phase` field, telemetry counters `auto_prime_fired` + `auto_prime_skipped_reason`, 9-case test matrix (3 lifecycle × 3 handoff states), prime must NOT count as user turn in BENCH-09, ≤500-token budget must include prime, system prompt must explicitly list `claudex_search`/`recall`/`events` once injection dies.

### #3 — Experience-warning trigger surface
**Locked:** PreToolUse hook with `applies_to_paths` (glob) + `applies_to_commands` (regex) fields per warning. Surface as system-role nudge BEFORE tool runs. Drop UPS keyword regex on prompt text. Relevance threshold `helped/total ≥ 0.7` AND `total ≥ 10`. Max 1 warning per tool call (highest-relevance wins). v1 advisory only; v2 blocking severity deferred.

### #4 — BENCH-09 measurement
**Locked:** Option I (Phase 5 code-complete + 30d soak) + Option X (raise `user_framing` cap from 3 → 30, re-baseline) + Angel daily medians published to `bench09_daily.jsonl` for early-warning. The per-session cap conflict with the threshold makes the current baseline invalid; cap must change OR threshold must change. Cap-raise wins (3 was arbitrary, no rationale).

### #5 — Cache-stability verification
**Locked:** 3-layer gate (golden snapshot + invariance test mutating volatile state + token count ≤500). Hook-output only — gate the boundary you own (codex was right, gemini's "full prefix" point is true at cache-physics level but unverifiable in our CI). 9 lifecycle scenarios as the corpus matrix; edge cases (CRLF/LF mixed, missing MEMORY.md, very long CLAUDE.md) become invariance tests not corpus rows. Every-PR gate + nightly OS matrix. Telemetry hash log to detect drift in production (Angel-published, defer to Phase 6).

Pre-work hardening list (must land before deletion): clock leaks, session-ID strip, host-env normalization, stable tiebreakers, text normalizer + `.gitattributes * text eol=lf`, path corrections in CONTEXT.md.

### #6 — Fallback ladder execution
**Locked:** Pre-land vs post-land split (Oracle/LoCoMo + cache = pre-land gates; BENCH-09 30d = ops monitoring, not release ladder). L1 autonomous IF UPS budget split from session-start budget first. No stacking between rungs (each rung resets state to frozen P4 candidate SHA, NOT main). L3 mechanism: env flag `CLAUDEX_P4_INJECTION_MODE=lean|entity_only|dual` ("Ghost Code" pattern). Funeral PR deletes legacy after gate passes. L3 attribution via Recovery-Question diff → targeted ablation on subset, revert top 1-2 sections (≥80% rescue). Track `tool_use_count` per question to detect Tool Apathy. L4 "MEMORY.md curation must show measurable improvement" operationalized as MCP search invocation rate + content-quality score (per T1 audit).

---

## Phase-by-phase audit risk map (initial draft — refine with T1-T7)

| Phase | Status | Audit Risk | Key Concern |
|---|---|---|---|
| 1. P0 — Crystallization | ✓ Complete | LOW | PROJECT.md/REQUIREMENTS.md may need amendment after T4 |
| 2. P1 — Artifact unification | ✓ Complete | MEDIUM | V17 idempotency was a Phase 4 inline bugfix; confirm no other latent defects |
| 3. P2 — Directive detector | [~] Partial-B | HIGH | Outputs feed Phase 5 deletion targets — what reads them post-Phase 5? |
| 4. P3 — MEMORY.md curation | ✓ Complete | **CRITICAL** | Visible content-quality regressions in production; PASS theater |
| 5. P4 — Kill legacy injection | ⏸ PAUSED | **CRITICAL** (constructive) | Issues catalogued; replan per T5 |
| 6. P5 — Retrieval simplification | Future | MEDIUM | LoCoMo can validate this, but reranker quality is load-bearing |
| 7. P6 — Framing rewrite | Future | MEDIUM | Hypothesis-test on imperative cues; benchmarks blind to framing |
| 8. P6.5 — RL ablation gate | Future | LOW | Cleanest phase design; deterministic A/B |
| 9. P7 — Angel simplification | Future | HIGH | Aggressive deletion of cognitive layer; needs T6 audit |
| 10. P8 — Rule lifecycle | Future | LOW | Sound design with held-out detector recall sub-gate |
| 11. P9 — Final validation | Future | HIGH | LoCoMo growth path 62.3→70%+ unspecified across phases 5-10 |

---

## Memories saved this session (cross-reference)

These persist to future sessions. Do not re-establish; build on them.

1. **`feedback_design_consult_pattern.md`** — For non-trivial design decisions, spawn codex + gemini in parallel via Agent subagents (Bash background kills codex on Windows per `~/.claude/docs/codex.md`). Synthesize their input with own analysis. Bring unified proposal to user. User decides. They are advisors, not deciders.

2. **`feedback_benchmarks_are_sanity_not_gates.md`** — Don't center benchmarks (LongMemEval/LoCoMo/BENCH-09) as primary success gates for v4. They're proxies. Real gates are correctness invariants + behavioral soak + Vesna.

3. **`project_v4_trajectory_audit.md`** — Phase 5 paused 2026-04-27. v4 may be regressing real-world quality while reporting benchmark wins. Audit pending across all 11 phases.

---

## What NOT to do next session

1. **Do NOT spawn `/auto-orchestrate` or `/gsd:plan-phase 5`.** Phase 5 is paused. Auto-orchestrate is for after the audit closes and ROADMAP is rewritten.

2. **Do NOT trust phase SUMMARY claims at face value.** Verify against runtime artifacts (MEMORY.md content, DB samples, file inspection). Phase 4 SUMMARY said all PASS while shipping junk content — same skepticism applies to Phase 1, 2, 3 SUMMARYs.

3. **Do NOT chase benchmark numbers as primary success signal.** Per the saved feedback memory, treat them as no-regression sanity checks.

4. **Do NOT delete the existing `auto-gsd-phase5` team yet.** It has CONTEXT.md committed at `d652c08` which may be salvageable post-audit. Leave team config in place; revisit when Phase 5 replan starts in T5.

5. **Do NOT re-derive the design decisions from session e0d0a138.** They're captured in the Phase 5 audit section above (#1-#6). They might be superseded by audit, but they're recorded.

6. **Do NOT amend ROADMAP, STATE.md, or PROJECT.md piecemeal during the audit.** Collect findings across T1-T7, then do a single coherent rewrite at T8. Otherwise the project state thrashes.

---

## Quick verify on session start (mechanical sanity)

```bash
# Confirm STATE.md reflects pause
grep -A1 "Status:" .planning/STATE.md | head -3

# Confirm audit doc exists
ls -la .planning/audits/2026-04-27-v4-trajectory-audit.md

# Confirm ROADMAP still has Phase 5 unstarted (we did NOT advance it)
grep "Phase 5.*Not started\|Phase 5.*0/0" .planning/ROADMAP.md

# Confirm CONTEXT.md still on disk (don't trust its content though)
ls -la .planning/phases/05-p4-kill-legacy-injection-big-benchmark-gate/

# Confirm last 5 commits
git log --oneline -5

# Confirm MEMORY.md content quality issue is reproducible
head -20 ~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/MEMORY.md

# Confirm BENCH-09 contradiction
node -e "const Database=require('better-sqlite3'); const db=new Database(require('os').homedir()+'/.claudex/db/claudex.db',{readonly:true}); const r=db.prepare(\"SELECT COUNT(*) as total, COUNT(DISTINCT session_id) as sessions, MAX(cnt) as maxcnt FROM (SELECT COUNT(*) as cnt, session_id FROM session_events WHERE event_type='user_framing' GROUP BY session_id)\").get(); console.log(JSON.stringify(r));"
# Expected: maxcnt=3 (cap at lifecycle.ts:978), total ~1065, sessions ~726
```

---

## Why this matters (closing context for the next session)

The user's exact framing for this audit was: *"This is very sensitive work we cannot allow ourselves such regressions because of our stupidity! It is not too late to take the right approach and put the v4 on the better road than it is!"*

That language matters. We're not doing a routine retrospective. We're doing course-correction on a system that was about to ship Phase 5 against gates that don't measure Phase 5, while the prior phase shipped flagship content visibly broken in production.

The work is sensitive because:
- v4 is mostly *already* deleting things. Each phase reduces capacity. If quality regressions ride along under the cover of benchmark-PASS theater, the cumulative damage compounds across phases 4-11.
- Memory systems are insidious: a quality regression in MEMORY.md won't show up in a single session — it'll show up over months as the agent feels less coherent. By the time you notice subjectively, the regression is baked into a year of session histories.
- The benchmarks-as-gates pattern is seductive because it produces clean numbers. Resisting it requires sustained discipline in the audit and the replan.

**Be honest in this audit.** If something Phase 4 shipped is broken, say so plainly. If a Phase 5-11 plan rests on a hypothesis we can't test, say that. If the "agent thinks again" thesis is unfalsifiable with current instrumentation, name it. The user's directive is for *honest* assessment — not for activity that looks like assessment.

Read this handoff fully on `/starthere`. Read the audit doc at `.planning/audits/2026-04-27-v4-trajectory-audit.md` next. Then begin T1 (MEMORY.md content quality across 5 projects). Don't do anything else until T1 is reported back to the user.

This is the seamless context the user asked for. Good luck.
