# Active Handoff — claudex-v3 (v4 redesign)

> Commander's intent: user wants the v4 redesign executed via `/auto-orchestrate`. Scope locked, crystallization complete, Phase 2 (P1 — Artifact table unification) is the next step. One human-review todo blocks P1 *execution* (not planning).

## What's Left To Do

1. **Human-review the stale `project_curated_context` entries before P1 migration runs.**
   Markers flagged in STATE.md: `Gemma 4 31B`, `llama-server:8081`, `local llama-server`. These will be imported as `status='stale'` during P1's migration into the unified artifact table; a human decides whether to keep, rewrite, or drop them. Can happen any time before P1 execute (not before P1 plan).

2. **Resume the pipeline: `/auto-orchestrate --from-phase 2`.**
   This spawns a fresh `plan-2` teammate running `/auto-plan-phase 2` against `.planning/ROADMAP.md` Phase 2 (P1 — Artifact table unification). Plan covers the V17 migration + legacy views. Then execute. Then P2 (directive detector) starts.

3. **Subsequent phase sequence** (the big picture — read `ROADMAP.md` for per-phase detail):
   - P2: Directive detector (writes `directive_rule` artifacts).
   - P3: MEMORY.md curation + C2 auto-dream write-guard.
   - **P4: Kill legacy injection** (the big benchmark gate — session-start ≤500 tokens, UPS ≤1KB, cache-stable, `initialUserMessage` prime).
   - P5: Retrieval simplification (kill the 6-multiplier scoring chain).
   - P6: Framing rewrite (all formatters advisory voice).
   - **P6.5: RL ablation gate** (feature-flag, bench-measured go/no-go on RL deletion).
   - P7: Angel simplification (CARA/dream/investigator/crystallizer gone; RL conditional).
   - P8: Rule lifecycle (scope + supersession + decay).
   - P9: Final validation + Vesna test, drop legacy tables, tag v4.

## Context That Won't Be Obvious

- **v4 supersedes v3.5.** The session-49 consolidation spec (`context/specs/CLAUDEX_V3_5_CONSOLIDATION.md`) is archived as prior art. The authoritative scope is `context/specs/CLAUDEX_V4_SCOPE.md`. Memory-as-rules is the diagnosis; advisory/pull is the treatment.
- **Benchmark floors are hard.** LongMemEval Oracle ≥88% (currently 90.6% — never cross the floor). LoCoMo no regression >2pp per phase. Every phase commit includes both scores in the message. Phase reverts on regression.
- **`.planning.archive.2026-04-20/` is the prior "CC Source Upgrades" milestone** — never started, 81 items. Five items merged into v4 (T5, I3, C2, I1, T3 budget). Don't resurrect the rest.
- **Auto-orchestrate's task-list can collide** with my orchestrator-level `TaskCreate` calls — creates "task-list" noise the teammates see as misrouted messages. If resuming, either don't create orchestrator-level tasks OR prefix them so they're obviously out-of-band.
- **crystallizer produced `.planning/` cleanly on second attempt** after a message-delivery race caused it to think it was still waiting. Pattern: when a teammate reports "still blocked" despite your SendMessage succeeding, resend with a `RESEND:` prefix.
- **Team name `auto-gsd-pipeline` is shared** across sessions. If resuming and you see a stale team, clean up with `rm -rf ~/.claude/teams/auto-gsd-pipeline ~/.claude/tasks/auto-gsd-pipeline` before recreating (TeamDelete requires being in-team).
