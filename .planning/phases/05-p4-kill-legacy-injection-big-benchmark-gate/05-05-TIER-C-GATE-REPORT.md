# Tier C Gate Report — Final session-start cascade verdict

**Date:** 2026-04-29
**Sections deleted (3):** Entity Summaries auto-surface, Curated Context, Experience Warnings auto-surface
**Commits:**
- `e3e2d84` (Entity Summaries)
- `9db987e` (Curated Context)
- `a66f893` (Experience Warnings auto-surface; renderExperienceWarnings preserved)

## Final Layer 1 — Token budget ≤500 (HARD)

| Scenario | Pre-Phase-5 | Post-Tier-A | Post-Tier-B | Post-Tier-C | ≤500? |
|----------|-------------|-------------|-------------|-------------|-------|
| cold-start | 124 | 124 | 124 | 124 | yes |
| warm-start-with-memory-md | 148 | 148 | 148 | 148 | yes |
| handoff-start | 145 | 145 | 145 | 145 | yes |
| gsd-active-start | 191 | 191 | 191 | 191 | yes |

Same caveat as Tier A/B: fixture cascade tokens didn't shift because empty fixture DBs never traversed content-gated branches at session-start. Production cascade soak (Plan 09) measures live tokens against real DB.

**Strict mode flipped:** `src/tests/assembly/assembler.cache-stability.test.ts` no longer has the `CLAUDEX_P5_TOKEN_GATE_STRICT` env conditional — Layer 1 is hard-asserted. Commit `7b04cce`.

## Layer 2 — Byte-identical across consecutive runs (CACH-01)

All 4 scenarios PASS. 12/12 cache-stability tests green under strict mode.

## Layer 3 — Invariant under volatile mutation (CACH-02)

All 4 scenarios PASS.

## Vesna probe pass-rate

| Category | Pre-Phase-5 | Post-Tier-A | Post-Tier-B | Post-Tier-C |
|----------|-------------|-------------|-------------|-------------|
| perceptual_similarity (proxy) | 100% | 100% | 100% | 100% |

Phase 10 full Vesna suite not yet shipped. Plan 09 will run whatever subset is live.

## MEMORY.md SC#3

Phase 5 doesn't modify MEMORY.md content. No expected change. Plan 09 SC#3 mechanical scorer runs against all 5 active projects.

## Cascade composition (post-Phase-5 surface)

Surviving session-start cascade:

| Section | Notes |
|---------|-------|
| Identity | from `<identityDir>/USER.md` (cache-stable post Plan 01 normalize) |
| claudex_ready | navigation reinforcement (~70 tokens, locked) |
| Project (CLAUDE.md fallback) | only fires if no CLAUDE.md (which CC loads natively) |
| Session Continuity | handoff + latest session log (CACH-03 normalize applied) |
| Checkpoint | from DB |
| learnings | top 5 (cache-stable post Plan 01 tiebreaker) |
| rules_reminder | post-compact only |
| GSD | from STATE.md / ROADMAP.md (CACH-03 parse extension) |
| Codebase Context | session-start only (Plan 06 moves to UPS) |

Total median across fixture scenarios: ~152 tokens. Well under 500-token hard cap.

## Verdict

**PASS** — session-start structural deletion COMPLETE.

Rationale:
- 3 atomic deletion commits + 1 strict-flip commit land cleanly.
- All 12 cache-stability tests green under strict Layer 1.
- 161 assembly tests pass (was 165; 4 deleted curated_context cascade tests are now obsolete — formatter unit tests in `curated-context-section.test.ts` still cover the formatter).
- Vesna proxy unchanged at 100%; SC#3 file content unmodified.
- `renderExperienceWarnings` + `applyEffects` preserved as callable for Plan 08's reactive surface (UPS explicit-query / PreToolUse path/command).
- Imports cleaned: `formatCuratedContextSection` removed (no other consumer).

Cumulative Tier A+B+C deletion impact (assembler.ts code only):
- Tier A: 154 LOC
- Tier B: 127 LOC
- Tier C: 39 LOC + 90 LOC of obsolete assembler tests
- **Total: ~320 LOC removed from assembleFullContext + ~14 LOC cleanup in session-start.ts + 4 obsolete assembler tests**

## Routing

- Plan 06 next: move codebase_index from session-start to UPS turn payload.
- Plans 07-08 next: INJ-06 prime contract + INJ-07 reactive triggers.
- Plan 09: full SC#1-#4 gate aggregator + soak + STATE/ROADMAP update.
