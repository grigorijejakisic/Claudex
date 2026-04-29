# SC#1 Result — Vesna probe pass-rate

**Date:** 2026-04-29
**Suite used:** Phase 4.1 perceptual-similarity probes (proxy — full Phase 10 Vesna suite not yet shipped per ROADMAP)
**Test file:** `src/tests/integration/phase-4-1-perceptual-similarity-probes.test.ts`

## Per-category results (proxy subset)

| Category | Pass | Total | Rate | ≥80%? |
|----------|------|-------|------|-------|
| perceptual_similarity (lesson recall by paraphrase) | 4 | 4 | 100% | yes |
| entity_recall | not-yet-instrumented | - | - | n/a |
| constraint_recall | not-yet-instrumented | - | - | n/a |
| handoff_pickup | covered structurally by SC#4 | - | - | yes (via SC#4 PASS) |
| cross_project | not-yet-instrumented | - | - | n/a |

**Overall (informational):** 4/4 = 100% on the runnable subset.

## Comparison vs pre-Phase-5 baseline

Pre-Phase-5 baseline (`05-VESNA-BASELINE.md`): 4/4 = 100% on the same proxy subset.
Post-Phase-5: 4/4 = 100%. **Delta: 0** (no regression).

## Phase 10 instrumentation gap

Per ROADMAP Phase 10 ("Vesna probe suite as central validation"), the full ~20-probe suite covering entity_recall, constraint_recall, handoff_pickup, cross_project, lesson_application, and self-instrumented categories is **not yet shipped**. ROADMAP allows Phase 10 to be parallelized with Phase 5; in this Phase 5 close, the instrumentation is partial and SC#1 is met against the available subset.

## Verdict

**PASS-WITH-PROXY-NOTE** — proxy subset 4/4 = 100% (≥80% gate satisfied). Full Phase 10 suite is the structural follow-up that closes SC#1 with full per-category coverage. Phase 5's deletion did NOT regress the runnable subset.

The structural surface that the full Vesna suite will measure has been built up by Phase 5 (CACH-03 hardening, frontmatter-gated prime, reactive trigger helpers). When Phase 10 lands the full probe set, it can be re-run against the post-Phase-5 codebase to confirm full per-category pass-rates.

## Phase 5 close routing

Per AMENDMENT: "Phase 5 ships → run Phase 10's full ~20-probe suite (or whichever subset is live when 5 ships)." The runnable subset passes 100%; this satisfies the AMENDMENT condition.

The handoff_pickup category — the most directly Phase-5-facing — is covered by SC#4's structural soak (3/3 PASS). SC#1's proxy subset combined with SC#4's soak provides complementary coverage of the categories that Phase 5 most directly affects.
