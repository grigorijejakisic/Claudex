/**
 * Claudex v3 -- Checkpoint Type Definitions
 *
 * These types are the shared language of the checkpoint system.
 * Every module (writer, loader, hooks) imports from this file.
 * Changes here affect all checkpoint-related code. Modify with care.
 *
 * Based on Section 12.3 of the Context Management Architecture spec.
 */

// =============================================================================
// Schema Constants
// =============================================================================

export const CHECKPOINT_SCHEMA = 'claudex/checkpoint' as const;
export const CHECKPOINT_VERSION = 2 as const;

// =============================================================================
// Checkpoint Metadata
// =============================================================================

export interface CheckpointMeta {
  checkpoint_id: string;                          // unique: "YYYY-MM-DD_cpN"
  session_id: string;
  scope: string;                                  // "global" | "project:{name}"
  created_at: string;                             // ISO-8601
  created_at_epoch_ms: number;                    // milliseconds (ensureEpochMs)
  trigger: 'auto-75pct' | 'auto-80pct' | 'manual' | 'pre-compact' | 'session-end' | 'plan-complete' | 'incremental';
  writer_version: string;                         // Claudex semver
  token_usage: {
    input_tokens: number;
    output_tokens: number;
    window_size: number;
    utilization: number;
  };
  previous_checkpoint: string | null;             // basename only -- never absolute paths
  session_log: string | null;
}

// =============================================================================
// Working State
// =============================================================================

export interface WorkingState {
  task: string;
  status: 'in_progress' | 'blocked' | 'paused';
  branch: string | null;
  next_action: string | null;
}

// =============================================================================
// Decisions
// =============================================================================

export interface Decision {
  id: string;
  what: string;
  why: string;
  when: string;                                   // ISO-8601
  reversible: boolean;
}

// =============================================================================
// Files
// =============================================================================

export interface FileState {
  changed: Array<{
    path: string;
    action: string;
    summary: string;
  }>;
  read: string[];
  hot: string[];
}

// =============================================================================
// GSD Checkpoint State
// =============================================================================

export interface GsdCheckpointState {
  active: boolean;
  milestone: string | null;
  phase: number;
  phase_name: string | null;
  phase_goal: string | null;
  plan_status: string | null;
  plan_number: number | null;
  completion_pct: number;
  requirements: Array<{
    id: string;
    status: string;
    description: string;
  }>;
}

// =============================================================================
// Thread
// =============================================================================

export interface ThreadState {
  summary: string;
  key_exchanges: Array<{
    role: 'user' | 'agent';
    gist: string;
  }>;
}

// =============================================================================
// Full Checkpoint
// =============================================================================

export interface Checkpoint {
  schema: typeof CHECKPOINT_SCHEMA;
  version: typeof CHECKPOINT_VERSION;
  meta: CheckpointMeta;
  working: WorkingState;
  decisions: Decision[];
  files: FileState;
  gsd: GsdCheckpointState | null;
  open_questions: string[];
  learnings: string[];
  thread: ThreadState;
  pressure_snapshot?: { hot: string[]; warm: string[] };
  recent_observations?: Array<{ title: string; category: string; timestamp_epoch: number }>;
  boost_state?: { files: string[]; turn: number; applied_at: number } | null;
}

// =============================================================================
// Selective Loading
// =============================================================================

export type CheckpointSection =
  | 'meta'
  | 'working'
  | 'decisions'
  | 'files'
  | 'gsd'
  | 'open_questions'
  | 'learnings'
  | 'thread';

export interface LoadOptions {
  sections: CheckpointSection[];
  resumeMode: boolean;                            // true = load decisions + thread + files.hot
}

// =============================================================================
// Loading Presets
// =============================================================================

export const ALWAYS_LOAD: CheckpointSection[] = ['meta', 'working', 'open_questions'];
export const RESUME_LOAD: CheckpointSection[] = [...ALWAYS_LOAD, 'decisions', 'thread', 'files'];
export const GSD_LOAD: CheckpointSection[] = ['gsd'];
