/**
 * Checkpoint v3 schema interfaces, status types, and threshold constants.
 * No runtime logic — pure type definitions.
 * @see Architecture Section 8.1
 */

import type { Database } from 'better-sqlite3';
import type { TokenUsage } from '../shared/types.js';
import type { EnrichmentProvider } from '../intelligence/enrichment.js';

export type CheckpointTrigger = 'threshold' | 'compaction' | 'session_end';
export type CheckpointStatus = 'pending' | 'committed' | 'mirrored';
export type SelectiveLoadPreset = 'ALWAYS' | 'RESUME' | 'GSD';
export type WorkingStatus = 'in_progress' | 'blocked' | 'paused';

/** Matches checkpoint_meta DB row. */
export interface CheckpointMeta {
  checkpoint_id: string;
  session_id: string;
  trigger: CheckpointTrigger;
  status: CheckpointStatus;
  data: string | null;
  mirror_path: string | null;
  error: string | null;
  created_at_epoch: number;
  updated_at_epoch: number;
}

/** Working context section. */
export interface WorkingState {
  task: string | null;
  status: WorkingStatus | null;
  next_action: string | null;
  branch: string | null;
}

/** File tracking section. */
export interface CheckpointFiles {
  hot: Array<{ path: string; last_action?: string | null }>;
  read: string[];
}

/** Thread section. */
export interface CheckpointThread {
  topic: string | null;
  summary: string | null;
  key_exchanges: Array<{ role: string; gist: string }>;
}

/** Decision entry. */
export interface CheckpointDecision {
  content: string;
  source: string;
  timestamp: number;
}

/** Full schema v3 checkpoint. @see Architecture Section 8.1 */
export interface CheckpointV3 {
  schema: 'claudex/checkpoint';
  version: 3;
  meta: {
    checkpoint_id: string;
    session_id: string;
    scope: string | null;
    trigger: CheckpointTrigger;
    token_usage: {
      input_tokens: number;
      output_tokens: number;
      window_size: number;
      utilization: number;
    } | null;
    previous_checkpoint: string | null;
  };
  working: WorkingState;
  decisions: CheckpointDecision[];
  files: CheckpointFiles;
  thread: CheckpointThread;
  open_items: string[];
  learnings: string[];
  gsd: unknown | null;
  /** 1-2 line recitation: current task, step, what's next. @see Upgrade 10 */
  current_objective?: string | null;
  /** Verified facts that should not be re-checked. @see Upgrade 12 */
  verified_facts?: string[];
}

/** Input for writeCheckpoint. */
export interface WriteCheckpointParams {
  db: Database;
  sessionId: string;
  project: string;
  projectDir: string;
  trigger: CheckpointTrigger;
  tokenUsage?: TokenUsage;
  gsd?: unknown;
  lastAssistantText?: string;
  enrichmentProvider?: EnrichmentProvider;
  scope?: string;
  /** When true, writes YAML compressed as .yaml.gz via zlib. Default false. */
  compression?: boolean;
}

/** Output from writeCheckpoint. */
export interface WriteCheckpointResult {
  checkpointId: string;
  status: CheckpointStatus;
  filePath: string | null;
  enriched: boolean;
}

/** Thresholds for 200k context windows (75%, 90%). */
export const THRESHOLDS_200K = [0.75, 0.90];

/** Thresholds for 1M context windows (15% through 90%). */
export const THRESHOLDS_1M = [0.15, 0.30, 0.45, 0.60, 0.75, 0.90];

/** Window size boundary: below = 200k thresholds, above = 1M thresholds. */
export const WINDOW_THRESHOLD = 500_000;
