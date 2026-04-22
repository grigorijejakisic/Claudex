/**
 * run-precision.ts — Plan 03-05 precision harness.
 *
 * Reads `fixture-candidates.jsonl` + `gold-labels.jsonl`, drives the full
 * detector pipeline in dryRun mode against each candidate, and emits a JSON
 * run file with joint precision + per-field + per-regex-family + per-scope
 * diagnostics. Output directory is content-addressed by ISO timestamp so
 * longitudinal comparison across tuning cycles is easy.
 *
 * Design choice: rather than refactor the detector around a `processCandidate`
 * entry point, we seed a throwaway in-memory DB with the exact
 * `conversation_turns` rows the candidates reference, then call
 * `extractDirectivesFromSession` with `dryRun=true`. The detector's own
 * `decisions[]` array is our per-candidate audit log. This exercises the
 * exact production code path minus DB writes.
 *
 * Usage:
 *   node dist/benchmarks/directive-detector/run-precision.cjs
 *     [--candidates=.planning/.../fixture-candidates.jsonl]
 *     [--labels=.planning/.../gold-labels.jsonl]
 *     [--threshold=0.70]
 *     [--threshold-universal=0.85]
 *     [--model=glm-5.1:cloud]
 *     [--output-dir=.planning/.../fixtures/runs/]
 *     [--tag=<name>]
 *     [--heartbeat-ms=30000]  // 0 disables
 *     [--limit=<N>]           // run only the first N candidates (smoke tests)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { extractDirectivesFromSession, type DetectionRecord } from '../../intelligence/directive-detector.js';
import type { FixtureCandidate, ContextTurn } from './build-candidates.js';
import type { GoldLabelRow, LabelFields } from './label-candidates.js';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  candidates: string;
  labels: string;
  threshold: number;
  thresholdUniversal: number;
  model: string;
  outputDir: string;
  tag: string | null;
  heartbeatMs: number;
  limit: number | null;
}

function defaultFixturePath(file: string): string {
  return path.join(
    process.cwd(),
    '.planning',
    'phases',
    '03-p2-directive-detector',
    'fixtures',
    file,
  );
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    candidates: defaultFixturePath('fixture-candidates.jsonl'),
    labels: defaultFixturePath('gold-labels.jsonl'),
    threshold: 0.70,
    thresholdUniversal: 0.85,
    model: 'glm-5.1:cloud',
    outputDir: defaultFixturePath('runs'),
    tag: null,
    heartbeatMs: 30_000,
    limit: null,
  };
  for (const a of argv) {
    const [k, v] = a.split('=');
    if (v === undefined) continue;
    if (k === '--candidates') out.candidates = v;
    else if (k === '--labels') out.labels = v;
    else if (k === '--threshold') out.threshold = parseFloat(v);
    else if (k === '--threshold-universal') out.thresholdUniversal = parseFloat(v);
    else if (k === '--model') out.model = v;
    else if (k === '--output-dir') out.outputDir = v;
    else if (k === '--tag') out.tag = v;
    else if (k === '--heartbeat-ms') out.heartbeatMs = parseInt(v, 10);
    else if (k === '--limit') out.limit = parseInt(v, 10);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as T);
}

// ---------------------------------------------------------------------------
// Metric computation — shared with the unit test via export
// ---------------------------------------------------------------------------

export interface PairedCandidate {
  candidate: FixtureCandidate;
  label: LabelFields;
  detector: DetectionRecord;
  scope_excluded_from_scoring?: boolean;
}

export interface RunMetrics {
  corpus: { candidates: number; labeled: number; confirmed_by_detector: number };
  metrics: {
    joint_precision: number | null;
    is_directive_precision: number | null;
    scope_precision_given_correct: number | null;
    polarity_precision_given_correct: number | null;
  };
  per_regex_family: Record<string, { candidates: number; confirmed: number; joint_correct: number; rate: number | null }>;
  per_scope: Record<string, { confirmed: number; joint_correct: number; rate: number | null }>;
  confusion_matrix: {
    detector_true_labeler_true: number;
    detector_true_labeler_false: number;
    detector_false_labeler_true: number;
    detector_false_labeler_false: number;
  };
}

function detectorSaidTrue(d: DetectionRecord): boolean {
  if (d.decision === 'inserted' || d.decision === 'updated' || d.decision === 'annotated_opposite' || d.decision === 'annotated_related') return true;
  return d.confirmation?.is_directive === true;
}

function detectorScope(d: DetectionRecord): string | null {
  return d.confirmation?.scope ?? null;
}

function detectorPolarity(d: DetectionRecord): string | null {
  return d.confirmation?.polarity ?? null;
}

export function computeMetrics(pairs: PairedCandidate[]): RunMetrics {
  const perFamily: RunMetrics['per_regex_family'] = {};
  const perScope: RunMetrics['per_scope'] = {};
  const cm = {
    detector_true_labeler_true: 0,
    detector_true_labeler_false: 0,
    detector_false_labeler_true: 0,
    detector_false_labeler_false: 0,
  };

  let confirmedByDetector = 0;
  let jointCorrect = 0;
  let isDirCorrect = 0;
  let scopeNumerator = 0, scopeDenominator = 0;
  let polNumerator = 0, polDenominator = 0;

  for (const p of pairs) {
    const detTrue = detectorSaidTrue(p.detector);
    const labTrue = p.label.is_directive === true;

    if (detTrue && labTrue) cm.detector_true_labeler_true++;
    else if (detTrue && !labTrue) cm.detector_true_labeler_false++;
    else if (!detTrue && labTrue) cm.detector_false_labeler_true++;
    else cm.detector_false_labeler_false++;

    const family = p.candidate.matched_families[0] ?? '(none)';
    if (!perFamily[family]) perFamily[family] = { candidates: 0, confirmed: 0, joint_correct: 0, rate: null };
    perFamily[family].candidates++;

    if (detTrue) {
      confirmedByDetector++;
      perFamily[family].confirmed++;
      const detScope = detectorScope(p.detector) ?? '(none)';
      if (!perScope[detScope]) perScope[detScope] = { confirmed: 0, joint_correct: 0, rate: null };
      perScope[detScope].confirmed++;

      if (labTrue) isDirCorrect++;
      const scopeExcluded = p.scope_excluded_from_scoring === true;
      const scopeMatch = scopeExcluded ? true : detectorScope(p.detector) === (p.label.scope ?? null);
      const polarityMatch = detectorPolarity(p.detector) === (p.label.polarity ?? null);
      if (labTrue && scopeMatch && polarityMatch) {
        jointCorrect++;
        perFamily[family].joint_correct++;
        perScope[detScope].joint_correct++;
      }

      if (labTrue) {
        // Conditional-on-is_directive-correct numerators/denominators
        if (!scopeExcluded) {
          scopeDenominator++;
          if (scopeMatch) scopeNumerator++;
        }
        polDenominator++;
        if (polarityMatch) polNumerator++;
      }
    }
  }

  for (const f of Object.keys(perFamily)) {
    const row = perFamily[f];
    row.rate = row.confirmed > 0 ? row.joint_correct / row.confirmed : null;
  }
  for (const s of Object.keys(perScope)) {
    const row = perScope[s];
    row.rate = row.confirmed > 0 ? row.joint_correct / row.confirmed : null;
  }

  return {
    corpus: {
      candidates: pairs.length,
      labeled: pairs.length,
      confirmed_by_detector: confirmedByDetector,
    },
    metrics: {
      joint_precision: confirmedByDetector > 0 ? jointCorrect / confirmedByDetector : null,
      is_directive_precision: confirmedByDetector > 0 ? isDirCorrect / confirmedByDetector : null,
      scope_precision_given_correct: scopeDenominator > 0 ? scopeNumerator / scopeDenominator : null,
      polarity_precision_given_correct: polDenominator > 0 ? polNumerator / polDenominator : null,
    },
    per_regex_family: perFamily,
    per_scope: perScope,
    confusion_matrix: cm,
  };
}

// ---------------------------------------------------------------------------
// Seed a throwaway DB with the fixture candidates' turns
// ---------------------------------------------------------------------------

function allContextTurns(c: FixtureCandidate): Array<{ turn_idx: number; user_text: string | null; assistant_text: string | null }> {
  const seen = new Map<number, { turn_idx: number; user_text: string | null; assistant_text: string | null }>();
  const add = (t: ContextTurn): void => {
    seen.set(t.turn_idx, { turn_idx: t.turn_idx, user_text: t.user_text, assistant_text: t.assistant_text });
  };
  for (const t of c.context_prev_2) add(t);
  for (const t of c.context_next_2) add(t);
  // The candidate turn itself:
  seen.set(c.turn_idx, { turn_idx: c.turn_idx, user_text: c.raw_text, assistant_text: null });
  return Array.from(seen.values()).sort((a, b) => a.turn_idx - b.turn_idx);
}

function seedDbForCandidate(candidate: FixtureCandidate): Database.Database {
  const db = new Database(':memory:');
  applyV17DDL(db);
  db.exec(`CREATE TABLE conversation_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    user_text TEXT,
    assistant_text TEXT,
    timestamp_epoch INTEGER NOT NULL DEFAULT 0
  )`);
  const insert = db.prepare(`INSERT INTO conversation_turns(session_id, project, turn_number, user_text, assistant_text, timestamp_epoch) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const t of allContextTurns(candidate)) {
    insert.run(candidate.session_id, 'harness', t.turn_idx, t.user_text, t.assistant_text, 1000 + t.turn_idx);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Success signal = the `*_<tag>.json` run file lands in outputDir with a
// populated `metrics` block. Process-table absence alone does NOT imply
// failure — observers must grep for the output JSON, not `wmic` the PID.
async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  console.log(`harness_pid=${process.pid}`);
  if (!fs.existsSync(args.candidates)) {
    console.error(`run-precision: missing ${args.candidates}`);
    return 2;
  }
  if (!fs.existsSync(args.labels)) {
    console.error(`run-precision: missing ${args.labels}`);
    return 2;
  }

  const allCandidates = readJsonl<FixtureCandidate>(args.candidates);
  const candidates = args.limit != null ? allCandidates.slice(0, args.limit) : allCandidates;
  const labelRows = readJsonl<GoldLabelRow>(args.labels);
  const byCid = new Map(labelRows.map(r => [r.candidate_id, r]));

  const pairs: PairedCandidate[] = [];
  let skipped = 0;

  console.log(`run-precision: ${candidates.length} candidates, ${labelRows.length} labels, model=${args.model} thresh=${args.threshold}/${args.thresholdUniversal}`);

  // Heartbeat timer — fixed-interval liveness beacon independent of the
  // 10-candidate progress bucket. Flushes to the redirected log even when
  // an individual LLM call is slow enough that the loop hasn't advanced by
  // 10 candidates yet. Observers should treat heartbeats as "process alive".
  const startMs = Date.now();
  let done = 0;
  const heartbeatTimer = args.heartbeatMs > 0
    ? setInterval(() => {
        const elapsed = Math.round((Date.now() - startMs) / 1000);
        console.log(`  heartbeat: ${done}/${candidates.length} ${elapsed}s`);
      }, args.heartbeatMs)
    : null;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const labelRow = byCid.get(c.candidate_id);
    if (!labelRow) {
      skipped++;
      continue;
    }
    const db = seedDbForCandidate(c);
    try {
      let detRecord: DetectionRecord;
      try {
        const result = await extractDirectivesFromSession(
          db,
          c.session_id,
          'harness',
          {
            dryRun: true,
            thresholdGeneral: args.threshold,
            thresholdUniversal: args.thresholdUniversal,
            model: args.model,
          },
        );
        // The detector emits one decision per regex match; find ours by turn_idx.
        detRecord = result.decisions.find(d => d.turn_idx === c.turn_idx)
          // Fallback: a candidate may produce a non-match if stripCodeBlocks removed
          // all regex-triggering text; represent as rejected_regex synthetically.
          ?? {
            session_id: c.session_id,
            turn_idx: c.turn_idx,
            raw_text: c.raw_text,
            matched_families: c.matched_families,
            decision: 'rejected_regex',
          };
      } catch (candidateErr) {
        // Per-candidate isolation: one bad candidate should not kill the batch.
        // Represent as rejected_regex so the pair still contributes a zero-confirm
        // row to the metrics (consistent with treating errors as conservative rejects).
        const msg = candidateErr instanceof Error ? candidateErr.message : String(candidateErr);
        console.log(`  ERROR candidate=${c.candidate_id} turn=${c.turn_idx}: ${msg}`);
        detRecord = {
          session_id: c.session_id,
          turn_idx: c.turn_idx,
          raw_text: c.raw_text,
          matched_families: c.matched_families,
          decision: 'rejected_regex',
        };
      }
      const scopeExcluded = (labelRow as GoldLabelRow & { scope_excluded_from_scoring?: boolean }).scope_excluded_from_scoring === true;
      pairs.push({ candidate: c, label: labelRow.label, detector: detRecord, scope_excluded_from_scoring: scopeExcluded });
    } finally {
      try { db.close(); } catch { /* noop */ }
    }
    done = i + 1;
    if (done % 10 === 0) console.log(`  progress: ${done}/${candidates.length}`);
  }

  if (heartbeatTimer) clearInterval(heartbeatTimer);

  const metrics = computeMetrics(pairs);

  const runTs = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = args.tag ? `${runTs}_${args.tag}` : runTs;
  const outDir = args.outputDir;
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${runId}.json`);

  const runDoc = {
    run_id: runId,
    tag: args.tag,
    config: {
      threshold: args.threshold,
      threshold_universal: args.thresholdUniversal,
      model: args.model,
    },
    ...metrics,
    decisions: pairs.map(p => ({
      candidate_id: p.candidate.candidate_id,
      matched_families: p.candidate.matched_families,
      labeler: p.label,
      detector_decision: p.detector.decision,
      detector_confirmation: p.detector.confirmation,
    })),
  };
  fs.writeFileSync(outFile, JSON.stringify(runDoc, null, 2), 'utf8');

  const joint = metrics.metrics.joint_precision;
  const jointPct = joint != null ? `${(joint * 100).toFixed(1)}%` : 'n/a';
  const verdict =
    joint == null ? 'no-data' :
      joint >= 0.92 ? 'ship' :
      joint >= 0.88 ? 'noise-bound' : 'tune';
  console.log(`run=${runId} joint=${jointPct} skipped=${skipped} → ${verdict}`);
  console.log(`  → ${outFile}`);
  return 0;
}

export { main, seedDbForCandidate, allContextTurns };

declare const require: { main: unknown } | undefined;
declare const module: unknown;
try {
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    main(process.argv.slice(2))
      .then(code => process.exit(code))
      .catch(e => { console.error(e); process.exit(1); });
  }
} catch { /* noop */ }
