/**
 * Angel System types — shared across all Angel modules.
 */

export interface AngelConfig {
  /** Heartbeat interval in milliseconds. Default: 30 minutes. */
  heartbeatIntervalMs: number;
  /** Idle threshold in seconds — sessions inactive beyond this are considered idle. Default: 30 min. */
  idleThresholdSeconds: number;
  /** Cloud model for complex reasoning (pattern extraction). Uses CliProxy/API. Default: claude-sonnet-4-6. */
  cloudModel: string;
  /** Local model for simple tasks (classification). Uses Ollama. Default: llama3.2. */
  localModel: string;
  /** Max patterns to extract per session. Default: 5. */
  maxPatternsPerSession: number;
  /** PID file path. */
  pidFile: string;
}

export const DEFAULT_ANGEL_CONFIG: AngelConfig = {
  heartbeatIntervalMs: 30 * 60 * 1000, // 30 minutes
  idleThresholdSeconds: 30 * 60,        // 30 minutes
  cloudModel: 'claude-sonnet-4-6',
  localModel: 'llama3.2',
  maxPatternsPerSession: 5,
  pidFile: '',  // Set at runtime from paths
};

export interface IdleSession {
  session_id: string;
  project: string;
  last_activity_epoch: number;
  observation_count: number;
  topic: string | null;
  idle_minutes: number;
}

export interface UnprocessedSession {
  session_id: string;
  project: string;
  turn_count: number;
  topic: string | null;
  ended_at_epoch: number;
}

export interface MemoryMigrationStats {
  entries_migrated: number;
  projects: string[];
}

export interface ExtractedPattern {
  trigger_context: string;
  lesson: string;
  anti_pattern?: string;
  severity: 'critical' | 'important' | 'minor';
  domain?: string;
}

export interface ConversationTurn {
  id: number;
  session_id: string;
  project: string;
  turn_number: number;
  user_text: string | null;
  assistant_text: string | null;
  timestamp_epoch: number;
}
