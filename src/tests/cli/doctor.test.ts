import { describe, it, expect } from 'vitest';
import { runDoctor } from '../../cli/doctor.js';
import type { RegisteredCheck } from '../../diagnostics/types.js';

const ALL_PASS: RegisteredCheck[] = [
  { name: 'A', fn: async () => ({ name: 'A', status: 'pass', detail: 'ok' }) },
  { name: 'B', fn: async () => ({ name: 'B', status: 'pass', detail: 'ok' }) },
];

const ONE_FAIL: RegisteredCheck[] = [
  { name: 'A', fn: async () => ({ name: 'A', status: 'pass', detail: 'ok' }) },
  {
    name: 'DB',
    fn: async () => ({
      name: 'DB',
      status: 'fail',
      detail: 'forced',
      remediation: 'try setup',
    }),
  },
];

const ONE_WARN: RegisteredCheck[] = [
  { name: 'A', fn: async () => ({ name: 'A', status: 'pass', detail: 'ok' }) },
  {
    name: 'Reranker',
    fn: async () => ({
      name: 'Reranker',
      status: 'warn',
      detail: 'port unreachable',
      remediation: 'restart angel',
    }),
  },
];

describe('runDoctor', () => {
  it('returns exitCode 0 + human-readable output when all checks pass', async () => {
    const { exitCode, output } = await runDoctor({ json: false, checks: ALL_PASS });
    expect(exitCode).toBe(0);
    expect(output).toContain('Claudex Doctor');
    expect(output).toContain('All checks passed. Claudex is healthy.');
  });

  it('returns exitCode 1 when any check fails (mocked failure)', async () => {
    const { exitCode, output } = await runDoctor({ json: false, checks: ONE_FAIL });
    expect(exitCode).toBe(1);
    expect(output).toContain('1 check failed');
    expect(output).toContain('try setup');
  });

  it('returns exitCode 0 when only warns are present (warn !== fail)', async () => {
    const { exitCode, output } = await runDoctor({ json: false, checks: ONE_WARN });
    expect(exitCode).toBe(0);
    expect(output).toContain('1 warning');
  });

  it('--json mode produces well-formed JSON with overall status', async () => {
    const { exitCode, output } = await runDoctor({ json: true, checks: ONE_FAIL });
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('fail');
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.startedAt).toBeDefined();
    expect(typeof parsed.durationMs).toBe('number');
  });

  it('--json mode emits valid JSON for an all-pass report', async () => {
    const { exitCode, output } = await runDoctor({ json: true, checks: ALL_PASS });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('pass');
    expect(parsed.checks.every((c: { status: string }) => c.status === 'pass')).toBe(true);
  });
});
