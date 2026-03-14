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
import { ThreadTracker, persistTopicUpdate } from '../../intelligence/thread-tracker.js';
import type { TopicShiftResult } from '../../intelligence/topic-shift.js';
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
import { addJournalEntry, getJournalBySession, getSessionMilestones } from '../../core/journal.js';
import { getThreadState } from '../../core/thread.js';
import { getDecisionsBySession } from '../../core/decisions.js';
import { getObservationsByProject, getObservationById } from '../../core/observations.js';
import { createArtifact, tickArtifactTTL } from '../../core/artifacts.js';
import { getLearningsByProject } from '../../core/learnings.js';

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

// CROSS-007: Module-level epoch guard to prevent tickArtifactTTL from firing
// multiple times within the same turn (tool-heavy turns can have 10+ calls).
let _lastTickEpoch = 0;

/**
 * Process a tool observation and update file pressure scores.
 * Used by PostToolUse (CC) and onToolResult (bridge).
 * Non-throwing.
 */
export function processToolAndPressure(params: ToolObservationParams): void {
  const observationId = processToolObservation({
    db: params.db,
    sessionId: params.sessionId,
    project: params.project,
    toolName: params.toolName,
    toolInput: params.toolInput,
    toolOutput: params.toolOutput,
    projectRoot: params.cwd,
  });

  // Create artifact from observation — non-throwing
  if (observationId != null) {
    try {
      const obs = getObservationById(params.db, observationId);
      if (obs) {
        createArtifact(
          params.db,
          params.sessionId,
          params.project,
          'observation',
          String(observationId),
          obs.title.slice(0, 150),
          obs.content,
          obs.importance,
        );
      }
    } catch {
      // Non-throwing — artifact creation must not break observation capture
    }
  }

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

  // CROSS-007: Tick artifact TTL once per turn, not per tool call.
  // In tool-heavy turns with 10+ calls, ticking per call over-decrements TTL.
  // Guard: skip if already ticked within the last 5 seconds (same turn).
  try {
    const now = Math.floor(Date.now() / 1000);
    if (now - _lastTickEpoch >= 5) {
      tickArtifactTTL(params.db, params.project);
      _lastTickEpoch = now;
    }
  } catch {
    // Non-throwing — artifact TTL tick must not break tool processing
  }

  // ARCH-006: Milestone detection — capture significant tool outcomes.
  // Moved from post-tool-use.ts so both CC hooks and OpenClaw bridge get milestones.
  try {
    captureMilestone(params.db, params.sessionId, params.project, params.toolName, params.toolOutput);
  } catch {
    // Non-throwing — milestone capture must not break tool processing
  }
}

/**
 * Detect milestone events from tool execution results.
 * Returns a concise milestone string, or null if no milestone detected.
 * Pure function — no side effects.
 * ARCH-006: Moved from post-tool-use.ts to lifecycle for adapter-agnostic access.
 */
export function detectMilestone(toolName: string, toolOutput: string): string | null {
  if (!toolOutput) return null;

  // Test suite results
  const testMatch = toolOutput.match(/(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/i);
  const testFail = toolOutput.match(/(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ure)?/i);
  if (testMatch || testFail) {
    const passed = testMatch ? testMatch[1] : '0';
    const failed = testFail ? testFail[1] : '0';
    if (testFail && parseInt(failed) > 0) {
      return `Tests: ${passed} passed, ${failed} failed`;
    }
    if (testMatch) {
      return `Tests: ${passed} passing`;
    }
  }

  // Build results
  if (/build/i.test(toolOutput) && /success|clean|complete/i.test(toolOutput)) {
    return 'Build succeeded';
  }

  // Git commits (match [branch abc1234] pattern)
  if (toolName === 'Bash') {
    const commitMatch = toolOutput.match(/\[\S+\s+([a-f0-9]{7,})\]/);
    if (commitMatch) {
      return `Committed ${commitMatch[1].slice(0, 7)}`;
    }
  }

  // Deployment/team events
  if (/workers?\s+(?:deployed|spawned|started)/i.test(toolOutput) ||
      /agents?\s+(?:deployed|spawned|started)/i.test(toolOutput)) {
    return 'Team agents deployed';
  }

  return null;
}

/**
 * Capture a milestone journal entry if a significant event is detected.
 * Non-throwing.
 * ARCH-006: Moved from post-tool-use.ts to lifecycle for adapter-agnostic access.
 */
function captureMilestone(
  db: Database.Database,
  sessionId: string,
  project: string,
  toolName: string,
  toolOutput: Record<string, unknown> | undefined,
): void {
  try {
    // Extract text content from tool output
    const outputText = toolOutput
      ? (typeof toolOutput === 'string'
        ? toolOutput
        : (toolOutput.content as string) || (toolOutput.output as string) || (toolOutput.stdout as string) || JSON.stringify(toolOutput))
      : '';

    const milestone = detectMilestone(toolName, outputText);
    if (milestone) {
      // Truncate to 100 chars
      const content = milestone.length > 100 ? milestone.slice(0, 97) + '...' : milestone;
      addJournalEntry(db, sessionId, project, 'milestone', content);
    }
  } catch {
    // Non-throwing — milestone capture must not break tool processing
  }
}

/**
 * Create a thread tracker, record an after-tool event, and persist.
 * Used by PostToolUse (CC) and onToolResult (bridge).
 *
 * R19: ThreadTracker is intentionally re-instantiated per call. In CC hooks each
 * invocation runs in a fresh process, so there is no cross-event state to share.
 * The bridge adapter similarly calls this per-event; the tracker loads persisted
 * state from the DB on construction, so cross-event continuity is maintained via
 * the database rather than in-memory caching.
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
 *
 * R19: ThreadTracker is re-instantiated per hook call. State continuity is via DB,
 * not in-memory caching.
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
 * Persist a topic update to thread_state when a topic shift is detected.
 * Called by both CC hooks (UserPromptSubmit) and bridge (onContext) after
 * topic shift detection. Non-throwing.
 */
export function persistTopicIfShifted(
  db: Database.Database,
  sessionId: string,
  topicShift: TopicShiftResult | null,
): void {
  if (topicShift?.shifted && topicShift.newTopic) {
    persistTopicUpdate(db, sessionId, topicShift.newTopic);
  }
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
 * Build a flow entry from structured data available in the DB.
 * Concatenates thread topic, recent decisions, and high-importance observation titles.
 * Non-throwing — returns null if no meaningful content is available.
 */
export function buildFlowEntry(
  db: Database.Database,
  sessionId: string,
  project: string,
): string | null {
  try {
    const parts: string[] = [];

    // Thread topic
    const thread = getThreadState(db, sessionId);
    if (thread?.topic) {
      parts.push(thread.topic);
    }

    // Recent decisions (last 3)
    const decisions = getDecisionsBySession(db, sessionId, { limit: 3 });
    if (decisions.length > 0) {
      const decisionSnippets = decisions
        .map(d => d.content.slice(0, 60))
        .join('; ');
      parts.push(`Decisions: ${decisionSnippets}`);
    }

    // Recent high-importance observation titles
    const obs = getObservationsByProject(db, project, { limit: 10 });
    const highImp = obs
      .filter(o => o.importance >= 4)
      .slice(0, 3)
      .map(o => o.title);
    if (highImp.length > 0) {
      parts.push(`Key: ${highImp.join(', ')}`);
    }

    if (parts.length === 0) return null;

    // Join and truncate to 200 chars
    const flow = parts.join(' — ');
    return flow.length > 200 ? flow.slice(0, 197) + '...' : flow;
  } catch {
    return null;
  }
}

/**
 * Capture a flow journal entry during compaction.
 * Non-throwing — journal capture must not break compaction.
 */
export function captureFlowEntry(
  db: Database.Database,
  sessionId: string,
  project: string,
): void {
  try {
    const content = buildFlowEntry(db, sessionId, project);
    if (content) {
      addJournalEntry(db, sessionId, project, 'flow', content);
    }
  } catch {
    // Non-throwing — journal capture must not break compaction
  }
}

/**
 * Run the compaction sequence: write checkpoint, promote learnings, mark post-compact.
 * Used by PreCompact (CC) and onCompact (bridge).
 */
export async function runCompactionSequence(params: CompactionParams): Promise<void> {
  // Capture flow entry BEFORE observations are marked consumed
  captureFlowEntry(params.db, params.sessionId, params.project);


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
    // Mark old observations as consumed AFTER checkpoint succeeds
    // Observations older than 5 minutes ago that aren't in the most recent 10
    // Scoped to current session to prevent cross-session blindness
    try {
      const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
      markObservationsConsumed(params.db, params.project, params.sessionId, fiveMinutesAgo, 10);
    } catch {
      // Non-fatal — checkpoint already written, consumption is best-effort
    }

    // sessionLearnings empty — no new learnings to promote during compaction.
    // Call is retained for cap enforcement (prunes excess learnings per project).
    promoteLearnings({
      db: params.db,
      project: params.project,
      sessionLearnings: [],
    });

    // Create artifacts from learnings — deduped by artifact_ref to prevent
    // compaction from duplicating all 50 learnings on every cycle (ARCH-004).
    try {
      const learnings = getLearningsByProject(params.db, params.project, { limit: 50 });
      for (const learning of learnings) {
        const ref = String(learning.id);
        const exists = params.db.prepare(
          "SELECT 1 FROM artifacts WHERE artifact_type = 'learning' AND artifact_ref = ? AND project = ? LIMIT 1"
        ).get(ref, params.project);
        if (!exists) {
          createArtifact(params.db, params.sessionId, params.project, 'learning', ref, learning.content.slice(0, 150), learning.content, 4);
        }
      }
    } catch {
      // Non-throwing — artifact creation must not break compaction
    }

    markPostCompactPending(params.db, params.sessionId);
  }
}

/**
 * Build and store a structured session summary from journal entries + thread state.
 * Non-throwing — summary capture must not break session-end cleanup.
 */
export function captureSessionSummary(
  db: Database.Database,
  sessionId: string,
  project: string,
): void {
  try {
    const parts: string[] = [];

    // Thread topic/summary
    const thread = getThreadState(db, sessionId);
    if (thread?.topic) {
      parts.push(`Session worked on ${thread.topic}.`);
    } else {
      parts.push('Session completed.');
    }

    // Milestones from journal (using convenience function)
    const milestones = getSessionMilestones(db, sessionId, 10);
    if (milestones.length > 0) {
      const milestoneList = milestones
        .map(m => m.content)
        .reverse() // chronological order
        .join(', ');
      parts.push(`Milestones: ${milestoneList}.`);
    }

    // Flow entries from journal
    const flows = getJournalBySession(db, sessionId, { entryType: 'flow', limit: 5 });
    if (flows.length > 0) {
      // Use the most recent flow entry as the narrative
      parts.push(`Flow: ${flows[0].content}.`);
    }

    // Decision count
    const decisions = getDecisionsBySession(db, sessionId);
    if (decisions.length > 0) {
      parts.push(`Decisions: ${decisions.length} made.`);
    }

    const summary = parts.join(' ');
    addJournalEntry(db, sessionId, project, 'summary', summary);
  } catch {
    // Non-throwing
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

  // Capture session summary before ending session
  captureSessionSummary(params.db, params.sessionId, params.project);

  // Decision artifacts are created at capture time in decision-capture.ts.
  // Removed duplicate creation here to prevent double artifacts (ARCH-006).

  endSession(params.db, params.sessionId, 'completed');

  pruneTelemetry(params.db, {
    retentionDays: params.config.observability.retention_days,
    retainErrorCount: params.config.observability.retain_error_count,
  });
}
