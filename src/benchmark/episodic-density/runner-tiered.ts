/**
 * Phase 2.1 — dual-tier dual-verdict orchestrator.
 *
 * Pipeline (ordering is load-bearing — DO NOT REORDER):
 *   1. runHarnessTiered -> TieredHarnessResult { strict_3frame, relaxed_2frame }
 *   2. computeVerdict (or blockedVerdict) called EXACTLY TWICE (once per tier)
 *      with distinct decision_rule_inputs (verdict-module discipline)
 *   3. Write 02.1-results.json (atomic) with shape:
 *        { schema_version, generated_at_ts_epoch, harness, verdicts: { strict_3frame, relaxed_2frame } }
 *   4. Write 02.1-RESULTS.md placeholder (Plan 02.1-05 owns the renderer)
 *   5. Append two new aggregator entries to .planning/aggregates/multi-handle.json
 *      (atomic + idempotent + append-only). On first run: seed Phase 2's entry first.
 *
 * Steps 3 + 4 happen BEFORE step 5. Ordering test in Plan 02.1-04 Task 4
 * spies on fs.writeFileSync and asserts.
 *
 * NO side effects on src/shared/constants.ts feature flag.
 * NO movement of Vesna probes between probes/ and probes/.disabled/.
 * (CONTEXT.md decision 7 binding — single GREEN does not ship probes;
 * artifacts unchanged at 02.1 close.)
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  runHarnessTiered,
  type TieredHarnessResult,
  type HarnessRunResult,
} from './harness.js';
import {
  computeVerdict,
  blockedVerdict,
  type Verdict,
} from './verdict.js';
import {
  appendBoundExperiences,
  buildPhase21Entry,
  type BoundExperience,
} from './aggregator.js';

const PHASE21_DIR = path.resolve(
  process.cwd(),
  '.planning',
  'phases',
  '02.1-corpus-expansion-rerun',
);
export const RESULTS_JSON = path.join(PHASE21_DIR, '02.1-results.json');
export const RESULTS_MD = path.join(PHASE21_DIR, '02.1-RESULTS.md');

const PHASE2_RESULTS_JSON_PATH = path.resolve(
  process.cwd(),
  '.planning',
  'phases',
  '02-multi-modal-index-seeds-density-check',
  '02-results.json',
);

export interface TieredRunSummary {
  verdicts: {
    strict_3frame: Verdict;
    relaxed_2frame: Verdict;
  };
  results_md_path: string;
  results_json_path: string;
  /** 0..3: 2 from this phase + 1 if Phase 2 was just seeded on first run. */
  aggregator_entries_appended: number;
}

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, contents);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

/**
 * Per-tier verdict computation. The verdict module is invoked exactly
 * once per tier (via either `computeVerdict` for populated tiers or
 * `blockedVerdict` for n=0 sentinel tiers); total verdict-module call
 * count per `runFullPhase21Measurement` invocation is 2.
 */
function computePerTierVerdict(
  harness: HarnessRunResult,
  tier: string,
  ts_epoch: number,
): Verdict {
  if (harness.decision_rule_inputs.held_out_test_n === 0) {
    return blockedVerdict(`tier=${tier} pairs.total=0 (corpus-too-sparse sentinel)`, {
      ts_epoch,
    });
  }
  return computeVerdict(harness.decision_rule_inputs, { ts_epoch });
}

export interface RunFullPhase21Opts {
  seed?: number;
  ts_epoch?: number;
  /** Override the 02.1-results.json output path (test isolation). */
  resultsJsonPath?: string;
  /** Override the 02.1-RESULTS.md output path (test isolation). */
  resultsMdPath?: string;
  /** Override the multi-handle.json aggregator path (test isolation). */
  aggregatorPath?: string;
  /** Override the path to Phase 2's published 02-results.json (test isolation). */
  phase2ResultsJsonPath?: string;
}

export async function runFullPhase21Measurement(
  db: Database,
  opts?: RunFullPhase21Opts,
): Promise<TieredRunSummary> {
  const ts = opts?.ts_epoch ?? Math.floor(Date.now() / 1000);
  const resultsJsonPath = opts?.resultsJsonPath ?? RESULTS_JSON;
  const resultsMdPath = opts?.resultsMdPath ?? RESULTS_MD;
  const aggregatorPath = opts?.aggregatorPath; // appendBoundExperiences uses default if undefined
  const phase2JsonPath = opts?.phase2ResultsJsonPath ?? PHASE2_RESULTS_JSON_PATH;

  // --- Step 1: run both tiers ---
  const tiered: TieredHarnessResult = await runHarnessTiered(db, { seed: opts?.seed });

  // --- Step 2: compute two verdicts (exactly two calls into the verdict module) ---
  const strictVerdict = computePerTierVerdict(tiered.strict_3frame, 'strict_3frame', ts);
  const relaxedVerdict = computePerTierVerdict(tiered.relaxed_2frame, 'relaxed_2frame', ts);

  // --- Step 3: persist 02.1-results.json (atomic write, BEFORE aggregator append) ---
  const resultsJsonShape = {
    schema_version: 1 as const,
    generated_at_ts_epoch: ts,
    harness: tiered,
    verdicts: {
      strict_3frame: strictVerdict,
      relaxed_2frame: relaxedVerdict,
    },
  };
  atomicWrite(resultsJsonPath, JSON.stringify(resultsJsonShape, null, 2));

  // --- Step 4: persist 02.1-RESULTS.md placeholder (Plan 02.1-05 fills in) ---
  const placeholderMd = `# Phase 2.1 Results — Placeholder

This file is rendered fully by Plan 02.1-05.

Verdicts (preview):
- strict_3frame: ${strictVerdict.kind}, n=${tiered.strict_3frame.decision_rule_inputs.held_out_test_n}
- relaxed_2frame: ${relaxedVerdict.kind}, n=${tiered.relaxed_2frame.decision_rule_inputs.held_out_test_n}

See \`02.1-results.json\` for machine-readable structured output.
`;
  atomicWrite(resultsMdPath, placeholderMd);

  // --- Step 5: aggregator append (LAST write step) ---
  const today = new Date(ts * 1000).toISOString().slice(0, 10);

  // Seed Phase 2's entry on first run; subsequent runs skip via
  // (phase, labeler) tuple uniqueness.
  let phase2Json: unknown = undefined;
  try {
    phase2Json = JSON.parse(fs.readFileSync(phase2JsonPath, 'utf8'));
  } catch {
    // If Phase 2's results JSON is missing (e.g. clean checkout without
    // Phase 2 run), continue without seeding — the aggregator is still
    // valid, just without the Phase 2 entry.
  }

  const newEntries: BoundExperience[] = [
    buildPhase21Entry('strict_3frame', tiered.strict_3frame, strictVerdict, null, today),
    buildPhase21Entry('relaxed_2frame', tiered.relaxed_2frame, relaxedVerdict, null, today),
  ];

  const appendedCount = appendBoundExperiences(newEntries, {
    phase2ResultsJson: phase2Json,
    filePath: aggregatorPath,
  });

  return {
    verdicts: { strict_3frame: strictVerdict, relaxed_2frame: relaxedVerdict },
    results_md_path: resultsMdPath,
    results_json_path: resultsJsonPath,
    aggregator_entries_appended: appendedCount,
  };
}
