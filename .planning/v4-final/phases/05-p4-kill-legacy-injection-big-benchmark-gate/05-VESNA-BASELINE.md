# Phase 5: Pre-deletion Vesna Baseline

**Captured:** 2026-04-29
**Probe set:** phase-4-1-perceptual-similarity-probes (proxy — full Phase 10 Vesna suite not yet shipped)
**Total probes run:** 4

## Per-category pass-rate

| Category | Pass | Total | Rate |
|----------|------|-------|------|
| perceptual_similarity (lesson recall by paraphrase) | 4 | 4 | 100% |
| entity_recall | not-yet-instrumented | - | - |
| constraint_recall | not-yet-instrumented | - | - |
| handoff_pickup | not-yet-instrumented | - | - |

**Overall:** 4/4 = 100% on the runnable subset.

## Notes

- This baseline is for L3 fallback-ladder attribution diagnostics only.
- The Phase 5 acceptance gate is absolute (≥80%), not delta vs this baseline.
- Full Phase 10 Vesna suite (~20 probes covering entity/constraint/handoff/cross-project/lesson/self-instrumented categories) is NOT yet shipped per ROADMAP — Phase 10 is parallelizable but not yet executed.
- Probe subset used: `src/tests/integration/phase-4-1-perceptual-similarity-probes.test.ts` (4 lesson-recall paraphrase probes from Phase 4.1).
- Plan 09 verdict aggregator may extend the probe set as Phase 10 lands; absolute ≥80% gate per category is the acceptance line.
- Pre-deletion DB backup: `~/.claudex/backups/pre-v4-P4-1777478253.db` (schema_version=18, 8859 artifacts, 989 sessions, 191 learnings).
