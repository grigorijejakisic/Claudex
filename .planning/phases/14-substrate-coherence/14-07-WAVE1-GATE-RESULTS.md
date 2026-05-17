---
phase: 14-substrate-coherence
sub_phase: 14-07
wave: 1
role: PM-maintained record of every cutover-gate run. Populated by 14-07c cutover-v7.ts at each execution.
created_by: PM (Claude Opus 4.7) on 2026-05-16
baseline_file: .planning/phases/14-substrate-coherence/14-07-WAVE1-BASELINES.json
---

# Wave 1 Gate Results

This document is the PM-maintained record of every cutover gate run.
Populated by `src/scripts/cutover-v7.ts` at execution time. Each run
appends a new block below; do not modify prior blocks (they are
historical record).

## Baseline (v6.6.0 ship at `a3b3a42`)

- Vesna SC#1: **27/28 PASS** (97% aggregate; entity-001 known-fail at v6.6.0 with missing patterns `"BGE|bge-reranker|7439"` — pre-existing, not a v7 regression; tracked as post-ship engineering item per vesna-baseline-diagnostic 2026-05-17)
- LongMemEval Oracle (deepseek-coder-v2:16b): **90.6%** (426/470)
- LoCoMo (claude-sonnet-4-6): **55.5%** (855/1540) — known WIP item from v4 ship
- Cross-project candidate hit rate noise: **18%** (post-14-03 isSubstantive)

See `14-07-WAVE1-BASELINES.json` for the machine-readable form (consumed by `run-wave1-benchmarks.ts`).

## Gate criteria

Every run must satisfy (thresholds read from `14-07-WAVE1-BASELINES.json`, not narrative):

- Vesna SC#1 measured >= baseline (0.97 ≈ 27/28 at v6.6.0; entity-001 pre-existing fail is the floor, not the ceiling)
- LongMemEval Oracle measured >= baseline (0.906)
- LoCoMo measured >= baseline (0.555)
- Cross-project hit rate noise measured <= 0.20 (20% threshold, 18% floor)

If ANY gate fails, the cutover script exits 1 and refuses the cutover.
PM does NOT auto-rollback; PM escalates to PO per WAVE1-COORDINATION's
PM→PO escalation rules.

## Run log

*(No runs yet. First entry will be populated when operator invokes
`bun src/scripts/cutover-v7.ts --apply` and the script appends a
block following the template below.)*

### Run template

```
### Run YYYY-MM-DDTHH:MM:SS+TZ

- **Operator:** <name>
- **Mode:** dry-run | apply
- **DB path:** <path>
- **Pre-cutover validation:**
  - artifact_id_map completeness: <PASS/FAIL>
  - verifyDeterminism on sample: <PASS/FAIL>
- **Re-vectorization:**
  - Rows attempted: <N>
  - Succeeded: <N>
  - Failed: <N>
  - Failure rate: <N>%
- **Benchmark gate:**
  | Gate                       | Measured | Baseline | Threshold | Result |
  |----------------------------|----------|----------|-----------|--------|
  | vesna_sc1                  | XX/18    | 18/18    | >=        | PASS/FAIL |
  | longmemeval_oracle         | XX.X%    | 90.6%    | >=        | PASS/FAIL |
  | locomo                     | XX.X%    | 55.5%    | >=        | PASS/FAIL |
  | cross_project_hit_rate     | XX%      | 18%      | <=20%     | PASS/FAIL |
- **Read-only flag flip:** <YES (rows flipped: N) / NO (gate failed)>
- **Final disposition:** <CUTOVER COMPLETE / GATE FAILED — held at HEAD / DRY-RUN ONLY>
- **Operator approval line:** (operator fills in before v7.0.0 ship: e.g., "approved 2026-XX-XX; ship is go")
- **Telemetry rows emitted:** <count, per phase>
```

### Run 2026-05-17T09:14:43.625Z

- **Mode:** apply
- **DB path:** C:\Users\Grigorije\.claudex\db\claudex.db
- **Pre-cutover validation:**
  - artifact_id_map completeness: PASS (total_legacy=10721, mapped=10721)
  - verifyDeterminism on sample: PASS
- **Re-vectorization:** Rows attempted: 12556, Succeeded: 12551, Failed: 5 (0.0%)
- **Benchmark gate:** 
  | Gate                       | Measured | Baseline | Threshold | Result |
  |----------------------------|----------|----------|-----------|--------|
  | vesna_sc1                  | 28/28    | 27/28    | >=27/28   | PASS |
- **Read-only flag flip:** YES (rows flipped: 10722)
- **Final disposition:** CUTOVER COMPLETE
- **Operator approval line:** *(operator fills in before v7.0.0 ship)*
- **Telemetry rows emitted:** per phase (see telemetry table with session_id='cutover-v7')
