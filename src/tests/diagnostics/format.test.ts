import { describe, it, expect } from 'vitest';
import { formatHuman, formatJson } from '../../diagnostics/format.js';
import type { DoctorReport } from '../../diagnostics/types.js';

const PASS_REPORT: DoctorReport = {
  overall: 'pass',
  startedAt: '2026-05-02T00:00:00.000Z',
  durationMs: 100,
  checks: [
    { name: 'Bun version', status: 'pass', detail: 'Bun 1.3.6', durationMs: 4 },
    { name: 'DB schema', status: 'pass', detail: 'user_version=24', durationMs: 8 },
  ],
};

const MIXED_REPORT: DoctorReport = {
  overall: 'fail',
  startedAt: '2026-05-02T00:00:00.000Z',
  durationMs: 250,
  checks: [
    { name: 'Bun version', status: 'pass', detail: 'Bun 1.3.6', durationMs: 4 },
    {
      name: 'Reranker',
      status: 'warn',
      detail: 'port 7439 unreachable',
      remediation: 'Restart Angel',
      durationMs: 30,
    },
    {
      name: 'DB schema',
      status: 'fail',
      detail: 'DB schema v23 < build v24',
      remediation: "Run 'bun run setup'",
      durationMs: 8,
    },
  ],
};

describe('formatHuman', () => {
  it('renders all-pass report with success footer and no remediation lines', () => {
    const out = formatHuman(PASS_REPORT);
    expect(out).toContain('Claudex Doctor');
    expect(out).toContain('Bun version');
    expect(out).toContain('Bun 1.3.6');
    expect(out).toContain('DB schema');
    expect(out).toContain('user_version=24');
    expect(out).toContain('All checks passed. Claudex is healthy.');
    expect(out).not.toContain('→');
  });

  it('renders mixed report with ✓/⚠/✗ symbols, remediation lines, and failure footer', () => {
    const out = formatHuman(MIXED_REPORT);
    expect(out).toContain('✓ Bun version');
    expect(out).toContain('⚠ Reranker');
    expect(out).toContain('✗ DB schema');
    expect(out).toContain('  → Restart Angel');
    expect(out).toContain("  → Run 'bun run setup'");
    expect(out).toContain('1 check failed. See remediations above.');
  });

  it('counts warnings in the success footer when overall is pass', () => {
    const warnReport: DoctorReport = {
      overall: 'pass',
      startedAt: '2026-05-02T00:00:00.000Z',
      durationMs: 50,
      checks: [
        {
          name: 'Reranker',
          status: 'warn',
          detail: 'port 7439 unreachable',
          remediation: 'Restart Angel',
          durationMs: 30,
        },
      ],
    };
    const out = formatHuman(warnReport);
    expect(out).toContain('All checks passed (1 warning). Claudex is healthy.');
  });
});

describe('formatJson', () => {
  it('emits valid JSON with status, checks, startedAt, durationMs', () => {
    const out = formatJson(MIXED_REPORT);
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe('fail');
    expect(parsed.checks).toHaveLength(3);
    expect(parsed.checks[0].name).toBe('Bun version');
    expect(parsed.startedAt).toBe(MIXED_REPORT.startedAt);
    expect(parsed.durationMs).toBe(MIXED_REPORT.durationMs);
  });
});
