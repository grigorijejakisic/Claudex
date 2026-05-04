---
phase: 05-p4-kill-legacy-injection-big-benchmark-gate
plan: "05"
status: complete
completed: 2026-04-29
---

# Plan 05-05 SUMMARY: Tier C deletion (Entity Summaries + Curated + Experience auto-surface)

## Commits

| # | SHA | Description |
|---|-----|-------------|
| 1 | `e3e2d84` | feat(05): delete Entity Summaries auto-surface (Tier C 1/3) |
| 2 | `9db987e` | feat(05): delete Curated Context (Tier C 2/3) + 4 obsolete cascade tests |
| 3 | `a66f893` | feat(05): delete Experience Warnings auto-surface (Tier C 3/3); renderExperienceWarnings preserved |
| 4 | `7b04cce` | test(05): strict Layer 1 cache-stability gate (≤500 tokens hard) |

## Cumulative Phase 5 deletion impact (Plans 03+04+05)

| Tier | Sections | Lines deleted from assembler.ts |
|------|----------|----------------------------------|
| A (Plan 03) | Flow, Reference, Materialization | 154 |
| B (Plan 04) | Predicted, Opinions, Principles (session-start), project_overview | 127 |
| C (Plan 05) | Entity Summaries, Curated, Experience auto-surface | 39 |
| **Total** | **10 sections** | **~320 LOC** |

Plus: 14 LOC session-start.ts cleanup, 90 LOC obsolete assembler tests removed, 12 LOC strict-flip cleanup in cache-stability test.

## Layer 1 final numbers (cl100k_base)

All 4 scenarios well under 500-token hard cap:
- cold-start = 124
- warm-start-with-memory-md = 148
- handoff-start = 145
- gsd-active-start = 191

Strict mode flipped at end of plan; `CLAUDEX_P5_TOKEN_GATE_STRICT` env flag retired.

## Vesna trajectory (proxy)

| Stage | Pass-rate |
|-------|-----------|
| Pre-Phase-5 baseline | 100% (4/4) |
| Post-Tier-A | 100% |
| Post-Tier-B | 100% |
| Post-Tier-C (final structural) | 100% |

## SC#3 trajectory

Phase 5 doesn't modify MEMORY.md content. Plan 09 mechanical scorer runs against all 5 active projects.

## Final cascade composition (post-Phase-5, fixture)

| Section | Status |
|---------|--------|
| Identity | survives (cache-stable) |
| claudex_ready | survives (locked navigation reinforcement) |
| Project (CLAUDE.md fallback) | survives (CC loads CLAUDE.md natively) |
| Session Continuity | survives (CACH-03 normalize) |
| Checkpoint | survives |
| learnings | survives (Plan 01 tiebreaker) |
| rules_reminder | post-compact only |
| GSD | survives (Plan 01 parser extension) |
| Codebase Context | survives session-start; Plan 06 moves to UPS |

Deleted at session-start (10 sections):
1. Flow (Plan 03)
2. Reference Layer (Plan 03)
3. Materialization (Plan 03)
4. Predicted Context (Plan 04)
5. Angel Opinions (Plan 04)
6. Proven Principles (Plan 04 — UPS retained)
7. project_overview (Plan 04)
8. Entity Summaries auto-surface (Plan 05)
9. Curated Context (Plan 05)
10. Experience Warnings auto-surface (Plan 05 — function preserved for Plan 08)

## Verdict

**PASS** — session-start structural deletion COMPLETE.

Plan 06 next (codebase_index → UPS).
