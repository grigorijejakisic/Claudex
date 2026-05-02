/**
 * Parallel runner for diagnostic checks.
 * Executes all registered checks concurrently, traps per-check exceptions,
 * and aggregates results into a DoctorReport.
 *
 * Pure: no printing, no process.exit, no global side effects.
 */

import type { CheckResult, DoctorReport, OverallStatus, RegisteredCheck } from './types.js';

export async function runChecks(checks: RegisteredCheck[]): Promise<DoctorReport> {
  const startedAt = new Date().toISOString();
  const runStart = performance.now();

  const results = await Promise.all(
    checks.map(async (registered): Promise<CheckResult> => {
      const t0 = performance.now();
      try {
        const partial = await registered.fn();
        return { ...partial, durationMs: Math.round(performance.now() - t0) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          name: registered.name,
          status: 'fail',
          detail: `check threw: ${message}`,
          remediation: 'Check src/diagnostics/<file>.ts logs and re-run with stderr capture.',
          durationMs: Math.round(performance.now() - t0),
        };
      }
    }),
  );

  const overall: OverallStatus = results.some((r) => r.status === 'fail') ? 'fail' : 'pass';

  return {
    overall,
    checks: results,
    startedAt,
    durationMs: Math.round(performance.now() - runStart),
  };
}
