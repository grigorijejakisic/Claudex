/**
 * Shared diagnostic-check contract for `claudex doctor`.
 * No I/O — pure types.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
  durationMs: number;
}

export type CheckFn = () => Promise<Omit<CheckResult, 'durationMs'>>;

export interface RegisteredCheck {
  name: string;
  fn: CheckFn;
}

export type OverallStatus = 'pass' | 'fail';

export interface DoctorReport {
  overall: OverallStatus;
  checks: CheckResult[];
  startedAt: string;
  durationMs: number;
}
