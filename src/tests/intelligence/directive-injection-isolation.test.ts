/**
 * Injection-path isolation check (Plan 03-04).
 *
 * Phase 3 contract: the directive detector is write-side only. It must NOT
 * import from `src/assembler/*`, `src/hooks/*`, or any section formatter —
 * those are the session-start injection path, scheduled to be rewritten in
 * P4/P6. Coupling the detector to them now would force P4's blast radius to
 * cross P2, and that's exactly what this phase's gate criteria forbid.
 *
 * This test is a cheap running guard. The complementary check — "the
 * heartbeat-diff doesn't touch assembler/sections" — is NOT a running test;
 * it's a phase-completion verification (see 03-CONTEXT §gate_criteria).
 */

import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DETECTOR_PATH = path.resolve('src/intelligence/directive-detector.ts');
const REGEX_PATH = path.resolve('src/intelligence/directive-detector-regex.ts');
const CONFIG_PATH = path.resolve('src/intelligence/directive-detector-config.ts');

function readSrc(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

it('directive-detector.ts does not import from assembler, hooks, or sections', () => {
  const src = readSrc(DETECTOR_PATH);
  expect(src).not.toMatch(/from ['"][^'"]*\/assembler\//);
  expect(src).not.toMatch(/from ['"][^'"]*\/hooks\//);
  expect(src).not.toMatch(/from ['"][^'"]*\/sections/);
});

it('directive-detector-regex.ts stays standalone (no assembler/hooks/sections imports)', () => {
  const src = readSrc(REGEX_PATH);
  expect(src).not.toMatch(/from ['"][^'"]*\/assembler\//);
  expect(src).not.toMatch(/from ['"][^'"]*\/hooks\//);
  expect(src).not.toMatch(/from ['"][^'"]*\/sections/);
});

it('directive-detector-config.ts stays standalone', () => {
  const src = readSrc(CONFIG_PATH);
  expect(src).not.toMatch(/from ['"][^'"]*\/assembler\//);
  expect(src).not.toMatch(/from ['"][^'"]*\/hooks\//);
  expect(src).not.toMatch(/from ['"][^'"]*\/sections/);
});
