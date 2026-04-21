---
plan_id: 03-05
phase: 3
wave: 2
depends_on:
  - 03-01
  - 03-02
  - 03-03
files_modified:
  - src/benchmarks/directive-detector/run-precision.ts
  - src/benchmarks/directive-detector/compare-runs.ts
  - src/benchmarks/directive-detector/runbook.md
  - src/tests/benchmarks/run-precision.test.ts
autonomous: true
requirements:
  - EXTR-04
---

# Plan 03-05: Precision Harness + Iteration Runbook

## Objective

Ship a re-runnable precision harness that consumes `gold-labels.jsonl` + runs the detector in `dryRun` mode over `fixture-candidates.jsonl`, emits a JSON run result with joint + per-field metrics. Also ship the iteration-cycle runbook (from RESEARCH §1.6) as a committed `runbook.md` checked against actual data structures.

## Must-haves (goal-backward)

- `run-precision.ts` CLI emits a single JSON file per run under `.planning/phases/03-p2-directive-detector/fixtures/runs/<ISO_timestamp>.json`.
- Metrics emitted: `joint_precision`, `is_directive_precision`, `scope_precision_given_is_directive_correct`, `polarity_precision_given_is_directive_correct`, per-regex-family breakdown, per-scope breakdown, raw confusion matrix (serializable).
- Detector runs in `dryRun: true` — no DB mutation.
- Comparable across runs: `compare-runs.ts` emits a markdown table diffing two run JSONs.
- `runbook.md` codifies RESEARCH §1.6 tuning decision tree as executable markdown — each decision branch names a concrete next command.
- Tests: run-precision produces metrics given a fixed canned input; compare-runs emits the expected markdown given two fixed JSONs.

## Tasks

<task id="03-05-01">
  <subject>Create run-precision.ts</subject>
  <description>
CLI entry point:
```
bun run src/benchmarks/directive-detector/run-precision.ts
  [--candidates=.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates.jsonl]
  [--labels=.planning/phases/03-p2-directive-detector/fixtures/gold-labels.jsonl]
  [--threshold=0.70]
  [--threshold-universal=0.85]
  [--model=glm-5.1:cloud]
  [--output-dir=.planning/phases/03-p2-directive-detector/fixtures/runs/]
  [--tag=<optional run tag>]
```

Flow:
1. Load candidates JSONL and labels JSONL.
2. Inner-join by `candidate_id`; emit warning if any candidate lacks a label (skip those).
3. Feed each candidate to `extractDirectivesFromSession`-like logic in `dryRun: true`. Since `extractDirectivesFromSession` takes a session_id and reads from DB, refactor: Plan 03-01 must expose a lower-level `processCandidate(db, candidate, config)` that the harness can call per-candidate. Do not round-trip through the DB — the harness wants pure input → decision output.
4. For each candidate, collect:
   - `labeler.is_directive` vs. `detector.is_directive`
   - `labeler.scope` vs. `detector.scope`
   - `labeler.polarity` vs. `detector.polarity`
   - `detector.confidence`
   - `candidate.matched_families[0]` (for per-family breakdown)
5. Compute metrics (RESEARCH §1.5):
   - `joint_precision`: numerator = count where `is_directive ✓ AND scope ✓ AND polarity ✓` AND detector said `is_directive=true`; denominator = count where detector said `is_directive=true`.
   - `is_directive_precision`: numerator = count where `detector.is_directive=true AND labeler.is_directive=true`; denominator = count where detector said true.
   - `scope_precision | is_directive=correct`: of the subset where both detector and labeler said `is_directive=true`, fraction with matching `scope`.
   - `polarity_precision | is_directive=correct`: same subset, matching `polarity`.
   - `per_regex_family[family] = {candidates, confirmed, joint_correct, rate}`
   - `per_scope[scope] = {...}` — universal counted separately (double-weight in escalation analysis).
6. Persist JSON:
   ```json
   {
     "run_id": "<ISO>",
     "tag": "<optional>",
     "config": { "threshold": 0.70, "threshold_universal": 0.85, "model": "glm-5.1:cloud" },
     "corpus": { "candidates": N, "labeled": M, "confirmed_by_detector": K },
     "metrics": {
       "joint_precision": 0.xx,
       "is_directive_precision": 0.xx,
       "scope_precision_given_correct": 0.xx,
       "polarity_precision_given_correct": 0.xx
     },
     "per_regex_family": {...},
     "per_scope": {...},
     "confusion_matrix": [...],
     "decisions": [ /* full DetectionRecord per candidate for audit */ ]
   }
   ```
7. Print a one-line status to stdout: `run=<ts> joint=<xx.x>% → {ship|noise-bound|tune}`. Exit code 0 always; failure communication is in the metrics, not the exit code. (Rationale: iteration wants to see the number, not a CI gate.)
  </description>
</task>

<task id="03-05-02">
  <subject>Expose processCandidate() from directive-detector.ts</subject>
  <description>
Amend Plan 03-01's `directive-detector.ts` to export a per-candidate entry point usable by the harness:

```ts
export interface CandidateInput {
  session_id: string;
  turn_idx: number;
  raw_text: string;
  matched_families: string[];
  context: Array<{ role: 'user'|'assistant', turn_offset: number, text: string }>;
}

export async function processCandidate(
  candidate: CandidateInput,
  embedCtx: { embed: (text: string) => Promise<number[]> },
  llmCtx:   { confirm: (sys: string, prompt: string) => Promise<string>,
              relation: (sys: string, prompt: string) => Promise<string> },
  dedupCtx: { lookup: (embedding: number[], scope: string, projectId: string) =>
                      Promise<Array<{ id: string, cosine: number, body: string, data: unknown }>> },
  projectId: string,
  config: DirectiveDetectorConfig,
): Promise<DetectionRecord>;
```

No DB handle — purely functional over injectable context. The heartbeat-path `extractDirectivesFromSession` wraps `processCandidate` with DB-backed `embedCtx`/`llmCtx`/`dedupCtx`. The harness wraps it with no-DB, real-LLM context (for dryRun) + a trivial dedup stub (the harness is stateless — every candidate is "fresh" for metric purposes; dedup is out of scope for the precision metric, which measures is_directive + scope + polarity).

This is a small refactor of Plan 03-01's internals — the external `extractDirectivesFromSession` API is unchanged. Add a task dependency note to Plan 03-01 execution: "Task 03-01-03 MUST produce an internal structure supporting this split." (Done already in the task description — `collectCandidates`, `formatContextForLLM`, `parseConfirmation` are pure helpers. The split is cheap.)
  </description>
</task>

<task id="03-05-03">
  <subject>Create compare-runs.ts</subject>
  <description>
CLI:
```
bun run src/benchmarks/directive-detector/compare-runs.ts <run-a.json> <run-b.json>
```

Output to stdout: a markdown table diffing top-level metrics + per-regex-family rows where rate-diff > 2pp. Example:
```
| Metric | run-a | run-b | Δ |
|---|---:|---:|---:|
| joint_precision         | 84.0% | 89.0% | +5.0 |
| is_directive_precision  | 92.0% | 93.0% | +1.0 |
...

Per-family (only families with |Δ| > 2pp):
| Family          | run-a | run-b | Δ |
|---|---:|---:|---:|
| always_emphasis | 78%   | 88%   | +10 |
| negation_dont   | 91%   | 85%   | -6  |
```

Used manually during iteration to attribute gains/regressions to specific changes.
  </description>
</task>

<task id="03-05-04">
  <subject>Create runbook.md — iteration decision tree</subject>
  <description>
`src/benchmarks/directive-detector/runbook.md` codifies RESEARCH §1.6. Markdown with one section per decision branch, each naming a concrete shell command. Example skeleton:

```markdown
# Directive Detector Iteration Runbook

## 1. Run the precision harness
bun run src/benchmarks/directive-detector/run-precision.ts --tag=<name>

## 2. Read `joint_precision` from run JSON.

### Branch A: joint_precision ≥ 92% → SHIP
- Commit config, run full benchmark suite (LongMemEval + LoCoMo).
- Record final metrics in `.planning/phases/03-p2-directive-detector/` completion commit.

### Branch B: 88% ≤ joint < 92% → NOISE-BOUND, EXPAND CORPUS
- Add sessions 22-36 to `FIXTURE_SESSIONS`.
- `bun run .../build-candidates.ts --output=...fixture-candidates-ext.jsonl`
- `bun run .../label-candidates.ts --input=...fixture-candidates-ext.jsonl --output=...gold-labels-ext.jsonl`
- Review pass + re-run precision with merged fixture.

### Branch C: joint < 88% → 3-CYCLE TUNE

#### Cycle 1 — threshold sweep
- Set `--threshold` ∈ {0.65, 0.70, 0.75, 0.80}; `--threshold-universal` ∈ {0.80, 0.85, 0.90}.
- Pick the pair maximizing joint while keeping `per_scope.universal.precision` ≥ 95%.
- If max < 88% → Cycle 2.

#### Cycle 2 — regex + few-shot
- Inspect `per_regex_family`; drop families with <50% confirm rate from `DIRECTIVE_REGEX_FAMILIES`.
- Examine false-negatives (labeler said yes, detector missed): add new regex families if obvious pattern.
- Swap 3 few-shot examples in `confirmation-few-shot.json` toward dominant failure mode.
- Re-run at Cycle-1 best threshold. If < 88% → Cycle 3.

#### Cycle 3 — prompt rewrite
- Rewrite `confirmation-system-prompt.md` OR `scope-rubric-system-prompt.md` (not both — attribution).
- Re-run. If still < 88% → ESCALATE.

### Escalation template
[paste the escalation message format from RESEARCH §1.6]
```

No code in runbook — just commands + decisions. Make sure commands are copy-pasteable.
  </description>
</task>

<task id="03-05-05">
  <subject>Write run-precision.test.ts — metric correctness</subject>
  <description>
- Mock the detector context: feed 10 canned candidates with canned labeler + detector outputs; assert the computed metrics match hand-calculated numbers.
- Edge cases: denominator=0 (no detector confirmations) → `joint_precision: null` not NaN.
- `compare-runs.ts`: feed two canned JSONs; assert markdown output matches an inline snapshot.
- Does NOT run the actual LLM — all confirm/relation outputs are canned. Fast (<1s).
  </description>
</task>

## Verification

- `bun run build` succeeds.
- `bun run test src/tests/benchmarks/run-precision.test.ts` — all pass.
- `bun run test` — all pre-existing tests still pass.
- Smoke: run the harness once with a 5-candidate canned subset via CLI; output JSON file contains all required keys.
- `runbook.md` renders cleanly and every `bun run ...` command quoted matches a real file under `src/benchmarks/directive-detector/`.
