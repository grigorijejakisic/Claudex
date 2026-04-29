#!/usr/bin/env node
/**
 * Phase 5 SC#4 soak — one-turn handoff pickup verification across 3 projects.
 *
 * For each fixture project (claudex-v3, lacuna-betting, oracle) builds a
 * minimal project tree (.planning/STATE.md + context/handoffs/ACTIVE.md)
 * and verifies:
 *   1. computeInitialUserMessage(cwd) returns a non-null prime
 *   2. Prime begins with "Resume handoff: " and ends with the canonical
 *      ".planning/handoffs/ACTIVE.md." suffix
 *   3. Token count of the prime ≤ 100 (cl100k_base; the prime itself is
 *      tiny — the SC#4 contract is about the SHAPE, not size)
 *
 * Exit 0 on PASS (3/3), 1 on FAIL.
 *
 * Usage: bun run build && node dist/scripts/phase-5-soak.cjs
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encode } from 'gpt-tokenizer';
import { computeInitialUserMessage } from '../src/adapters/cc-hooks/session-start.js';

interface ProjectFixture {
  name: string;
  phase: string;
  summary: string;
}

const FIXTURES: ProjectFixture[] = [
  { name: 'claudex-v3', phase: '5', summary: 'Resume Phase 5 wave 8 — full SC#1-#4 gate aggregator running.' },
  { name: 'lacuna-betting', phase: '7.2', summary: 'Resume polling loop hardening; 60-poll shadowban incident still load-bearing.' },
  { name: 'oracle', phase: '3', summary: 'Resume topic-shift detector; cross-project recall surfaces still TBD.' },
];

interface SoakResult {
  project: string;
  prime: string | null;
  passes_contract: boolean;
  prime_tokens: number;
  begins_with_resume_handoff: boolean;
  ends_with_active_md_path: boolean;
  reason: string | null;
}

function setupFixture(tmpRoot: string, fx: ProjectFixture): string {
  const cwd = path.join(tmpRoot, fx.name);
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.planning', 'STATE.md'),
    `# State\n\n**Current Phase:** ${fx.phase}\n**Current Phase Name:** Soak Test\n`,
    'utf-8',
  );
  fs.mkdirSync(path.join(cwd, 'context', 'handoffs'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'context', 'handoffs', 'ACTIVE.md'),
    `---\nstatus: active\nphase: "${fx.phase}"\nsummary: ${fx.summary}\n---\n\n# ${fx.name} handoff\n\n${fx.summary}\n`,
    'utf-8',
  );
  return cwd;
}

function runSoak(): { results: SoakResult[]; verdict: 'PASS' | 'FAIL' } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-soak-'));
  const results: SoakResult[] = [];
  try {
    for (const fx of FIXTURES) {
      const cwd = setupFixture(tmpRoot, fx);
      const prime = computeInitialUserMessage(cwd);
      const beginsOk = prime ? prime.startsWith('Resume handoff: ') : false;
      const endsOk = prime ? prime.endsWith(' Full state at .planning/handoffs/ACTIVE.md.') : false;
      const tokens = prime ? encode(prime).length : 0;
      const passes = !!prime && beginsOk && endsOk && tokens <= 100;

      const reason: string | null =
        !prime ? 'no prime emitted' :
        !beginsOk ? `prime does not start with "Resume handoff: ": ${prime.slice(0, 40)}` :
        !endsOk ? `prime does not end with ".planning/handoffs/ACTIVE.md.": ${prime.slice(-60)}` :
        tokens > 100 ? `prime tokens=${tokens} exceeds 100` :
        null;

      results.push({
        project: fx.name,
        prime,
        passes_contract: passes,
        prime_tokens: tokens,
        begins_with_resume_handoff: beginsOk,
        ends_with_active_md_path: endsOk,
        reason,
      });
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  }

  const allPass = results.every(r => r.passes_contract);
  return { results, verdict: allPass ? 'PASS' : 'FAIL' };
}

function main(): void {
  const { results, verdict } = runSoak();

  for (const r of results) {
    console.log(`[${r.project}] passes=${r.passes_contract} tokens=${r.prime_tokens} prime=${JSON.stringify(r.prime?.slice(0, 80) ?? '')}${r.reason ? ` reason=${r.reason}` : ''}`);
  }
  console.log(JSON.stringify({ verdict, results }, null, 2));

  if (verdict !== 'PASS') {
    process.exit(1);
  }
  process.exit(0);
}

main();

export { main, runSoak };
