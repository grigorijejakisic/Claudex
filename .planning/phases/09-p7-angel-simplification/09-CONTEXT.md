# Phase 9: P7 — Angel Simplification (Sub-Phased Per-Module Deletion) — Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Generative axiom:** Dead infrastructure adds maintenance burden and obscures real behavior. T6 audit verified all consumers of these modules are in `assembler.ts` (deleted by Phase 5) — these are dead-code cleanup, not cognitive-capacity cuts.

---

<domain>
## Phase Boundary

This phase delivers three things and only these three things:

1. **Per-module deletion in named sub-phases** (one module per sub-phase, bisectable):
   - 9.1: `cara-reasoning.ts`
   - 9.2: `autonomous-investigator.ts`
   - 9.3: `consolidator.ts::runDreamConsolidation`
   - 9.4: `pattern-extractor.ts::crystallizePatternToSkill`
   - 9.5: `cross-project-consolidator.ts`
   - 9.6: `proactive-curator.ts`
   - 9.7: `data-quality.ts`
   - **9.8 (CONDITIONAL on Phase 8 decision)**: RL stack — `retrieval-rl.ts`, `memrl-scorer.ts`, `rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`, `policy-registry.ts`, `policy_weights` table (V19 migration)
2. **Each sub-phase: delete one module → vitest pass → Vesna probe spot-check → atomic commit.** No grouped deletions — bisectability requires one-module-per-commit discipline.
3. **Heartbeat tick reduction**: from ~20 phases to ~8 phases after all deletions complete.

**Out of scope:**
- Replacement implementations (these modules are dead infra; nothing replaces them)
- Schema migration beyond `policy_weights` drop (other Angel tables stay)
- Any module not listed above (don't expand scope mid-phase)

**Hard gates:**
- Phase 5 must have shipped first (consumers in `assembler.ts` deleted there)
- Phase 8 RL ablation decision must be locked before 9.8 schedules
- Vesna pass rate maintained at SC#1 ≥80% at every sub-phase
- Net LOC delta ~−3000 to −4000 lines (size sanity check; significantly under-deleting suggests scope error)

</domain>

<decisions>
## Implementation Decisions

### Sub-phase execution discipline

Each sub-phase 9.N follows identical pattern:
1. Verify zero current consumers of the module (grep + read assembler.ts post-Phase-5)
2. Delete module file + associated tests
3. Run full vitest suite — must pass
4. Run Vesna probe suite spot-check (minimum 5 probes from each category) — pass rate ≥80%
5. Atomic commit with message `chore(angel): delete <module> (Phase 9.N)`
6. Update STATE.md with sub-phase completion

**No grouped commits.** When 9.3 fails Vesna, bisect to identify whether 9.1, 9.2, or 9.3 caused it. Mega-commit makes this impossible.

### 9.8 conditional logic

- Read `context/specs/V4_RL_ABLATION.md` (created by Phase 8)
- If decision is "delete" (Vesna delta within -2pp): schedule 9.8 after 9.7
- If decision is "keep": skip 9.8 entirely; document in STATE.md
- 9.8 deletion includes: 7 code files + `policy_weights` table drop via new migration step

### Module dependencies (T6-verified)

T6 audit confirmed:
- `cara-reasoning.ts` consumers: only `assembler.ts` Section formatter (Phase 5 deletes)
- `autonomous-investigator.ts` consumers: only heartbeat tick dispatcher (no inbound)
- `consolidator.ts::runDreamConsolidation` consumers: heartbeat tick + experimental skill (Phase 5)
- `pattern-extractor.ts::crystallizePatternToSkill` consumers: heartbeat tick (no inbound)
- `cross-project-consolidator.ts` consumers: heartbeat tick (Phase 6.5 implements cross-project differently — not via this module)
- `proactive-curator.ts` consumers: heartbeat tick (no inbound — Phase 4.1's curator is separate)
- `data-quality.ts` consumers: assembler quality-warning surface (Phase 5 deletes)

If T6 was wrong on any module, bisect catches it; restore + investigate.

### Test deletion

- Each module's associated test file in `src/tests/...` deleted alongside the module
- Tests testing OTHER modules (which incidentally exercise the deleted module) — fix or delete per case
- `bun run test` must pass after every sub-phase

### Heartbeat phase reduction

After all 9.X sub-phases:
- Existing heartbeat: ~20 phase ticks (lifecycle, decay, dream, crystallize, autonomous, cross-project, curator, data-quality, RL trainer, etc.)
- Post-Phase-9: ~8 phase ticks (memory-md write, transcript chunker, vocabulary promote, archive sweep, multi_project_count update, retention sweep, message router, status — planner enumerates final list)

### Vesna probe spot-check per sub-phase

- Minimum 5 probes per sub-phase (not full ~20-probe suite — that runs at phase close)
- Selected to cover: 1 entity recall, 1 constraint recall, 1 handoff pickup, 1 cross-project, 1 lesson application
- Pass rate ≥80% (4 of 5 minimum)
- Full ~20-probe suite runs at end of Phase 9 to confirm no aggregate regression

### Claude's Discretion (planner free to decide)

- Sub-phase scheduling parallel vs serial (recommendation: serial; cheap to do, makes bisect trivial)
- Specific test files to delete vs preserve (planner enumerates per module)
- Migration step number for `policy_weights` drop (next available; planner picks)
- Whether to consolidate trivial deletions (e.g., delete `cara-reasoning.ts` and its 3-line wrapper in same sub-phase) — recommendation: prefer separate commits for any non-trivial wrapper; co-located trivial wrapper OK in same commit

</decisions>

<specifics>
## Specific Ideas

- **Bisectability over speed**: per-module discipline costs ~7-8 commits but makes failure attribution one bisect away. Mega-commit costs "fast" but unbisectable when Vesna fails downstream.
- **Heartbeat tick count is the visible metric**: from ~20 to ~8 is a real signal that infrastructure simplified. Watch this in PR descriptions.
- **9.8 conditional honors Phase 8's evidence**: don't pre-commit to deletion. Phase 8's behavioral evidence drives 9.8.

</specifics>

<deferred>
## Deferred Ideas

- **New Angel cognitive layer** — explicitly NOT replacing the deleted modules; scope is deletion, not redesign
- **Heartbeat tick framework refactor** (e.g., declarative scheduling) — not in 9; might be a future cleanup if heartbeat code reads worse after deletions
- **`autonomous-investigator.ts` revival in different form** — there have been ideas about agent-driven investigation; not 9's concern

</deferred>

<artifacts>
## Reference Artifacts

- `src/angel/cara-reasoning.ts` — 9.1 target
- `src/angel/autonomous-investigator.ts` — 9.2 target
- `src/angel/consolidator.ts` — 9.3 target (specific function)
- `src/angel/pattern-extractor.ts` — 9.4 target (specific function)
- `src/angel/cross-project-consolidator.ts` — 9.5 target
- `src/angel/proactive-curator.ts` — 9.6 target
- `src/core/data-quality.ts` (or wherever it lives — planner verifies path) — 9.7 target
- `src/intelligence/retrieval-rl.ts` and siblings — 9.8 conditional targets
- `context/specs/V4_RL_ABLATION.md` — Phase 8's gate decision
- `.planning/audits/2026-04-27-v4-trajectory-audit.md` — T6 finding (consumer verification)

</artifacts>

---

*Phase: 09-p7-angel-simplification*
*Context gathered: 2026-04-29*
