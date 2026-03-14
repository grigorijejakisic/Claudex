/**
 * GSD state interfaces matching checkpoint gsd: field schema.
 */

export interface GsdState {
  phase: number;
  plan: number;
  status: string;
  goal: string;
  success_criteria: string[];
  completion: string; // e.g. "4/6 requirements met"
}

