---
plan_id: 03-06
phase: 3
wave: 3
depends_on:
  - 03-01
  - 03-02
  - 03-03
  - 03-04
  - 03-05
files_modified:
  - .planning/phases/03-p2-directive-detector/03-CALIBRATION.md
  - .planning/phases/03-p2-directive-detector/fixtures/runs/
autonomous: false
requirements:
  - EXTR-04
---

# Plan 03-06: Calibration + Ship

## Objective

Run the precision harness against the committed fixture, follow the `runbook.md` decision tree, document results in `03-CALIBRATION.md`, gate on joint precision ≥ 90%, then run LongMemEval Oracle + LoCoMo to confirm no benchmark regression.

**`autonomous: false`** — calibration requires human decisions at the iteration branches (noise-bound vs tune, which cycle to enter, when to escalate).

## Must-haves (goal-backward)

- At least one precision-harness run committed under `.planning/phases/03-p2-directive-detector/fixtures/runs/`.
- `03-CALIBRATION.md` documents: initial metrics, iteration steps taken, final config, final metrics. One line per iteration cycle.
- Final `joint_precision ≥ 0.75` on the committed fixture (gate lowered from 0.90 per 03-LABEL-AUDIT.md: human ceiling on this fixture is ~0.55–0.60 due to gold-label noise; 0.75 asks the detector to hit ~75–80% of human ceiling after the 12-case user re-label on 2026-04-21).
- Per-field diagnostic numbers (is_directive precision, scope precision, polarity precision, universal-scope precision) recorded.
- LongMemEval Oracle ≥ 88% (hard floor from CONTEXT §gate_criteria).
- LoCoMo change vs post-P1 baseline: absolute regression ≤ 2pp.
- 2020 Vitest tests pass.
- One `directive_rule` artifact exists in the live DB after the first post-P2 Angel tick (heartbeat log or explicit integration test).

## Tasks

<task id="03-06-01">
  <subject>First precision-harness run + branch into runbook</subject>
  <description>
1. Execute:
   ```
   bun run src/benchmarks/directive-detector/run-precision.ts --tag=baseline
   ```
2. Read `joint_precision` from the emitted JSON.
3. Apply the runbook's decision tree (Plan 03-05's `runbook.md`):
   - ≥ 92% → go to 03-06-02.
   - 88-92% → corpus expansion (sessions 22-36) → re-run → re-decide.
   - < 88% → enter 3-cycle tune.

Record every run's output JSON path in a running log inside `03-CALIBRATION.md`.
  </description>
</task>

<task id="03-06-02">
  <subject>Cycle 1 — threshold sweep (only if runbook Branch C triggered)</subject>
  <description>
Run precision with each threshold pair:
- `(0.65, 0.80)`, `(0.65, 0.85)`, `(0.65, 0.90)`
- `(0.70, 0.80)`, `(0.70, 0.85)`, `(0.70, 0.90)`
- `(0.75, 0.85)`, `(0.75, 0.90)`
- `(0.80, 0.85)`, `(0.80, 0.90)`

Tag each run (`--tag=t70u85`, etc.). Use `compare-runs.ts` to rank. Select the pair maximizing `joint_precision` while keeping `per_scope.universal.precision ≥ 0.95`.

Update `directive-detector-config.ts` DEFAULT_CONFIG if a pair other than (0.70, 0.85) wins. Commit.

If max joint < 88% → go to 03-06-03.
  </description>
</task>

<task id="03-06-03">
  <subject>Cycle 2 — regex + few-shot (only if Cycle 1 insufficient)</subject>
  <description>
1. From the Cycle 1 best run's `per_regex_family`, identify families with `rate < 0.50`.
2. Remove those families from `directive-detector-regex.ts`. Re-run `build-candidates.ts` to shrink the candidate set accordingly.
3. Inspect labeler-said-yes-but-detector-missed cases (requires cross-referencing the harness decisions[] with gold-labels.jsonl; Plan 03-05's `compare-runs.ts` exposes disagreement via confusion matrix). If a clear pattern exists: add a new regex family. Else: skip the add.
4. Swap 3 few-shot examples in `confirmation-few-shot.json` toward the dominant failure mode. Keep the 3:3:3 scope balance.
5. Re-run precision at Cycle-1 best thresholds. Commit.

If joint still < 88% → go to 03-06-04.
  </description>
</task>

<task id="03-06-04">
  <subject>Cycle 3 — prompt rewrite (only if Cycle 2 insufficient)</subject>
  <description>
1. Pick ONE of `confirmation-system-prompt.md` OR `scope-rubric-system-prompt.md` to rewrite (one structural change per run — attribution).
2. Rewrite with explicit focus on the dominant failure mode (from Cycle-2 run's confusion matrix).
3. Re-run precision. Commit.

If joint still < 88% → go to 03-06-05 (escalation).
  </description>
</task>

<task id="03-06-05">
  <subject>Escalation path (only if Cycle 3 insufficient)</subject>
  <description>
Post a teammate message to `team-lead` using the RESEARCH §1.6 escalation template:

```
Directive detector P2 iteration budget exhausted — cycle 3 joint precision=X%.
Cycles tried: threshold={values}, regex={changes}, prompt={summary}.
Top failure mode: {scope confusion | polarity flip | is_directive false positive}.
Options:
  (A) Lower fixture gate to Y% — risk Z
  (B) Corpus expansion to 30 sessions — estimated +M hours labeling
  (C) Rethink scope taxonomy — {specific proposal}
Awaiting direction.
```

STOP work. Do NOT silently lower the gate.

Only resume when `team-lead` replies with a direction. Record the direction + rationale in `03-CALIBRATION.md`.
  </description>
</task>

<task id="03-06-06">
  <subject>Ship — write 03-CALIBRATION.md</subject>
  <description>
Once `joint_precision ≥ 0.75` (gate lowered per 03-LABEL-AUDIT.md):

File: `.planning/phases/03-p2-directive-detector/03-CALIBRATION.md`

Structure:
```markdown
# P2 — Directive Detector — Calibration

**Calibrated:** <ISO-date>
**Final config:** threshold=X, threshold-universal=Y, model=glm-5.1:cloud

## Fixture
- 14 sessions, 526 user turns, <N> candidates, <M> labeled.

## Iteration log
| Run tag | joint | is_dir | scope|is_dir✓ | polarity|is_dir✓ | change |
|---|---:|---:|---:|---:|---|
| baseline | 0.84 | 0.92 | 0.91 | 0.95 | default config |
| t75u85   | 0.86 | 0.91 | 0.93 | 0.95 | threshold tune |
| fewshot1 | 0.91 | 0.94 | 0.94 | 0.96 | swap 3 few-shot ex to polarity-focused |
| FINAL    | 0.91 | 0.94 | 0.94 | 0.96 | shipped |

## Per-scope final
| Scope | candidates | precision |
|---|---:|---:|
| session   | 22 | 0.93 |
| project   | 58 | 0.91 |
| universal | 12 | 0.97 |

## Per-family final
(auto-insert from compare-runs.ts output)

## Decisions
- Which iteration branch taken; why.
- Any escalations / direction changes.

## Follow-ups for P8
- Rows with `data.possible_contradicts` — count: N.
- Rows with `data.related_to` — count: N.
- First reinforcement count distribution.
```

This file is the phase-completion commit's primary artifact.
  </description>
</task>

<task id="03-06-07">
  <subject>Benchmark gate — LongMemEval Oracle + LoCoMo</subject>
  <description>
After calibration locks the config:

1. **LongMemEval Oracle** — re-run with the post-P1 harness config (Ollama deepseek-coder-v2:16b baseline per task #22 commit). Hard floor: ≥ 88%. Result logged in `03-CALIBRATION.md` + `benchmarks/results/p2-postcalibration/longmemeval-*.log`.

2. **LoCoMo** — re-run same conditions. Floor: absolute regression ≤ 2pp vs post-P1 baseline (baseline to be pulled from task #23's output when it lands).

Dependency note: task #23 ("Run LongMemEval Oracle + LoCoMo benchmarks post-V17; record results") is still pending as of plan-writing time. If #23 hasn't produced post-P1 numbers before this task runs, block here and surface that dependency to team-lead rather than guess at a baseline.

If either gate fails: do NOT merge. Root-cause analysis + potential rollback of the detector's write-path (directive rows are additive; LoCoMo regression from additive rows would be surprising and warrants investigation). Document in `03-CALIBRATION.md`.
  </description>
</task>

<task id="03-06-08">
  <subject>Integration-confirm: first live tick writes a directive_rule row</subject>
  <description>
After ship:
1. Start Angel: `node dist/angel/index.cjs &`.
2. Wait one heartbeat cycle against the live DB (extractable from heartbeat logs at `context/logs/`).
3. Query `SELECT COUNT(*) FROM artifact WHERE kind='directive_rule'` — count > 0 indicates the pipeline ran end-to-end on real data.
4. Spot-check 2-3 rows: body + scope + polarity look correct.

Optional: add a `post-p2-smoke.test.ts` that runs a tiny live-DB-readonly check (CI-skipped — it's a deployment confirmation, not a unit test).
  </description>
</task>

<task id="03-06-09">
  <subject>Zero-diff check on injection surface</subject>
  <description>
From CONTEXT §gate_criteria: "Zero injection-path changes."

Run:
```
git diff <post-P1-baseline-commit>..HEAD -- src/assembler/ src/hooks/session-start.ts src/core/sections.ts
```

Expected output: empty. Only acceptable: a `directive_rule` kind-registry addition (if the kind is actually registered via anything other than the AFTER-INSERT trigger — which it shouldn't be; the trigger auto-registers on first insert). If output is non-empty, explain in `03-CALIBRATION.md` why, or roll back.

Record the diff check + result in the calibration doc.
  </description>
</task>

## Verification

- `03-CALIBRATION.md` exists with final metrics.
- `joint_precision ≥ 0.75` documented (gate lowered per 03-LABEL-AUDIT.md + 12-case user re-label of gold fixture 2026-04-21).
- LongMemEval Oracle ≥ 88%, LoCoMo regression ≤ 2pp documented.
- `bun run test` — all 2020 tests pass.
- `SELECT COUNT(*) FROM artifact WHERE kind='directive_rule'` > 0 on the live DB after first post-ship Angel tick.
- `git diff` on assembler/hooks/sections — empty.
