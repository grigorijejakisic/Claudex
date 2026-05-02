#!/usr/bin/env node
/**
 * `claudex doctor` — diagnose install health.
 *
 * Exit 0: all pass (warns OK).
 * Exit 1: any fail.
 * Exit 2: doctor itself crashed.
 *
 * `--json` switches to machine-readable output. No other flags supported.
 */

import { runChecks } from '../diagnostics/runner.js';
import { formatHuman, formatJson } from '../diagnostics/format.js';
import { checkBun } from '../diagnostics/check-bun.js';
import { checkDb } from '../diagnostics/check-db.js';
import { checkOllama } from '../diagnostics/check-ollama.js';
import { checkReranker } from '../diagnostics/check-reranker.js';
import { checkHooks } from '../diagnostics/check-hooks.js';
import { checkAngel } from '../diagnostics/check-angel.js';
import type { RegisteredCheck } from '../diagnostics/types.js';

const REGISTERED: RegisteredCheck[] = [
  { name: 'Bun version', fn: checkBun },
  { name: 'DB schema', fn: checkDb },
  { name: 'Ollama', fn: checkOllama },
  { name: 'Reranker', fn: checkReranker },
  { name: 'CC hooks', fn: checkHooks },
  { name: 'Angel', fn: checkAngel },
];

export interface RunDoctorOptions {
  json?: boolean;
  checks?: RegisteredCheck[];
}

export interface RunDoctorResult {
  exitCode: 0 | 1;
  output: string;
}

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<RunDoctorResult> {
  const checks = opts.checks ?? REGISTERED;
  const report = await runChecks(checks);
  const output = opts.json ? formatJson(report) : formatHuman(report);
  return {
    exitCode: report.overall === 'pass' ? 0 : 1,
    output,
  };
}

async function main(): Promise<number> {
  const wantJson = process.argv.includes('--json');
  const { exitCode, output } = await runDoctor({ json: wantJson });
  process.stdout.write(output + '\n');
  return exitCode;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`doctor crashed: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(2);
    });
}
