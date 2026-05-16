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

- Vesna SC#1: **18/18 PASS** (100%)
- LongMemEval Oracle (deepseek-coder-v2:16b): **90.6%** (426/470)
- LoCoMo (claude-sonnet-4-6): **55.5%** (855/1540) — known WIP item from v4 ship
- Cross-project candidate hit rate noise: **18%** (post-14-03 isSubstantive)

See `14-07-WAVE1-BASELINES.json` for the machine-readable form.

## Gate criteria

Every run must satisfy:

- Vesna SC#1 measured >= baseline (18/18)
- LongMemEval Oracle measured >= baseline (90.6%)
- LoCoMo measured >= baseline (55.5%)
- Cross-project hit rate noise measured <= baseline (20% tolerance from 18% floor)

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
