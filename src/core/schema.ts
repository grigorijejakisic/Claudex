/**
 * Schema DDL constants for Claudex v3.
 *
 * Contains the complete V10 schema: 23 tables + FTS5 virtual tables + triggers + indexes.
 * All CREATE statements use IF NOT EXISTS for idempotency.
 *
 * Split from migrations.ts for clarity — DDL is structural, migrations are procedural.
 */

/**
 * Complete v3 schema DDL — core tables + FTS5 virtual tables + triggers + indexes.
 * All CREATE statements use IF NOT EXISTS for idempotency.
 */
export const SCHEMA_V3 = `
-- observations: core data table
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'code', 'architecture', 'decision', 'error', 'test',
    'config', 'dependency', 'documentation', 'performance',
    'security', 'other'
  )),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)),
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at_epoch INTEGER,
  deleted_at_epoch INTEGER DEFAULT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  obs_type TEXT,
  stability_class TEXT DEFAULT 'standard'
    CHECK (stability_class IN ('transient', 'standard', 'stable', 'permanent')),
  novelty_score REAL DEFAULT 0.5,
  consolidated_into INTEGER
);

-- FTS5 virtual table for full-text search on observations.
-- Queried in production via searchArtifactsInternal Stage 1 (artifacts.ts),
-- which joins observations_fts to find artifacts by observation content match.
-- Also searchable via searchObservations (test + future use).
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, content,
  content=observations,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- FTS sync trigger: after insert
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

-- FTS sync trigger: after delete
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
END;

-- FTS sync trigger: after update
CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO observations_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

-- Observation indexes (single-column)
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC);
CREATE INDEX IF NOT EXISTS idx_obs_deleted ON observations(deleted_at_epoch);

-- Composite indexes for hot query paths
-- Dedup query in extraction dispatcher: WHERE tool_name=? AND category=? AND project=? AND session_id=? AND timestamp_epoch>?
CREATE INDEX IF NOT EXISTS idx_obs_dedup
  ON observations(tool_name, category, project, session_id, timestamp_epoch DESC);

-- getObservationsByProject + pruneObservations: WHERE project=? AND deleted_at_epoch IS NULL ORDER BY timestamp_epoch DESC
CREATE INDEX IF NOT EXISTS idx_obs_project_active
  ON observations(project, deleted_at_epoch, timestamp_epoch DESC);

-- pruneObservations candidate selection + applyRetentionPolicy: WHERE project=? AND deleted_at_epoch IS NULL AND importance<?
CREATE INDEX IF NOT EXISTS idx_obs_project_importance
  ON observations(project, deleted_at_epoch, importance);

-- Consumed observations index (post-compaction filtering)
CREATE INDEX IF NOT EXISTS idx_obs_consumed
  ON observations(project, consumed, timestamp_epoch DESC);

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  scope TEXT,
  project TEXT,
  cwd TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'failed', 'transferred')),
  observation_count INTEGER NOT NULL DEFAULT 0,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at_epoch INTEGER,
  adapter TEXT DEFAULT 'unknown',
  session_summary TEXT,
  name TEXT,
  transferred_to TEXT
);

-- getActiveSession: WHERE status='active' AND project=? ORDER BY created_at_epoch DESC
CREATE INDEX IF NOT EXISTS idx_sessions_active
  ON sessions(status, project, created_at_epoch DESC);

-- pressure_scores
CREATE TABLE IF NOT EXISTS pressure_scores (
  file_path TEXT NOT NULL,
  project TEXT NOT NULL,
  raw_pressure REAL NOT NULL DEFAULT 0.0,
  temperature TEXT NOT NULL DEFAULT 'COLD'
    CHECK (temperature IN ('HOT', 'COLD')),
  last_touched_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  decay_rate REAL NOT NULL DEFAULT 0.1,
  PRIMARY KEY (file_path, project)
);

-- getHotFiles: WHERE project=? AND temperature='HOT' ORDER BY raw_pressure DESC
CREATE INDEX IF NOT EXISTS idx_pressure_project_temp
  ON pressure_scores(project, temperature, raw_pressure DESC);

-- learnings
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL DEFAULT '__global__',
  agent_id TEXT NOT NULL DEFAULT 'default',
  fingerprint TEXT NOT NULL,
  content TEXT NOT NULL,
  promotion_count INTEGER NOT NULL DEFAULT 1,
  first_seen_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  last_promoted_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, agent_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_learnings_promo
  ON learnings(project, agent_id, promotion_count DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  content,
  tokenize='porter unicode61',
  content=learnings,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS learnings_fts_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts(rowid, content) VALUES(new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS learnings_fts_ad AFTER DELETE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS learnings_fts_au AFTER UPDATE OF content ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO learnings_fts(rowid, content) VALUES(new.id, new.content);
END;

-- decisions
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '__global__',
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'confirmation', 'direction', 'rejection', 'explicit'
  )),
  fingerprint TEXT NOT NULL,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_decisions_session
  ON decisions(session_id, timestamp_epoch DESC);

-- getDecisionsByProject: WHERE project=? ORDER BY timestamp_epoch DESC
CREATE INDEX IF NOT EXISTS idx_decisions_project
  ON decisions(project, timestamp_epoch DESC);

-- thread_state
CREATE TABLE IF NOT EXISTS thread_state (
  session_id TEXT PRIMARY KEY,
  topic TEXT,
  summary TEXT,
  key_exchanges TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(key_exchanges)),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  summary_embedding BLOB,
  qdrant_synced INTEGER NOT NULL DEFAULT 0
);

-- checkpoint_tracking
CREATE TABLE IF NOT EXISTS checkpoint_tracking (
  session_id TEXT PRIMARY KEY,
  last_checkpoint_epoch INTEGER,
  thresholds_hit TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(thresholds_hit)),
  observation_count INTEGER NOT NULL DEFAULT 0,
  post_compact_pending INTEGER NOT NULL DEFAULT 0,
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- schema_versions
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

-- checkpoint_meta
CREATE TABLE IF NOT EXISTS checkpoint_meta (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('threshold', 'compaction', 'session_end')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'committed', 'mirrored')),
  data TEXT,
  mirror_path TEXT,
  error TEXT,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_cpmeta_session
  ON checkpoint_meta(session_id, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_cpmeta_status
  ON checkpoint_meta(status, updated_at_epoch);

-- session_journal: flow breadcrumbs, milestones, session summaries
CREATE TABLE IF NOT EXISTS session_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('flow', 'milestone', 'summary')),
  content TEXT NOT NULL,
  metadata TEXT,
  recall_text TEXT,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  embedding BLOB
);

CREATE INDEX IF NOT EXISTS idx_journal_session
  ON session_journal(session_id, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_journal_project_type
  ON session_journal(project, entry_type, timestamp_epoch DESC);

-- FTS5 for session_journal — enables associative recall search
CREATE VIRTUAL TABLE IF NOT EXISTS session_journal_fts USING fts5(
  content, recall_text,
  content='session_journal',
  content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS journal_fts_ai AFTER INSERT ON session_journal BEGIN
  INSERT INTO session_journal_fts(rowid, content, recall_text)
  VALUES (new.id, new.content, COALESCE(new.recall_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS journal_fts_ad AFTER DELETE ON session_journal BEGIN
  INSERT INTO session_journal_fts(session_journal_fts, rowid, content, recall_text)
  VALUES ('delete', old.id, old.content, COALESCE(old.recall_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS journal_fts_au AFTER UPDATE ON session_journal BEGIN
  INSERT INTO session_journal_fts(session_journal_fts, rowid, content, recall_text)
  VALUES ('delete', old.id, old.content, COALESCE(old.recall_text, ''));
  INSERT INTO session_journal_fts(rowid, content, recall_text)
  VALUES (new.id, new.content, COALESCE(new.recall_text, ''));
END;

-- artifacts: reference + materialization context model
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (
    'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone',
    'memory_file', 'session_log', 'handoff'
  )),
  artifact_ref TEXT,
  summary TEXT NOT NULL,
  content TEXT,
  state TEXT NOT NULL DEFAULT 'fresh'
    CHECK (state IN ('fresh', 'packed', 'materialized')),
  ttl INTEGER NOT NULL DEFAULT 3,
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  retrieval_score REAL NOT NULL DEFAULT 1.0,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  last_materialized_epoch INTEGER,
  embedding BLOB,
  activation_score REAL NOT NULL DEFAULT 1.0,
  superseded_by INTEGER,
  valid_until INTEGER,
  confidence REAL NOT NULL DEFAULT 1.0,
  novelty_score REAL NOT NULL DEFAULT 0.5
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project_state
  ON artifacts(project, state, importance DESC, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_type_importance
  ON artifacts(project, artifact_type, importance DESC, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_session
  ON artifacts(session_id, timestamp_epoch DESC);

-- artifacts_fts: full-text search on artifact summary + content (Claudex Recall)
-- bm25() returns negative values (more negative = better match).
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  summary,
  content,
  content=artifacts,
  content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, summary, content)
  VALUES (new.id, new.summary, COALESCE(new.content, ''));
END;
CREATE TRIGGER IF NOT EXISTS artifacts_fts_update AFTER UPDATE OF summary, content ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
  VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
  INSERT INTO artifacts_fts(rowid, summary, content)
  VALUES (new.id, new.summary, COALESCE(new.content, ''));
END;
CREATE TRIGGER IF NOT EXISTS artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
  VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
END;

-- context_triggers: maps file globs and command patterns to knowledge domains
CREATE TABLE IF NOT EXISTS context_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glob_pattern TEXT,
  command_pattern TEXT,
  knowledge_domain TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  project TEXT NOT NULL DEFAULT '__global__'
);

-- session_events: structured events for cross-session thread reconstruction
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_session_events_session
  ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_project
  ON session_events(project, timestamp_epoch);

-- verified_facts: session-scoped facts for checkpoint inclusion
CREATE TABLE IF NOT EXISTS verified_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_verified_facts_session
  ON verified_facts(session_id, created_at_epoch DESC);

-- experience_patterns: cross-session failure pattern memory with ExpeL scoring
CREATE TABLE IF NOT EXISTS experience_patterns (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('correction', 'behavioral', 'discovery')),
  trigger_context TEXT NOT NULL,
  lesson TEXT NOT NULL,
  anti_pattern TEXT,
  severity TEXT NOT NULL DEFAULT 'important'
    CHECK (severity IN ('critical', 'important', 'minor')),
  score INTEGER NOT NULL DEFAULT 2,
  times_triggered INTEGER NOT NULL DEFAULT 0,
  times_useful INTEGER NOT NULL DEFAULT 0,
  source_session TEXT,
  source_project TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  last_triggered_epoch INTEGER,
  trigger_glob TEXT,
  trigger_command TEXT,
  embedding BLOB,
  assumption TEXT,
  reality TEXT,
  root_cause TEXT,
  generalized_rule TEXT,
  abstraction_level TEXT DEFAULT 'tip',
  verified INTEGER NOT NULL DEFAULT 0,
  verification_count INTEGER NOT NULL DEFAULT 0,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  harmful_count INTEGER NOT NULL DEFAULT 0,
  escalation_level TEXT NOT NULL DEFAULT 'pattern',
  maturity TEXT DEFAULT 'candidate'
    CHECK (maturity IN ('candidate', 'established', 'proven')),
  confidence REAL DEFAULT 0.5,
  retrieval_mode TEXT DEFAULT 'reactive'
    CHECK (retrieval_mode IN ('always', 'categorical', 'reactive')),
  trigger_intents TEXT DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_expat_project_score
  ON experience_patterns(source_project, score DESC);
CREATE INDEX IF NOT EXISTS idx_expat_score
  ON experience_patterns(score DESC, times_triggered DESC);

-- FTS5 index for trigger context matching
CREATE VIRTUAL TABLE IF NOT EXISTS experience_patterns_fts USING fts5(
  trigger_context,
  lesson,
  anti_pattern,
  content='experience_patterns',
  content_rowid='rowid'
);

-- Keep FTS in sync with experience_patterns
CREATE TRIGGER IF NOT EXISTS experience_patterns_ai AFTER INSERT ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
  VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern);
END;

CREATE TRIGGER IF NOT EXISTS experience_patterns_ad AFTER DELETE ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern)
  VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern);
END;

CREATE TRIGGER IF NOT EXISTS experience_patterns_au AFTER UPDATE ON experience_patterns BEGIN
  INSERT INTO experience_patterns_fts(experience_patterns_fts, rowid, trigger_context, lesson, anti_pattern)
  VALUES ('delete', old.rowid, old.trigger_context, old.lesson, old.anti_pattern);
  INSERT INTO experience_patterns_fts(rowid, trigger_context, lesson, anti_pattern)
  VALUES (new.rowid, new.trigger_context, new.lesson, new.anti_pattern);
END;

-- V9: artifact_links — Zettelkasten-style linking between artifacts
CREATE TABLE IF NOT EXISTS artifact_links (
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN ('related', 'supports', 'contradicts', 'supersedes', 'caused_by')),
  strength REAL NOT NULL DEFAULT 0.5,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  valid_at_epoch INTEGER,
  invalid_at_epoch INTEGER,
  PRIMARY KEY (source_id, target_id)
);

-- V9: retrieval_events — feedback loop tracking for materialized artifacts
CREATE TABLE IF NOT EXISTS retrieval_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  query_text TEXT,
  was_referenced INTEGER,
  correction_followed INTEGER,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_retrieval_artifact ON retrieval_events(artifact_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_events(session_id);

-- V9: capability_boundaries — correction rate tracking by domain
CREATE TABLE IF NOT EXISTS capability_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  domain TEXT NOT NULL,
  total_interactions INTEGER NOT NULL DEFAULT 0,
  corrections INTEGER NOT NULL DEFAULT 0,
  last_updated_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, domain)
);

-- V10: conversation_turns — stores raw user prompts + assistant responses per turn
CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  turn_number INTEGER NOT NULL DEFAULT 0,
  user_text TEXT,
  assistant_text TEXT,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_convturns_session
  ON conversation_turns(session_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_convturns_project
  ON conversation_turns(project, timestamp_epoch DESC);

-- FTS5 for conversation_turns — enables full dialogue search
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
  user_text, assistant_text,
  content=conversation_turns,
  content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS convturns_fts_ai AFTER INSERT ON conversation_turns BEGIN
  INSERT INTO conversation_turns_fts(rowid, user_text, assistant_text)
  VALUES (new.id, COALESCE(new.user_text, ''), COALESCE(new.assistant_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS convturns_fts_ad AFTER DELETE ON conversation_turns BEGIN
  INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_text, assistant_text)
  VALUES ('delete', old.id, COALESCE(old.user_text, ''), COALESCE(old.assistant_text, ''));
END;

-- V10: session_messages — inter-session message bus (Angel System Phase 1)
CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_session TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_type TEXT NOT NULL DEFAULT 'angel'
    CHECK (sender_type IN ('angel', 'session', 'system')),
  message_type TEXT NOT NULL DEFAULT 'event'
    CHECK (message_type IN ('event', 'command', 'query', 'advisory', 'request', 'response', 'notify', 'transfer', 'acknowledge')),
  content TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal', 'urgent', 'advisory')),
  request_id TEXT,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  delivered_at_epoch INTEGER,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessmsg_target
  ON session_messages(target_session, delivered_at_epoch, priority);
CREATE INDEX IF NOT EXISTS idx_sessmsg_sender
  ON session_messages(sender, created_at_epoch DESC);

-- V12: entity_aliases — canonical entity name resolution
CREATE TABLE IF NOT EXISTS entity_aliases (
  alias TEXT NOT NULL,
  canonical TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (alias)
);
CREATE INDEX IF NOT EXISTS idx_entity_canonical ON entity_aliases(canonical);

-- V12: solution_outcomes — track whether retrieved knowledge actually helped
CREATE TABLE IF NOT EXISTS solution_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  pattern_id TEXT,
  artifact_id INTEGER,
  approach TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial', 'unknown')),
  impact TEXT,
  effectiveness_score REAL DEFAULT 0.5,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_outcomes_pattern
  ON solution_outcomes(pattern_id, outcome);
CREATE INDEX IF NOT EXISTS idx_outcomes_project
  ON solution_outcomes(project, created_at_epoch DESC);

-- V12: session_signals — stigmergic coordination between sessions
CREATE TABLE IF NOT EXISTS session_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  signal_type TEXT NOT NULL
    CHECK (signal_type IN ('wip', 'failure', 'danger', 'claim', 'discovery')),
  target TEXT NOT NULL,
  detail TEXT,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at_epoch INTEGER,
  cleared_at_epoch INTEGER
);
CREATE INDEX IF NOT EXISTS idx_signals_project_type
  ON session_signals(project, signal_type, cleared_at_epoch);
CREATE INDEX IF NOT EXISTS idx_signals_session
  ON session_signals(session_id, cleared_at_epoch);

-- V11: artifact_access_log — enables proper ACT-R multi-access BLL
CREATE TABLE IF NOT EXISTS artifact_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  access_type TEXT NOT NULL DEFAULT 'retrieval'
    CHECK (access_type IN ('retrieval', 'materialization', 'reference', 'spread')),
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_aal_artifact
  ON artifact_access_log(artifact_id, timestamp_epoch DESC);

-- V11: knowledge_gaps — System 3 metacognition register
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  domain TEXT NOT NULL,
  description TEXT NOT NULL,
  detected_by TEXT NOT NULL,
  detected_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  priority REAL NOT NULL DEFAULT 0.5,
  resolved_at_epoch INTEGER,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_kg_project
  ON knowledge_gaps(project, resolved_at_epoch);

-- V11: temporal_profile — user behavior patterns by time bucket
CREATE TABLE IF NOT EXISTS temporal_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL CHECK (hour_bucket BETWEEN 0 AND 5),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  session_count INTEGER NOT NULL DEFAULT 0,
  avg_duration_sec REAL,
  common_first_actions TEXT DEFAULT '[]',
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, hour_bucket, day_of_week)
);

-- V11: action_transitions — Markov chain for next-action prediction
CREATE TABLE IF NOT EXISTS action_transitions (
  project TEXT NOT NULL,
  from_action TEXT NOT NULL,
  to_action TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (project, from_action, to_action)
);

-- V11: policy_weights — persisted RL model weights for memory policy training
CREATE TABLE IF NOT EXISTS policy_weights (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  model_name TEXT NOT NULL DEFAULT 'default',
  weights BLOB NOT NULL,
  training_episodes INTEGER NOT NULL DEFAULT 0,
  avg_reward REAL,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, model_name)
);
`;

/**
 * Team coordination tables: file leases + artifact claims.
 * Advisory locks and retrieved-set coordination for parallel workers.
 */
export const TEAM_COORDINATION_SCHEMA = `
-- file_leases: advisory file locks for parallel workers (MCP Agent Mail pattern)
CREATE TABLE IF NOT EXISTS file_leases (
  file_path TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  granted_at_epoch INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 600
);

-- artifact_claims: retrieved-set coordination to prevent duplicate worker work
CREATE TABLE IF NOT EXISTS artifact_claims (
  artifact_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  claimed_at_epoch INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 300,
  PRIMARY KEY (artifact_id)
);
`;

/**
 * Telemetry table DDL — separate constant for clarity.
 */
export const TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
    'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error'
  )),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  latency_ms REAL,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  adapter TEXT DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch DESC);
`;
