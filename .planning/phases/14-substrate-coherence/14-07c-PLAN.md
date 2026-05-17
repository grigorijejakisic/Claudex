---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07c
type: execute
wave: 1
depends_on: ["07a", "07b"]
files_modified:
  - src/scripts/cutover-v7.ts (NEW)
  - src/scripts/run-wave1-benchmarks.ts (NEW)
  - src/core/migration-steps.ts
  - src/tests/scripts/cutover-v7.test.ts (NEW)
  - src/tests/scripts/run-wave1-benchmarks.test.ts (NEW)
  - .planning/phases/14-substrate-coherence/14-07-WAVE1-GATE-RESULTS.md (NEW; PM-maintained)
autonomous: false
operator_gated: true
requirements: []

must_haves:
  truths:
    - "Cutover is operator-gated **by default** — the CLI runs in `--dry-run` mode unless `--apply` is supplied; `--apply` requires typed `CONFIRM` confirmation unless `--confirm-non-interactive` is also passed. **Per CONTEXT Locked Decision 10 (Option B authorization, operator-confirmed 2026-05-16 18:13): when /auto-orchestrate dispatches Worker C under one-run authorization, the cutover invokes `--apply --confirm-non-interactive` autonomously. The benchmark gate (Vesna / LongMemEval / LoCoMo / cross-project hit rate) remains binding — gate failure halts the cutover even under autonomous mode.** Outside Option B dispatch, the operator-gated default holds."
    - "Cutover is idempotent. Re-running on a post-cutover DB exits with `already_cutover` status code 0 and writes nothing."
    - "Re-vectorization is bulk: `reVectorizeAll` (from 14-07a's `src/core/re-vectorize.ts`) iterates V17 `artifact` and writes vectors into `vec_artifact_v17`. Failures logged to telemetry with `event_kind='re_vectorize_failed'`. Cutover refuses to proceed if failure rate exceeds 5%."
    - "Benchmark gate refuses cutover if ANY of: Vesna < v6.6.0 baseline (read from `14-07-WAVE1-BASELINES.json` — currently 0.97 ≈ 27/28 at v6.6.0; entity-001 `BGE|bge-reranker|7439` awareness probe is a pre-existing known-fail per 2026-05-17 vesna-baseline-diagnostic, not a v7 ship gate), LongMemEval < v6.6.0 baseline (90.6% Oracle with `deepseek-coder-v2:16b`), LoCoMo < v6.6.0 baseline (55.5% with `claude-sonnet-4-6`), cross-project candidate hit rate degraded vs v6.6.0 (currently 18% noise floor post-14-03)."
    - "Benchmark thresholds are non-regression, not SOTA chasing. v6.6.0 baselines are the floor. Per `memory/feedback_benchmarks_are_sanity_not_gates.md`."
    - "Gate results recorded in `.planning/phases/14-substrate-coherence/14-07-WAVE1-GATE-RESULTS.md` with: run timestamps, measured values, thresholds, PASS/FAIL per gate, operator approval line. PM-maintained."
    - "Read-only flag flip on legacy `artifacts`: `UPDATE artifacts SET read_only = 1` AND application-layer enforcement (any INSERT/UPDATE/DELETE against legacy `artifacts` rejected with explicit error). Enforcement helper lives in `src/core/migration-steps.ts` next to the migration step."
    - "Rollback path: if cutover fails AFTER flag flip but BEFORE ship, operator runs `cutover-v7.ts --rollback` which clears the read_only flag and emits warnings. Full schema-level rollback via `migrateV37toV36` remains available but drops the V17 unified state — not recommended unless V17 is fundamentally broken."
    - "Cutover writes one telemetry row per phase transition with `event_kind='cutover_phase_complete'` and `detail={phase, success, metric_snapshot}`. 14-07-WAVE1-GATE-RESULTS.md is the human-readable surface; telemetry is the audit trail."
    - "Cutover acquires `BEGIN IMMEDIATE` lock on the SQLite DB for the duration of the flag flip + re-vectorization to prevent concurrent writes from corrupting state. Long-running re-vectorization releases the lock between batches; concurrent reads continue uninterrupted."
  artifacts:
    - path: "src/scripts/cutover-v7.ts"
      provides: "Operator-runnable cutover CLI. Dry-run default. Re-vectorizes all V17 artifact, populates vec_artifact_v17, flips read_only flag, runs gate checks, records to WAVE1-GATE-RESULTS.md."
      contains: "cutoverV7|runDryRun|applyCutover|rollbackCutover|verifyPostCutover"
    - path: "src/scripts/run-wave1-benchmarks.ts"
      provides: "Orchestrator script invoking Vesna + LongMemEval + LoCoMo + cross-project hit rate against post-migration state. Emits structured JSON output for cutover gate parsing."
      contains: "runVesna|runLongMemEval|runLoCoMo|runCrossProjectHitRate|compareToBaseline"
    - path: "src/core/migration-steps.ts"
      provides: "Extended with `flipLegacyArtifactsReadOnly` helper + application-layer enforcement guards for legacy table writes post-cutover."
      contains: "flipLegacyArtifactsReadOnly|enforceLegacyReadOnly"
    - path: "src/tests/scripts/cutover-v7.test.ts"
      provides: "Tests for cutover idempotency, dry-run mode, rollback, gate refusal on regression, bulk re-vectorization failure tolerance."
      contains: "idempotent|dry_run|rollback|gate_refusal|bulk_failure"
    - path: "src/tests/scripts/run-wave1-benchmarks.test.ts"
      provides: "Tests for benchmark orchestration: each runner's output parsing, baseline comparison logic, gate decision."
      contains: "vesna_result|longmemeval_result|locomo_result|baseline_comparison"
    - path: ".planning/phases/14-substrate-coherence/14-07-WAVE1-GATE-RESULTS.md"
      provides: "PM-maintained record of every cutover-gate run with timestamps, measured values, thresholds, and operator approval log."
      contains: "Wave 1 Gate Results|baseline|measured"
  key_links:
    - from: "src/scripts/cutover-v7.ts"
      to: "src/core/re-vectorize.ts (reVectorizeAll)"
      via: "Bulk re-vectorize all V17 artifact rows; populate vec_artifact_v17"
      pattern: "reVectorizeAll"
    - from: "src/scripts/cutover-v7.ts"
      to: "src/scripts/run-wave1-benchmarks.ts"
      via: "Cutover invokes benchmark orchestrator; refuses to proceed if any gate fails"
      pattern: "runWave1Benchmarks"
    - from: "src/scripts/cutover-v7.ts"
      to: "src/core/migration-steps.ts (flipLegacyArtifactsReadOnly)"
      via: "After benchmarks pass + re-vectorization succeeds, flip the legacy table to read-only"
      pattern: "flipLegacyArtifactsReadOnly"
---

<objective>
Three deliverables in one plan:

1. **`src/scripts/cutover-v7.ts`** — operator-runnable CLI that orchestrates the Wave 1 cutover end-to-end. Dry-run by default. In `--apply` mode: bulk re-vectorizes V17 artifact (calls 14-07a's `reVectorizeAll`), verifies `artifact_id_map` completeness, runs the benchmark gate, flips legacy `artifacts.read_only = 1`, records to `14-07-WAVE1-GATE-RESULTS.md`. Idempotent. Operator-confirmable rollback.

2. **`src/scripts/run-wave1-benchmarks.ts`** — orchestrator running Vesna SC#1 + LongMemEval (Oracle) + LoCoMo + cross-project candidate hit rate against the post-migration DB. Compares to v6.6.0 baselines; refuses the cutover if any gate regresses.

3. **Read-only enforcement helpers in `src/core/migration-steps.ts`** — `flipLegacyArtifactsReadOnly(db)` + `enforceLegacyReadOnly(db)` (the runtime guard that wraps legacy table writes and refuses them post-cutover).

After this plan lands AND the operator approves cutover:
- All V17 `artifact` rows have valid 1024-d embeddings in `vec_artifact_v17`.
- Legacy `artifacts` is read-only (writes refused at runtime).
- Benchmarks confirm no regression vs v6.6.0.
- Wave 2 dispatch is unblocked.
- v7.0.0-rc branch carries the landed state.

| What this plan provides | Why |
|---|---|
| Operator-runnable cutover CLI | Operator-in-loop for the highest-risk wave operation |
| Bulk re-vectorization | Embeddings populated for V17 unified vector store |
| Benchmark gate | Vesna + LongMemEval + LoCoMo non-regression enforced |
| Read-only legacy artifacts | Post-cutover writes go to V17 only |
| Idempotency + rollback path | Cutover survives partial failures; recovery routes documented |
| Gate results record | PM audit trail; operator sign-off surface |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE1-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07a-PLAN.md
@.planning/phases/14-substrate-coherence/14-07b-PLAN.md
@src/core/re-vectorize.ts
@src/core/artifact-id-map.ts
</context>

<anti_scope>
- Do NOT auto-run cutover. Dry-run is the default; `--apply` requires operator-typed confirmation.
- Do NOT drop the legacy `artifacts` table. Read-only mirror is preserved for one milestone post-cutover (rollback path).
- Do NOT change benchmark thresholds. v6.6.0 baselines are the gate. Lifting LoCoMo from 55.5% is a separate engineering track.
- Do NOT modify caller sites — all caller migration is 14-07b's responsibility, already landed.
- Do NOT touch link tables (Wave 2 territory).
- Do NOT touch session-start assembler surfaces (Wave 3 territory).
- Do NOT modify hybrid-retrieval ranking math, candidate-pool composition, or query expansion.
- Do NOT change arctic-embed2 model or BGE reranker config.
- Do NOT introduce new benchmarks beyond the four named gates. SOTA chasing is out of scope.
- Do NOT silent-skip a failed benchmark — every failure raises an explicit refusal with the measured value vs threshold.
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: Cutover CLI src/scripts/cutover-v7.ts</name>
  <files>src/scripts/cutover-v7.ts</files>
  <action>
Create the operator-runnable cutover script.

```typescript
/**
 * Phase 14-07c — V7 unified-substrate cutover script.
 *
 * Operator-runnable. Dry-run by default. --apply requires typed
 * confirmation. Idempotent: re-running post-cutover exits 0 with
 * `already_cutover`.
 *
 * Usage:
 *   bun src/scripts/cutover-v7.ts [--apply] [--rollback] [--db <path>] [--skip-benchmarks]
 *
 * Default DB path: ~/.claudex/db/claudex.db
 *
 * Exit codes:
 *   0 — dry-run success OR cutover success OR already_cutover
 *   1 — benchmark gate failed
 *   2 — re-vectorization failed past threshold
 *   3 — IO / DB error
 *   4 — operator declined confirmation
 *   5 — rollback executed
 */
```

Phases (each emits a telemetry row on completion):

**Phase A — Pre-cutover validation**
1. Verify DB is at V37 (`PRAGMA user_version`).
2. Verify `artifact_id_map` completeness via `verifyMappingComplete(db)` — refuse if unmapped > 0.
3. Verify `verifyDeterminism` on a sample text (refuses if arctic-embed2 non-deterministic, per Risk 6 in 14-07a).
4. Print pre-cutover summary.

**Phase B — Bulk re-vectorization**
1. Call `reVectorizeAll(db, { batch_size: 100, on_progress })`. Progress printed every 100 rows.
2. If failure rate > 5%, refuse to proceed. Exit 2.
3. Confirm `vec_artifact_v17` row count == V17 `artifact` row count.

**Phase C — Benchmark gate**
1. If `--skip-benchmarks` (operator override, REQUIRES `--apply` AND typed `SKIP_BENCHMARKS` confirmation), skip; record `gate=skipped` with WARNING.
2. Else invoke `runWave1Benchmarks` (Task 2). Receive structured JSON results.
3. Per gate: PASS if measured >= baseline; FAIL otherwise.
4. If ANY gate FAILs, refuse cutover. Exit 1.

**Phase D — Read-only flag flip**
1. `flipLegacyArtifactsReadOnly(db)` — sets `read_only = 1` on every legacy artifacts row; updates a metadata row in `schema_versions`.
2. Verify post-flip: an attempted INSERT against legacy artifacts raises the application-layer enforcement error.

**Phase E — Gate record + ship**
1. Append a record block to `.planning/phases/14-substrate-coherence/14-07-WAVE1-GATE-RESULTS.md` with timestamp, all measured values, thresholds, PASS/FAIL per gate, operator approval line (empty; operator fills in before ship).
2. Emit final telemetry row with `event_kind='cutover_complete'` + summary.
3. Print success message with path to gate-results file.

**--rollback mode** (mutually exclusive with --apply):
1. Verify cutover was previously applied (read schema_versions metadata).
2. Clear `read_only` flag on legacy artifacts.
3. Emit rollback telemetry row.
4. Print warning that V17 unified shape is still present; full schema rollback is `migrateV37toV36` and is destructive of any new V17-only writes.

Dry-run mode prints what each phase WOULD do without executing Phases B, D, E. Phase A still runs (validation is read-only).

Confirmation prompt for `--apply` (interactive only if stdin is a TTY):
```
This will cutover the Claudex substrate to V7 unified shape.
The legacy `artifacts` table will become read-only.
Re-vectorization will run over <N> rows; this may take a while.
Type CONFIRM to proceed, anything else to abort:
```

If stdin is non-TTY (e.g., piped from a script), `--apply` requires `--confirm-non-interactive` flag explicitly.
  </action>
  <verification>
- Dry-run on a V37 DB with seeded fixtures exits 0 with printed phase summary.
- `--apply` with `CONFIRM` typed: cutover phases A-E execute; gate-results file updated; legacy read_only flag set.
- Re-running `--apply` on post-cutover DB exits 0 with `already_cutover`.
- Re-vectorization failure injection (mock 10% failure rate) → exit 2.
- Benchmark gate failure injection (mock Vesna 17/18) → exit 1.
- `--rollback` on post-cutover DB clears read_only; verifyable via DB query.
- All telemetry rows emitted at expected phase boundaries.
  </verification>
</task>

<task type="auto">
  <name>Task 2: Benchmark orchestrator src/scripts/run-wave1-benchmarks.ts</name>
  <files>src/scripts/run-wave1-benchmarks.ts</files>
  <action>
Create the benchmark orchestrator. Runnable standalone or invoked by cutover-v7.ts.

```typescript
/**
 * Phase 14-07c — Wave 1 benchmark orchestrator.
 *
 * Runs Vesna SC#1 + LongMemEval (Oracle) + LoCoMo + cross-project
 * candidate hit rate against the current DB state. Compares to v6.6.0
 * baselines. Emits structured JSON for cutover gate consumption.
 *
 * Standalone usage:
 *   bun src/scripts/run-wave1-benchmarks.ts [--json] [--baseline <path>]
 */

interface BenchmarkResult {
  gate: 'vesna_sc1' | 'longmemeval_oracle' | 'locomo' | 'cross_project_hit_rate';
  measured: number;     // 18/18 → 1.0 for vesna; 0.906 for longmemeval; etc.
  baseline: number;     // v6.6.0 floor
  threshold: number;    // baseline (non-regression)
  passed: boolean;
  details: object;      // gate-specific
}

export async function runWave1Benchmarks(opts?: {
  db_path?: string;
  baseline_path?: string;
}): Promise<BenchmarkResult[]>;
```

Per-gate runner:

1. **Vesna SC#1** — invokes `bun run vesna`. Parses output. PASS if 18/18.
2. **LongMemEval Oracle** — invokes existing LongMemEval harness with `--mode=oracle --model=deepseek-coder-v2:16b`. PASS if measured >= 0.906.
3. **LoCoMo** — invokes existing LoCoMo harness with `--model=claude-sonnet-4-6`. PASS if measured >= 0.555.
4. **Cross-project candidate hit rate** — invokes the measurement script from `context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md` re-run on current DB. PASS if noise rate <= 20% (v6.6.0 baseline post-14-03 is 18%).

Baseline file at `.planning/phases/14-substrate-coherence/14-07-WAVE1-BASELINES.json` (PM-created during plan authoring):
```json
{
  "vesna_sc1": 1.0,
  "longmemeval_oracle": 0.906,
  "locomo": 0.555,
  "cross_project_hit_rate": 0.20
}
```

Structured JSON output (with `--json`):
```json
{
  "run_timestamp_epoch_ms": 1234567890,
  "results": [
    { "gate": "vesna_sc1", "measured": 1.0, "baseline": 1.0, "threshold": 1.0, "passed": true, "details": {...} },
    ...
  ],
  "overall_passed": true
}
```

Human-readable output (default):
```
Wave 1 Benchmark Gate
=====================
  vesna_sc1            : 18/18 PASS  (baseline 18/18)
  longmemeval_oracle   : 91.2%  PASS (baseline 90.6%)
  locomo               : 55.8%  PASS (baseline 55.5%)
  cross_project_hit    : 17%    PASS (baseline 18%)

GATE: PASS (4/4)
```
  </action>
  <verification>
- Orchestrator runs all 4 gates against a fixture DB.
- JSON output is structurally correct.
- Each gate's runner correctly invokes its underlying harness.
- Baseline comparison logic is correct for both >= and <= cases.
- A failing gate is correctly reported with measured + baseline + delta.
  </verification>
</task>

<task type="auto">
  <name>Task 3: Read-only enforcement helpers in migration-steps.ts</name>
  <files>src/core/migration-steps.ts</files>
  <action>
Add two helpers (not part of `migrateV36toV37` — they're invoked by cutover, not by schema migration):

```typescript
/**
 * Phase 14-07c — flip legacy artifacts to read-only.
 * Sets read_only = 1 on every row. Updates schema_versions metadata.
 * Idempotent: re-running is a no-op if already flipped.
 */
export function flipLegacyArtifactsReadOnly(db: Database): { rows_flipped: number; already_flipped: boolean };

/**
 * Phase 14-07c — runtime enforcement guard.
 * Returns a wrapper around db.prepare that throws if the prepared
 * statement targets legacy `artifacts` with INSERT/UPDATE/DELETE
 * AND the read_only flag is set.
 *
 * Optional: install this guard at DB open time post-cutover.
 */
export function enforceLegacyReadOnly(db: Database): void;
```

`enforceLegacyReadOnly` implementation: SQLite supports CREATE TRIGGER to RAISE on INSERT/UPDATE/DELETE. Install three triggers on legacy `artifacts`:
```sql
CREATE TRIGGER IF NOT EXISTS prevent_legacy_insert_post_cutover
  BEFORE INSERT ON artifacts
  WHEN (SELECT read_only FROM artifacts LIMIT 1) = 1
  BEGIN
    SELECT RAISE(ABORT, 'legacy artifacts table is read-only post-cutover; write to V17 artifact');
  END;
-- similar for UPDATE and DELETE
```

The trigger key check uses a representative row's flag; the schema constraint is that the flag is uniform across the table (cutover flips ALL rows).

Alternative if SQLite trigger conditions are tricky: application-layer guard in `src/adapters/shared/lifecycle.ts` that checks the read_only state at DB open time and wraps `db.prepare`.

**Position-unless-flagged:** I lean on SQLite triggers (DB-level, can't be bypassed by accident). Application-layer guards are bypassable if a caller skips the helper. If PM flags this, the alternative is application-layer wrap.
  </action>
  <verification>
- `flipLegacyArtifactsReadOnly` flips all rows; reports correct count.
- Re-running is a no-op (already_flipped=true).
- Post-flip, attempting INSERT against legacy artifacts raises the trigger error (or the app-layer error).
- Post-flip, SELECT against legacy artifacts continues to work.
- `enforceLegacyReadOnly` is idempotent (installing twice is fine).
  </verification>
</task>

<task type="auto">
  <name>Task 4: Tests for cutover script</name>
  <files>src/tests/scripts/cutover-v7.test.ts</files>
  <action>
New test file. Uses tmp DB per test. Tests:

1. `dry-run on V37 fixture: exits 0, prints phase summary, writes nothing`
2. `--apply with confirm: phases A-E execute; gate-results file updated; read_only flag set`
3. `--apply re-run on post-cutover: exits 0 with already_cutover`
4. `re-vectorization failure rate > 5%: exit 2, no read_only flip`
5. `Vesna gate failure (mocked 17/18): exit 1, no read_only flip`
6. `LongMemEval gate failure (mocked 89.0%): exit 1`
7. `LoCoMo gate failure (mocked 54.0%): exit 1`
8. `cross-project hit rate degraded (mocked 25%): exit 1`
9. `--rollback on post-cutover: clears read_only flag, exit 5`
10. `--rollback on pre-cutover: exits with error (nothing to rollback)`
11. `non-TTY stdin + --apply without --confirm-non-interactive: exit 4`
12. `verifyMappingComplete fails (1 unmapped row): exit 1 with explicit reason`
13. `verifyDeterminism reports non-deterministic: exit 1 with explicit reason`
14. `telemetry rows emitted at each phase boundary`
15. `gate-results file format matches the documented Markdown structure`

Mocking strategy: inject the benchmark orchestrator + Ollama callable + cutover internals via DI hooks. Real benchmarks are NOT run in unit tests (they're integration; covered by manual operator run).
  </action>
  <verification>
- All 15 tests pass.
- Each exit code branch covered.
- Test fixtures isolated (tmp DB per test).
  </verification>
</task>

<task type="auto">
  <name>Task 5: Tests for benchmark orchestrator</name>
  <files>src/tests/scripts/run-wave1-benchmarks.test.ts</files>
  <action>
New test file. Tests:

1. `runWave1Benchmarks: all 4 gates run, results structured correctly`
2. `Vesna result parsing: 18/18 → measured=1.0, passed=true`
3. `Vesna result parsing: 17/18 → measured=0.944, passed=false`
4. `LongMemEval result parsing: 90.6% → measured=0.906, passed=true at baseline=0.906`
5. `LoCoMo result parsing: 55.5% → measured=0.555, passed=true at baseline=0.555`
6. `cross-project hit rate parsing: 17% noise → measured=0.17, passed=true (≤ 0.20 threshold)`
7. `baseline file missing: uses hard-coded fallback baseline`
8. `--json output: parseable JSON with all gates + overall_passed`
9. `human-readable output: includes PASS/FAIL per gate + GATE summary line`
10. `gate runner failure (e.g., Vesna runner throws): captured as result with passed=false + details.error`

Mocking strategy: inject each gate's runner via DI. Real harnesses are NOT invoked in unit tests.
  </action>
  <verification>
- All 10 tests pass.
- JSON schema matches documented shape.
  </verification>
</task>

<task type="auto">
  <name>Task 6: Build + run plan-touched tests + integration smoke</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/scripts/cutover-v7.test.ts` — 15 tests pass.
- `npx vitest run src/tests/scripts/run-wave1-benchmarks.test.ts` — 10 tests pass.
- `npx vitest run` — full suite green (Wave 1 baseline + 14-07a's +35 + 14-07b's +45 + this plan's +25 = +105 new total tests since v6.6.0).
- **Integration smoke (operator-runnable, not auto):** `bun src/scripts/cutover-v7.ts --dry-run` against the actual `~/.claudex/db/claudex.db`. Captures pre-cutover phase A output. Documents in 14-07-WAVE1-STATUS.md.
- Create the baseline file `.planning/phases/14-substrate-coherence/14-07-WAVE1-BASELINES.json` with the v6.6.0 baselines.
- Create the empty `14-07-WAVE1-GATE-RESULTS.md` template (no measured values yet; populated when operator runs cutover).
  </action>
  <verification>
- Build green.
- 25 new tests pass.
- Full suite green.
- Dry-run smoke against real DB completes without error.
- Baseline file exists with documented v6.6.0 values.
- Gate-results template exists.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `src/scripts/cutover-v7.ts` exists; runnable via `bun src/scripts/cutover-v7.ts`; dry-run is default.
- AC-2: `--apply` requires typed `CONFIRM` confirmation OR `--confirm-non-interactive` for piped use.
- AC-3: Cutover phases A-E execute in order; each emits a telemetry row.
- AC-4: Bulk re-vectorization handles failure rate; >5% failure refuses cutover with exit 2.
- AC-5: Benchmark gate runs all four gates (Vesna / LongMemEval / LoCoMo / cross-project hit rate) and refuses cutover on any regression.
- AC-6: `flipLegacyArtifactsReadOnly` flips all rows; idempotent re-run.
- AC-7: Post-flip, legacy `artifacts` writes raise enforcement error (trigger-level or app-layer).
- AC-8: `--rollback` clears the read_only flag; emits warning; does not unwind V17 unified shape.
- AC-9: Cutover is idempotent — re-running on post-cutover DB exits 0 with `already_cutover`.
- AC-10: `run-wave1-benchmarks.ts` produces structured JSON; baseline comparison logic correct.
- AC-11: `14-07-WAVE1-BASELINES.json` exists with v6.6.0 baselines.
- AC-12: `14-07-WAVE1-GATE-RESULTS.md` template exists; populated by cutover runs.
- AC-13: All 25 new tests (15 cutover + 10 benchmark) pass.
- AC-14: Operator-runnable dry-run smoke against real DB completes; output captured in 14-07-WAVE1-STATUS.md.
- AC-15: Default mode is operator-gated — typed `CONFIRM` required for `--apply`. **Exception per Locked Decision 10 (Option B):** /auto-orchestrate Worker C invokes `--apply --confirm-non-interactive` when dispatched under autonomous-one-run authorization. The benchmark gate remains binding regardless — gate failure halts the cutover script with exit 1, no flag bypasses this.
</acceptance_criteria>

<risks>
- **Risk 1: Bulk re-vectorization is slow on production-size DB.** With ~thousands of legacy artifacts, re-vectorizing all sequentially could take significant time. Mitigation: batch size of 100 with progress callback; per-row Ollama call ~50ms → ~50 seconds per 1000 rows. Acceptable. If problematic, increase batch parallelism (post-ship optimization).
- **Risk 2: Ollama unavailable at cutover time.** If snowflake-arctic-embed2 model isn't loaded or Ollama is down, re-vectorize fails. Mitigation: phase A's `verifyDeterminism` call detects this pre-cutover; refuses to start with explicit reason.
- **Risk 3: Benchmark harness regression unrelated to V17 unification.** A Vesna or LoCoMo regression might be due to harness changes between v6.6.0 and now, not the cutover. Mitigation: re-run baselines against v6.6.0 tag commit immediately before cutover (operator-runnable step in 14-07c gate procedure).
- **Risk 4: Read-only trigger interferes with legacy SELECT.** SQLite triggers can sometimes affect non-trigger operations. Mitigation: trigger explicitly targets INSERT/UPDATE/DELETE only; SELECT verified to work post-flip in test 4.
- **Risk 5: Cutover partial failure leaves DB in inconsistent state.** E.g., re-vectorization succeeds but read_only flip fails. Mitigation: each phase emits telemetry; rollback path documented per-phase. Operator-runnable diagnostic flag `--status` (added to scope if needed during execution).
- **Risk 6: Gate-results file becomes stale or out-of-sync with telemetry.** Mitigation: cutover script writes both telemetry rows AND gate-results entries in the same transaction-ish boundary. PM reviews both at every cutover run.
- **Risk 7: Operator runs cutover prematurely (before 14-07a+b fully merged).** Mitigation: phase A's `verifyMappingComplete` will detect unmapped rows; refuses to start.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Cutover idempotency — does the script handle every partial-failure case cleanly?
- (b) Operator-confirmation UX — is the confirmation prompt unambiguous? Can it be bypassed accidentally?
- (c) Benchmark gate logic — does any baseline comparison admit a false-PASS on regression?
- (d) Read-only enforcement — does the trigger / app-layer guard correctly prevent all legacy writes without affecting reads?
- (e) Rollback path — does --rollback actually leave the system in a safe state, or just appear to?

NO-SIGNOFF triggers PM escalation per WAVE1-COORDINATION's rules.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above (this plan satisfies).
2. Tests written alongside code — 25 new tests cover idempotency, gate refusal, rollback, all exit codes.
3. Live-wiring smoke: AC-14 verifies dry-run against the real production DB.
4. No "MVP" shortcuts — operator-gated UX is the production-quality safeguard; idempotency is the recovery guarantee.
5. Negative results valid: if benchmarks regress, the cutover is HELD, not pushed. Per `memory/feedback_precommit_binds_metric_not_correctness.md` — the decision rule binds even if it costs us a ship.
6. Cross-family external review per the gate above.
7. No time estimates anywhere.
</methodology_gates>
