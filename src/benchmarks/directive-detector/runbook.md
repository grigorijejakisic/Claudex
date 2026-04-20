# Directive Detector — Iteration Runbook

Codifies Phase 3 RESEARCH §1.6 into executable steps. Every decision branch
names a concrete shell command you can copy-paste. If you need to pause
mid-cycle, commit the current run JSON and the config / prompt / regex
change that produced it — iteration cycles are auditable only when each run
has a distinct `--tag`.

All commands assume `bun run build` has been run since the last source edit.

---

## 1. Run the precision harness

```
node dist/benchmarks/directive-detector/run-precision.cjs --tag=<name>
```

Output lands at `.planning/phases/03-p2-directive-detector/fixtures/runs/<iso>_<tag>.json`.
The CLI prints a single summary line:

```
run=<iso>_<tag> joint=<xx.x>% skipped=0 → {ship|noise-bound|tune}
```

Read `joint_precision` from the run JSON to route the decision below.

---

## 2. Branch A — `joint_precision ≥ 92%` → SHIP

1. Commit the current config + prompt assets + regex as the baseline.
2. Run the full benchmark suite to confirm no regression:
   ```
   bun run bench:longmemeval
   bun run bench:locomo
   ```
3. Record metrics in the phase completion commit message.
4. Close the phase. No further iteration.

---

## 3. Branch B — `88% ≤ joint < 92%` → NOISE-BOUND (expand corpus)

The gate is within the confidence interval for 106 candidates. Double the
corpus before assuming real under-performance.

1. Extend `FIXTURE_SESSIONS` in `src/benchmarks/directive-detector/fixture-sessions.ts`
   with sessions 22–36 (15 additional sessions, logs under `context/sessions/2026-03-2?_session-*.md`).
2. Rebuild the candidate file:
   ```
   node dist/benchmarks/directive-detector/build-candidates.cjs \
     --output=.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates-ext.jsonl
   ```
3. Re-label the extended set:
   ```
   node dist/benchmarks/directive-detector/label-candidates.cjs label \
     --input=.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates-ext.jsonl \
     --output=.planning/phases/03-p2-directive-detector/fixtures/gold-labels-ext.jsonl
   ```
4. Run the review pass (human-in-the-loop):
   ```
   node dist/benchmarks/directive-detector/label-candidates.cjs review \
     --labels=.planning/phases/03-p2-directive-detector/fixtures/gold-labels-ext.jsonl \
     --candidates=.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates-ext.jsonl
   ```
5. Re-run the harness against the merged fixture (or just the extended one):
   ```
   node dist/benchmarks/directive-detector/run-precision.cjs \
     --candidates=.planning/phases/03-p2-directive-detector/fixtures/fixture-candidates-ext.jsonl \
     --labels=.planning/phases/03-p2-directive-detector/fixtures/gold-labels-ext.jsonl \
     --tag=ext-corpus
   ```
6. Go back to Step 1 of this runbook with the new joint number.

---

## 4. Branch C — `joint < 88%` → 3-CYCLE TUNE

Three structured cycles, one knob per cycle. Budget is strict: if cycle 3
fails, escalate. Do NOT silently lower the precision gate.

### Cycle 1 — threshold sweep

Sweep both thresholds; pick the pair that maximizes joint while keeping
`per_scope.universal.rate` ≥ 95% (universal errors leak across every project).

```
for t in 0.65 0.70 0.75 0.80; do
  for u in 0.80 0.85 0.90; do
    node dist/benchmarks/directive-detector/run-precision.cjs \
      --threshold=$t --threshold-universal=$u --tag=cycle1_t${t}_u${u}
  done
done
```

Pick the best (t, u) pair:
```
node dist/benchmarks/directive-detector/compare-runs.cjs <baseline.json> <best.json>
```

- If best joint ≥ 88% → go back to Step 1 with the new thresholds.
- Else → Cycle 2.

### Cycle 2 — regex + few-shot

Open the latest run JSON. Inspect:

1. `per_regex_family` — drop families with `rate < 0.5` from
   `src/intelligence/directive-detector-regex.ts`. These are noise sources.
2. `confusion_matrix.detector_false_labeler_true` — these are the
   false-negatives (labeler said yes, detector said no). Scan the underlying
   text for new regex families to ADD (keep it tight; one new family at a
   time).
3. Swap 3 examples in `src/intelligence/directive-detector-prompts/confirmation-few-shot.json`
   toward the dominant failure mode (whichever field — is_directive, scope,
   or polarity — has the worst diagnostic).

Re-run at the Cycle-1 best thresholds:
```
bun run build
node dist/benchmarks/directive-detector/run-precision.cjs \
  --threshold=<best> --threshold-universal=<best> --tag=cycle2
```

- If joint ≥ 88% → Step 1.
- Else → Cycle 3.

### Cycle 3 — prompt rewrite

One structural change. Either edit
`src/intelligence/directive-detector-prompts/confirmation-system-prompt.md`
OR `scope-rubric-system-prompt.md`, NOT both (attribution matters).

After the edit:
```
bun run build
node dist/benchmarks/directive-detector/run-precision.cjs \
  --threshold=<cycle1 best> --threshold-universal=<cycle1 best> --tag=cycle3
```

- If joint ≥ 88% → Step 1.
- Else → Escalate.

---

## 5. Escalation template

Paste as a message to `team-lead`:

```
Directive detector P2 iteration budget exhausted — cycle 3 joint precision=X.X%.
Cycles tried:
  - Cycle 1 thresholds: {(t_general, t_universal) tried, best pair}
  - Cycle 2 regex changes: {families dropped, families added}
  - Cycle 2 few-shot swaps: {3 replacements, failure mode targeted}
  - Cycle 3 prompt edit: {which file, one-line summary of the change}
Top failure mode: {is_directive FP | scope confusion | polarity flip}
Top false-positive examples:
  1. <candidate_id> — <raw_text excerpt>
  2. ...
Top false-negative examples:
  1. <candidate_id> — <raw_text excerpt>
  2. ...
Options:
  (A) Lower fixture gate to Y% — risk: {specific concern}
  (B) Corpus expansion to 30 sessions — estimated +M hours labeling
  (C) Rethink scope taxonomy — specific proposal
Awaiting direction.
```

---

## 6. Comparison helper

Diff any two runs with:
```
node dist/benchmarks/directive-detector/compare-runs.cjs \
  .planning/.../runs/<run-a>.json \
  .planning/.../runs/<run-b>.json
```
Markdown to stdout — copy into the escalation or phase-completion commit.
