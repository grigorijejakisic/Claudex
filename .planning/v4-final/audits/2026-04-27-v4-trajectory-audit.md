# v4 Trajectory Audit — Evidence Notes (2026-04-27)

**Status:** Pending. This document is the evidence trail for the audit decided in session e0d0a138 (2026-04-27). It is structured so the next session can pick up without re-deriving findings.

**Audit scope:** All 11 phases. Both **shipped** (1-4) and **planned** (5-11). The instinct that triggered this audit is that v4 may be regressing real-world quality while reporting benchmark wins. Shipped phases must be re-verified against runtime artifacts, not against their SUMMARY.md claims.

---

## Why this audit exists

Three converging observations during the 2026-04-27 Phase 5 design session:

1. **Codex grep verified that benchmarks don't measure assembler changes.**
   - LongMemEval harness uses bespoke `retrieveContext` (`src/benchmark/longmemeval-harness.ts:212`) — no `assembleFullContext`, no MCP `claudex_search`, no production retrieval.
   - LoCoMo harness calls `hybridSearchAsync` (production retrieval) but skips `assembleFullContext` and session-start.
   - **Implication:** Phase 5's ROADMAP gates ("LongMemEval ≥88%, LoCoMo within 2pp") cannot mechanically be moved by the changes Phase 5 makes. The L1..L4 fallback ladder triggers on numbers that won't move.

2. **Codex grep verified that BENCH-09 is contaminated.**
   - `retrieval_events` (the BENCH-09 source table) is written by assembly-time materialization at `src/assembly/assembler.ts:607` and `:1021` via `src/intelligence/retrieval-feedback.ts:182`.
   - The MCP `claudex_search` tool at `src/mcp/recall-server.ts:90` does NOT write to `retrieval_events`.
   - **Implication:** Deleting injection in Phase 5 will mechanically drop BENCH-09 metrics regardless of whether the agent's behavior changes. The metric collapses.
   - Additional: `bench09-baseline.json` defines non-trivial sessions as "≥10 user_framing events," but `recordUserFraming` at `src/adapters/shared/lifecycle.ts:978` caps at 3 per session. **Mathematically impossible threshold.** Live DB confirms: 1065 events across 726 sessions, max 3 per session.

3. **Phase 4's flagship deliverable (MEMORY.md) ships with visible content quality issues.**
   - `entity:-` (literal `"` quote character classified as entity, "trend STRENGTHENING")
   - `entity:--2--1` (shell redirect fragment `" 2>&1` classified as entity)
   - Recent Threads with topic = session ID (`session-e0d0a138 — session e0d0a138`)
   - Stale Handoff section (pointed at completed Phase 4 work for ~17 days post-close until noticed in session e0d0a138)
   - Duplicated `<!-- USER EDITABLE -->` markers (writer corruption)

The Phase 4 SUMMARY claimed PASS on benchmarks. The benchmarks didn't actually test the MEMORY.md feature. The static test suite passed. Live content was junk.

---

## Phase-by-phase audit (initial draft)

This is the audit framework. Specifics need verification next session — quoted line:file references are confidence anchors, not all are independently re-verified yet.

### Phase 1: P0 — Crystallization (shipped 2026-04-19)

**Status claim:** Complete.

**Audit risk: LOW.** Just docs. But not zero — the rest of the roadmap is built on its assumptions.

**Verify:**
- Read `.planning/PROJECT.md`. Are the locked Q1-Q4 design decisions still defensible given what we've learned?
- Read `.planning/REQUIREMENTS.md`. Are the requirement IDs (STOR-01..08, EXTR-01..06, INJ-01..07, BENCH-01..09, RETR-01..05, CUR-01..08, FRAM-01..04, LIFE-01..04) coherent with current understanding?
- Were any "stale" `project_curated_context` entries (called out in SC#3) actually flagged before P1 ran?
- Spot-check: did the assumptions about benchmarks being good gates appear in PROJECT.md or REQUIREMENTS.md? If so, those documents need amendment.

### Phase 2: P1 — Artifact table unification (shipped 2026-04-20)

**Status claim:** Complete.

**Audit risk: MEDIUM.** Schema migration shipped, but Phase 4 had to add inline bugfix 04-07 because V17 migration's `initializeSchema` wasn't idempotent and threw on view-indexing. Result: **3.5 days of hook data lost** before the bug was caught (per ACTIVE.md context).

**Implications for Phase 2 audit:**
- Phase 2 SUMMARY presumably said "all tests pass." Tests passed; runtime re-init was broken. Same pattern as Phase 4.
- What other latent defects in V17 migration could be lurking? Has the migration been re-run cleanly on a fresh DB?
- The SQL views (legacy table preservation per SC#3) — are they still in place and returning identical data? Sample queries needed.

**Verify:**
- Run V17 migration from a clean state (or check that `migrations.ts` initialize is now truly idempotent).
- Sample SELECT against each legacy view (`learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`, `artifacts(entity_summary)`) and confirm shape unchanged.
- DB backup `~/.claudex/backups/pre-v4-P1-1776681458021.db` — confirm exists and restorable.

### Phase 3: P2 — Directive detector (partial-ship B, 2026-04-22)

**Status claim:** Partial-with-followups. Joint=0.50 (target 0.70). The `negation_dont` family follow-up deferred to Phase 10.

**Audit risk: HIGH.** This phase ships outputs (`directive_rule` artifacts) that **feed the injection sections being deleted in Phase 5**. After Phase 5, what consumes them?

**Specific concerns:**
- Phase 3 SC#3 says "no injection-path changes" — outputs go to artifact table. Where in the assembler are `directive_rule` rows surfaced?
- If they're surfaced in Experience Warnings auto-surface (Phase 5 deletion target) or Curated Context (Phase 5 deletion target), then Phase 3's output stream is orphaned post-Phase 5. The detector keeps running, writes rows, nobody reads them.
- This means Phase 3 was either (a) work for v3 that v4 is killing, or (b) work for v4 whose consumer was supposed to be MEMORY.md or a Phase 7 advisory surface. Which is it? Is it documented?
- Real-world quality of the rules: are sample `directive_rule` rows actually useful, or noise?

**Verify next session:**
```sql
-- Sample directive_rule artifacts
SELECT id, scope, content, created_at FROM artifacts WHERE kind='directive_rule' ORDER BY created_at DESC LIMIT 20;
-- Count by scope
SELECT scope, COUNT(*) FROM artifacts WHERE kind='directive_rule' GROUP BY scope;
-- What reads them? Grep:
-- grep -rn "kind = 'directive_rule'\|kind='directive_rule'" src/
```

If the answer is "nothing reads them post-Phase 5," then Phase 3 needs a Phase 5+ consumer or its outputs become dead data.

### Phase 4: P3 — MEMORY.md curation + auto-dream guard (shipped 2026-04-26)

**Status claim:** Complete. All gates PASS (LongMemEval 89.6%, LoCoMo 62.3%, soak 8/8).

**Audit risk: CRITICAL.** This is the phase with the most damning evidence already gathered.

**Direct evidence of content-quality regressions (visible right now):**
- `entity:-` parsing bug (entity literally a quote character)
- `entity:--2--1` parsing bug (shell redirect fragment classified as entity)
- `Recent Threads` with topic = session ID (zero info transferred to agent)
- Handoff section drifts stale post-close (was 17 days stale at session-start until 2026-04-27 noticed)
- Duplicated `<!-- USER EDITABLE -->` markers — writer is producing corrupted file structure

**Three inline bugfixes shipped** (04-06, 04-07, 04-08) because static tests passed while live was broken. The most damning is **04-08**: memory-md-writer project ID resolution was wrong on Windows, so **CLAUDEXv3 itself had a 17-day-stale MEMORY.md** during Phase 4. The writer wasn't writing.

**Validation theater:**
- Phase 4 PASS on LongMemEval = retrieval quality on fixed corpus. Doesn't test MEMORY.md.
- Phase 4 PASS on LoCoMo = same.
- Phase 4 PASS on soak = mechanical "did MEMORY.md materialize?" Doesn't test content quality.
- Phase 4 PASS on 2577/2597 tests = static. Doesn't test live-fire output.
- **None of the gates measured the actual quality of what shipped.**

**What probably needs to happen:**
- Phase 4 should be re-opened or amended (likely a Phase 4.1 corrective). Specifically:
  - Fix entity parser (filter out non-word entities, stripping shell-character noise)
  - Fix Recent Threads topic generation (LLM-segment first turn or reject if topic is just session ID)
  - Fix Handoff section staleness (write-time check that handoff `updated_at` is reasonable, or read content and refresh from active handoff at write time)
  - Fix duplicated user-editable marker (writer state machine bug)
- Add a content-quality gate (manual inspection at minimum) before any phase relies on MEMORY.md as a load-bearing surface.
- Document which content quality issues are tolerable noise vs deal-breakers.

**Verify next session:**
- Read MEMORY.md across 4-5 active CC projects (claudex-v3, lacuna-betting-9f1d552c, oracle-3951898e, desktop-01dcc792, nexus-e53c6c93) and tabulate content quality issues.
- Sample `entity_summary` artifacts in DB to find the parsing bug source. Likely in pattern extraction or entity recognition.
- Check writer logic for duplicated marker bug (`src/angel/memory-md-writer.ts`).
- Inspect Recent Threads generation — what's the topic-extraction pipeline?

### Phase 5: P4 — Kill legacy injection (PAUSED 2026-04-27)

**Status claim:** Not started. Discuss step ran 2026-04-27, CONTEXT.md was committed, but planning paused after gating-story problems surfaced.

**Audit risk: CRITICAL — but constructive.** We have an exhaustive list of issues from the design discussion. This is fixable; it just needs the audit completed first.

**Issues raised during 2026-04-27 design discussion (to be addressed in replan):**

1. **Wrong-fit gates.** ROADMAP "first hard within-2pp LoCoMo gate" can't move because LoCoMo doesn't exercise the assembler. Replace with: token budget ≤500, cache-stability snapshot+invariance, BENCH-09 (fixed metric).
2. **Path bug in CONTEXT.md.** discuss-5 wrote `.planning/handoffs/ACTIVE.md` in places (handoff is at `context/handoffs/ACTIVE.md`) and `src/intelligence/assembler.ts` (assembler is at `src/assembly/assembler.ts`).
3. **Slash-command-skip in `initialUserMessage` is unimplementable** at SessionStart because there's no first-user-message field in the hook payload. Replace condition with kill-existing-auto-`/starthere` behavior in `session-start.ts:333+`.
4. **Synthetic user-message authority** — current `session-start.ts:353-369` extracts handoff priorities and injects as a synthetic user instruction. That's prompt injection from disk with user-role authority. Must be `[SYSTEM]` role + pointer-only (no extracted summary).
5. **Cache-busting leaks in surviving code (must fix before deletion):**
   - Clock leaks: `assembler.ts:572` (`Date.now()` filter), `:657` (`last 24h` fallback), `:447` (`unixepoch() - 604800`)
   - Session-ID leaks: `sections.ts:859` (`session abcdefgh`), `:1005` (`source_session_id` in curated)
   - Host-env leaks: `sections.ts:635` (reads `~/.claude/CLAUDE.md`), `assembler.ts:646` (uses `path.sep`)
   - Partial orderings (silent churn): `learnings.ts:60`, `artifacts.ts:178/212`, `codebase-indexer.ts:306`, `state-reader.ts:109`
6. **STATE.md parser broken.** `src/gsd/state-reader.ts:61-69` extracts numeric phase only, not phase name. STATE.md content itself is split-brain (line 8 says Phase 4/P3, lines 12-13 say Phase 5/P4).
7. **Handoff frontmatter spec missing.** No canonical `phase` field, only `handoff_id` slug. Need explicit `phase:` and a clean `status: active`.
8. **BENCH-09 cap ↔ threshold contradiction** (see "Why this audit" #2 above).
9. **L1..L4 fallback ladder triggers on benchmarks that can't move** (see "Why this audit" #1 above). Restructure ladder around real signals.
10. **Tool Apathy failure mode** (gemini's catch): if post-deletion sessions show low tool calls, the fix isn't reverting code — it's a system-prompt intervention. Telemetry must distinguish "agent didn't pull because nothing was relevant" vs "agent didn't pull because lazy."

**Decisions locked during the design discussion (now potentially superseded by audit, but document them):**

| Area | Locked | Notes |
|---|---|---|
| #1 Sequencing | 3-tier deletion (Tier A: Flow/Reference/Materialization; Tier B: Predicted/Angel-Opinions/Proven-Principles; Tier C: Entity-Summaries/Curated/Experience-auto-surface) with full Oracle at each tier; LoCoMo only at umbrella close + Tier B circuit breaker | Tiers may need rethink if Phase 3 detector outputs need preservation |
| #2 Prime | `[SYSTEM]` directive pointer + 1 line phase context, gated on `status: active` + phase match in handoff frontmatter, no slash-command skip, kill existing auto-`/starthere` | Pre-work: STATE.md parser, handoff frontmatter spec |
| #3 Warnings | PreToolUse hook with `applies_to_paths`/`applies_to_commands` fields; relevance threshold helped/total ≥0.7 AND total ≥10; max 1 warning per tool call; v1 advisory only | Drop UPS keyword regex |
| #4 BENCH-09 | Option I (code-complete + 30d soak) + Option X (raise user_framing cap from 3 to 30, re-baseline) + Angel daily medians to `bench09_daily.jsonl` | Metric is the gate |
| #5 Cache-stability | 3-layer gate (snapshot + invariance + token-count, hook-output only) over 9 lifecycle scenarios; every-PR + nightly OS matrix | Pre-work hardening list above |
| #6 Fallback ladder | "Ghost Code" pattern for L3 (env flag `CLAUDEX_P4_INJECTION_MODE=lean\|entity_only\|dual`, NOT branch checkout), Recovery-Question attribution (not full ablation), no stacking between rungs, L1 autonomous IF UPS budget split first, pre-land vs post-land split | Triggers need restructure post-audit |

### Phase 6: P5 — Retrieval simplification (planned)

**Audit risk: MEDIUM.** This is the one phase whose gating actually works as currently specified — LoCoMo DOES exercise `hybridSearchAsync` (the function Phase 6 simplifies). So LoCoMo regression is a real signal here.

**But:**
- "Let the reranker do the work" assumes BGE-reranker-v2-m3 is high quality. CLAUDE.md confirms it's the load-bearing piece. But: has reranker quality been independently measured? Per CLAUDE.md, the bi-encoder fallback exists (snowflake-arctic-embed2) — what happens when reranker is down?
- Phase 6 deletes the 6-multiplier chain (`retrieval_multiplier × novelty × activation × q_value × ...`). Were any of those multipliers actually doing something? E.g., novelty signal might have been compensating for a reranker weakness.
- Without per-multiplier ablation, we don't know which to keep. Phase 8 (RL ablation gate) does ablation for the RL stack but not for the other multipliers.

**Verify next session:**
- Sample retrieval results pre-multiplier-deletion vs post (synthetic test). What changes?
- Does the reranker handle pure FTS5+vec0 RRF input as well as it handles the 6-multiplier-output input?
- Is there a quality regression that LoCoMo catches but Vesna-style probes don't, or vice versa?

### Phase 7: P6 — Framing rewrite (planned)

**Audit risk: MEDIUM.** Strip imperative voice ("WARNING:", "Correct approach:", "Apply them proactively") in favor of advisory ("Similar prior situation: user wanted Y; outcome was Z").

**Concerns:**
- SC#5 admits this is hypothesis-test: "if frame rewrite drops scores, models were leveraging imperative cues and mitigation needed." But: benchmarks don't test the framing path well (same problem as Phase 5). How do we know if it dropped behavior in real use?
- Subjective: when the agent reads "Correct approach: Always X" vs "Similar prior situation, user wanted X" — does behavior actually shift? This is a prompt-engineering question that probably needs subjective AB testing on real sessions, not benchmark numbers.

**Verify next session:**
- What benchmark would show framing impact? If none, Phase 7 needs a different gate (subjective AB, ratings, real-world soak comparison).

### Phase 8: P6.5 — RL ablation gate (planned)

**Audit risk: LOW.** This is the cleanest phase design in the whole roadmap. Feature flag, A/B LoCoMo, deterministic decision. **Best phase in the plan.**

**One caveat:**
- The decision is binary (ship RL deletion or not) based on whether flagged LoCoMo within -2pp. What if it's exactly at -2pp? Define edge cases.
- Decision feeds Phase 9.8 conditional. Make sure Phase 9 plan reads the decision correctly.

### Phase 9: P7 — Angel simplification (planned)

**Audit risk: HIGH.** Aggressive deletion — ~3000-4000 LOC. Modules being deleted:
- `cara-reasoning.ts` (CARA opinion formation)
- `autonomous-investigator.ts`
- `consolidator.ts::runDreamConsolidation` (dream cycle)
- `pattern-extractor.ts::crystallizePatternToSkill` (skill crystallization)
- `cross-project-consolidator.ts`
- `proactive-curator.ts`
- `data-quality.ts`
- Conditional: RL stack (`retrieval-rl.ts`, `memrl-scorer.ts`, `rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`, `policy-registry.ts`, `policy_weights` table)

**Concerns:**
- These modules were doing *something*. CARA forms opinions, dreams extract patterns, skill crystallizer turns repeated patterns into reusable skills. Phase 9 trusts that MEMORY.md + retrieval is sufficient replacement. **Same trust assumption as Phase 5.**
- Phase 4's MEMORY.md content quality is junk (visible). Deleting the cognitive layer that *generated* curatable content is a leap of faith. Where does future MEMORY.md content come from after CARA/dream are dead?
- "Heartbeat tick count drops from ~20 phases to ~8" — 12 phases worth of cognitive work being deleted. The risk isn't the LOC delete; it's the cognitive capacity loss.

**Verify next session:**
- What does each module currently produce? Sample artifact tables for outputs of each.
- Is any of that output being read post-Phase 5? (Same question as directive detector in Phase 3.)
- If Phase 9 lands and the content quality of MEMORY.md doesn't improve, what's the fallback? Phase 11 has BENCH-09 as the falsification check, but BENCH-09 is contaminated.

### Phase 10: P8 — Rule lifecycle (planned)

**Audit risk: LOW.** Sound design. Sub-gate on detector recall ≥0.85 target / 0.70 floor. Held-out fixture. Honest gate.

**One concern:** Confidence decay sweep daily. If detector quality drifts (which it will if input distribution drifts), decay rate compounds. Need monitoring.

### Phase 11: P9 — Final validation + cleanup (planned)

**Audit risk: HIGH.** This is where the roadmap's gating story comes due.

**The unaccounted growth:**
- LoCoMo target: ≥70% (stretch ≥80%). Current: 62.3%.
- BENCH-09 target: ≥2× baseline (current baseline: 1, target: 2).
- The roadmap doesn't explicitly say which phases drive LoCoMo growth from 62.3 to 70%+. Phase 5 (verified can't move LoCoMo). Phase 6 might (retrieval simplification) but could go either way. Phase 7 could go either way. Phase 9 deletes cognitive layer — likely flat or down.
- **Where does the growth come from?** If it doesn't, Phase 11 will fail-to-tag.

**Vesna smoke check:** "fresh session, claudex_search('Vesna') returns entity_summary in rank 1-3 without filesystem exploration." Reduced from ship-blocking to smoke check. **But Vesna IS the actual quality signal** per session e0d0a138 reframe (benchmarks are sanity, behavioral observation + Vesna are the real signal). Re-elevating Vesna may be appropriate.

**Verify next session:**
- Is there a phase-by-phase LoCoMo expectation table somewhere? If not, build one — even if it's just "Phase 5: 0pp; Phase 6: +Xpp; Phase 7: 0±Ypp; Phase 8: deterministic; Phase 9: -Z to +0pp; Phase 10: 0pp."
- If the math doesn't reach 70% by Phase 11, the roadmap needs amendment now, not at Phase 11 close.

---

## Audit working tasks (priority-ordered, for next session)

**T1 — MEMORY.md content quality audit across 5 active projects.** READ 5 MEMORY.md files. Tabulate parsing bugs, useless threads, stale handoffs, duplicate markers. Score each on usefulness 0-3 (3=helpful, 0=junk).

**T2 — Directive detector (Phase 3) consumer audit.** Sample `directive_rule` artifacts. Find every site in `src/` that reads them. Determine which sites are deleted by Phase 5 vs preserved. Identify any orphan-output risk.

**T3 — Phase 2 V17 migration soundness.** Verify idempotency on clean state. Sample legacy SQL views. Compare against pre-migration backup if accessible.

**T4 — Phase 1 docs sanity.** Read PROJECT.md and REQUIREMENTS.md. Identify any assumption that's been falsified by what we've learned. Mark for amendment.

**T5 — Phase 5 replan.** With audit findings in hand, rewrite Phase 5 plan: real gates (correctness + soak + Vesna), pre-work hardening list (clock leaks, session-ID strips, host-env, orderings, normalizer), tier-based deletion, BENCH-09 cap fix, L1..L4 ladder restructured.

**T6 — Phase 9 cognitive-layer deletion risk audit.** For each of CARA, dream, skill crystallizer, consolidator, etc., sample their outputs. Find consumers. Decide deletion order (or whether to defer some).

**T7 — Phase 11 LoCoMo growth math.** Build the per-phase LoCoMo expectation table. If math doesn't reach target, amend ROADMAP.

**T8 — ROADMAP rewrite.** After T1-T7, rewrite ROADMAP success criteria to use real gates throughout. Update STATE.md to reflect rewrites.

**T9 — Phase 4 corrective.** Decide: amend Phase 4 in place vs Phase 4.1 corrective phase. Either way, fix the entity parser, thread topics, handoff staleness, and duplicate-marker bugs.

---

## What NOT to do next session

- Do NOT spawn auto-orchestrate. Phase 5 is paused. Auto-orchestrate is for after the audit closes.
- Do NOT trust phase SUMMARY claims at face value. Verify against runtime artifacts (MEMORY.md content, DB samples, etc.).
- Do NOT chase benchmark numbers as primary success signal (per `feedback_benchmarks_are_sanity_not_gates.md`).
- Do NOT delete the existing `auto-gsd-phase5` team yet — it has CONTEXT.md committed at d652c08 which is salvageable post-audit.
- Do NOT re-derive the design decisions from session e0d0a138 — they're captured in the Phase 5 audit section above. They might be superseded by the audit, but they're recorded so future you doesn't have to redo the codex/gemini consults.

---

## Reference: design-consult workflow rule

Established 2026-04-27 in session e0d0a138, saved as `feedback_design_consult_pattern.md`. For non-trivial design decisions: spawn codex + gemini in parallel via Agent subagents (Bash background kills codex on Windows — see `~/.claude/docs/codex.md`). Synthesize their input with own analysis. Present unified proposal to user. User decides. Codex is stronger on codebase-grounded correctness; gemini stronger on prompt-design fundamentals; user is the only one with project intent.

This pattern was load-bearing in surfacing the Phase 5 issues. It's the workflow for the audit too — for any genuinely uncertain design call (e.g., "is module X really safe to delete?"), use the consult pattern.
