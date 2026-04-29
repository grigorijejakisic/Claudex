# Phase 6 Plan 03 — Consolidation (path A) note

**Captured:** 2026-04-29
**Status:** approved by team-lead in lieu of aggressive deletion (path B) per `06-MULTIPLIER-ABLATION.md` evidence-floor reasoning.

## Why this file exists

Plan 03 as originally written (`06-03-PLAN.md`) is the **deletion** path. It enumerates every multiplier verdicted DROP in `06-MULTIPLIER-ABLATION.md`, removes its code, and verifies the post-deletion baseline.

The Wave 2 evidence (0.0pp delta on every per-flag run at N=11) cannot resolve effects below ~9pp per probe. Acting on that evidence as a deletion mandate would be a Type I error masquerading as evidence-driven simplification.

Per team-lead's directive, Plan 03 executes a **consolidation** path:

- Same math; fewer ad-hoc tiers.
- One scoring function (`computeArtifactScore`) replaces the inline 7-multiplier × 3-factor scoring blocks duplicated across `hybridSearchSync` and `hybridSearchAsync`.
- One flat documented weight vector — recency, importance, relevance, retrieval, novelty, activation, qvalue — exposed for future ablation.
- Sync↔async paths produce identical scores (closes the latent qMultiplier mismatch).

## What changes

### Before (today)

Two scoring blocks, one per path. Sync has 7 multipliers, async has 6 (qMultiplier missing from async — a real bug regardless of ablation outcome).

```ts
// hybridSearchSync (lines ~516-536):
const threeFactor = computeThreeFactorScore(artifact, ...);
const retrievalMultiplier = enabled('retrieval') ? getRetrievalScoreMultiplier(...) : 1.0;
const noveltyMultiplier = enabled('novelty') ? 0.5 + (a.novelty_score ?? 0.5) : 1.0;
const activationFactor = enabled('activation') ? Math.max(0.1, a.activation_score ?? 1.0) : 1.0;
const qMultiplier = enabled('qvalue') ? 0.5 + (a.q_value ?? 0.5) : 1.0;
const baseScore = rrfScore * (1 + threeFactor);
const hybridScore = baseScore * retrievalMultiplier * noveltyMultiplier * activationFactor * qMultiplier;

// hybridSearchAsync (lines ~713-718): same shape, qMultiplier MISSING.
```

### After (Plan 03 consolidation)

One function `computeArtifactScore(artifact, rrfScore, ctx)` consumed by both paths. Identical math, identical weights.

```ts
const hybridScore = computeArtifactScore(artifact, rrfScore, {
  db,
  artifactId,
  relevance,
  weights,                  // forwarded from options.weights (or DEFAULT_WEIGHTS)
  multiplierFlags: mFlags,  // forwarded from options.multiplierFlags (or {})
});
```

Internally, `computeArtifactScore` walks one canonical formula:

```ts
hybrid_score
  = rrfScore
  * (1 + α·recency + β·importance + γ·relevance)   // inner three-factor
  * retrievalMultiplier                              // outer #1
  * noveltyMultiplier                               // outer #2
  * activationFactor                                // outer #3
  * qMultiplier                                     // outer #4
```

Each of the seven multiplier values is computed via a **per-multiplier helper** (one helper per multiplier) so that:
1. Each multiplier has a single home — the helper.
2. The flat weight vector is documented in one place — `MULTIPLIER_WEIGHTS`.
3. Ablation toggles still work — each helper checks the flag and returns the neutral value (0 for inner factors inside `(1 + ...)`, 1.0 for outer multipliers).

## Documented weight vector

Every multiplier's "weight" (in the flat-vector sense) is the value the helper returns under default conditions, given a neutral input artifact. Documenting this lets future ablation target individual weights:

| Multiplier  | Helper                       | Neutral artifact returns | Ablation-disabled returns | Notes |
|-------------|------------------------------|--------------------------|---------------------------|-------|
| recency     | `computeRecencyScore`        | exp(-0.995 · hours)      | 0 (inner)                 | Range [0, 1]; α weight applied in three-factor sum. |
| importance  | `computeImportanceScore`     | importance / 5           | 0 (inner)                 | Range [0, 1]; β weight applied in three-factor sum. |
| relevance   | (passed as argument)         | vector_score or 1/rank   | 0 (inner)                 | Range [0, 1]; γ weight applied in three-factor sum. |
| retrieval   | `getRetrievalScoreMultiplier`| `retrieval_score` (artifact column; default 1.0) | 1.0 (outer) | Phase 5.2 retrieval-feedback. Outer multiplier. |
| novelty     | `computeNoveltyMultiplier`   | 0.5 + (novelty_score ?? 0.5) → range [0.5, 1.5] | 1.0 (outer) | Boosts novel artifacts; demotes redundant. |
| activation  | `computeActivationFactor`    | max(0.1, activation_score ?? 1.0) | 1.0 (outer) | RIF-decayed artifacts get demoted. Floor 0.1 prevents zero-suppress. |
| qvalue      | `computeQMultiplier`         | 0.5 + (q_value ?? 0.5) → range [0.55, 1.5] | 1.0 (outer) | MemRL learned utility. Phase 2 Amp. |

`α = β = γ = 1.0` by default (`DEFAULT_WEIGHTS` unchanged).

## Behavior preservation invariants

The consolidation must preserve byte-equal scoring relative to *the union of* what sync + async produced before, **except** where the sync↔async mismatch existed:

1. **Sync path before vs sync path after:** byte-equal. Sync had all 7 multipliers; consolidation keeps all 7 in the same order.
2. **Async path before vs async path after:** **NOT byte-equal**. Async previously omitted qMultiplier; after consolidation it includes it. This is the bug-fix portion of Plan 03 — sync was always the canonical-but-undocumented form, and async will now match it. The async-path tests in `hybrid-retrieval.test.ts` are the canary; if any of them break on numeric values rather than ordering, that's the qvalue addition surfacing — re-baseline with the new formula.
3. **All-flags-disabled invariant:** unchanged. `hybrid_score === rrfScore` when every flag is `false`, regardless of path.
4. **Ablation harness baseline:** must remain ≥ W2 baseline minus 1pp (= ≥99% on the 11-probe set). With identical math under default flags, expect 100%.

## What this plan does NOT do

Per `06-MULTIPLIER-ABLATION.md` "Decisions for Wave 3":

- **Does NOT delete any of the 7 multipliers.** The DROP verdicts in the table are below the harness's resolution floor; default-conservative axiom (KEEP unless evidence drops) applies.
- **Does NOT touch the 5 RRF channels.** `graph_walk` and `temporal` remain in the async path. Channel-level deletion is also evidence-thin and is deferred to a post-Phase-10 follow-up. Original Plan 03 task `06-03-03` (graph + temporal channel deletion check) is replaced with: "no channel changes; document retention rationale in this note."
- **Does NOT remove `multiplierFlags` from any multiplier.** Every flag remains so the harness can target individual weights.

Channel retention rationale (replaces original Task 06-03-03):

- `graph_walk` adds 2-hop traversal across `artifact_links`. Light (~5ms) and provides relational recall the FTS5+vec0+recency channels miss by construction. Default-conservative.
- `temporal` (the `parseTemporalExpression`-driven recency channel under "yesterday"/"last week" queries) is a directly user-visible feature. Disabling it would require the Phase 10 query corpus to confirm no degradation. Out of scope for Plan 03.

## Deletion debate hook for post-Phase-10

The full Phase 10 Vesna suite (~20 probes with closer-to-threshold targets) is the resolution upgrade needed. When that suite ships, re-run the W2 harness verbatim with the larger probe set:

```bash
bun run test src/tests/integration/phase-6-multiplier-ablation.test.ts
```

If individual multipliers show ≥5pp drops, those become DROP candidates for a post-Phase-10 follow-up plan. Until then, the multipliers stay. This expectation is recorded in `06-MULTIPLIER-ABLATION.md` "Forward look" section.

## Testing matrix

| Suite                                                        | Expected result                                                       |
|--------------------------------------------------------------|-----------------------------------------------------------------------|
| `bun run test src/tests/core/hybrid-retrieval.test.ts`       | 35/35 pass — sync path math byte-equal; no test re-baseline.          |
| `bun run test src/tests/integration/phase-6-multiplier-ablation.test.ts` | All sweep tests pass; baseline 11/11 = 100% (post-consolidation). |
| `bun run test`                                               | Full suite: only the 20 pre-existing llama-server-supervisor failures remain. |

If async-path tests numerically drift (qvalue addition bug-fix), those are re-baselined with comments pointing to this note. No ordering-asserting test should break.
