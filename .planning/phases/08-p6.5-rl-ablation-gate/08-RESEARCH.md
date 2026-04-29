# Phase 8 — Research

**Date:** 2026-04-29
**Mode:** Lightweight — CONTEXT.md already locks decisions; this file maps the
real RL surface and grounds the plan in concrete call sites.

CONTEXT.md cited `src/intelligence/hybrid-retrieval.ts` and `src/intelligence/retrieval-rl.ts`
as the gate points. The codebase scan finds: `hybrid-retrieval.ts` actually lives
at `src/core/hybrid-retrieval.ts` (CONTEXT path is wrong); `retrieval-rl.ts` exists
but its rerank exports are orphaned; the live Q-value path is a different file
(`src/intelligence/memrl-scorer.ts`) feeding the `artifacts.q_value` column.

---

## RL stack — actual call topology (post-Phase 6 consolidation)

### 1. Score consumer (read path) — `src/core/hybrid-retrieval.ts`

The Phase 6 consolidation collapsed the sync/async qMultiplier mismatch. The
single canonical scoring helper is:

- `computeQMultiplier(artifact)` — sections.ts:277
  - Returns `0.5 + (artifact.q_value ?? 0.5)`. Range `[0.55, 1.5]`.
  - One callsite: `computeArtifactScore` line 344, gated by
    `enabled('qvalue')` — i.e., the existing `multiplierFlags.qvalue === false`
    path already collapses it to `1.0`.

This means **the env-var gate in the read path is one line: branch in
`computeQMultiplier` that returns `1.0` when the env flag is set, before the
`q_value` lookup.** Or equivalently, the env-var sets a default
`multiplierFlags.qvalue = false` at the top of `hybridSearchSync` /
`hybridSearchAsync`. Recommended: do it in `computeQMultiplier` itself —
single location, minimum diff, identical semantics for both sync and async.

### 2. Q-value writer (write path) — `src/intelligence/memrl-scorer.ts`

This is the file that actually mutates `artifacts.q_value`. CONTEXT.md does
not mention it but it's load-bearing for the read path. Exports:

- `recordRetrieval` — bumps retrieval_count
- `recordSuccess` / `recordFailure` — EMA-update on q_value
- `propagateQValues` — link-weighted neighbor propagation
- `applyTemporalDecay` — daily decay of stale Q-values
- `processSessionQValues` — session-end batch scorer
- `getQValueMultiplier` — alternate read helper (not the one hybrid-retrieval
  uses; hybrid-retrieval reads `artifact.q_value` directly off the row)

Live callers:
- `src/adapters/cc-hooks/stop.ts:414` — `processSessionQValues` on session end
- `src/angel/heartbeat.ts:1032` — `applyTemporalDecay` once per day

**For the gate:** the env flag should also short-circuit
`processSessionQValues` (no new writes) and `applyTemporalDecay` (no decay).
Otherwise the flag-on run keeps mutating the column it's pretending to ignore,
contaminating subsequent baseline runs.

### 3. Policy trainer (write path) — `src/intelligence/rl-trainer.ts`

Heartbeat block at `src/angel/heartbeat.ts:710-732`. Calls
`trainPolicyBatch(db, project)` only when no other heavy work ran this tick.
Loads/saves an `RLMemoryPolicy` per project. Internally rate-limited (needs
100+ reward signals before it does anything).

**For the gate:** wrap the entire heartbeat block (lines 713-732) in
`if (!process.env.CLAUDEX_DISABLE_RL_SCORING)`. The Phase 8 mandate is "skip
rl-trainer ticks in heartbeat" — this is the single gate that satisfies it.

### 4. Orphaned surface — `src/intelligence/retrieval-rl.ts`

Exports `applyQValueReranking`, `getQValueBoosts`, `computeQValue`,
`updateSessionQValues`. Of these:

- `updateSessionQValues` IS called (`src/adapters/cc-hooks/session-end.ts:62`)
  — writes to `experience_patterns.confidence`, NOT to `artifacts.q_value`.
  This is a separate confidence-blending path; it does not feed the qMultiplier
  the hybrid-retrieval ablation is testing.
- `applyQValueReranking` and `getQValueBoosts` have **zero non-test callers**.
  They are dead exports. Phase 9.8 deletion candidates regardless of Phase 8
  outcome.

**For the gate:** also short-circuit `updateSessionQValues` to keep the test
clean (the confidence blend it does is part of the broader RL stack).

---

## Reference test/probe surface — what we have and what we need

### Phase 6 multiplier-ablation harness (`src/tests/integration/phase-6-multiplier-ablation.test.ts`)

- 11 deterministic in-process probes across 4 flavors: lesson(4), entity(3),
  constraint(2), handoff(2).
- Already wires `multiplierFlags` into `hybridSearchSync`. Drop-in for the
  Phase 8 A/B if we accept its limits.
- **Critical confound** (called out in CONTEXT.md `<deferred>`): every probe
  passes at 100% under the all-disabled flag set, including `qvalue=false`.
  Phase 6 already showed `0pp delta` for qvalue. Re-running the same harness
  is circular. Phase 8 needs a richer set OR a different surface.

### Phase 6.5 cross-project Vesna probes (`phase-6-5-cross-project-vesna.test.ts`)

3 probes — shadowban, auth-token-expiry, schema-migration — that exercise the
*advisory prompt + assembly* pipeline end-to-end. These hit `assembler.ts`
which composes the Experience Tier (`formatExperienceTierSection`), which
calls into the retrieval path. **These probes have non-trivial pass/fail
behavior and exercise the qMultiplier through the full surface.** Phase 8 A/B
candidate.

### Phase 7 advisory-voice probes (`phase-7-advisory-voice.test.ts`)

Formatter-shape probes; do not exercise retrieval. Not useful for Phase 8.

### Phase 7.5 handoff-pickup probes (`phase-7-5-handoff-pickup.test.ts`)

3 handoff schema probes. Exercise the assembly handoff line, not retrieval.
Marginal Phase 8 utility.

### Self-instrumented + cross-project + lesson-application categories from CONTEXT.md

CONTEXT.md asks for per-category breakdown across 6 categories: *entity,
constraint, handoff, cross-project, lesson application, self-instrumented*.
The Phase 6 harness only covers 4 (lesson, entity, constraint, handoff).
Cross-project comes from Phase 6.5 (3 probes); lesson-application overlaps
with the `lesson` flavor in Phase 6; self-instrumented currently has zero
probes.

**Pragmatic minimum for Phase 8 A/B:** Phase 6 harness (11 probes, 4
flavors) + Phase 6.5 cross-project (3 probes, 1 flavor) = **14 probes
across 5 of 6 CONTEXT.md categories.** The self-instrumented gap is real but
Phase 10's full ~20-probe suite hasn't shipped — CONTEXT.md explicitly accepts
"minimum 10 probes from existing test files." 14 > 10; lesson-application
overlap with `lesson` flavor is acceptable.

---

## Decision criteria — corner cases the planner needs to honor

CONTEXT.md locks the threshold at **-2pp** with conservative-default at the
boundary. With N=14, the per-probe resolution is `1/14 ≈ 7.1pp`. **A 2pp
gate is below the discrete resolution of the probe set** — exact -2pp won't
appear; the realized deltas are step-sized at multiples of 7.1pp. This means
in practice the verdict from a single trial is one of:

| Probes flipping | Δpp | Verdict (per CONTEXT.md) |
|---:|---:|---|
| 0 | 0 | KEEP-OR-DELETE (≥ -2pp → DELETE allowed) |
| 1 worsens | -7.1 | KEEP (RL load-bearing) |
| 1 improves | +7.1 | DELETE allowed |

The planner should:

1. Run **3 trials** per condition (CONTEXT.md says 2-3, recommend 3) and
   aggregate by mean. Even with deterministic in-process probes, randomness
   creeps in via the per-test SQLite seeding order. Mean across trials is
   more robust than any single run.
2. Report **range** alongside mean — if the trials disagree (e.g., 14/14 vs
   13/14 vs 14/14), the gate decision should respect the worst trial under
   conservatism (a single regressing trial is a load-bearing signal).
3. **Per-category** delta means a 7.1pp jump in one category (e.g., one of
   the 3 cross-project probes flips) shows up as ~33pp in that category but
   ~7pp aggregate — both numbers must be reported so reviewers can see
   category-specific load-bearing even when aggregate is at-noise.

---

## Telemetry counter

CONTEXT.md `<decisions>` recommends a lightweight counter that records flag
invocations. The existing `src/core/telemetry-counters.ts` already has
`incrementRerankerFallbackCounter` as a pattern — same shape works here:

```ts
incrementRlScoringDisabledCounter(); // bumped each time CLAUDEX_DISABLE_RL_SCORING gate fires
```

Counter increments only when `process.env.CLAUDEX_DISABLE_RL_SCORING === '1'`
and the gated code-path was about to run. Lets the A/B harness assert the
gate fired N times during the flagged trials (N >= 1 for read path,
heartbeat-tick-count for trainer, session-count for memrl-scorer).

This is a sanity-only check — confirms the flag actually intercepted the
path. Without it a misimplemented gate could silently no-op and we'd report
"0pp delta" when the real delta is unknown.

---

## File-by-file change shape

| File | Change | Lines added |
|---|---|---:|
| `src/core/hybrid-retrieval.ts` | One-line guard at top of `computeQMultiplier` | ~3 |
| `src/intelligence/memrl-scorer.ts` | Top-of-function guards in `processSessionQValues`, `applyTemporalDecay`, `recordRetrieval`, `recordSuccess`, `recordFailure`, `propagateQValues` | ~12 |
| `src/intelligence/retrieval-rl.ts` | Top-of-function guard in `updateSessionQValues` | ~3 |
| `src/angel/heartbeat.ts` | One env-check around the existing rl-trainer block (lines 713-732) | ~3 |
| `src/core/telemetry-counters.ts` | One new counter `rl_scoring_disabled_total` + helper | ~10 |
| `src/tests/integration/phase-8-rl-ablation.test.ts` (new) | A/B harness — runs Phase 6 + Phase 6.5 probe sets under both conditions, 3 trials each, emits `08-rl-ablation-summary.json` | ~150 |
| `context/specs/V4_RL_ABLATION.md` (new) | Decision document — populated by phase close | ~80 |

---

## Risk surface

- **Cross-trial contamination**: If Phase 6.5 probes seed Q-values during
  setup (they don't today — Phase 6.5 uses `createTestDbWithSession` which
  fresh-DBs), this would contaminate later trials. Confirmed clean.
- **Vitest env-var precedence**: `process.env.CLAUDEX_DISABLE_RL_SCORING` is
  read at function-call time, so flipping it between trials inside the same
  vitest process works. The harness should `process.env.CLAUDEX_DISABLE_RL_SCORING = '1'`
  for flagged trials and `delete process.env.CLAUDEX_DISABLE_RL_SCORING` for
  baseline trials.
- **Phase 6 confound (called out in CONTEXT.md)**: the existing 11-probe
  harness already shows 0pp for qvalue. Phase 8 must add the Phase 6.5
  cross-project probes to get any signal. The A/B summary should explicitly
  break out *Phase 6 narrow harness* (expected: 0pp) vs *Phase 6.5
  cross-project* (expected: signal if any) vs *aggregate*. If both come back
  0pp, that IS the signal and supports DELETE; we just need to be honest
  that the test set is what it is (Phase 10's full suite isn't shipped).
- **Heartbeat trainer is rate-limited (100+ rewards)**: in test conditions
  the trainer block is unlikely to fire even without the gate. The "skips
  rl-trainer ticks" requirement is mostly a code-shape correctness gate
  (env-var wraps it), not a measurable delta. Fine — the gate's *behavioral*
  effect is dominated by the read path.

---

## Out of scope (per CONTEXT.md `<deferred>`)

- Actual deletion of the RL stack (Phase 9.8, conditional on this phase's
  decision)
- New simpler-learned-signal design (only triggered if KEEP, separate phase)
- Retrieval-feedback path (`retrieval-feedback.ts`) — that is the
  `retrievalMultiplier`, a separate ablation flag; not part of the RL stack
- Phase 6 multiplier-ablation harness rewrite (its 0pp delta is *evidence*,
  not a bug; respect it)

---

*Phase: 08-p6.5-rl-ablation-gate*
*Research captured: 2026-04-29*
