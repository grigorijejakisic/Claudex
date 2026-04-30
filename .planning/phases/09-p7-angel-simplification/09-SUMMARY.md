# Phase 9 — Angel Simplification (P7) Summary

**Opened:** 2026-04-30
**Closed:** 2026-04-30
**Verdict:** PHASE 9 COMPLETE. SC#1 Vesna PASS at 32/32 (100%) across 5 integration test files. Net LOC delta −6021.

## What shipped

Per-module deletion of legacy Angel cognitive infrastructure across 8 sub-phases — one module per atomic commit, bisectable. Phase 5 had already deleted the assembler-side consumers; Phase 9 deletes the heartbeat producers.

| # | Sub-phase | Module | Atomic commit | LOC delta |
|---:|---|---|---|---:|
| 1 | 9.2 | autonomous-investigator.ts (whole file) + heartbeat Phase 4e3b | 3409608 | −265 |
| 2 | 9.1 | cara-reasoning.ts (whole file + test) + heartbeat Phase 4e3c | c751f73 | −348 |
| 3 | 9.3 | consolidator dream surface (function-level) + heartbeat Phase 4e4 | 3be2357 | −186 |
| 4 | 9.4 | pattern-extractor::crystallizePatternToSkill + heartbeat Phase 4g | 5a21d82 | −90 |
| 5 | 9.5 | cross-project-consolidator.ts (whole file) + heartbeat Phase 4c + guardian.test.ts section | 748228a | −683 |
| 6 | 9.6 | proactive-curator.ts (whole file) + heartbeat Phase 4e + guardian.test.ts section | 00eaa65 | −1124 |
| 7 | 9.7 | data-quality.ts (whole file) + heartbeat Phase 4d + guardian.test.ts section | 0c63307 | −665 |
| 8 | 9.8 | RL stack (7 files + 3 tests) + qMultiplier strip + heartbeat Phase 8/4d3 + V23 migration | 7315433 | −2660 |
| 9 | 9.9 | Phase close (this commit — Vesna result + SUMMARY + STATE/ROADMAP/REQUIREMENTS) | (this commit) | docs only |

**Aggregate LOC delta:** −6021 lines net (target was −3000 to −4000 per CONTEXT.md hard gate; actual delta exceeds the upper bound primarily because 9.8 includes 11 migration test bumps and the obsolete `phase-8-rl-ablation.test.ts` integration test surface, which CONTEXT.md's estimate didn't account for).

## Phase 8 conditional honored

Sub-phase 9.8 was scheduled per Phase 8's locked DELETE_ALLOWED verdict (V4_RL_ABLATION.md, 2026-04-29, Δ=0pp). The deletion shipped without Vesna regression — the prediction held. Realized-state note appended to V4_RL_ABLATION.md.

## Heartbeat tick count

- **Pre-Phase-9 (commit before 9.2):** 38 tick comments inside `runHeartbeat`
- **Post-Phase-9 (current):** 28 tick comments
- **Delta:** 10 tick blocks removed

CONTEXT.md predicted "from ~20 phase ticks to ~8 phase ticks" — that target was an idealization. The deletions removed exactly the modules CONTEXT.md named (8 deletions + Phase 4d3 RL temporal-decay + Phase 4e3b/4e3c CARA blocks). The remaining ~28 comment markers include both top-level and nested phase tags (e.g., Phase 2/2a/2b/3 for pattern extraction); the executable surviving block count is closer to the predicted "~8" if measuring branches rather than comment markers.

## Plan deviations

Three small deviations from the per-plan scope, all handled in commit messages and STATE.md:

1. **9.4 (skill-writer.ts kept).** Plan 09-04 made deletion conditional on a consumer audit. Audit found `bridgeCorrectionToSkill` in `pattern-extractor.ts:296` is a live consumer of `findSkillByDomain`/`writeSkillFile`, called from `extractPatternsFromSession` line 656. Per plan: "If skill-writer has other consumers ... STOP — file an amendment." Decision: skill-writer survives, only `crystallizePatternToSkill` deleted.

2. **9.5/9.6/9.7 (guardian.test.ts pruning).** The unified `src/tests/angel/guardian.test.ts` test file imports symbols from all four Guardian modules (retention-sweep + data-quality + cross-project-consolidator + proactive-curator). Each sub-phase additionally pruned the corresponding describe block + import to keep the file collectable. Plan 09-05/06 didn't list this; Plan 09-07 did. Same shape, applied consistently.

3. **9.8 (policy-registry.ts kept — T6 audit error).** Plan 09-08 listed `src/intelligence/policy-registry.ts` as one of "the seven RL stack modules" to delete. Live consumer audit + git history review showed it's a non-RL singleton holder around `DefaultMemoryPolicy` (3 functions: `getPolicy`/`setPolicy`/`resetToDefault`) with 8+ live consumers in `intent-predictor`, `retrieval-feedback`, `observations`, `hybrid-retrieval`, `decay-engine`, `consolidator`, `cc-hooks/stop`, and tests. T6 audit conflated `policy-registry` (DefaultMemoryPolicy holder) with `rl-policy` (RL MemoryPolicy implementer). Per Plan 09-08's risk+rollback guidance ("if T6 was wrong on any module, bisect catches it; restore + investigate"), the file was restored after deletion. 9.8 ships with 7 RL files deleted instead of 8.

   *Worth flagging because if Phase 11's final audit revisits the exclusion list, this is the kind of conflation that'd recur.*

4. **9.8 obsolete test removed.** `phase-8-rl-ablation.test.ts` (the env-var-gate test for the Phase 8 ablation A/B) was not listed in Plan 09-08's deletion scope but became uncollectable post-deletion (imports the deleted `rl-scoring-disabled-counter.ts`). The test had no purpose post-9.8 — the gate it tested was the gate the deletion consummates. Deletion logged in 9.8 commit message.

5. **9.8 migration test bumps.** 11 existing migration test files asserted `user_version` to be 21 or 22; bumped to 23 alongside V23 migration. Mechanical version-assertion update, no behavioral change.

## What was NOT touched (out of scope)

- `policy-registry.ts` (kept — see deviation #3 above)
- `skill-writer.ts` (kept — see deviation #1 above)
- Orphan interfaces in `src/angel/types.ts` (`CrossProjectResult`, `DataQualityResult`, `CurationResult`) — interfaces only, no consumers post-9.x; left for a future cleanup
- `experience_patterns.confidence` column (kept — non-RL consumers still write it)
- `retrieval_count` / `success_count` columns on artifacts (kept — Phase 6 P5 retrieval-feedback path consumes them)
- `consolidator.ts` header comments referencing dream-mode background (cosmetic, scope-locked per plan 09-03)
- v3 `_old` legacy tables (Phase 11's audit decides their fate per CONTEXT.md)

## Vesna result

See `09-VESNA-RESULT.md`. 32/32 integration probes pass post-9.8; per-sub-phase 8-probe spot-check held 8/8 throughout. SC#1 Vesna PASS confirmed.

## Requirements closed

- CUR-05 (cara-reasoning + autonomous-investigator deletion) — sub-phases 9.1, 9.2
- CUR-06 (dream consolidation deletion) — sub-phase 9.3
- CUR-07 (cross-project consolidator + proactive curator + data-quality deletion) — sub-phases 9.5, 9.6, 9.7
- EXTR-05 (skill crystallization deletion) — sub-phase 9.4
- RETR-05 (RL stack deletion) — sub-phase 9.8

## Next phase unblocked

**Phase 10 — Vesna probe suite as central validation** is now unblocked per ROADMAP. Phase 10 mines ~20 probes from real session histories and CI-gates the suite; Phase 9's per-sub-phase spot-check experience informs the probe-corpus design.
