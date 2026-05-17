#!/usr/bin/env node
/**
 * Phase 14-07c — Cross-project equivalence hit-rate measurement.
 *
 * Queries the experience-tier candidate pool, samples top-N by recency,
 * classifies each as noise vs substantive, outputs JSON.
 *
 * Methodology per `context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md`
 * (post-Plan-14-03 re-measurement).
 *
 * Baseline at v6.6.0: noise_rate = 0.18 (18/100).
 * Cutover gate threshold: noise_rate <= 0.20 (per 14-07-WAVE1-BASELINES.json).
 *
 * Usage:
 *   bun src/scripts/cross-project-hit-rate.ts
 *   node dist/scripts/cross-project-hit-rate.cjs
 *
 * Flags:
 *   --db <path>       DB path (default: ~/.claudex/db/claudex.db)
 *   --target <name>   Target project (default: big-mozzy-v2 — matches v6.6.0 baseline)
 *   --sample <N>      Sample size (default: 100)
 *   --json            Output JSON only (no human-readable banner)
 *
 * Exit codes:
 *   0 — measurement completed; result printed
 *   1 — DB / IO error
 *   2 — invalid args
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const DEFAULT_TARGET = 'big-mozzy-v2';
const DEFAULT_SAMPLE_SIZE = 100;

const NOISE_TOOL_PREFIX_RE = /^(Read|Edit|Write|Bash|MultiEdit|Glob|Grep|WebSearch|WebFetch|NotebookEdit|MultiGrep):/i;
const FLOW_NOISE_PREFIX_RE = /^\[(Pre-assembly|Reflection)\]\s*/i;

export interface HitRateRow {
  title: string;
  body: string;
  kind: string;
  project: string;
}

export interface HitRateResult {
  noise_rate: number;
  sample_size: number;
  noise_count: number;
  target_project: string;
  schema_version: 1;
}

/**
 * Classify a candidate as noise per the post-Plan-14-03 methodology.
 * Noise = short summary (< 60 chars combined), raw tool-call prefix, or
 * short `[Pre-assembly]/[Reflection]` flow stripped to under 40 chars.
 *
 * Exported for test fixture coverage.
 */
export function isNoise(row: HitRateRow): boolean {
  const title = (row.title ?? '').trim();
  const body = (row.body ?? '').trim();
  const combined = (title + ' ' + body).trim();

  // Pattern 1: combined content < 60 chars
  if (combined.length < 60) return true;

  // Pattern 2: title starts with a raw tool-call prefix (pre-14-03 tool traces)
  if (NOISE_TOOL_PREFIX_RE.test(title)) return true;

  // Pattern 3: `[Pre-assembly]`/`[Reflection]` flow stripped to < 40 chars
  const stripped = title.replace(FLOW_NOISE_PREFIX_RE, '').trim();
  if (FLOW_NOISE_PREFIX_RE.test(title) && stripped.length < 40) return true;

  return false;
}

interface ParsedArgs {
  dbPath: string;
  target: string;
  sample: number;
  jsonOnly: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    dbPath: DEFAULT_DB_PATH,
    target: DEFAULT_TARGET,
    sample: DEFAULT_SAMPLE_SIZE,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db' && argv[i + 1]) {
      args.dbPath = argv[++i];
    } else if (a === '--target' && argv[i + 1]) {
      args.target = argv[++i];
    } else if (a === '--sample' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`invalid --sample value: ${argv[i]}`);
      }
      args.sample = n;
    } else if (a === '--json') {
      args.jsonOnly = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.error('Usage: cross-project-hit-rate [--db PATH] [--target NAME] [--sample N] [--json]');
  console.error('Measures cross-project experience-tier noise rate against a target project.');
  console.error('Default target: big-mozzy-v2 (matches v6.6.0 baseline). Default sample: 100.');
}

/**
 * Query the V17 artifact pool and run the noise classification.
 * Exported for test injection.
 */
export function measureHitRate(
  db: Database.Database,
  target: string,
  sampleSize: number,
): HitRateResult {
  // Substantive types per post-Plan-14-03 candidate pool definition.
  // Excludes target project (same-project candidates are routed elsewhere).
  // No confidence floor here — the noise classifier (`isNoise`) handles
  // raw-tool-call and short-content filtering. Adding a confidence >= 0.8
  // gate empirically dropped the pool to <30 rows in production (most
  // observations are importance ∈ {1,2,3} → confidence ∈ {0.2, 0.4, 0.6})
  // which is a non-representative sample.
  const rows = db
    .prepare(
      `
        SELECT title, body, kind, project
        FROM artifact
        WHERE project != ?
          AND kind IN ('learning', 'memory_file', 'flow', 'milestone', 'observation', 'decision', 'experience_pattern')
          AND status = 'active'
        ORDER BY created_at_epoch_ms DESC
        LIMIT ?
      `,
    )
    .all(target, sampleSize) as HitRateRow[];

  let noiseCount = 0;
  for (const r of rows) {
    if (isNoise(r)) noiseCount++;
  }

  return {
    noise_rate: rows.length > 0 ? noiseCount / rows.length : 0,
    sample_size: rows.length,
    noise_count: noiseCount,
    target_project: target,
    schema_version: 1,
  };
}

function main(): void {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    printHelp();
    process.exit(2);
  }

  if (!fs.existsSync(parsed.dbPath)) {
    console.error(`error: DB not found at ${parsed.dbPath}`);
    process.exit(1);
  }

  let db: Database.Database;
  try {
    db = new Database(parsed.dbPath, { readonly: true });
  } catch (err) {
    console.error(`error: cannot open DB: ${(err as Error).message}`);
    process.exit(1);
  }

  try {
    const result = measureHitRate(db, parsed.target, parsed.sample);

    if (parsed.jsonOnly) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      console.log(`Cross-project hit-rate — target ${result.target_project}`);
      console.log(`  Sample size:    ${result.sample_size}`);
      console.log(`  Noise count:    ${result.noise_count}`);
      console.log(`  Noise rate:     ${(result.noise_rate * 100).toFixed(1)}% (${result.noise_rate.toFixed(4)})`);
      console.log(`  Gate threshold: ≤ 20% (v6.6.0 baseline: 18%)`);
      console.log('');
      console.log(JSON.stringify(result));
    }
  } catch (err) {
    console.error(`error: measurement failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Only run main() when invoked as a script, not when imported by tests.
// In ESM, import.meta.url === pathToFileURL(__filename) when executed directly.
// In CJS (compiled), require.main === module is the equivalent.
const isMainModule = (() => {
  try {
    // CJS path (compiled output)
    // @ts-expect-error — CJS interop check
    if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
      return true;
    }
  } catch { /* not CJS */ }
  try {
    // ESM path
    const argv1 = process.argv[1] ?? '';
    return argv1.endsWith('cross-project-hit-rate.ts') || argv1.endsWith('cross-project-hit-rate.cjs');
  } catch { /* not ESM */ }
  return false;
})();

if (isMainModule) {
  main();
}
