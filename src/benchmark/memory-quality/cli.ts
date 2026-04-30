#!/usr/bin/env bun
/**
 * SC#3 CLI — invoked by `bun run sc3`.
 *
 * Runs the mechanical content-quality scorer against every active project
 * and reports per-project + aggregate results.
 *
 * Flags:
 *   --json     Emit JSON-only result for CI / Plan-07 consumption.
 *
 * Exit code: 0 iff every NON-MISSING project ≥80. Missing projects are
 * reported but do not fail the gate (per Plan 11-01 spec).
 */

import * as fs from 'fs';
import { ACTIVE_PROJECTS } from './projects.js';
import { scoreMemoryFile } from './scorer.js';
import { isMissing } from './types.js';
import type { ProjectScoreResult, MissingProjectResult, MemoryQualityScore } from './types.js';

interface CliFlags {
  json: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  return { json: argv.includes('--json') };
}

function scoreOne(project: { slug: string; memoryPath: string; activeHandoffPath?: string; unresolved?: boolean }): ProjectScoreResult {
  if (!fs.existsSync(project.memoryPath)) {
    const missing: MissingProjectResult = {
      project: project.slug,
      memoryPath: project.memoryPath,
      missing: true,
      reason: project.unresolved
        ? `slug not in ~/.claudex/projects.json registry`
        : `MEMORY.md does not exist on disk`,
    };
    return missing;
  }
  return scoreMemoryFile(project.memoryPath, {
    project: project.slug,
    activeHandoffPath: project.activeHandoffPath,
  });
}

export interface CliReport {
  /** True iff every non-missing project ≥80. */
  gated: boolean;
  /** Mean score across non-missing results, 0..100. */
  aggregate: number;
  /** Number of missing projects (informational; does NOT affect gated). */
  missingCount: number;
  /** Per-project results in registry order. */
  results: ProjectScoreResult[];
}

export function runCli(): CliReport {
  const results: ProjectScoreResult[] = ACTIVE_PROJECTS.map(scoreOne);
  const scored: MemoryQualityScore[] = results.filter((r): r is MemoryQualityScore => !isMissing(r));
  const missingCount = results.length - scored.length;
  const aggregate =
    scored.length === 0 ? 0 : scored.reduce((sum, s) => sum + s.total, 0) / scored.length;
  const gated = scored.length > 0 && scored.every(s => s.pass);
  return { gated, aggregate, missingCount, results };
}

function renderHuman(report: CliReport): string {
  const lines: string[] = [];
  lines.push('SC#3 — MEMORY.md content-quality (mechanical scoring)');
  lines.push('');
  lines.push('| Project | Score | Pass | Parsing | Project-spec | Topics | Density | Handoff |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of report.results) {
    if (isMissing(r)) {
      lines.push(`| ${r.project} | — | MISSING | — | — | — | — | — |`);
      continue;
    }
    const d = r.dimensions;
    lines.push(
      `| ${r.project} | ${r.total} | ${r.pass ? '✓' : '✗'} | ${d.parsing.score}/20 | ${d.projectSpecific.score}/20 | ${d.topicsNotSessionIds.score}/20 | ${d.pointerDensity.score}/20 | ${d.handoffFreshness.score}/20 |`,
    );
  }
  lines.push('');
  lines.push(`Gated: ${report.gated ? 'PASS' : 'FAIL'}    Aggregate: ${report.aggregate.toFixed(1)}    Missing: ${report.missingCount}`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const flags = parseArgs(args);
  const report = runCli();
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(report) + '\n');
  }
  process.exit(report.gated ? 0 : 1);
}

// Only auto-run when invoked as a script (not when imported by tests).
const isDirect = process.argv[1] && (
  process.argv[1].endsWith('cli.ts') ||
  process.argv[1].endsWith('cli.js') ||
  process.argv[1].endsWith('cli.cjs')
);
if (isDirect) {
  main().catch((e) => {
    process.stderr.write(`sc3: ${(e as Error).message}\n`);
    process.exit(2);
  });
}
