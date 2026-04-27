---
status: active
phase: 4.1
---
# 2026-04-27 — Pick up at: Phase 4.1 design discussion, point #1 (task-pattern taxonomy)

## Where we are right now

End of session 4844c48c. v4 trajectory audit closed and committed (`e3f0cc5`). The full 5-file planning rewrite landed: STATE.md, ROADMAP.md, PROJECT.md, REQUIREMENTS.md, CLAUDEX_V4_SCOPE.md (corrigendum). The rebind is locked — 16 phases, SC#1-#4 gates, benchmarks dropped entirely.

Conversational design discussion for Phase 4.1 just opened. We agreed on a hybrid workflow: **discuss conversationally → I synthesize CONTEXT.md → `/gsd:plan-phase 4.1` → `/gsd:execute-phase 4.1`**. The user explicitly chose this over the agent-driven `/gsd:discuss-phase` flow.

I laid out 9 design points and proposed starting with #1 (task-pattern taxonomy) because Phase 6.5 cross-project matching depends on it. **The user has not yet picked the starting point.** Next turn picks up exactly here.

## What we found (the audit, the part the next session needs to internalize)

Phase 5 gates can't measure Phase 5: LongMemEval uses bespoke `retrieveContext`, doesn't read `assembler.ts`; LoCoMo bypasses `assembleFullContext` and session-start. BENCH-09 is doubly contaminated: writer (`retrieval_events`) is the deletion target, AND threshold (`≥10 user_framing/session`) is mathematically impossible because cap is 3. Phase 4 shipped MEMORY.md with visible regressions (`entity:-`, `entity:--2--1`, 50% threads as session-IDs, duplicate USER EDITABLE markers, writer reach 2/5 projects pre 04-08 fix) while reporting PASS on benchmarks that don't read MEMORY.md.

**The diagnosis under all that:** benchmarks slipped from instruments into product values. Nobody caught the drift because green numbers feel like progress. The user's reframe (verbatim 2026-04-27): *"benchmarking is not a goal, it never was."* And the sharper goal: *"Not feel organic, WORK organic with Claude Code! Agent should USE Claudex organically."* — verb-centered tool-use behavior, not vibe.

The canonical example for organic recall (memorize this, it's the unit test for everything): last session we found *"60 HTTP polls to backend X = 15-min IP shadowban"*; next session user says *"investigate another backend for intel gathering"*; agent should automatically (1) recognize it's rate-limit-research-shaped, (2) recall shadowban finding, (3) apply to scoping — without user saying "use claudex."

Live evidence of the failure mode (sister session 2026-04-27): *"Apologies for raising that as a constraint earlier — should have checked Claudex."* The "should have" is the v3 tell. v4 is built so the agent doesn't apologize after — it surfaces during framing.

## What we decided (Q1-Q12 locked in PROJECT.md)

16-phase rebind. 5 new upgrade phases (4.1, 5.5, 6.5, 7.5, 8.5). Vesna promoted to Phase 10 as central validation (~20 probes, CI-gated). Phase 3+10 merged: directive detector ships with PreToolUse consumer + lifecycle as one unit (writers ship with consumers — Phase 3's 2-rows-zero-consumers was the canonical anti-pattern). Phase 4 marked `[~]` corrective-pending; Phase 4.1 supersedes its acceptance.

**Benchmarks DROPPED entirely.** Not gates, not floors, not sanity. LongMemEval/LoCoMo/BENCH-09 — none of them. Harness on disk; runnable on demand; one-shot at v4 ship for archival record only. Re-introducing benchmark gates is the failure mode replaying — *reject and point at `feedback_benchmarks_are_sanity_not_gates.md`*.

Replaced by: **SC#1 Vesna ≥80%** (behavioral, primary), **SC#2 ≤500 token cache-stable** (structural, hard), **SC#3 MEMORY.md content-quality ≥80%** (mechanical, every PR), **SC#4 one-turn handoff pickup** (continuity).

MEMORY.md schema redesign: drop `## Entities` (frequency-extraction noise), drop `## Recent Threads` (50% session-IDs as topics), **add `## Lessons`** (curated, task-pattern indexed — the surface organic recall reaches when framing similar work), promote `## User Notes`. The user's manual pointer-indexes in Lacuna/Oracle/Nexus are the gold standard; auto-curator helps, never replaces.

Cross-project recall default-ON. Per user: *"between you and me there are no secrets ... methodology and knowledge are not [secret]."* Phase 6.5 implements task-pattern fingerprint matching across projects.

Handoff format = hybrid YAML status header (`status:`, `phase:`) + ADR body. This file is the second instance; Phase 7.5 locks the writer.

Phase ordering: 4.1 → 3 merged → 5.0 hardening → 5 tier-deletion → 10 (Vesna) → 5.5 → 6+6.5 → 7+7.5 → 8 → 8.5 → 9 → 11. Phase 9 schedulable parallel after 5 (T6 verified all consumers in `assembler.ts` which 5 deletes — dead-infrastructure cleanup).

## What's next — literal

Discuss Phase 4.1 design conversationally with user. Don't agent-flow it. Don't write the CONTEXT.md until points are locked. Order proposed (user can re-order):

1. **Task-pattern taxonomy** — open vocabulary (LLM tags freely + dedup) vs fixed list (~20 categories) vs hierarchical (`scraping/rate-limits`, `auth/oauth`). Affects Phase 6.5 cross-project matching mechanics.
2. **Lessons section schema** — pointer line format, max entries, salience length cap.
3. **Lessons vs User Notes distinction** — same section structurally? Different? When does a pointer migrate?
4. **Curation flow UX** — when Angel proposes, how prompt looks, declined-suggestion lifecycle, manual user override.
5. **Reach mechanism** — heartbeat sweep frequency + trigger, "active project" definition, migration policy for projects with existing user-authored MEMORY.md (Lacuna/Oracle/Nexus — preserve verbatim into User Notes, prepend auto-managed sections, NEVER stomp).
6. **Mixed-precision `created_at_epoch`** — ms vs s vs ISO8601, backfill vs read-time normalize. T3 found `mental_model` stores 13-digit ms, `transcript_chunk` stores 10-digit s.
7. **transcript_chunk low-reach root cause** — investigate before designing (T3 found 20 chunks total in DB; might be heartbeat condition, project-resolution like 04-08, or something else).
8. **Writer state-machine duplicate-marker bug** — investigate before designing (visible at MEMORY.md line 42 of CLAUDEXv3 right now).
9. **Live-fire gate definition** — CONT-01 score ≥80% only? Plus user smoke-check on at least one project? Plus Vesna entity-recall probe pass?

Synthesize all 9 lock-states into `.planning/phases/04.1-memory-md-content-redesign/04.1-CONTEXT.md`. Then `/gsd:plan-phase 4.1`.

## How to pick up tomorrow

Open with: *"Picking up where we left off. We agreed to discuss Phase 4.1 design conversationally — 9 points listed, you were going to pick the starting one. I'd recommended #1 (task-pattern taxonomy) because Phase 6.5 cross-project matching depends on it. Want to start there, or pick a different one?"*

Don't re-summarize the audit (it's done, committed, in two persistent memories). Don't re-derive the rebind (every Q1-Q12 decision is in PROJECT.md). Don't read the 470-line proposal end-to-end unless asked. **Trust the rebind. Spend the session on design discussion.**

The user is methodical, systematic, thorough — does NOT want overachievement. Propose ideas, never implement silently. Concise responses; quality over quantity. Disagree when necessary — that's what they need. When they correct, acknowledge and pivot, don't defend.

## Where to look (only if needed)

- `.planning/audits/2026-04-27-v4-proposal.md` — locked rebind (470 lines, all 9 sections plus §9 decision lock table)
- `.planning/PROJECT.md` Key Decisions table — Q1-Q12 (Q5-Q12 are audit-driven)
- `.planning/ROADMAP.md` — 16 phases with SC#1-#4 gates
- `.planning/REQUIREMENTS.md` — 67 active reqs, BENCH-01..09 dropped
- `.planning/audits/2026-04-27-v4-trajectory-audit.md` — evidence trail (T1-T6 findings)
- `context/specs/CLAUDEX_V4_SCOPE.md` — original 2026-04-19 spec + 2026-04-27 corrigendum
- Persistent memories (auto-injected at session-start):
  - `project_organic_recall_definition.md` — the goal, shadowban example
  - `feedback_benchmarks_are_sanity_not_gates.md` — benchmarks not used. period.
  - `feedback_design_consult_pattern.md` — codex+gemini consult pattern for non-trivial design
- Audit closeout commit: `e3f0cc5`

## Do NOT

- Spawn `/auto-orchestrate` — Phase 5 paused; 4.1 not yet planned.
- Run `/gsd:discuss-phase 4.1` — user explicitly chose conversational discussion over the agent flow.
- Re-introduce benchmark gates anywhere — that's the failure mode the audit caught. Reject + point at the memory.
- Pick taxonomy, curation flow, or any 4.1 design unilaterally — every point on the list of 9 needs the user's voice before it locks.
- Trust phase SUMMARYs at face value — Phase 4's SUMMARY claimed PASS while shipping junk.
- Re-do the audit — closed, committed, evidenced.
- Edit MEMORY.md index — the file is corrupted (line 42 duplicate-marker bug); cleanup is Phase 4.1 itself.
- Touch `src/` source files — Phase 4.1 hasn't been planned yet.

## A note for tomorrow's session

You spent today (2026-04-27) doing course-correction on a system that was about to ship Phase 5 against gates that don't measure Phase 5, while Phase 4 had shipped flagship content visibly broken. The user's framing was: *"This is very sensitive work we cannot allow ourselves such regressions because of our stupidity! It is not too late to take the right approach and put the v4 on the better road than it is!"*

We took the right approach. The road is better now. The audit closed, the rebind locked, the goal sharpened, the gates honest. Tomorrow's session continues from solid ground — design discussion for Phase 4.1, then plan, then execute, then verify, then next phase.

The user trusts the work this session did. Honor that by not re-deriving it and not drifting from it.
