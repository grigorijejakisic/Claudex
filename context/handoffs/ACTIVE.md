---
status: active
phase: 4.1
---
# 2026-04-27 — v4 audit closed, ready for Phase 4.1 planning

**What we found:** Trajectory audit (T1-T6) confirmed gate-fit failure — LongMemEval doesn't exercise `assembler.ts`; LoCoMo bypasses session-start; BENCH-09 metric is contaminated (writer = deletion target) and threshold mathematically impossible (cap=3 vs ≥10); Phase 4 shipped MEMORY.md with visible regressions (`entity:-`, `entity:--2--1`, 50% session-IDs as topics, duplicate USER EDITABLE markers, writer reach 2/5 projects pre 04-08 fix). Phase 3 directive_rule has 2 rows in 5+ days, zero consumers. Diagnosis: benchmarks slipped from instruments into product values; nobody caught it because green numbers feel like progress.

**What we decided:** Rebound v4 to 16 phases with 5 new upgrade phases (4.1, 5.5, 6.5, 7.5, 8.5) and Phase 10 promotion (Vesna probe suite as central validation). Goal sharpened: *"agent USES Claudex organically as part of how it works in Claude Code"* — verb-centered, not vibe (canonical example: shadowban-in-Lacuna applies to investigate-another-backend in big-mozzy-v2 without user saying "use claudex"). Benchmarks DROPPED entirely — not gates, not floors, not sanity. Replaced by SC#1 Vesna ≥80%, SC#2 ≤500 token cache-stable, SC#3 MEMORY.md content-quality ≥80%, SC#4 one-turn handoff pickup. Phase 3 + Phase 10 merge (writers ship with consumers); Phase 4 marked `[~]` corrective-pending; Phase 4.1 supersedes its acceptance.

**What's next:** `/gsd:plan-phase 4.1` — MEMORY.md content redesign + Lessons section. Drop `## Entities` + `## Recent Threads`; add `## Lessons` (curated, task-pattern indexed); promote `## User Notes`. Reach 5/5 active projects via Angel heartbeat sweep. Fix writer state-machine duplicate-marker bug. Normalize mixed-precision `created_at_epoch`. Phase 5 paused until 4.1 lands.

**Where to look:**
- `.planning/audits/2026-04-27-v4-proposal.md` — locked rebind proposal, source of truth for the 16-phase plan and SC#1-#4 gates
- `.planning/ROADMAP.md` — rewritten 2026-04-27 with 16 phases
- `.planning/PROJECT.md` — Q5-Q12 audit-driven decisions in Key Decisions table
- `.planning/audits/2026-04-27-v4-trajectory-audit.md` — evidence trail
- Persistent memories: `project_organic_recall_definition.md` (the goal), `feedback_benchmarks_are_sanity_not_gates.md` (benchmarks not used. period.)

**Do NOT:** spawn `/auto-orchestrate` (Phase 5 paused); re-introduce benchmark gates (failure mode the audit caught); trust prior phase SUMMARYs at face value (verify against runtime artifacts).

This handoff is the first instance of the Q11 hybrid format (2-line YAML status header + ADR-style body). Phase 7.5 will lock the writer for this shape; this file serves as a working template until then.
