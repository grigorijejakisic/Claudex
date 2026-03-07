/**
 * CM Adapter — Type Definitions
 *
 * Types for the Context Manager adapter's state files
 * and coordination config reading.
 */

export interface FileAccess {
  path: string;
  access_count: number;
  last_accessed: string; // ISO-8601
  kind: 'read' | 'modified';
}

export interface StateFiles {
  decisions: Array<{ id: string; what: string; when: string }>;
  thread: Array<{ role: 'user' | 'agent'; gist: string }>;
  resources: { files: FileAccess[]; tools_used: string[] };
  open_items: string[];
  learnings: Array<{ text: string; when: string }>;
}

export interface CrossSessionLearning {
  id: string;
  text: string;
  source_session: string;
  created_at: string;
  last_promoted_at: string;
  promotion_count: number;
  last_checkpoint_id: string;
}

export interface CrossSessionLearningsStore {
  version: 1;
  max_entries: 50;
  learnings: CrossSessionLearning[];
}

/** Role assignment from coordination config */
export type RoleOwner = 'claudex' | 'context_manager' | 'both';
