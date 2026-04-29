/**
 * Phase 5 full-gate aggregator (Plan 09).
 *
 * Verifies the per-SC report files are present and that the canonical
 * verdict line in 05-09-FINAL-VERDICT.md is "**Final verdict**".
 *
 * The underlying test files run independently — this aggregator is
 * intentionally lightweight: it locks the *paper trail* of the gate so
 * that future regressions can immediately see which gate file is missing
 * or has a bad verdict header.
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PHASE_DIR = path.join(
  process.cwd(),
  '.planning',
  'phases',
  '05-p4-kill-legacy-injection-big-benchmark-gate',
);

function readReport(name: string): string {
  const p = path.join(PHASE_DIR, name);
  expect(fs.existsSync(p), `report missing: ${name}`).toBe(true);
  return fs.readFileSync(p, 'utf-8');
}

describe('Phase 5 full gate — paper trail', () => {
  test('SC#1 report exists and verdict line present', () => {
    const md = readReport('05-09-SC1-VESNA-RESULT.md');
    expect(md).toMatch(/##\s+Verdict/);
    expect(md).toMatch(/\*\*PASS/);
  });

  test('SC#2 report exists and PASS', () => {
    const md = readReport('05-09-SC2-CACHE-RESULT.md');
    expect(md).toMatch(/##\s+Verdict/);
    expect(md).toMatch(/\*\*PASS\*\*/);
  });

  test('SC#3 report exists and PASS', () => {
    const md = readReport('05-09-SC3-MEMORY-RESULT.md');
    expect(md).toMatch(/##\s+Verdict/);
    expect(md).toMatch(/\*\*PASS\*\*/);
  });

  test('SC#4 report exists and PASS', () => {
    const md = readReport('05-09-SC4-PICKUP-RESULT.md');
    expect(md).toMatch(/##\s+Verdict/);
    expect(md).toMatch(/\*\*PASS\*\*/);
  });

  test('Final verdict report exists and PASS', () => {
    const md = readReport('05-09-FINAL-VERDICT.md');
    expect(md).toMatch(/##\s+Final verdict/);
    expect(md).toMatch(/\*\*PASS\*\*/);
  });

  test('All 11 phase requirement IDs are mentioned in the final verdict', () => {
    const md = readReport('05-09-FINAL-VERDICT.md');
    const ids = ['INJ-01', 'INJ-02', 'INJ-03', 'INJ-04', 'INJ-05', 'INJ-06', 'INJ-07',
                 'CACH-01', 'CACH-02', 'CACH-03', 'TOK-01'];
    for (const id of ids) {
      expect(md, `missing requirement ID ${id}`).toContain(id);
    }
  });

  test('All 9 plan SUMMARY files exist on disk', () => {
    for (let i = 1; i <= 9; i++) {
      const num = i.toString().padStart(2, '0');
      const p = path.join(PHASE_DIR, `05-${num}-SUMMARY.md`);
      expect(fs.existsSync(p), `missing SUMMARY: 05-${num}`).toBe(true);
    }
  });
});
