/**
 * Shared adapter lifecycle logic.
 * Composable functions used by both CC hooks and OpenClaw bridge adapters.
 * Eliminates ~300 lines of duplication across the two adapter implementations.
 * @see Architecture Sections 3.2, 3.3
 */

import type Database from 'better-sqlite3';
import type { ClaudexConfig } from '../../shared/config.js';
import type { TokenUsage } from '../../shared/types.js';
import { processToolObservation } from '../../extraction/extractor.js';
import { updatePressureScore } from '../../core/pressure.js';
import { sanitizePath } from '../../extraction/redaction.js';
import { ThreadTracker } from '../../intelligence/thread-tracker.js';
import { shouldTriggerCheckpoint, writeCheckpoint } from '../../checkpoint/writer.js';
import { getCheckpointTracking } from '../../core/checkpoint-tracking.js';
import { readGsdState } from '../../gsd/state-reader.js';
import { captureDecisions } from '../../intelligence/decision-capture.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { initTemplates } from '../../embeddings/templates.js';
import { promoteLearnings } from '../../intelligence/learnings-promoter.js';
import { markPostCompactPending } from '../../core/checkpoint-tracking.js';
import { pruneObservations, applyRetentionPolicy } from '../../decay/decay-engine.js';
import { markObservationsConsumed } from '../../core/observations.js';
import { decayPressureStratified } from '../../decay/pressure-decay.js';
import { endSession } from '../../core/sessions.js';
import { pruneTelemetry } from '../../observability/telemetry.js';

// ---------------------------------------------------------------------------
// Shared parameter types
// ---------------------------------------------------------------------------

/** Minimal params shared across all lifecycle operations. */
export interface LifecycleParams {
  db: Database.Database;
  sessionId: string;
  project: string;
  cwd: string;
  scope?: string;
  config: ClaudexConfig;
}

/** Params for tool observation processing. */
export interface ToolObservationParams {
  db: Database.Database;
  sessionId: string;
  project: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
}

/** Params for decision capture. */
export interface DecisionCaptureParams {
  db: Database.Database;
  sessionId: string;
  project: string;
  config: ClaudexConfig;
  userText?: string;
  assistantText?: string;
  /** Pre-built classifier (bridge uses cached version). Omit to build fresh. */
  classifier?: { provider: EmbeddingProvider; templates: NonNullable<Awaited<ReturnType<typeof initTemplates>>> } | null;
}

/** Params for checkpoint threshold check. */
export interface CheckpointThresholdParams {
  db: Database.Database;
  sessionId: string;
  project: string;
  cwd: string;
  scope?: string;
  config: ClaudexConfig;
  gauge: TokenUsage | null;
}

/** Params for compaction sequence. */
export interface CompactionParams {
  db: Database.Database;
  sessionId: string;
  project: string;
  cwd: string;
  scope?: string;
  gauge?: TokenUsage;
  gsd?: ReturnType<typeof readGsdState>;
  enrichmentProvider?: Parameters<typeof writeCheckpoint>[0]['enrichmentProvider'];
}

/** Params for session-end cleanup. */
export interface SessionEndParams {
  db: Database.Database;
  sessionId: string;
  project: string;
  cwd: string;
  scope?: string;
  config: ClaudexConfig;
  gauge?: TokenUsage;
}

// ---------------------------------------------------------------------------
// Shared lifecycle functions
// ---------------------------------------------------------------------------

/**
 * Process a tool observation and update file pressure scores.
 * Used by PostToolUse (CC) and onToolResult (bridge).
 * Non-throwing.
 */
export function processToolAndPressure(params: ToolObservationParams): void {
  processToolObservation({
    db: params.db,
    sessionId: params.sessionId,
    project: params.project,
    toolName: params.toolName,
    toolInput: params.toolInput,
    toolOutput: params.toolOutput,
    projectRoot: params.cwd,
  });

  // Update pressure from file paths in tool input
  // Sanitize paths to match observation extraction (cross-table join consistency)
  const filePathKeys = ['file_path', 'filePath', 'path'];
  for (const key of filePathKeys) {
    const filePath = params.toolInput[key];
    if (typeof filePath === 'string' && filePath) {
      const sanitized = sanitizePath(filePath, params.cwd);
      updatePressureScore(params.db, sanitized, params.project, 0.1);
      break;
    }
  }
}

/**
 * Create a thread tracker, record an after-tool event, and persist.
 * Used by PostToolUse (CC) and onToolResult (bridge).
 */
export function trackAfterTool(
  db: Database.Database,
  sessionId: string,
  userPrompt: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): void {
  const tracker = new ThreadTracker(db, sessionId);
  tracker.onAfterTool(userPrompt, toolName, toolInput);
  tracker.persist();
}

/**
 * Create a thread tracker and record an after-turn event.
 * Used by Stop (CC) and onTurnEnd (bridge).
 */
export function trackAfterTurn(
  db: Database.Database,
  sessionId: string,
  userText: string | undefined,
  assistantText: string | undefined,
): void {
  const tracker = new ThreadTracker(db, sessionId);
  tracker.onAfterTurn(userText, assistantText);
  // persist() removed — onAfterTurn() already persists internally (thread-tracker.ts:206)
}

/**
 * Check if a checkpoint should be triggered by token threshold, and write if so.
 * Used by PostToolUse, Stop (CC) and onToolResult, onTurnEnd (bridge).
 * Non-throwing on checkpoint write failure (propagates shouldTrigger check errors).
 */
export async function checkpointIfThresholdMet(params: CheckpointThresholdParams): Promise<void> {
  const tracking = getCheckpointTracking(params.db, params.sessionId);

  if (shouldTriggerCheckpoint({
    trigger: 'threshold',
    tokenUsage: params.gauge ?? undefined,
    tracking,
    debounceSeconds: params.config.checkpoint.debounce_seconds,
  })) {
    const gsd = readGsdState(params.cwd);
    await writeCheckpoint({
      db: params.db,
      sessionId: params.sessionId,
      project: params.project,
      projectDir: params.cwd,
      trigger: 'threshold',
      tokenUsage: params.gauge ?? undefined,
      gsd: gsd ?? undefined,
      scope: params.scope,
    });
  }
}

/**
 * Build a fresh embedding classifier for decision capture.
 * Returns null if embeddings are disabled, Ollama is unavailable, or init fails.
 * Non-throwing.
 */
export async function buildDecisionClassifier(
  config: ClaudexConfig,
): Promise<{ provider: EmbeddingProvider; templates: NonNullable<Awaited<ReturnType<typeof initTemplates>>> } | null> {
  if (!config.embeddings.enabled) return null;

  try {
    const ep = new EmbeddingProvider({
      baseUrl: config.embeddings.ollama_base_url,
      model: config.embeddings.model,
    });
    if (await ep.isAvailable()) {
      const templates = await initTemplates(ep);
      if (templates) {
        return { provider: ep, templates };
      }
    }
  } catch {
    // Fail open -- no classifier
  }
  return null;
}

/**
 * Capture decisions with optional embedding classifier.
 * If `params.classifier` is provided, uses it directly (bridge caching path).
 * If `params.classifier` is undefined, builds one fresh (CC hooks path).
 * Non-throwing on classifier build failure (falls back to regex-only).
 */
export async function captureDecisionsWithClassifier(params: DecisionCaptureParams): Promise<void> {
  const classifier = params.classifier !== undefined
    ? params.classifier
    : params.config.embeddings.enabled
      ? await buildDecisionClassifier(params.config)
      : null;

  await captureDecisions({
    db: params.db,
    sessionId: params.sessionId,
    project: params.project,
    userText: params.userText,
    assistantText: params.assistantText,
    mode: 'after_turn',
    classifier,
    confidenceThreshold: params.config.embeddings.decision_confidence_threshold,
  });
}

/**
 * Run the compaction sequence: write checkpoint, promote learnings, mark post-compact.
 * Used by PreCompact (CC) and onCompact (bridge).
 */
export async function runCompactionSequence(params: CompactionParams): Promise<void> {
  // Upgrade 6: Mark old observations as consumed before compaction
  // Observations older than 5 minutes ago that aren't in the most recent 10
  try {
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    markObservationsConsumed(params.db, params.project, fiveMinutesAgo, 10);
  } catch {
    // Non-fatal — continue with compaction even if masking fails
  }

  const result = await writeCheckpoint({
    db: params.db,
    sessionId: params.sessionId,
    project: params.project,
    projectDir: params.cwd,
    trigger: 'compaction',
    tokenUsage: params.gauge,
    gsd: params.gsd ?? undefined,
    enrichmentProvider: params.enrichmentProvider,
    scope: params.scope,
  });

  if (result) {
    // sessionLearnings empty — no new learnings to promote during compaction.
    // Call is retained for cap enforcement (prunes excess learnings per project).
    promoteLearnings({
      db: params.db,
      project: params.project,
      sessionLearnings: [],
    });

    markPostCompactPending(params.db, params.sessionId);
  }
}

/**
 * Run session-end cleanup: final checkpoint, decay, end session, prune telemetry.
 * Used by SessionEnd (CC) and plugin-entry session_end hook (bridge).
 */
export async function runSessionEndCleanup(params: SessionEndParams): Promise<void> {
  const gsd = readGsdState(params.cwd);

  await writeCheckpoint({
    db: params.db,
    sessionId: params.sessionId,
    project: params.project,
    projectDir: params.cwd,
    trigger: 'session_end',
    tokenUsage: params.gauge,
    gsd: gsd ?? undefined,
    scope: params.scope,
  });

  pruneObservations(params.db, params.project, {
    pruneThreshold: params.config.observations.prune_threshold,
    pruneCount: params.config.observations.prune_count,
  });

  applyRetentionPolicy(params.db, params.project, params.config.observations.retention_days);

  decayPressureStratified(params.db, params.project);

  endSession(params.db, params.sessionId, 'completed');

  pruneTelemetry(params.db, {
    retentionDays: params.config.observability.retention_days,
    retainErrorCount: params.config.observability.retain_error_count,
  });
}
