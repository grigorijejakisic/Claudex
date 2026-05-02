/**
 * CLI bundle smoke tests — runs the bundled `dist/cli/*.cjs` entry points as
 * subprocesses and asserts they exit 0 (or 1 with a message — never with a
 * runtime ReferenceError or similar bundle-time symbol-binding crash).
 *
 * Catches the v4.1.1 regression class: esbuild's CJS output renames re-exported
 * symbols for disambiguation, leaving local call sites referencing unbound
 * names. Unit tests against `src/` source pass while the bundled `dist/` fails;
 * doctor + Vesna don't exercise the broken code path either. This suite spawns
 * the actual built CLIs end-to-end so the bundled symbol resolution is tested.
 *
 * The setup CLI runs with `CLAUDEX_DRY_RUN=1` to walk all 8 steps without
 * mutating the user's machine; the dry-run mode still exercises the
 * `getHookPaths()` call site at step 8 that the v4.1.1 bug tripped over.
 *
 * Doctor and Vesna run read-only against the real environment.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SETUP_CJS = path.join(REPO_ROOT, 'dist', 'cli', 'setup.cjs');
const DOCTOR_CJS = path.join(REPO_ROOT, 'dist', 'cli', 'doctor.cjs');
const VESNA_CJS = path.join(REPO_ROOT, 'dist', 'benchmark', 'vesna', 'cli.cjs');

// ReferenceError is the canonical bundle-time symbol-binding failure.
// If any of these strings appear in stderr, the bundle is broken.
const BUNDLE_FAILURE_PATTERNS = [
  /ReferenceError:.*is not defined/,
  /SyntaxError:.*Unexpected/,
  /TypeError:.*is not a function/,
  /Cannot find module/,
];

function assertNoBundleFailure(stderr: string, stdout: string, name: string): void {
  const combined = `${stderr}\n${stdout}`;
  for (const pat of BUNDLE_FAILURE_PATTERNS) {
    expect(combined, `${name} bundle integrity failure (matched ${pat})`).not.toMatch(pat);
  }
}

describe('CLI bundle smoke', () => {
  it('setup.cjs exists in dist/', () => {
    expect(fs.existsSync(SETUP_CJS), `dist/cli/setup.cjs missing — run 'bun run build'`).toBe(true);
  });

  it('doctor.cjs exists in dist/', () => {
    expect(fs.existsSync(DOCTOR_CJS), `dist/cli/doctor.cjs missing — run 'bun run build'`).toBe(true);
  });

  it('vesna cli.cjs exists in dist/', () => {
    expect(fs.existsSync(VESNA_CJS), `dist/benchmark/vesna/cli.cjs missing — run 'bun run build'`).toBe(true);
  });

  it('setup.cjs runs to completion in dry-run mode (catches v4.1.1-class regressions)', () => {
    const result = spawnSync('node', [SETUP_CJS], {
      env: { ...process.env, CLAUDEX_DRY_RUN: '1' },
      encoding: 'utf-8',
      timeout: 30_000,
    });

    assertNoBundleFailure(result.stderr ?? '', result.stdout ?? '', 'setup.cjs');

    expect(result.status, `setup.cjs exited ${result.status}; stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('[1/8]');
    expect(result.stdout).toContain('[8/8]');
    expect(result.stdout).toContain('DRY RUN complete');
    // The v4.1.1 fix point: getHookPaths must resolve and produce a hook count.
    expect(result.stdout).toMatch(/Would register \d+ hooks/);
  }, 60_000);

  it('doctor.cjs runs read-only checks and exits 0 or 1', () => {
    const result = spawnSync('node', [DOCTOR_CJS], {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    assertNoBundleFailure(result.stderr ?? '', result.stdout ?? '', 'doctor.cjs');

    // Doctor exits 0 if all pass-or-warn; 1 if any fail. Both are valid;
    // 2 is doctor-itself-crashed which would be a bundle bug.
    expect(result.status, `doctor.cjs exited ${result.status} (2 = doctor crashed); stderr: ${result.stderr}`).not.toBe(2);
    expect([0, 1]).toContain(result.status);

    // Banner present in either pass or fail mode.
    expect(result.stdout).toContain('Claudex Doctor');

    // At least one check rendered (sanity — bundle didn't bail before the table).
    expect(result.stdout).toMatch(/Bun version|DB schema|Ollama|Reranker|CC hooks|Angel/);
  }, 60_000);

  it('doctor.cjs --json produces parseable JSON', () => {
    const result = spawnSync('node', [DOCTOR_CJS, '--json'], {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    assertNoBundleFailure(result.stderr ?? '', result.stdout ?? '', 'doctor.cjs --json');

    expect(result.status).not.toBe(2);

    // Strip Bun's `$ node ...` banner if present, then JSON-parse the rest.
    const stdout = result.stdout ?? '';
    const jsonStart = stdout.indexOf('{');
    expect(jsonStart, `doctor --json produced no JSON output: ${stdout.slice(0, 200)}`).toBeGreaterThanOrEqual(0);
    const jsonText = stdout.slice(jsonStart);

    let parsed: unknown;
    expect(() => { parsed = JSON.parse(jsonText); }, `doctor --json output not valid JSON: ${jsonText.slice(0, 200)}`).not.toThrow();
    expect(parsed).toMatchObject({
      status: expect.stringMatching(/^(pass|fail)$/),
      checks: expect.any(Array),
    });
  }, 60_000);

  it('vesna cli.cjs runs the probe corpus and exits 0 or 1', () => {
    const result = spawnSync('node', [VESNA_CJS], {
      encoding: 'utf-8',
      timeout: 120_000,
    });

    assertNoBundleFailure(result.stderr ?? '', result.stdout ?? '', 'vesna cli.cjs');

    // Vesna exits 0 if AGGREGATE pass + per-category pass; 1 if gate fails.
    // Both are valid. 2+ would suggest a bundle/runtime crash.
    expect(result.status, `vesna exited ${result.status}; stderr: ${result.stderr}`).not.toBe(2);
    expect([0, 1]).toContain(result.status);

    // Probe corpus loaded — at least one category surfaced.
    expect(result.stdout).toMatch(/AGGREGATE|entity-recall|constraint-recall|handoff-pickup/);
  }, 180_000);
});
