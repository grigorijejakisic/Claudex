/**
 * Output formatters for `claudex doctor`.
 *
 * Pure functions — no I/O. The CLI orchestrator calls them and prints.
 */

import type { DoctorReport, CheckResult } from './types.js';

const SYMBOL: Record<CheckResult['status'], string> = {
  pass: '✓',
  fail: '✗',
  warn: '⚠',
};

const RULE = '─'.repeat(50);

export function formatHuman(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('Claudex Doctor — checking install health');
  lines.push(RULE);

  for (const c of report.checks) {
    const sym = SYMBOL[c.status];
    const left = `${sym} ${c.name.padEnd(18)}`;
    const right = `${c.detail.padEnd(28)} (${c.durationMs}ms)`;
    lines.push(`${left} ${right}`);
    if (c.status !== 'pass' && c.remediation) {
      lines.push(`  → ${c.remediation}`);
    }
  }

  lines.push(RULE);

  if (report.overall === 'pass') {
    const warns = report.checks.filter((c) => c.status === 'warn').length;
    lines.push(
      warns === 0
        ? 'All checks passed. Claudex is healthy.'
        : `All checks passed (${warns} warning${warns === 1 ? '' : 's'}). Claudex is healthy.`,
    );
  } else {
    const fails = report.checks.filter((c) => c.status === 'fail').length;
    lines.push(`${fails} check${fails === 1 ? '' : 's'} failed. See remediations above.`);
  }

  return lines.join('\n');
}

export function formatJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      status: report.overall,
      checks: report.checks,
      startedAt: report.startedAt,
      durationMs: report.durationMs,
    },
    null,
    2,
  );
}
