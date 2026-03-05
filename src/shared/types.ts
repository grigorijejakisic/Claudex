/**
 * Claudex v2 — Shared Type Definitions
 *
 * These types are the contract between all work packages.
 * Changes here affect every module. Modify with care.
 */

import type { GsdState } from '../gsd/types.js';
import type { GsdCheckpointState } from '../checkpoint/types.js';

// =============================================================================
// Hook I/O
// =============================================================================

/** Common stdin fields received by all hooks */
export interface HookStdin {
  schema_version?: number;  // Absent = v1 (backward compat)
  session_id: string;
  hook_event_name: string;
  cwd: string;
  transcript_path?: string;
}

/** Stdin for SessionStart hook */
export interface SessionStartInput extends HookStdin {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear';
}

/** Stdin for PreCompact hook */
export interface PreCompactInput extends HookStdin {
  hook_event_name: 'PreCompact';
  trigger: 'auto' | 'manual';
}

/** Stdin for SessionEnd hook */
export interface SessionEndInput extends HookStdin {
  hook_event_name: 'SessionEnd';
  reason: 'clear' | 'logout' | 'prompt_input_exit';
}

/** Stdin for UserPromptSubmit hook */
export interface UserPromptSubmitInput extends HookStdin {
  hook_event_name: 'UserPromptSubmit';
}

/** Stdin for PostToolUse hook */
export interface PostToolUseInput extends HookStdin {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
}

/** Stdin for Stop hook */
export interface StopInput extends HookStdin {
  hook_event_name: 'Stop';
  stop_reason?: string;
}

/** Stdout format for all hooks (Claude Code v1.0.21+ protocol) */
export interface HookStdout {
  schema_version?: number;  // Stamped on output by infrastructure
  systemMessage?: string;   // Top-level system message (Stop hook and others)
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

// =============================================================================
// Scope
// =============================================================================

export type Scope =
  | { type: 'global' }
  | { type: 'project'; name: string; path: string };

/** Project entry in ~/.claudex/projects.json (object-map format) */
interface ProjectEntry {
  path: string;
  status: 'active' | 'archived';
}

/** Full projects.json structure */
export interface ProjectsRegistry {
  projects: Record<string, ProjectEntry>;
}

// =============================================================================
// Observations
// =============================================================================

export type ObservationCategory =
  | 'decision'
  | 'discovery'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'change'
  | 'error'
  | 'configuration';

export interface Observation {
  id?: number;
  session_id: string;
  timestamp: string;          // ISO-8601 UTC
  timestamp_epoch: number;
  tool_name: string;
  category: ObservationCategory;
  title: string;
  content: string;
  facts?: string[];           // Structured facts extracted
  files_read?: string[];
  files_modified?: string[];
  importance: number;         // 1=trivial, 2=minor, 3=normal, 4=significant, 5=critical
  project?: string;           // null for global scope
}

/** Session record in SQLite (complements sessions/index.json) */
export interface SessionRecord {
  id?: number;
  session_id: string;
  scope: string;              // 'global' or 'project:<name>'
  project?: string;
  cwd: string;
  started_at: string;
  started_at_epoch: number;
  ended_at?: string;
  ended_at_epoch?: number;
  status: 'active' | 'completed' | 'failed';
  observation_count: number;
}

// =============================================================================
// Checkpoint State
// =============================================================================

export interface CheckpointState {
  session_id: string;
  last_epoch: number;
  active_files: string[];
  boost_applied_at?: number;
  boost_turn_count?: number;
}

// =============================================================================
// Search
// =============================================================================

export interface SearchResult {
  observation: Observation;
  rank: number;               // BM25 relevance score
  snippet: string;            // Context snippet around match
}

// =============================================================================
// Reasoning Chains (Flow)
// =============================================================================

export type ReasoningTrigger = 'pre_compact' | 'manual' | 'session_end';

export interface ReasoningChain {
  id?: number;
  session_id: string;
  project?: string;
  timestamp: string;
  timestamp_epoch: number;      // milliseconds
  trigger: ReasoningTrigger;
  title: string;
  reasoning: string;
  decisions?: string[];         // JSON array when stored
  files_involved?: string[];    // JSON array when stored
  importance: number;
  created_at?: string;
  created_at_epoch?: number;
}

// =============================================================================
// Consensus Decisions
// =============================================================================

export type ConsensusStatus = 'proposed' | 'agreed' | 'rejected' | 'superseded';

export interface ConsensusDecision {
  id?: number;
  session_id: string;
  project?: string;
  timestamp: string;
  timestamp_epoch: number;
  title: string;
  description: string;
  claude_position?: string;
  codex_position?: string;
  human_verdict?: string;
  status: ConsensusStatus;
  tags?: string[];              // JSON array when stored
  files_affected?: string[];    // JSON array when stored
  importance: number;
  created_at?: string;
  created_at_epoch?: number;
}

// =============================================================================
// Pressure Scores
// =============================================================================

export type TemperatureLevel = 'HOT' | 'WARM' | 'COLD';

export interface PressureScore {
  id?: number;
  file_path: string;
  /**
   * Project scope for this pressure score. Uses `'__global__'` sentinel
   * for global scope (no project). Never stored as NULL in SQLite —
   * the sentinel ensures UNIQUE(file_path, project) works correctly.
   */
  project?: string;
  raw_pressure: number;
  temperature: TemperatureLevel;
  last_accessed_epoch?: number;
  decay_rate: number;
  updated_at?: string;
  updated_at_epoch?: number;
}

// =============================================================================
// Hologram Sidecar
// =============================================================================

export interface ScoredFile {
  path: string;
  raw_pressure: number;
  temperature: 'HOT' | 'WARM' | 'COLD';
  system_bucket: number;
  pressure_bucket: number;
  phase_boosted?: boolean;  // true when file was boosted by phase relevance
}

export interface HologramQuery {
  prompt: string;
  session_state?: Record<string, unknown>;
}

export interface HologramResponse {
  hot: ScoredFile[];
  warm: ScoredFile[];
  cold: ScoredFile[];
}

/** Request sent to hologram sidecar via TCP/NDJSON */
export interface SidecarRequest {
  id: string;
  type: 'query' | 'ping' | 'update' | 'shutdown';
  payload: {
    prompt?: string;
    claude_dir?: string;
    files_changed?: string[];
    session_state?: {
      turn_number: number;
      session_id: string;
    };
    project_dir?: string;
    project_config?: {
      patterns: string[];
      exclude: string[];
      max_files: number;
    };
    boost_files?: string[];
  };
}

/** Response from hologram sidecar via TCP/NDJSON */
export interface SidecarResponse {
  id: string;
  type: 'result' | 'pong' | 'error';
  payload: {
    hot?: ScoredFile[];
    warm?: ScoredFile[];
    cold?: ScoredFile[];
    error_message?: string;
  };
  timing_ms?: number;
}

// =============================================================================
// Context Assembly
// =============================================================================

export interface ContextSources {
  hologram: HologramResponse | null;
  searchResults: SearchResult[];
  recentObservations: Observation[];
  reasoningChains?: ReasoningChain[];
  consensusDecisions?: ConsensusDecision[];
  scope: Scope;
  identity?: { agent?: string; user?: string };
  projectContext?: { primer?: string; handoff?: string };
  postCompaction?: boolean;
  gsdState?: GsdState;
  gsdPlanMustHaves?: string[];
  gsdRequirementStatus?: { complete: number; total: number };
  checkpointGsd?: GsdCheckpointState;  // Fallback GSD from checkpoint when live GSD unavailable
}

export interface AssembledContext {
  markdown: string;
  tokenEstimate: number;
  sources: string[];
}

// =============================================================================
// Configuration
// =============================================================================

export interface ClaudexConfig {
  hologram?: {
    enabled: boolean;
    python_path?: string;
    sidecar_path?: string;
    timeout_ms: number;
    health_interval_ms: number;
    project_patterns?: string[];
    project_exclude?: string[];
    project_max_files?: number;
  };
  database?: {
    path?: string;
    wal_mode: boolean;
  };
  hooks?: {
    latency_budget_ms: number;
    context_token_budget?: number;
  };
  observation?: {
    enabled: boolean;
    redact_secrets: boolean;
    retention_days?: number;
  };
  wrapper?: {
    enabled: boolean;
    warnThreshold: number;      // default 0.70 — emit warning log
    flushThreshold: number;     // default 0.80 — trigger flush
    cooldownMs: number;         // default 30000 — min time between flushes
  };
  vector?: {
    enabled: boolean;           // default false (use FTS5)
    provider: 'fts5' | 'openai' | 'local';
    openai?: { apiKey?: string; model?: string };
  };
  checkpoint?: {
    /** Override auto-detected context window size (in tokens). */
    window_size?: number;
  };
}

/** Default configuration values */
export const DEFAULT_CONFIG: ClaudexConfig = {
  hologram: {
    enabled: true,
    timeout_ms: 2000,
    health_interval_ms: 30000,
    project_patterns: ['*.md', '*.ts', '*.py', '**/*.md', '**/*.ts', '**/*.py'],
    project_exclude: [
      'node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**',
      '**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx',
      '**/test_*.py', '**/*_test.py', '**/tests/**',
    ],
    project_max_files: 200,
  },
  database: {
    wal_mode: true,
  },
  hooks: {
    latency_budget_ms: 3000,
    context_token_budget: 4000,
  },
  observation: {
    enabled: true,
    redact_secrets: true,
    retention_days: 90,
  },
  wrapper: {
    enabled: true,
    warnThreshold: 0.70,
    flushThreshold: 0.80,
    cooldownMs: 30000,
  },
  vector: {
    enabled: false,
    provider: 'fts5',
  },
  checkpoint: {
    window_size: undefined,
  },
};

// =============================================================================
// Schema Versioning
// =============================================================================

export interface SchemaVersioned {
  schema: string;     // e.g., "claudex/observation"
  version: number;    // Monotonically increasing integer
}

// Existing schemas (from v1 — DO NOT change)
export const SCHEMAS = {
  SESSION_LOG: { schema: 'claudex/session-log', version: 1 },
  HANDOFF: { schema: 'claudex/handoff', version: 1 },
  TRANSCRIPT_SNAPSHOT: { schema: 'claudex/transcript-snapshot', version: 1 },
  SESSION_INDEX: { schema: 'claudex/session-index', version: 1 },
  // New schemas (Phase 1)
  OBSERVATION: { schema: 'claudex/observation', version: 1 },
  HOOK_CONFIG: { schema: 'claudex/hook-config', version: 1 },
} as const;
