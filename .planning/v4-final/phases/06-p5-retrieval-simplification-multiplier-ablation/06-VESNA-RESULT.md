# Phase 6 — SC#1 Vesna Gate Result

**Captured:** 2026-04-29T22:48Z
**Probe set:** `src/tests/integration/phase-6-multiplier-ablation.test.ts` (11 probes — Phase 6 expansion of the Phase 4.1/5 4-probe paraphrase set)
**Total probes run:** 11
**Pipeline:** post-consolidation (`computeArtifactScore` consolidated; `multiplierFlags` undefined = production config; cross-encoder live or bi-encoder fallback per environment)

## Per-category pass-rate

| Category                                               | Pass | Total | Rate  |
|--------------------------------------------------------|------|-------|-------|
| lesson_recall (paraphrase robustness)                  | 4    | 4     | 100%  |
| entity_recall                                          | 3    | 3     | 100%  |
| constraint_recall                                      | 2    | 2     | 100%  |
| handoff_pickup                                         | 2    | 2     | 100%  |

**Overall:** 11/11 = 100%

## SC#1 verdict

**PASS.** Overall ≥80% threshold met by 20pp; every category ≥80% (in fact, every category at 100%).

The post-consolidation pipeline meets the Phase 6 close gate. The `computeArtifactScore` consolidation in Plan 03 changed nothing observable on the sync path (math is byte-equal); the async path gained qMultiplier (closing the latent sync↔async mismatch) but no async-path test asserts a numeric value, so this is invisible at the SC level. The pre/post baseline matches verbatim:

- W1 baseline (pre-consolidation, 06-01-baseline.json): 11/11 = 100%
- W6 gate (post-consolidation, 06-06-vesna-gate.json): 11/11 = 100%

## Notes

- This is the Phase 6 close gate, not the canonical Phase 10 Vesna suite. Phase 10 ships ~20 probes with closer-to-threshold targets — that's the resolution upgrade flagged in `06-MULTIPLIER-ABLATION.md` "Forward look" / "Deletion debate deferred" sections.
- The Phase 5 baseline (`05-VESNA-BASELINE.md`) reported 4/4 = 100% on the lesson-recall subset; Phase 6 carries those four probes verbatim, plus 7 new probes covering entity, constraint, and handoff flavors. The lesson-recall sanity check in `phase-6-multiplier-ablation.test.ts::lesson-recall subset matches Phase 5 Vesna baseline (4/4 = 100%)` enforces this regression bar going forward.
- Pre-existing llama-server-supervisor test failures (20 of them) are unchanged from the Phase 5.5 STATE.md baseline. They are unrelated to the SC#1 result.
- Reproducibility: `bun run test src/tests/integration/phase-6-multiplier-ablation.test.ts` re-runs the gate; per-probe outcomes land in `runs/06-02-baseline.json` (and `runs/06-06-vesna-gate.json` snapshots the close gate).

## Deferred (non-blocking)

- **Aggressive multiplier deletion.** Deferred to a post-Phase-10 follow-up plan with the larger Vesna suite. Tracked in `06-MULTIPLIER-ABLATION.md` "Deletion debate" section.
- **Cross-encoder live-fire visibility live test.** The `phase-6-reranker-fallback-visibility.test.ts` integration covers the four failure modes via `globalThis.fetch` stubs. A live-fire test against the real port-7439 service is non-blocking and out of scope for Phase 6.
- **q_value column drop on `artifacts`.** The Q-value multiplier remains in production (consolidation, not deletion). The schema column also remains. Dropping it is a future hygiene item.
