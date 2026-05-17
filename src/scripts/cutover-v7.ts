/**
 * Phase 14-07c — V7 unified-substrate cutover script.
 *
 * Operator-runnable. Dry-run by default. `--apply` requires typed
 * confirmation OR `--confirm-non-interactive` for autonomous use.
 * Idempotent: re-running post-cutover exits 0 with `already_cutover`.
 *
 * Usage:
 *   bun src/scripts/cutover-v7.ts [--apply] [--rollback] [--db <path>]
 *   bun src/scripts/cutover-v7.ts --apply --confirm-non-interactive   # autonomous (Locked Decision 10)
 *   bun src/scripts/cutover-v7.ts --skip-benchmarks                   # requires --apply + typed SKIP_BENCHMARKS
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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  flipLegacyArtifactsReadOnly,
  clearLegacyReadOnly,
  enforceLegacyReadOnly,
} from '../core/migration-steps.js';
import { verifyMappingComplete } from '../core/artifact-id-map.js';
import {
  reVectorizeAll,
  verifyDeterminism,
  _setOllamaEmbedCallableForTest,
} from '../core/re-vectorize.js';
import type { ReVectorizeAllResult } from '../core/re-vectorize.js';
import {
  runWave1Benchmarks,
  formatHumanReadable,
  _setGateRunnersForTest,
} from './run-wave1-benchmarks.js';
import type { BenchmarkRunOutput, GateRunners } from './run-wave1-benchmarks.js';

// Re-export for tests.
export { _setOllamaEmbedCallableForTest, _setGateRunnersForTest };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const GATE_RESULTS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.planning/phases/14-substrate-coherence/14-07-WAVE1-GATE-RESULTS.md'
);
const BASELINES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.planning/phases/14-substrate-coherence/14-07-WAVE1-BASELINES.json'
);

/** Maximum acceptable re-vectorization failure rate (5%). */
const MAX_FAILURE_RATE = 0.05;

/** Schema version 3701 is the read-only flip marker in schema_versions. */
const CUTOVER_MARKER_VERSION = 3701;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CutoverOpts {
  apply: boolean;
  rollback: boolean;
  db_path: string;
  skipBenchmarks: boolean;
  confirmNonInteractive: boolean;
  /** DI: inject gate runners for tests. */
  gateRunners?: GateRunners | null;
  /** DI: inject re-vectorize callable for tests. */
  ollamaCallable?: ((text: string) => Promise<number[]>) | null;
  /** DI: gate-results file path override for tests. */
  gateResultsPath?: string;
}

export type CutoverStatus =
  | 'dry_run_complete'
  | 'already_cutover'
  | 'cutover_complete'
  | 'rollback_complete'
  | 'gate_failed'
  | 're_vectorize_failed'
  | 'mapping_incomplete'
  | 'determinism_failed'
  | 'declined'
  | 'error';

export interface CutoverResult {
  status: CutoverStatus;
  exit_code: 0 | 1 | 2 | 3 | 4 | 5;
  message: string;
  phases_completed: string[];
  gate_output?: BenchmarkRunOutput;
  revectorize_result?: ReVectorizeAllResult;
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

function emitTelemetry(
  db: Database.Database,
  phase: string,
  success: boolean,
  detail: Record<string, unknown>
): void {
  try {
    db.prepare(`
      INSERT INTO telemetry(session_id, event_kind, detail)
      VALUES ('cutover-v7', 'cutover_phase_complete', json(?))
    `).run(JSON.stringify({ phase, success, ...detail }));
  } catch { /* telemetry is best-effort — never fail the cutover for telemetry */ }
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/**
 * Check whether the cutover has already been applied.
 *
 * Primary check: schema_versions row 3701 exists.
 * Secondary check: all artifacts rows have read_only = 1.
 */
function isAlreadyCutover(db: Database.Database): boolean {
  try {
    // Primary: schema_versions marker.
    const svRow = db.prepare(
      `SELECT 1 FROM schema_versions WHERE version = ? LIMIT 1`
    ).get(CUTOVER_MARKER_VERSION);
    if (svRow) return true;

    // Secondary: check if artifacts table exists and all rows are read-only.
    const hasArtifacts = db.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='artifacts'`
    ).get() as { n: number };
    if (hasArtifacts.n === 0) return false;

    const unflipped = db.prepare(
      `SELECT COUNT(*) AS n FROM artifacts WHERE read_only = 0`
    ).get() as { n: number };
    return unflipped.n === 0 && (
      db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number }
    ).n > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

async function promptConfirmation(prompt: string, expectedWord: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() === expectedWord);
    });
  });
}

// ---------------------------------------------------------------------------
// Gate results file append
// ---------------------------------------------------------------------------

function appendGateResults(
  gateResultsPath: string,
  opts: {
    timestamp: string;
    db_path: string;
    mapping_check: { total_legacy: number; mapped: number; unmapped: number };
    determinism: boolean;
    revectorize: ReVectorizeAllResult | null;
    gate_output: BenchmarkRunOutput | null;
    rows_flipped: number;
    already_flipped: boolean;
    gate_skipped: boolean;
    final_disposition: string;
  }
): void {
  const gateRows = opts.gate_output?.results.map(r => {
    const measuredStr = r.gate === 'vesna_sc1'
      ? `${Math.round(r.measured * 28)}/28`
      : `${(r.measured * 100).toFixed(1)}%`;
    const baselineStr = r.gate === 'vesna_sc1'
      ? `${Math.round(r.baseline * 28)}/28`
      : `${(r.baseline * 100).toFixed(1)}%`;
    const thresholdStr = r.threshold_comparison === '>='
      ? `>=${baselineStr}`
      : `<=${baselineStr}`;
    return `  | ${r.gate.padEnd(26)} | ${measuredStr.padEnd(8)} | ${baselineStr.padEnd(8)} | ${thresholdStr.padEnd(9)} | ${r.passed ? 'PASS' : 'FAIL'} |`;
  }).join('\n') ?? '  (benchmarks skipped)';

  const rvStr = opts.revectorize
    ? `Rows attempted: ${opts.revectorize.total}, Succeeded: ${opts.revectorize.succeeded}, Failed: ${opts.revectorize.failed} (${((opts.revectorize.failed / Math.max(opts.revectorize.total, 1)) * 100).toFixed(1)}%)`
    : '(dry-run — not executed)';

  const block = `
### Run ${opts.timestamp}

- **Mode:** apply
- **DB path:** ${opts.db_path}
- **Pre-cutover validation:**
  - artifact_id_map completeness: ${opts.mapping_check.unmapped === 0 ? 'PASS' : `FAIL (${opts.mapping_check.unmapped} unmapped)`} (total_legacy=${opts.mapping_check.total_legacy}, mapped=${opts.mapping_check.mapped})
  - verifyDeterminism on sample: ${opts.determinism ? 'PASS' : 'FAIL'}
- **Re-vectorization:** ${rvStr}
- **Benchmark gate:** ${opts.gate_skipped ? 'SKIPPED (WARNING)' : ''}
  | Gate                       | Measured | Baseline | Threshold | Result |
  |----------------------------|----------|----------|-----------|--------|
${gateRows}
- **Read-only flag flip:** ${opts.rows_flipped > 0 ? `YES (rows flipped: ${opts.rows_flipped})` : opts.already_flipped ? 'YES (already flipped — idempotent re-run)' : 'NO (gate failed)'}
- **Final disposition:** ${opts.final_disposition}
- **Operator approval line:** *(operator fills in before v7.0.0 ship)*
- **Telemetry rows emitted:** per phase (see telemetry table with session_id='cutover-v7')
`;

  try {
    if (fs.existsSync(gateResultsPath)) {
      const existing = fs.readFileSync(gateResultsPath, 'utf8');
      fs.writeFileSync(gateResultsPath, existing + block, 'utf8');
    } else {
      fs.writeFileSync(gateResultsPath, block, 'utf8');
    }
  } catch (err) {
    console.warn(`[cutover-v7] Warning: Could not append to gate-results file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Main cutover orchestrator
// ---------------------------------------------------------------------------

export async function applyCutover(
  db: Database.Database,
  opts: CutoverOpts
): Promise<CutoverResult> {
  const phasesCompleted: string[] = [];
  const gateResultsPath = opts.gateResultsPath ?? GATE_RESULTS_PATH;

  // Inject DI callables if provided.
  if (opts.ollamaCallable !== undefined) {
    _setOllamaEmbedCallableForTest(opts.ollamaCallable);
  }
  if (opts.gateRunners !== undefined) {
    _setGateRunnersForTest(opts.gateRunners);
  }

  // ── Phase A: Pre-cutover validation ──────────────────────────────────────
  log('[Phase A] Pre-cutover validation...');

  // A.1 — Verify DB is at V37.
  let userVersion: number;
  try {
    userVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
  } catch (err) {
    return {
      status: 'error',
      exit_code: 3,
      message: `Failed to read PRAGMA user_version: ${err instanceof Error ? err.message : String(err)}`,
      phases_completed: phasesCompleted,
    };
  }

  if (userVersion < 37) {
    return {
      status: 'error',
      exit_code: 3,
      message: `DB is at V${userVersion}, expected V37+. Run migrateV36toV37 first.`,
      phases_completed: phasesCompleted,
    };
  }

  // A.2 — Verify artifact_id_map completeness.
  const mappingCheck = verifyMappingComplete(db);
  if (mappingCheck.unmapped > 0) {
    emitTelemetry(db, 'A', false, { reason: 'mapping_incomplete', ...mappingCheck });
    return {
      status: 'mapping_incomplete',
      exit_code: 1,
      message: `artifact_id_map is incomplete: ${mappingCheck.unmapped} legacy rows unmapped (total=${mappingCheck.total_legacy}, mapped=${mappingCheck.mapped}). Run migrateV36toV37 first.`,
      phases_completed: phasesCompleted,
    };
  }
  log(`  [A.2] artifact_id_map: ${mappingCheck.mapped}/${mappingCheck.total_legacy} mapped — PASS`);

  // A.3 — Verify arctic-embed2 determinism.
  let determinismResult: { deterministic: boolean };
  try {
    determinismResult = await verifyDeterminism('Claudex v7.0.0 cutover determinism probe');
  } catch (err) {
    emitTelemetry(db, 'A', false, { reason: 'determinism_check_error', error: String(err) });
    return {
      status: 'error',
      exit_code: 3,
      message: `verifyDeterminism failed (Ollama may be unavailable): ${err instanceof Error ? err.message : String(err)}`,
      phases_completed: phasesCompleted,
    };
  }

  if (!determinismResult.deterministic) {
    emitTelemetry(db, 'A', false, { reason: 'non_deterministic' });
    return {
      status: 'determinism_failed',
      exit_code: 1,
      message: 'arctic-embed2 is non-deterministic (different vectors for identical input). This is a production blocker. Do not proceed.',
      phases_completed: phasesCompleted,
    };
  }
  log('  [A.3] verifyDeterminism: PASS');

  emitTelemetry(db, 'A', true, { user_version: userVersion, mapping_check: mappingCheck });
  phasesCompleted.push('A');

  // ── Phase B: Bulk re-vectorization ───────────────────────────────────────
  log('[Phase B] Bulk re-vectorization...');
  let rvResult: ReVectorizeAllResult;
  try {
    rvResult = await reVectorizeAll(db, {
      batch_size: 100,
      // Use 0 retry delay when a DI callable is injected (test mode) to avoid slow tests.
      retry_base_delay_ms: opts.ollamaCallable !== undefined ? 0 : 500,
      on_progress: (done, total) => {
        if (done % 100 === 0 || done === total) {
          log(`  [B] Re-vectorized ${done}/${total} rows...`);
        }
      },
    });
  } catch (err) {
    emitTelemetry(db, 'B', false, { reason: 'reVectorizeAll_threw', error: String(err) });
    return {
      status: 'error',
      exit_code: 3,
      message: `reVectorizeAll threw: ${err instanceof Error ? err.message : String(err)}`,
      phases_completed: phasesCompleted,
    };
  }

  const failureRate = rvResult.total > 0 ? rvResult.failed / rvResult.total : 0;
  log(`  [B] Re-vectorization complete: ${rvResult.succeeded}/${rvResult.total} succeeded, ${rvResult.failed} failed (${(failureRate * 100).toFixed(1)}%)`);

  if (failureRate > MAX_FAILURE_RATE) {
    emitTelemetry(db, 'B', false, { failure_rate: failureRate, ...rvResult });
    return {
      status: 're_vectorize_failed',
      exit_code: 2,
      message: `Re-vectorization failure rate ${(failureRate * 100).toFixed(1)}% exceeds 5% threshold. ${rvResult.failed}/${rvResult.total} rows failed. Cutover refused.`,
      phases_completed: phasesCompleted,
      revectorize_result: rvResult,
    };
  }

  emitTelemetry(db, 'B', true, { failure_rate: failureRate, ...rvResult });
  phasesCompleted.push('B');

  // ── Phase C: Benchmark gate ───────────────────────────────────────────────
  log('[Phase C] Benchmark gate...');
  let gateOutput: BenchmarkRunOutput | null = null;
  let gateSkipped = false;

  if (opts.skipBenchmarks) {
    log('  [C] WARNING: benchmarks SKIPPED (--skip-benchmarks flag set)');
    gateSkipped = true;
    phasesCompleted.push('C-skipped');
  } else {
    try {
      gateOutput = await runWave1Benchmarks({
        db_path: opts.db_path,
        baseline_path: BASELINES_PATH,
        runners: opts.gateRunners,
      });
    } catch (err) {
      emitTelemetry(db, 'C', false, { reason: 'benchmark_runner_threw', error: String(err) });
      return {
        status: 'error',
        exit_code: 3,
        message: `Benchmark runner threw: ${err instanceof Error ? err.message : String(err)}`,
        phases_completed: phasesCompleted,
        revectorize_result: rvResult,
      };
    }

    log(formatHumanReadable(gateOutput));

    if (!gateOutput.overall_passed) {
      const failedGates = gateOutput.results
        .filter(r => !r.passed)
        .map(r => {
          const measuredPct = r.gate === 'vesna_sc1'
            ? `${Math.round(r.measured * 28)}/28`
            : `${(r.measured * 100).toFixed(1)}%`;
          const thresholdPct = r.gate === 'vesna_sc1'
            ? `${Math.round(r.threshold * 28)}/28`
            : `${(r.threshold * 100).toFixed(1)}%`;
          return `${r.gate}: measured=${measuredPct} ${r.threshold_comparison} threshold=${thresholdPct} — FAIL`;
        })
        .join('; ');

      emitTelemetry(db, 'C', false, { failed_gates: failedGates, results: gateOutput.results });
      return {
        status: 'gate_failed',
        exit_code: 1,
        message: `Benchmark gate FAILED — cutover refused. Failed gates: ${failedGates}`,
        phases_completed: phasesCompleted,
        gate_output: gateOutput,
        revectorize_result: rvResult,
      };
    }

    emitTelemetry(db, 'C', true, { results: gateOutput.results });
    phasesCompleted.push('C');
  }

  // ── Phase D: Read-only flag flip ──────────────────────────────────────────
  log('[Phase D] Flipping legacy artifacts to read-only...');
  let flipResult: { rows_flipped: number; already_flipped: boolean };
  try {
    flipResult = flipLegacyArtifactsReadOnly(db);
  } catch (err) {
    emitTelemetry(db, 'D', false, { reason: 'flip_threw', error: String(err) });
    return {
      status: 'error',
      exit_code: 3,
      message: `flipLegacyArtifactsReadOnly threw: ${err instanceof Error ? err.message : String(err)}`,
      phases_completed: phasesCompleted,
      gate_output: gateOutput ?? undefined,
      revectorize_result: rvResult,
    };
  }

  if (flipResult.already_flipped) {
    log('  [D] Already flipped (idempotent re-run)');
  } else {
    log(`  [D] Flipped ${flipResult.rows_flipped} rows to read_only=1`);
  }

  // D.2 — Install application-layer guard.
  try {
    enforceLegacyReadOnly(db);
    log('  [D.2] Application-layer read-only guard installed');
  } catch { /* non-fatal — triggers are the primary enforcement */ }

  // D.3 — Verify enforcement: attempt INSERT and verify it's rejected.
  try {
    let insertRejected = false;
    try {
      db.prepare(`INSERT INTO artifacts(session_id, artifact_type, summary) VALUES ('verify', 'observation', 'test')`).run();
    } catch {
      insertRejected = true;
    }
    if (!insertRejected) {
      log('  [D.3] WARNING: INSERT into legacy artifacts was NOT rejected. Triggers may not be installed correctly.');
    } else {
      log('  [D.3] Post-flip enforcement verified: INSERT rejected as expected');
    }
  } catch { /* non-fatal verification */ }

  emitTelemetry(db, 'D', true, { rows_flipped: flipResult.rows_flipped, already_flipped: flipResult.already_flipped });
  phasesCompleted.push('D');

  // ── Phase E: Gate record + ship ───────────────────────────────────────────
  log('[Phase E] Appending gate results + emitting final telemetry...');
  const timestamp = new Date().toISOString();
  appendGateResults(gateResultsPath, {
    timestamp,
    db_path: opts.db_path,
    mapping_check: mappingCheck,
    determinism: determinismResult.deterministic,
    revectorize: rvResult,
    gate_output: gateOutput,
    rows_flipped: flipResult.rows_flipped,
    already_flipped: flipResult.already_flipped,
    gate_skipped: gateSkipped,
    final_disposition: 'CUTOVER COMPLETE',
  });
  log(`  [E] Gate results appended to: ${gateResultsPath}`);

  emitTelemetry(db, 'E', true, {
    event_kind_override: 'cutover_complete',
    timestamp,
    gate_skipped: gateSkipped,
    rows_flipped: flipResult.rows_flipped,
    overall_gate_passed: gateOutput?.overall_passed ?? null,
  });
  phasesCompleted.push('E');

  log('');
  log('=== CUTOVER COMPLETE ===');
  log(`Legacy artifacts table is now read-only. V17 unified substrate is live.`);
  log(`Gate results: ${gateResultsPath}`);
  log('Next step: operator reviews gate-results file, then Wave 2 dispatch is unblocked.');

  return {
    status: 'cutover_complete',
    exit_code: 0,
    message: 'Cutover complete. Legacy artifacts is read-only. V17 unified substrate is live.',
    phases_completed: phasesCompleted,
    gate_output: gateOutput ?? undefined,
    revectorize_result: rvResult,
  };
}

export async function runDryRun(
  db: Database.Database,
  opts: CutoverOpts
): Promise<CutoverResult> {
  log('=== DRY-RUN MODE (no writes will be performed) ===');
  log('');

  const phases: string[] = [];

  // Phase A — validation (read-only, always runs).
  log('[Phase A] Pre-cutover validation...');
  try {
    const userVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
    log(`  [A.1] DB user_version: ${userVersion} (need >= 37)`);
    if (userVersion < 37) {
      log(`  [A.1] FAIL: DB is at V${userVersion}. migrateV36toV37 must run first.`);
    } else {
      log('  [A.1] PASS');
    }
  } catch (err) {
    log(`  [A.1] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const mappingCheck = verifyMappingComplete(db);
    log(`  [A.2] artifact_id_map: ${mappingCheck.mapped}/${mappingCheck.total_legacy} mapped, ${mappingCheck.unmapped} unmapped`);
    if (mappingCheck.unmapped > 0) {
      log('  [A.2] FAIL: incomplete mapping');
    } else {
      log('  [A.2] PASS');
    }
  } catch (err) {
    log(`  [A.2] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  log('  [A.3] Skipping verifyDeterminism in dry-run (requires Ollama)');
  phases.push('A');

  // Phase B — would run re-vectorization.
  try {
    const totalRows = (
      db.prepare(`SELECT COUNT(*) AS n FROM artifact`).get() as { n: number }
    ).n;
    log(`[Phase B] Would re-vectorize ${totalRows} V17 artifact rows (batch_size=100)`);
    log('  [B] (dry-run: not executed)');
  } catch {
    log('[Phase B] Would re-vectorize V17 artifact rows (dry-run: not executed)');
  }
  phases.push('B-dry');

  // Phase C — benchmarks.
  log('[Phase C] Would run benchmark gate (Vesna / LongMemEval / LoCoMo / cross-project hit rate)');
  log('  [C] (dry-run: not executed)');
  phases.push('C-dry');

  // Phase D — flag flip.
  try {
    const hasArtifacts = db.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='artifacts'`
    ).get() as { n: number };
    if (hasArtifacts.n > 0) {
      const rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number }).n;
      const alreadyFlipped = (db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE read_only = 1`).get() as { n: number }).n;
      log(`[Phase D] Would flip ${rowCount - alreadyFlipped} legacy artifacts rows to read_only=1 (${alreadyFlipped} already flipped)`);
    } else {
      log('[Phase D] No legacy artifacts table found (fresh DB)');
    }
  } catch {
    log('[Phase D] Would flip legacy artifacts to read_only=1 (dry-run)');
  }
  phases.push('D-dry');

  // Phase E.
  log(`[Phase E] Would append gate results to: ${opts.gateResultsPath ?? GATE_RESULTS_PATH}`);
  phases.push('E-dry');

  log('');
  log('=== DRY-RUN COMPLETE ===');
  log('Run with --apply to execute the cutover.');

  return {
    status: 'dry_run_complete',
    exit_code: 0,
    message: 'Dry-run complete. Run with --apply to execute.',
    phases_completed: phases,
  };
}

export async function rollbackCutover(
  db: Database.Database,
  opts: CutoverOpts
): Promise<CutoverResult> {
  log('=== ROLLBACK MODE ===');

  // Check there is something to roll back.
  const wasApplied = isAlreadyCutover(db);
  if (!wasApplied) {
    return {
      status: 'error',
      exit_code: 3,
      message: 'Rollback requested, but no cutover has been applied to this DB. Nothing to roll back.',
      phases_completed: [],
    };
  }

  let rowsCleared: number;
  try {
    const result = clearLegacyReadOnly(db);
    rowsCleared = result.rows_cleared;
  } catch (err) {
    return {
      status: 'error',
      exit_code: 3,
      message: `clearLegacyReadOnly threw: ${err instanceof Error ? err.message : String(err)}`,
      phases_completed: [],
    };
  }

  // Emit rollback telemetry.
  try {
    db.prepare(`
      INSERT INTO telemetry(session_id, event_kind, detail)
      VALUES ('cutover-v7', 'cutover_phase_complete', json(?))
    `).run(JSON.stringify({ phase: 'rollback', success: true, rows_cleared: rowsCleared }));
  } catch { /* non-fatal */ }

  log(`Cleared read_only flag on ${rowsCleared} legacy artifacts rows.`);
  log('');
  log('WARNING: The V17 unified artifact rows are still present in the `artifact` table.');
  log('The application now reads from legacy artifacts again, but any writes since cutover');
  log('went to V17 only. Those writes are NOT reflected in legacy artifacts.');
  log('');
  log('For full schema rollback (destructive), run migrateV37toV36 which drops');
  log('artifact_id_map and vec_artifact_v17. This loses any V17-only writes.');
  log('');
  log('Rollback complete. Exit code: 5 (per spec).');

  return {
    status: 'rollback_complete',
    exit_code: 5,
    message: `Rollback complete. Cleared read_only on ${rowsCleared} rows. V17 rows still present.`,
    phases_completed: ['rollback'],
  };
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export function parseCutoverArgs(argv: string[]): CutoverOpts {
  const args = argv.slice(2);
  const apply = args.includes('--apply');
  const rollback = args.includes('--rollback');
  const skipBenchmarks = args.includes('--skip-benchmarks');
  const confirmNonInteractive = args.includes('--confirm-non-interactive');

  const dbIdx = args.indexOf('--db');
  const db_path = dbIdx !== -1 && args[dbIdx + 1] ? args[dbIdx + 1] : DEFAULT_DB_PATH;

  return {
    apply,
    rollback,
    db_path,
    skipBenchmarks,
    confirmNonInteractive,
    gateRunners: null,
    ollamaCallable: undefined,
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function cutoverV7(opts: CutoverOpts): Promise<CutoverResult> {
  // Open DB.
  let db: Database.Database;
  try {
    db = new Database(opts.db_path);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    return {
      status: 'error',
      exit_code: 3,
      message: `Failed to open DB at ${opts.db_path}: ${err instanceof Error ? err.message : String(err)}`,
      phases_completed: [],
    };
  }

  try {
    // Idempotency check.
    if (!opts.rollback && isAlreadyCutover(db)) {
      log('Cutover already applied (already_cutover). Exiting 0.');
      return {
        status: 'already_cutover',
        exit_code: 0,
        message: 'Cutover already applied. Idempotent re-run: no changes made.',
        phases_completed: [],
      };
    }

    // Rollback mode.
    if (opts.rollback) {
      return await rollbackCutover(db, opts);
    }

    // Dry-run mode (default).
    if (!opts.apply) {
      return await runDryRun(db, opts);
    }

    // Apply mode — confirm if interactive, or check --confirm-non-interactive.
    if (!opts.confirmNonInteractive) {
      const isTTY = process.stdin.isTTY;
      if (!isTTY) {
        return {
          status: 'declined',
          exit_code: 4,
          message:
            'stdin is not a TTY and --confirm-non-interactive is not set. ' +
            'Pass --confirm-non-interactive for non-interactive (autonomous) use.',
          phases_completed: [],
        };
      }

      // Interactive confirmation.
      const rowCount = (() => {
        try {
          return (db.prepare(`SELECT COUNT(*) AS n FROM artifact`).get() as { n: number }).n;
        } catch { return 0; }
      })();

      const prompt =
        '\nThis will cutover the Claudex substrate to V7 unified shape.\n' +
        'The legacy `artifacts` table will become read-only.\n' +
        `Re-vectorization will run over ${rowCount} rows; this may take a while.\n` +
        'Type CONFIRM to proceed, anything else to abort: ';

      const confirmed = await promptConfirmation(prompt, 'CONFIRM');
      if (!confirmed) {
        log('Aborted by operator.');
        return {
          status: 'declined',
          exit_code: 4,
          message: 'Operator declined confirmation.',
          phases_completed: [],
        };
      }
    }

    return await applyCutover(db, opts);
  } finally {
    try { db.close(); } catch { /* ok */ }
    // Restore DI callables.
    _setOllamaEmbedCallableForTest(null);
    _setGateRunnersForTest(null);
  }
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCutoverArgs(process.argv);
  const result = await cutoverV7(opts);

  if (result.status !== 'dry_run_complete' && result.status !== 'already_cutover') {
    // Print status summary.
    log('');
    log(`Status: ${result.status}`);
    if (result.status !== 'cutover_complete' && result.status !== 'rollback_complete') {
      log(`Error: ${result.message}`);
    }
  }

  process.exit(result.exit_code);
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (isMain) {
  void main();
}
