/**
 * compare-runs.ts — diff two precision run JSONs (Plan 03-05).
 *
 * Emits a markdown table so iteration-cycle authors can attribute gains or
 * regressions to specific config / prompt / regex changes. Per-regex-family
 * rows are filtered to those with |Δ| > 2pp, keeping the output concise.
 *
 * Usage:
 *   node dist/benchmarks/directive-detector/compare-runs.cjs <run-a.json> <run-b.json>
 */

import * as fs from 'node:fs';

interface RunDoc {
  run_id: string;
  tag?: string | null;
  metrics: {
    joint_precision: number | null;
    is_directive_precision: number | null;
    scope_precision_given_correct: number | null;
    polarity_precision_given_correct: number | null;
  };
  per_regex_family: Record<string, { candidates: number; confirmed: number; joint_correct: number; rate: number | null }>;
  per_scope: Record<string, { confirmed: number; joint_correct: number; rate: number | null }>;
  corpus: { candidates: number; labeled: number; confirmed_by_detector: number };
}

function fmtPct(n: number | null): string {
  return n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`;
}

function fmtDelta(a: number | null, b: number | null): string {
  if (a == null || b == null) return 'n/a';
  const d = (b - a) * 100;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}`;
}

export interface CompareOptions {
  familyDeltaThresholdPp?: number;
  aLabel?: string;
  bLabel?: string;
}

export function renderMarkdown(a: RunDoc, b: RunDoc, opts: CompareOptions = {}): string {
  const threshold = (opts.familyDeltaThresholdPp ?? 2) / 100;
  const aLab = opts.aLabel ?? a.run_id;
  const bLab = opts.bLabel ?? b.run_id;

  const rows: string[] = [];
  rows.push(`| Metric | ${aLab} | ${bLab} | Δ (pp) |`);
  rows.push('|---|---:|---:|---:|');

  const metricKeys: Array<keyof RunDoc['metrics']> = [
    'joint_precision',
    'is_directive_precision',
    'scope_precision_given_correct',
    'polarity_precision_given_correct',
  ];
  for (const k of metricKeys) {
    rows.push(`| ${k} | ${fmtPct(a.metrics[k])} | ${fmtPct(b.metrics[k])} | ${fmtDelta(a.metrics[k], b.metrics[k])} |`);
  }

  rows.push('');
  rows.push(`| Corpus | ${aLab} | ${bLab} |`);
  rows.push('|---|---:|---:|');
  rows.push(`| candidates | ${a.corpus.candidates} | ${b.corpus.candidates} |`);
  rows.push(`| labeled | ${a.corpus.labeled} | ${b.corpus.labeled} |`);
  rows.push(`| confirmed_by_detector | ${a.corpus.confirmed_by_detector} | ${b.corpus.confirmed_by_detector} |`);

  // Per-family diff — only rows where |Δ rate| > threshold (default 2pp).
  const familyNames = Array.from(new Set([...Object.keys(a.per_regex_family), ...Object.keys(b.per_regex_family)])).sort();
  const shifted = familyNames.filter(f => {
    const ra = a.per_regex_family[f]?.rate ?? null;
    const rb = b.per_regex_family[f]?.rate ?? null;
    if (ra == null || rb == null) return true;
    return Math.abs(ra - rb) > threshold;
  });
  if (shifted.length > 0) {
    rows.push('');
    rows.push(`Per-family (|Δ| > ${(threshold * 100).toFixed(0)}pp or missing):`);
    rows.push(`| Family | ${aLab} | ${bLab} | Δ (pp) |`);
    rows.push('|---|---:|---:|---:|');
    for (const f of shifted) {
      const ra = a.per_regex_family[f]?.rate ?? null;
      const rb = b.per_regex_family[f]?.rate ?? null;
      rows.push(`| ${f} | ${fmtPct(ra)} | ${fmtPct(rb)} | ${fmtDelta(ra, rb)} |`);
    }
  }

  // Per-scope diff — always show all three scopes since "universal" deserves
  // per-iteration visibility.
  const scopeNames = Array.from(new Set([...Object.keys(a.per_scope), ...Object.keys(b.per_scope)])).sort();
  if (scopeNames.length > 0) {
    rows.push('');
    rows.push('Per-scope:');
    rows.push(`| Scope | ${aLab} | ${bLab} | Δ (pp) |`);
    rows.push('|---|---:|---:|---:|');
    for (const s of scopeNames) {
      const ra = a.per_scope[s]?.rate ?? null;
      const rb = b.per_scope[s]?.rate ?? null;
      rows.push(`| ${s} | ${fmtPct(ra)} | ${fmtPct(rb)} | ${fmtDelta(ra, rb)} |`);
    }
  }

  return rows.join('\n') + '\n';
}

function main(argv: string[]): number {
  if (argv.length < 2) {
    console.error('compare-runs: usage <run-a.json> <run-b.json>');
    return 2;
  }
  const a = JSON.parse(fs.readFileSync(argv[0], 'utf8')) as RunDoc;
  const b = JSON.parse(fs.readFileSync(argv[1], 'utf8')) as RunDoc;
  process.stdout.write(renderMarkdown(a, b));
  return 0;
}

export { main };

declare const require: { main: unknown } | undefined;
declare const module: unknown;
try {
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    process.exit(main(process.argv.slice(2)));
  }
} catch { /* noop */ }
