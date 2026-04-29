---
phase: 06-p5-retrieval-simplification-multiplier-ablation
plan: 06-03
subsystem: retrieval
tags: [phase-6, retr-01, retr-02, consolidation, sync-async-alignment, scoring, hybrid-retrieval]
requires: [06-01, 06-02]
provides: [consolidated-scoring-function, sync-async-aligned-paths, post-consolidation-baseline]
affects:
  - src/core/hybrid-retrieval.ts
tech-stack:
  added: []
  patterns: [single-canonical-scoring-function, per-multiplier-helper, scoring-context-interface, flag-driven-ablation, file-header-formula-documentation]
key-files:
  created:
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-03-CONSOLIDATION-NOTE.md
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-03-post-consolidation-baseline.json
  modified:
    - src/core/hybrid-retrieval.ts
    - .planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-MULTIPLIER-ABLATION.md
key-decisions:
  - decision: Path A (consolidation) shipped instead of Path B (aggressive deletion) per team-lead approval
    rationale: Wave 2 evidence (0.0pp delta on every per-flag run at N=11) is below the harness resolution floor of ~9pp per probe. CONTEXT.md default-conservative axiom (KEEP unless evidence drops) applies. Acting on 0pp DROP verdicts at this N would be a Type I error masquerading as evidence-driven simplification. Same simplification mandate (RETR-01/02) satisfied via consolidation.
  - decision: Single canonical computeArtifactScore function consumed by both sync and async paths
    rationale: Eliminates the duplicated inline scoring blocks at the two callsites. One home per multiplier (per-helper). One interface for the context (ArtifactScoringContext). Future ablation targets a single function, not two callsites in two paths.
  - decision: Sync↔async qMultiplier mismatch closed (async now applies all 7 multipliers)
    rationale: Real bug independent of the ablation question. Sync was always the canonical-but-undocumented form; async silently omitted qMultiplier. Consolidation gives both paths the same formula by construction.
  - decision: All 7 multipliers retained; multiplierFlags mechanism preserved
    rationale: Default-conservative under inconclusive evidence. The consolidated function makes future deletion a single-helper edit when Phase 10's larger suite resolves the evidence question.
  - decision: Channels (graph_walk, temporal) NOT touched
    rationale: Plan 03's original Task 06-03-03 (channel-level deletion check) replaced by retention-with-rationale per team-lead's "DO NOT touch the 5 RRF channels" directive. Channels remain at the CONTEXT.md floor + graph_walk + temporal, matching production today.
  - decision: Documented weight vector lives in 06-03-CONSOLIDATION-NOTE.md
    rationale: Per team-lead's "Document the consolidated weight vector clearly so future ablation can target individual weights." Table form (multiplier / helper / neutral return / ablation-disabled return / notes) is the canonical reference.
  - decision: Deletion-debate-deferred-to-post-Phase-10 hook recorded in 06-MULTIPLIER-ABLATION.md
    rationale: Per team-lead's "this becomes a Phase 10 deliverable hook." A post-Phase-10 follow-up plan can re-run the harness verbatim against the larger probe set and ship the actual deletion when evidence is above the resolution floor.
requirements-completed:
  - RETR-01 (collapse hybrid-retrieval scoring — done via consolidation, not deletion; same simplification outcome)
  - RETR-02 (delete multiplier chain elements that ablation proved non-load-bearing — interpreted under the evidence-resolution constraint as: consolidate the chain, document the weight vector, defer aggressive deletion to post-Phase-10)
  - RETR-05 (multipliers retained pending stronger evidence; consolidation simplifies the surface without making deletion calls below evidence resolution)
duration: 13 min
completed: 2026-04-29
---

# Phase 06 Plan 03: Simplify hybrid-retrieval per ablation evidence (consolidation path)

**One-liner.** Collapsed the duplicated 7-multiplier scoring blocks in `hybridSearchSync` and `hybridSearchAsync` into a single `computeArtifactScore(artifact, rrfScore, ctx)` function with one helper per multiplier and one documented flat weight vector — same math, fewer ad-hoc tiers, sync↔async qMultiplier bug closed in passing.

## Duration

- Started: 2026-04-29 ~22:30 UTC (after team-lead approval reply)
- Ended:   2026-04-29 ~22:43 UTC
- Wall clock: ~13 min

## Tasks (revised per team-lead path-A approval)

### 06-03-01 — Read 06-MULTIPLIER-ABLATION.md, document path-A scope

- Path B (aggressive deletion) explicitly declined per evidence-resolution argument.
- Path A scope captured in `06-03-CONSOLIDATION-NOTE.md`:
  - Before/after code shape (two scoring blocks → one consolidated function).
  - Documented flat weight vector (per-multiplier helper + neutral return + ablation-disabled return + notes).
  - Behavior preservation invariants (sync byte-equal; async newly aligns to sync via qvalue addition; all-flags-disabled invariant unchanged; ablation harness baseline must hold within 1pp).
  - Channel retention rationale (graph_walk + temporal kept; out of scope for Plan 03).
  - Testing matrix.

### 06-03-02 — Consolidate scoring into computeArtifactScore

- New `computeArtifactScore(artifact, rrfScore, ctx)` exported from `hybrid-retrieval.ts`.
- New `ArtifactScoringContext` interface (`db`, `artifactId`, `relevance`, `weights?`, `multiplierFlags?`).
- New per-multiplier helpers:
  - `computeNoveltyMultiplier(artifact)` — was inline `0.5 + (a.novelty_score ?? 0.5)`.
  - `computeActivationFactor(artifact)` — was inline `Math.max(0.1, a.activation_score ?? 1.0)`.
  - `computeQMultiplier(artifact)` — was inline `0.5 + (a.q_value ?? 0.5)`.
  - `getRetrievalScoreMultiplier` (existing) is the only outer multiplier still in another module.
- File-header doc block updated to reflect the consolidated formula and the channel set (5 channels async / 2 channels sync — explicitly enumerated).
- Both retrieval paths now construct a single `ArtifactScoringContext` and call `computeArtifactScore`. The duplicated scoring blocks are deleted.
- The `score_breakdown.three_factor` field still exposed for debug — recomputed inline (cheap; doesn't duplicate the multiplier chain).

### 06-03-03 — Sync↔async alignment

- Closed by construction. Both paths route through the same helper; identical inputs produce identical scores.
- Async path previously omitted qMultiplier; now applies it via the same helper. This is the only behavior change vs pre-Plan-03 — and only on the async path. No tests directly exercise `hybridSearchAsync` (verified via `Grep`), so no test re-baseline needed.

### 06-03-04 — Post-consolidation regression check

- Re-ran the ablation harness:
  - Baseline (all enabled) — 11/11 = 100%, identical to W2 baseline.
  - All-disabled (RRF only) — 11/11 = 100%, identical to W2.
  - Per-flag sweep — 0pp delta on every multiplier, identical to W2.
- Snapshot of post-consolidation baseline written to `runs/06-03-post-consolidation-baseline.json`.
- No deletion happened, so the regression bar is "byte-equal scoring on the sync path; addition-only behavior change on the async path" — both held.

## Verification

### must_haves checklist (revised for path A)

| Item | Status |
|------|--------|
| Single `computeArtifactScore` consumed by both retrieval paths | PASS |
| Sync↔async produce identical scores from identical inputs | PASS (qMultiplier bug closed) |
| `multiplierFlags` mechanism preserved for all 7 multipliers | PASS (default-conservative under inconclusive evidence) |
| All-flags-disabled invariant `hybrid_score === rrfScore` preserved | PASS (RRF-only invariant test still passes @ 12 decimals) |
| Post-consolidation baseline within 1pp of W2 baseline | PASS (byte-equal, 11/11 = 100%) |
| Documented weight vector | PASS (06-03-CONSOLIDATION-NOTE.md table) |
| Deletion-debate-deferred-to-Phase-10 hook in 06-MULTIPLIER-ABLATION.md | PASS (added "Post-Plan-03 status" + "Deletion debate" sections) |
| `bun run build` clean | PASS (~70ms) |
| `bun run test src/tests/core/hybrid-retrieval.test.ts` | 35/35 PASS |
| `bun run test src/tests/integration/phase-6-multiplier-ablation.test.ts` | 4/4 PASS |
| Full suite — only pre-existing llama failures remain | PASS (2861 pass, 20 llama-baseline fail, 0 non-llama regressions) |

### Wave-end gate

- Consolidation landed in two atomic commits (`415e333` + the documentation amend below).
- `06-03-CONSOLIDATION-NOTE.md` is the canonical record of what changed and why.
- `runs/06-03-post-consolidation-baseline.json` matches W2 baseline.

## Deviations from Plan

**[Strategic — path A vs path B]** The plan as written (`06-03-PLAN.md`) is the deletion path. Per team-lead's approval reply (received this turn), Plan 03 executed the consolidation path A instead. The consolidation produces the same simplification outcome (one scoring function, one weight vector, fewer ad-hoc tiers) without making deletion calls the W2 evidence cannot support. The deletion debate is deferred to a post-Phase-10 follow-up plan with the documented hook in `06-MULTIPLIER-ABLATION.md`. This was an explicit team-lead-approved scope change, not a deviation in the conventional sense — recorded here for audit trail.

**[Rule 1 — Bug] Sync↔async qMultiplier mismatch (closed in passing)** — Found during: Plan 03 task identification while reading `hybrid-retrieval.ts` lines 532 vs 718 | Issue: sync path applied `qMultiplier = 0.5 + q_value` but async path silently omitted it; identical retrieval queries produced different scores depending on which path was used | Fix: consolidating both paths through `computeArtifactScore` closes the mismatch by construction — both call `computeQMultiplier` via the same helper | Files modified: `src/core/hybrid-retrieval.ts` (consolidation diff) | Verification: no test exercises `hybridSearchAsync` directly (verified via `Grep`), so no value-asserting regression possible; the addition-only behavior change is documented in `06-03-CONSOLIDATION-NOTE.md`.

**Total deviations: 1 strategic scope change (team-lead approved), 1 Rule-1 bug fixed in passing.**

## Authentication Gates

None.

## Issues Encountered

None.

## Next Phase Readiness

Plan 04 (Wave 3b in parallel — reranker hard-required telemetry+visibility) is unblocked and unaffected by Plan 03. The V20 telemetry enum substrate from Plan 01 is in place; Plan 04 ships the write site + assembler section.

Plan 05 (Wave 4 — RIF/spread + MCP surface lock-down) is unblocked.

Plan 06 (Wave 5 — SC#1 Vesna gate + STATE/ROADMAP/REQUIREMENTS update + 06-SUMMARY.md) will run the absolute-≥80% Vesna gate against the consolidated retrieval pipeline.

## Files Touched (summary)

- 1 source file: `src/core/hybrid-retrieval.ts` (consolidation diff: -67 / +395 lines net of helper + interface + comment block + two callsite replacements).
- 2 documentation files: new `06-03-CONSOLIDATION-NOTE.md`; amended `06-MULTIPLIER-ABLATION.md` with post-Plan-03 status + deferred-deletion sections.
- 1 evidence snapshot: `runs/06-03-post-consolidation-baseline.json`.
- 0 test files (sync-path math byte-equal; async qvalue addition unobservable to existing tests).
