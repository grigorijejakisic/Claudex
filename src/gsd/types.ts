/**
 * GSD state interfaces matching checkpoint gsd: field schema.
 * @see Architecture Section 10
 */

export interface GsdState {
  phase: number;
  plan: number;
  status: string;
  goal: string;
  success_criteria: string[];
  completion: string; // e.g. "4/6 requirements met"
}

