---
phase: 14-substrate-coherence
sub_phase: 14-07
wave: 1
role: Worker 14-07c status — updated at each execution attempt.
last_updated: 2026-05-17T04:51+02:00
worker: v7-w1c-cutover
---

# Wave 1 Cutover Status

## Deliverables — SHIPPED

All 3 plan deliverables and tests are complete.

| File | Status |
|---|---|
| src/scripts/cutover-v7.ts | SHIPPED |
| src/scripts/run-wave1-benchmarks.ts | SHIPPED |
| src/core/migration-steps.ts (helpers) | SHIPPED |
| src/tests/scripts/cutover-v7.test.ts | SHIPPED |
| src/tests/scripts/run-wave1-benchmarks.test.ts | SHIPPED |
| build.ts (entry points) | SHIPPED |

**Tests: 30/30 PASS** (15 cutover + 15 benchmark). No regressions vs baseline.

## Dry-Run Output (pre-cutover state)

```
=== DRY-RUN MODE (no writes will be performed) ===

[Phase A] Pre-cutover validation...
  [A.1] DB user_version: 37 (need >= 37)
  [A.1] PASS
  [A.2] artifact_id_map: ~10700/10700 mapped (live DB, auto-backfill handles drift)
  [A.2] PASS
  [A.3] Skipping verifyDeterminism in dry-run (requires Ollama)
[Phase B] Would re-vectorize ~12535 V17 artifact rows (batch_size=100)
  [B] (dry-run: not executed)
[Phase C] Would run benchmark gate (Vesna / LongMemEval / LoCoMo / cross-project hit rate)
  [C] (dry-run: not executed)
[Phase D] Would flip ~10700 legacy artifact rows to read_only=1 (0 already flipped)
[Phase E] Would append gate results to: .planning/phases/14-substrate-coherence/14-07-WAVE1-GATE-RESULTS.md
```

## Cutover Execution Attempt (2026-05-17T04:19→04:44)

`node dist/scripts/cutover-v7.cjs --apply --confirm-non-interactive`

### Phase A — PASS
- DB at V37
- artifact_id_map 10700/10700 mapped (auto-backfill of live-DB drift)
- arctic-embed2 determinism: PASS

### Phase B — PASS
- 12530/12535 rows succeeded, 5 failed (0.04% failure rate — under 5% threshold)
- Re-vectorization is **complete** in vec_artifact_v17

### Phase C — FAIL (gate refused cutover)

Failures due to bugs (now fixed):
1. `spawnSync('bun', ...)` without `shell: true` on Windows → ENOENT for all runners
2. Script names wrong: `bun run longmemeval` → should be `bun run bench:longmemeval`
3. **BLOCKER**: `bun run cross-project-hit-rate` script does not exist in package.json

Gate results from the failed run (all gates returned 0/1.0 due to runner errors):
- vesna_sc1: 0/28 FAIL (runner error)
- longmemeval_oracle: 0.0% FAIL (runner error)
- locomo: 0.0% FAIL (runner error)
- cross_project_hit_rate: 100.0% FAIL (runner error + no script)

### Phase D — NOT EXECUTED (gate failed, correct behavior)

## Bugs Fixed (Post-Plan)

All bugs except the missing cross-project script are now fixed:
- `import.meta.url` → `__dirname`/`__filename` CJS compat
- `run-wave1-benchmarks` isMain block firing inside cutover bundle
- `spawnSync shell: true` for Windows
- Script names: `bench:longmemeval` / `bench:locomo`
- Auto-backfill of unmapped artifacts in Phase A (live-DB drift)
- Column-name detection (`timestamp_epoch` vs `timestamp_epoch_ms`)

## Blocker: Missing cross-project-hit-rate Script

The gate requires a `"cross-project-hit-rate"` script in package.json that outputs:
```json
{"noise_rate": 0.18}
```

Baseline: 0.18 (18% noise). Gate threshold: measured <= 0.20.

Reference measurement: context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md

**Options for PM:**
1. Assign script creation to a worker and re-run cutover after it ships.
2. Authorize `--skip-benchmarks` via manual confirmation (not `--confirm-non-interactive`).

## To Re-Run Cutover

Once the cross-project script exists, run from project root:
```
node dist/scripts/cutover-v7.cjs --apply --confirm-non-interactive
```

Phase B vectors (vec_artifact_v17) are already populated. Re-run will redo Phase B (idempotent DELETE+INSERT) — takes ~10-15 minutes for 12535 rows.

To skip Phase B re-work on re-run: the cutover script does not currently detect existing vectors. If you want to skip re-vectorization, implement `--skip-revectorize` flag or add a "already vectorized" check to reVectorizeAll.
