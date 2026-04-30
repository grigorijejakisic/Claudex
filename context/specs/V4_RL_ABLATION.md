# V4 RL Ablation — Decision

**Phase:** 8 (P6.5 — RL ablation gate)
**Status:** LOCKED
**Decision date:** 2026-04-29 (UTC: 2026-04-29T23:13:16.896Z)
**Source artifact:** `.planning/phases/08-p6.5-rl-ablation-gate/runs/08-rl-ablation-summary.json`

---

## Verdict

**DELETE_ALLOWED**

> RL stack is not load-bearing on the 14-probe Phase 8 surface (5 of 6 CONTEXT.md categories: lesson, entity, constraint, handoff, cross-project). Phase 9.8 is cleared to delete the surface. The locked decision honours CONTEXT.md `<decisions>.### Decision criteria` verbatim — aggregate `delta_pp = 0.00 ≥ -2pp`.

---

## Evidence

### A/B configuration

- Probe set: 14 probes across 5 categories (lesson, entity, constraint, handoff, cross-project)
- Self-instrumented category: 0 probes — gap documented; Phase 10 will fill
- Trials per condition: 3
- Decision threshold: -2pp aggregate mean delta, conservative-default at the boundary
- Gate path: `CLAUDEX_DISABLE_RL_SCORING=1` env var (ABL-01) intercepts `computeQMultiplier` (read), all seven `memrl-scorer` exports + `updateSessionQValues` (write), heartbeat `rl-trainer` block + heartbeat `applyTemporalDecay` block

### Per-condition mean pass rate

| Condition | Mean | Range |
|---|---:|---|
| Baseline (flag absent) | 100.00% | 100.00% – 100.00% |
| Flagged (CLAUDEX_DISABLE_RL_SCORING=1) | 100.00% | 100.00% – 100.00% |

**Aggregate delta:** 0.00pp
**Range-aware delta (mean(flagged) − max(baseline)):** 0.00pp

### Per-category delta (pp, flagged − baseline)

| Category | Δpp |
|---|---:|
| lesson | 0.00 |
| entity | 0.00 |
| constraint | 0.00 |
| handoff | 0.00 |
| cross-project | 0.00 |
| self-instrumented | not measured |

### Gate-fire sanity

| Trial | Baseline gate fires | Flagged gate fires |
|---:|---:|---:|
| 1 | 0 | 49 |
| 2 | 0 | 49 |
| 3 | 0 | 49 |

The flagged condition fired the env-var gate 49 times per trial across the qmultiplier read path. Baseline never fired (env var unset). The gate was structurally active in flagged trials and inert in baseline trials — a misimplemented gate that silently no-oped would have shown 0 fires in the flagged column and been caught here.

### Notes from harness

- Self-instrumented category not covered: 0 probes available pre-Phase-10
- Phase 6 confound: 11 of the 14 probes were already shown 0pp under `multiplierFlags.qvalue=false` in Phase 6 W2 — same semantics, different gate path. Incremental signal lives in the 3 Phase 6.5 cross-project probes.

---

## Implications

### **REALIZED** — DELETE_ALLOWED

Phase 9.8 is cleared to:

- Delete `src/intelligence/retrieval-rl.ts` (orphaned + zero non-test callers post-Phase-8 — `applyQValueReranking` and `getQValueBoosts` already had no callers; `updateSessionQValues` becomes dead with the env-var gate permanently on)
- Delete `src/intelligence/memrl-scorer.ts`
- Delete `src/intelligence/rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`
- Delete the `qMultiplier` branch in `computeArtifactScore` and the `qvalue` member from `MultiplierName`
- Drop the `q_value` column from `artifacts` (V22 migration) and the related columns from `experience_patterns` confidence-blend path
- Remove the `CLAUDEX_DISABLE_RL_SCORING` env-var gate (its absence is the permanent state once the surface is deleted)
- Delete `src/core/rl-scoring-disabled-counter.ts` and its test (the in-memory counter was Phase-8-only sanity-check infrastructure)
- Heartbeat tick simplification: drop the rl-trainer block (lines ~710-734) and the temporal decay block (~1028-1042)

Estimated LOC delta in Phase 9.8: ~−700 to −1100 lines net (RL stack source + tests + V22 migration + assembler clean-up).

### **NOT REALIZED — preserved for audit trail** — KEEP or KEEP_CONSERVATIVE_DEFAULT

If a future re-run on a richer probe set (Phase 10's full ~20 probes including self-instrumented) reverses the verdict, this branch becomes operative:

The RL stack stays. Phase 9.8 is cancelled. Open follow-ups:
- Document which categories show the load-bearing signal (per the per-category table above)
- Decide whether a redesign with a simpler learned signal is warranted (deferred per CONTEXT.md `<deferred>`); if KEEP_CONSERVATIVE_DEFAULT, CONTEXT.md says revisit after Phase 9
- Schema and code are unchanged from pre-Phase-8 except the env-var gate, which remains as a runtime toggle for future evaluation

---

## Confound disclosure

Per CONTEXT.md `<deferred>`, Phase 6 already ran an in-process ablation of the qvalue multiplier via `multiplierFlags.qvalue=false` on the same 11 Phase 6 probes and recorded a 0pp delta. Phase 8 reuses that probe set plus 3 cross-project probes from Phase 6.5. **The 11 Phase 6 probes are expected to show 0pp under the env-var gate too** — this is consistent evidence across two gate paths, not an independent confirmation. The signal Phase 8 adds is the 3 Phase 6.5 cross-project probes.

The 3 cross-project probes also returned 0pp on this surface. Their pass paths flow through `assembleExperienceTier` (HYBRID equivalence + handles in `cross-project-equivalence.ts`) and `expandSearchCrossProject` (task-shape vocabulary + perceptual-handle scoring) — neither of which reads `artifacts.q_value` directly. The qMultiplier in `computeArtifactScore` IS exercised by the Phase 6 probes, but every test artifact seeds via `createTestDbWithSession` + `createArtifact` which leave `q_value` at its column default — so even when the multiplier reads it, the read returns the same neutral value as the env-var-gated `1.0`. **The Phase 8 surface, as constructed, does not fully exercise the RL stack's runtime mutation cycle** (write → propagate → decay → read). Phase 10's full ~20-probe suite, if it includes self-instrumented and historical-Q probes, would be the surface that actually tests load-bearing-ness across the cycle.

That is a real limit of the evidence on this verdict — but per CONTEXT.md `<specifics>` and the locked decision criteria, *the verdict is on `delta_pp` from the available surface*, and at delta_pp = 0pp the rule is DELETE_ALLOWED. The verdict is overturnable by a richer probe set: re-run the harness, write a superseding `V4_RL_ABLATION.md` with a `## Supersedence` header citing this file's commit hash, and document the new evidence.

---

## Cross-references

- Roadmap: `.planning/ROADMAP.md` Phase 8 (P6.5)
- Requirements: ABL-01 (gate landed, Plan 08-01), ABL-02 (A/B run, Plan 08-02), ABL-03 (this lock, Plan 08-03)
- Phase 6 ablation evidence: `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-disable-qvalue.json`
- Phase 8 source artifact: `.planning/phases/08-p6.5-rl-ablation-gate/runs/08-rl-ablation-summary.json`
- Phase 9 sub-phase 9.8 (conditional RL deletion): `.planning/ROADMAP.md` Phase 9 success criterion 3

---

## Phase 9.8 execution

**Date executed:** 2026-04-30
**Verdict honored:** DELETE_ALLOWED → 9.8 shipped per CONTEXT.md `<decisions>.### 9.8 conditional logic`

**Deletions landed:**
- 7 RL source files: `retrieval-rl.ts`, `memrl-scorer.ts`, `rl-trainer.ts`, `rl-policy.ts`, `rl-model.ts`, `rl-reward.ts`, `rl-scoring-disabled-counter.ts`
- 3 RL test files: `retrieval-rl.test.ts`, `rl-model.test.ts`, `rl-scoring-disabled-counter.test.ts`
- 1 obsolete integration test: `phase-8-rl-ablation.test.ts` (test surface for the env-var gate that the deletion consummates)
- `qMultiplier` branch in `computeArtifactScore` (hybrid-retrieval.ts) + `'qvalue'` from `MultiplierName` union
- Heartbeat Phase 8 RL-trainer block (~28 lines) + Phase 4d3 temporal-decay block (~17 lines) + `result.rl_*` fields + `_lastDecayEpoch` rate-limit
- Adapter coupling: `cc-hooks/session-end.ts` (updateSessionQValues call), `cc-hooks/stop.ts` (memrl_q_update step)
- Q-value RL reranking inside `experience-patterns.ts` (boost loop + getQValueBoosts import)

**V23 migration shipped:**
- `migrateV22toV23` drops `policy_weights` table + `artifacts.q_value` column (idempotent guards)
- `TARGET_VERSION` raised 22→23 in `runMigrations`
- Fresh-DB stamping in `initializeSchema` runs V23 unconditionally (ensures policy_weights / q_value absent on new installs)
- `policy_weights` CREATE TABLE removed from `schema.ts`
- `q_value` ALTER ADD removed from `migrateSchemaFixes` step 8 (retrieval_count + success_count survive — they're consumed by retrieval-feedback)
- 11 existing migration test files updated 22→23 (mechanical version-assertion bump)

**Plan deviation (audit error correction):**
- Plan 09-08 listed `src/intelligence/policy-registry.ts` as one of "the seven RL stack modules". Verification (live consumer audit + git history) showed it's a non-RL singleton holder around `DefaultMemoryPolicy` (8+ live consumers in intent-predictor, retrieval-feedback, observations, hybrid-retrieval, decay-engine, consolidator, stop, memory-policy.test). T6 audit conflated `policy-registry` (DefaultMemoryPolicy holder) with `rl-policy` (RL MemoryPolicy implementer). Per Plan 09-08 risk+rollback guidance ("if T6 was wrong on any module, bisect catches it; restore + investigate"), the file was restored after deletion. 9.8 ships with 7 RL files deleted instead of 8.

**LOC delta:** ~−2700 lines (target was −700 to −1100 per the Phase 8 prediction; the prediction undercounted because the corresponding test files plus the qMultiplier branch + heartbeat blocks + adapter calls add up)

**Vesna spot-check:** 8/8 (4 multiplier-ablation probes + 4 cross-project probes), Phase 6 11-probe and Phase 6.5 3-probe surfaces both clean.

**DB backup:** `~/.claudex/backups/pre-v4-P9.8-20260430-131848.db` (376MB)

**Status:** REALIZED. The Phase 8 prediction held — Vesna pass rate did not regress under the deletion.
