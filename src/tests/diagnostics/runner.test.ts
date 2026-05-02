import { describe, it, expect } from 'vitest';
import { runChecks } from '../../diagnostics/runner.js';
import type { RegisteredCheck } from '../../diagnostics/types.js';

describe('runChecks', () => {
  it('aggregates all-pass checks → overall pass', async () => {
    const checks: RegisteredCheck[] = [
      { name: 'A', fn: async () => ({ name: 'A', status: 'pass', detail: 'ok' }) },
      { name: 'B', fn: async () => ({ name: 'B', status: 'pass', detail: 'ok' }) },
    ];

    const report = await runChecks(checks);

    expect(report.overall).toBe('pass');
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0].name).toBe('A');
    expect(report.checks[1].name).toBe('B');
    expect(report.checks[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(report.checks[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(report.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('aggregates one fail + one pass → overall fail; preserves remediation', async () => {
    const checks: RegisteredCheck[] = [
      { name: 'A', fn: async () => ({ name: 'A', status: 'pass', detail: 'ok' }) },
      {
        name: 'B',
        fn: async () => ({
          name: 'B',
          status: 'fail',
          detail: 'broken',
          remediation: 'try X',
        }),
      },
    ];

    const report = await runChecks(checks);

    expect(report.overall).toBe('fail');
    const failing = report.checks.find((c) => c.name === 'B');
    expect(failing?.status).toBe('fail');
    expect(failing?.remediation).toBe('try X');
  });

  it('traps thrown errors → coerces to fail; other checks still run', async () => {
    const checks: RegisteredCheck[] = [
      {
        name: 'thrower',
        fn: async () => {
          throw new Error('boom');
        },
      },
      { name: 'survivor', fn: async () => ({ name: 'survivor', status: 'pass', detail: 'ok' }) },
    ];

    const report = await runChecks(checks);

    const thrown = report.checks.find((c) => c.name === 'thrower');
    expect(thrown?.status).toBe('fail');
    expect(thrown?.detail).toContain('boom');
    expect(thrown?.remediation).toBeDefined();

    const survivor = report.checks.find((c) => c.name === 'survivor');
    expect(survivor?.status).toBe('pass');

    expect(report.overall).toBe('fail');
  });

  it('warn-only checks → overall pass (warn does not fail the run)', async () => {
    const checks: RegisteredCheck[] = [
      {
        name: 'A',
        fn: async () => ({ name: 'A', status: 'warn', detail: 'degraded', remediation: 'restart X' }),
      },
      {
        name: 'B',
        fn: async () => ({ name: 'B', status: 'warn', detail: 'degraded', remediation: 'restart Y' }),
      },
    ];

    const report = await runChecks(checks);

    expect(report.overall).toBe('pass');
    expect(report.checks.every((c) => c.status === 'warn')).toBe(true);
  });
});
