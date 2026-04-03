/**
 * Angel System types — shared across all Angel modules.
 */

/** Retention configuration for the Guardian of All Memory. */
export interface RetentionConfig {
  /** conversation_turns: days to keep full text. Default: 30 */
  conversationTurnsFullDays: number;
  /** conversation_turns: days to keep skeletal (user_text only). Default: 90 */
  conversationTurnsSkeletalDays: number;
  /** artifacts: days before unaccessed low-importance artifacts are deleted. Default: 60 */
  artifactColdDeleteDays: number;
  /** artifacts: days before superseded artifacts are deleted. Default: 30 */
  artifactSupersededDeleteDays: number;
  /** session_journal flow entries: retention days. Default: 60 */
  journalFlowRetentionDays: number;
  /** session_journal milestone entries: retention days. Default: 180 */
  journalMilestoneRetentionDays: number;
  /** session_events: retention days. Default: 90 */
  sessionEventsRetentionDays: number;
  /** retrieval_events: days before aggregation + deletion. Default: 30 */
  retrievalEventsRetentionDays: number;
  /** verified_facts: retention days. Default: 180 */
  verifiedFactsRetentionDays: number;
  /** observations: days before low-importance (1-2) observations are pruned. Default: 30 */
  observationLowImpRetentionDays: number;
  /** observations: days before medium-importance (3) observations are pruned. Default: 90 */
  observationMedImpRetentionDays: number;
  /** observations: days before high-importance (4-5) observations are pruned. Default: 180 */
  observationHighImpRetentionDays: number;
  /** Projects with no sessions for this many days get archived. Default: 30 */
  abandonedProjectDays: number;
  /** Retention sweep interval in minutes. Default: 60 */
  sweepIntervalMinutes: number;
  /** Data quality check interval in minutes. Default: 120 */
  qualityCheckIntervalMinutes: number;
  /** DB health self-report interval in hours. Default: 24 */
  healthReportIntervalHours: number;
  /** Enable cross-project knowledge consolidation. Default: true */
  crossProjectConsolidation: boolean;
  /** Enable data quality checks. Default: true */
  dataQualityChecks: boolean;
  /** Enable proactive memory curation. Default: true */
  proactiveCuration: boolean;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  conversationTurnsFullDays: 30,
  conversationTurnsSkeletalDays: 90,
  artifactColdDeleteDays: 60,
  artifactSupersededDeleteDays: 30,
  journalFlowRetentionDays: 60,
  journalMilestoneRetentionDays: 180,
  sessionEventsRetentionDays: 90,
  retrievalEventsRetentionDays: 30,
  verifiedFactsRetentionDays: 180,
  observationLowImpRetentionDays: 30,
  observationMedImpRetentionDays: 90,
  observationHighImpRetentionDays: 180,
  abandonedProjectDays: 30,
  sweepIntervalMinutes: 60,
  qualityCheckIntervalMinutes: 120,
  healthReportIntervalHours: 24,
  crossProjectConsolidation: true,
  dataQualityChecks: true,
  proactiveCuration: true,
};

export interface AngelConfig {
  /** Heartbeat interval in milliseconds. Default: 30 minutes. */
  heartbeatIntervalMs: number;
  /** Idle threshold in seconds — sessions inactive beyond this get a warning. Default: 15 min. */
  idleThresholdSeconds: number;
  /** Auto-close threshold in minutes — sessions still idle this long after warning get auto-closed. Default: 15 min (so 30 min total). */
  autoCloseMinutesAfterWarning: number;
  /** Cloud model for complex reasoning (pattern extraction). Uses CliProxy/API. Default: claude-sonnet-4-6. */
  cloudModel: string;
  /** Local model for simple tasks (classification). Uses Ollama. Default: llama3.2. */
  localModel: string;
  /** Max patterns to extract per session. Default: 5. */
  maxPatternsPerSession: number;
  /** PID file path. */
  pidFile: string;
  /** Retention and guardian configuration. */
  retention: RetentionConfig;
}

/** Result types for guardian phases. */
export interface RetentionSweepResult {
  conversation_turns_skeletal: number;
  conversation_turns_deleted: number;
  artifacts_deleted: number;
  journal_entries_deleted: number;
  session_events_deleted: number;
  retrieval_events_deleted: number;
  artifact_links_deleted: number;
  verified_facts_deleted: number;
  session_messages_deleted: number;
  observations_deleted: number;
  observations_superseded: number;
}

export interface CrossProjectResult {
  learnings_deduped: number;
  decisions_deduped: number;
  patterns_deduped: number;
  learnings_propagated: number;
}

export interface DataQualityResult {
  zero_obs_sessions_queued: number;
  orphaned_records_deleted: number;
  stale_embeddings_nulled: number;
  fts_discrepancies: number;
}

export interface CurationResult {
  artifacts_promoted: number;
  artifacts_decayed: number;
  contradictions_detected: number;
  hot_files_cooled: number;
  projects_archived: number;
  health_report_sent: boolean;
  digests_prepared: number;
}

export const DEFAULT_ANGEL_CONFIG: AngelConfig = {
  heartbeatIntervalMs: 2 * 60 * 1000, // 2 minutes (adaptive loop overrides based on workload)
  idleThresholdSeconds: 15 * 60,        // 15 minutes — warning
  autoCloseMinutesAfterWarning: 15,     // 15 minutes after warning — auto-close (30 min total)
  cloudModel: 'claude-opus-4-6',
  localModel: 'glm-5:cloud',
  maxPatternsPerSession: 5,
  pidFile: '',  // Set at runtime from paths
  retention: { ...DEFAULT_RETENTION_CONFIG },
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
  pattern_type?: 'correction' | 'behavioral';
  trigger_intents?: string[];
  retrieval_mode?: 'always' | 'categorical' | 'reactive';
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
