# Phase 8: P6.5 — RL Ablation Gate — Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Generative axiom:** Decide deletion by behavioral observation, not benchmark. The audit caught Phase 5 about to ship against gates that don't measure shipping; Phase 8 doesn't repeat that pattern at the RL stack level.

---

<domain>
## Phase Boundary

This phase delivers three things and only these three things:

1. **Feature flag `CLAUDEX_DISABLE_RL_SCORING=1`** that bypasses Q-value multipliers in `hybrid-retrieval.ts` and skips `rl-trainer` ticks in heartbeat
2. **A/B Vesna comparison** with flag set vs baseline. Decision committed to `context/specs/V4_RL_ABLATION.md`:
   - If flagged Vesna pass rate ≥ baseline -2pp: Phase 9 clears RL deletion
   - If flagged Vesna drops >2pp: RL is load-bearing — keep stack and adjust scope, OR redesign with simpler learned signal
   - Edge: exactly -2pp → default to "keep RL" (conservative)
3. **Locked decision** in `V4_RL_ABLATION.md` before Phase 9 begins — Phase 9's conditional 9.8 sub-phase reads this decision

**Out of scope:**
- Actual RL stack deletion (that's Phase 9.8, conditional)
- New learned-signal design (only relevant if RL is load-bearing — defer to follow-up phase)
- Benchmark-based RL evaluation (explicitly NOT used — v4 rebind dropped benchmarks)

**Hard gates:**
- A/B run on Vesna probe suite (SC#1 surface)
- Decision must be locked in writing before Phase 9 begins
- No deletion in Phase 8 — only the gate decision

</domain>

<decisions>
## Implementation Decisions

### Feature flag mechanics

- Env var: `CLAUDEX_DISABLE_RL_SCORING=1` enables bypass; absent or `0` keeps current behavior
- Code paths affected:
  - `src/intelligence/hybrid-retrieval.ts` — Q-value multiplier skipped (set to 1.0)
  - `src/angel/heartbeat.ts` — `rl-trainer` tick skipped
  - `src/intelligence/retrieval-rl.ts` — read paths return null/zero contributions when flag set
- Single env-var check, no plumbing through multiple layers; planner picks the cleanest gate point

### A/B execution

- Run Vesna probe suite (~20 probes once Phase 10 ships; minimum 10 probes if 8 lands first) under both conditions:
  - **Baseline (A)**: flag absent, full RL stack active
  - **Flagged (B)**: flag set, RL paths bypassed
- Identical probe set, identical session conditions, identical model
- Run 2-3 trials per condition to control for stochastic variance — report mean + range
- Capture per-category Vesna delta (entity recall, constraint recall, handoff pickup, cross-project, lesson application, self-instrumented) — RL might help one category and hurt another

### Decision criteria (locked)

| Flagged Vesna delta | Decision |
|---|---|
| ≥ baseline -2pp | RL not load-bearing → Phase 9.8 cleared for deletion |
| > baseline -2pp (i.e., flagged drops by more than 2pp) | RL load-bearing → keep stack, document trade-off |
| Exactly at -2pp | Default to KEEP (conservative); document and revisit after Phase 9 |

### Decision committal

- Result written to `context/specs/V4_RL_ABLATION.md` with:
  - Per-condition Vesna pass rate (mean + range)
  - Per-category delta breakdown
  - Decision (delete or keep)
  - If keep: documentation of which categories RL contributes to and why scope wasn't redesigned
- Phase 9 reads this file to determine whether to schedule sub-phase 9.8

### Claude's Discretion (planner free to decide)

- Exact gate point in code for the env-var check (recommendation: at hybrid-retrieval entry + heartbeat tick dispatch)
- Whether to add telemetry counter for flag invocations (recommendation: yes, lightweight, helps verify the gate fires)
- Number of trial runs per condition (recommendation: 3 minimum; planner can extend if variance is high)
- Whether to score per-probe individually for outlier detection (recommendation: yes — one bad probe shouldn't dominate)

</decisions>

<specifics>
## Specific Ideas

- **Behavioral over benchmark**: the v4 rebind explicitly dropped benchmarks. Phase 8 is a behavioral test — does the agent's recall behavior degrade without RL? Not "does the offline metric move."
- **Conservative default at boundary**: exactly -2pp defaults to keep. Not because RL is precious — because reverting a deletion is cheaper than re-implementing if we deleted prematurely.
- **Per-category delta matters**: aggregate Vesna pass rate hides category-specific effects. RL might be neutral on entity recall but load-bearing for cross-project lesson application.

</specifics>

<deferred>
## Deferred Ideas

- **Simpler learned-signal design** to replace RL stack — only relevant if RL is load-bearing AND decision is "redesign with simpler signal"; out of Phase 8 scope (would be a new phase)
- **RL telemetry deep-dive** beyond Vesna A/B — could examine which sessions RL helps in production, but Vesna is the gate
- **Comparing RL contribution before vs after Phase 6's multiplier ablation** — Phase 6 may have already affected RL's apparent contribution; planner notes this as a confound

</deferred>

<artifacts>
## Reference Artifacts

- `src/intelligence/retrieval-rl.ts` — primary RL scoring path
- `src/intelligence/rl-trainer.ts` — RL training loop, gated by flag
- `src/intelligence/hybrid-retrieval.ts` — consumer of Q-values
- `src/angel/heartbeat.ts` — schedules rl-trainer ticks
- `context/specs/V4_RL_ABLATION.md` — decision file (created by this phase)

</artifacts>

---

*Phase: 08-p6.5-rl-ablation-gate*
*Context gathered: 2026-04-29*
