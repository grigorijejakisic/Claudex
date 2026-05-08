#!/usr/bin/env node
/**
 * Operator-invoked reranker fitness check.
 *
 * Usage:
 *   bun run reranker:fitness
 *
 * Runs after backfill seeds the corpus. Writes a markdown report under
 * context/measurements/{date}-reranker-fitness.md and prints a one-line
 * verdict to stdout. NOT a ship blocker — informational only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase, closeDatabase } from '../core/storage.js';
import { getDbPath } from '../shared/paths.js';
import {
  computeRerankerFitness,
  PASS_THRESHOLD,
  type FitnessReport,
} from '../ingestion/reranker-fitness-check.js';

export interface FitnessCliArgs {
  outDir: string;
  sampleSize: number;
}

export function parseArgs(argv: string[]): FitnessCliArgs {
  const args: FitnessCliArgs = {
    outDir: path.join(process.cwd(), 'context', 'measurements'),
    sampleSize: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample' && i + 1 < argv.length) {
      args.sampleSize = Math.max(1, parseInt(argv[++i], 10) || 50);
    } else if (a === '--out' && i + 1 < argv.length) {
      args.outDir = argv[++i];
    }
  }
  return args;
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function renderMarkdown(report: FitnessReport): string {
  const lines: string[] = [];
  lines.push(`# Reranker Fitness Check — ${isoDate()}`);
  lines.push('');
  lines.push(`**Reranker URL:** \`${report.reranker_url}\``);
  lines.push(`**Reachable:** ${report.reranker_reachable ? 'yes' : 'NO — fitness check skipped'}`);
  lines.push(`**Sample size:** ${report.sample_size}`);
  lines.push(`**Mean top-3 overlap:** ${(report.mean_top3_overlap * 100).toFixed(1)}%`);
  lines.push(`**Threshold:** ${(PASS_THRESHOLD * 100).toFixed(0)}%`);
  lines.push(`**Verdict:** ${report.pass ? 'PASS' : 'BELOW THRESHOLD'}`);
  lines.push('');

  if (!report.reranker_reachable) {
    lines.push('## Reranker unreachable');
    lines.push('');
    lines.push('The cross-encoder service was not reachable on port 7439. P9 should');
    lines.push('default to bi-encoder-only retrieval per CONTEXT decision 4.');
    lines.push('');
    lines.push('Restart the supervisor with: `node dist/angel/index.cjs`');
    return lines.join('\n');
  }

  lines.push('## Per-query overlap distribution');
  lines.push('');
  const buckets = [0, 0, 0, 0]; // 0/3, 1/3, 2/3, 3/3
  for (const q of report.per_query) {
    const idx = Math.round(q.overlap * 3);
    buckets[idx] = (buckets[idx] ?? 0) + 1;
  }
  const labels = ['0/3', '1/3', '2/3', '3/3'];
  for (let i = 0; i < buckets.length; i++) {
    const bar = '#'.repeat(buckets[i]);
    lines.push(`  ${labels[i]}: ${buckets[i].toString().padStart(3)}  ${bar}`);
  }
  lines.push('');
  lines.push('## Reading the verdict');
  lines.push('');
  lines.push('Below threshold does NOT block ship. It informs P9: if cross-encoder');
  lines.push('top-3 stability against the bi-encoder is < 60% on transcript-distribution');
  lines.push('data, P9 uses bi-encoder-only as the baseline retrieval mode.');
  lines.push('Above threshold means the cross-encoder is the safe P9 default.');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase(getDbPath());
  try {
    const report = await computeRerankerFitness(db, { sampleSize: args.sampleSize });

    if (report.sample_size === 0 && !report.reranker_reachable) {
      console.log('No transcript chunks available — run `bun run backfill:transcripts` first.');
      process.exit(0);
    }

    fs.mkdirSync(args.outDir, { recursive: true });
    const outPath = path.join(args.outDir, `${isoDate()}-reranker-fitness.md`);
    fs.writeFileSync(outPath, renderMarkdown(report) + '\n');

    if (!report.reranker_reachable) {
      console.error('Reranker unreachable — fitness check skipped. P9 should default to bi-encoder-only retrieval per CONTEXT decision 4.');
    } else {
      const pct = (report.mean_top3_overlap * 100).toFixed(1);
      const verdict = report.pass ? 'PASS' : 'BELOW THRESHOLD';
      console.log(`Reranker fitness: mean top-3 overlap ${pct}% (n=${report.sample_size}) — ${verdict}`);
    }
    console.log(`Report: ${outPath}`);
  } finally {
    closeDatabase(db);
  }
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    return argv1.endsWith('reranker-fitness.ts') ||
           argv1.endsWith('reranker-fitness.cjs') ||
           argv1.endsWith('reranker-fitness.js');
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('reranker-fitness failed:', err);
    process.exit(1);
  });
}
