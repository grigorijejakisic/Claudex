/**
 * GSD state interfaces matching checkpoint gsd: field schema.
 */

export interface GsdState {
  phase: number;
  /** Canonical phase token from STATE.md (e.g. "5", "4.1"). EXACT match for INJ-06 prime. */
  phase_string?: string;
  /** Optional phase name from STATE.md `Current Phase Name:` line. */
  phase_name?: string;
  plan: number;
  status: string;
  goal: string;
  success_criteria: string[];
  completion: string; // e.g. "4/6 requirements met"
}

