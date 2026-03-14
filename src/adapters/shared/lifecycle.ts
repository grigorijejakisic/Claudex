/**
 * Shared adapter lifecycle logic.
 * Composable functions used by both CC hooks and OpenClaw bridge adapters.
 * Eliminates ~300 lines of duplication across the two adapter implementations.
 */

import type Database from 'better-sqlite3';
import type { ClaudexConfig } from '../../shared/config.js';
import type { TokenUsage } from '../../shared/types.js';
import { processToolObservation } from '../../extraction/extractor.js';
import { updatePressureScore } from '../../core/pressure.js';
import { sanitizePath } from '../../extraction/redaction.js';
import { ThreadTracker, persistTopicUpdate, extractTopic } from '../../intelligence/thread-tracker.js';
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
import { pruneTelemetry, emitTelemetry, sanitizeErrorForTelemetry } from '../../observability/telemetry.js';
import { addJournalEntry, getJournalBySession, getSessionMilestones } from '../../core/journal.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { getThreadState } from '../../core/thread.js';
import { getDecisionsBySession } from '../../core/decisions.js';
import { getObservationsByProject, getObservationById } from '../../core/observations.js';
import { createArtifact, tickArtifactTTL } from '../../core/artifacts.js';
import { getLearningsByProject } from '../../core/learnings.js';
import { extractInsights } from '../../intelligence/insight-extractor.js';

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
 * Ensure checkpoint_tracking has a last_tick_epoch column for cross-process
 * artifact TTL throttling. Idempotent — safe to call on every invocation.
 * Module-level flag prevents redundant ALTER TABLE after first successful call.
 */
let _tickColumnEnsured = false;
function ensureTickEpochColumn(db: Database.Database): void {
  if (_tickColumnEnsured) return;
  try {
    // Check if column exists via pragma
    const cols = db.pragma('table_info(checkpoint_tracking)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'last_tick_epoch')) {
      db.exec('ALTER TABLE checkpoint_tracking ADD COLUMN last_tick_epoch INTEGER NOT NULL DEFAULT 0');
    }
    _tickColumnEnsured = true;
  } catch {
    // Table may not exist yet (pre-migration). Silently skip — guard falls through to tick.
  }
}

/**
 * DB-persisted guard for artifact TTL ticking. Returns true if enough time
 * has elapsed since the last tick (cross-process safe via DB).
 * Falls back to allowing the tick if the DB query fails.
 */
function shouldTickArtifactTTL(db: Database.Database, sessionId: string, nowEpoch: number, project?: string): boolean {
  try {
    ensureTickEpochColumn(db);

    // Use project-scoped guard to prevent concurrent sessions from double-ticking.
    // tickArtifactTTL operates on ALL artifacts for a project, so the guard must
    // be project-scoped — not session-scoped — to prevent N sessions draining
    // TTL N times faster than intended.
    const guardKey = project ? `__ttl_guard__${project}` : sessionId;

    const row = cachedPrepare(db,
      'SELECT last_tick_epoch FROM checkpoint_tracking WHERE session_id = ?'
    ).get(guardKey) as { last_tick_epoch: number } | undefined;

    if (row && (nowEpoch - row.last_tick_epoch) < 120) {
      return false; // Ticked within last 2 minutes (any session) — skip
    }

    // Update the epoch (upsert to handle missing rows)
    cachedPrepare(db,
      `INSERT INTO checkpoint_tracking (session_id, last_tick_epoch, updated_at_epoch)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(session_id) DO UPDATE SET
         last_tick_epoch = excluded.last_tick_epoch,
         updated_at_epoch = unixepoch()`
    ).run(guardKey, nowEpoch);

    return true;
  } catch {
    // Fail open — allow tick if DB guard fails
    return true;
  }
}

/**
 * Process a tool observation and update file pressure scores.
 * Used by PostToolUse (CC) and onToolResult (bridge).
 * Non-throwing.
 */
export function processToolAndPressure(params: ToolObservationParams): void {
  // Each operation isolated — one failure must not kill subsequent operations
  let observationId: number | null = null;
  try {
    observationId = processToolObservation({
      db: params.db,
      sessionId: params.sessionId,
      project: params.project,
      toolName: params.toolName,
      toolInput: params.toolInput,
      toolOutput: params.toolOutput,
      projectRoot: params.cwd,
    });
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'tool_processing/observation', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  // Create artifact from high-signal observations only — routine low-importance
  // observations (imp 1-2) are noise that shouldn't occupy artifact slots.
  if (observationId != null) {
    try {
      const obs = getObservationById(params.db, observationId);
      if (obs && obs.importance >= 3) {
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
    } catch (e) {
      try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'tool_processing/artifact_create', error: sanitizeErrorForTelemetry(e) }); } catch {}
    }
  }

  // Update pressure from file paths in tool input
  // Sanitize paths to match observation extraction (cross-table join consistency)
  try {
    const filePathKeys = ['file_path', 'filePath', 'path'];
    for (const key of filePathKeys) {
      const filePath = params.toolInput[key];
      if (typeof filePath === 'string' && filePath) {
        const sanitized = sanitizePath(filePath, params.cwd);
        updatePressureScore(params.db, sanitized, params.project, 0.1);
        break;
      }
    }
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'tool_processing/pressure', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  // Tick artifact TTL once per turn, not per tool call.
  // In tool-heavy turns with 10+ calls, ticking per call over-decrements TTL.
  // Guard: DB-persisted epoch check — works cross-process (CC hooks are separate Node processes).
  try {
    const now = Math.floor(Date.now() / 1000);
    if (shouldTickArtifactTTL(params.db, params.sessionId, now, params.project)) {
      tickArtifactTTL(params.db, params.project);
    }
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'tool_processing/ttl_tick', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  // Milestone detection — capture significant tool outcomes.
  try {
    captureMilestone(params.db, params.sessionId, params.project, params.toolName, params.toolOutput);
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'tool_processing/milestone', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }
}

/**
 * Detect milestone events from tool execution results.
 * Returns a concise milestone string, or null if no milestone detected.
 * Pure function — no side effects.
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
 * ThreadTracker is intentionally re-instantiated per call. In CC hooks each
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
 * ThreadTracker is re-instantiated per hook call. State continuity is via DB,
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
 * Set the initial thread topic from user prompt if none exists yet.
 * Called by UserPromptSubmit on every turn — extractTopic returns null for
 * greetings and short messages, so only meaningful first prompts set the topic.
 * Non-throwing.
 */
export function ensureInitialTopic(
  db: Database.Database,
  sessionId: string,
  userText: string,
): void {
  try {
    const existing = getThreadState(db, sessionId);
    if (existing?.topic) return; // Already has a topic
    const topic = extractTopic(userText);
    if (topic) {
      persistTopicUpdate(db, sessionId, topic);
    }
  } catch {
    // Non-throwing
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
 * Capture user-side decisions (Tier 1 confirmations, Tier 3 rejections, Tier 4 markers)
 * from the user's prompt at submit time. CC's Stop hook doesn't receive user_prompt,
 * so this runs at UserPromptSubmit to capture what Stop would miss.
 * Non-throwing.
 */
export async function captureDecisionsFromUserPrompt(params: {
  db: Database.Database;
  sessionId: string;
  project: string;
  config: ClaudexConfig;
  userText: string;
}): Promise<void> {
  try {
    await captureDecisions({
      db: params.db,
      sessionId: params.sessionId,
      project: params.project,
      userText: params.userText,
      mode: 'after_tool', // Tier 1 + 4 only (no Tier 2 assistant scan)
    });
  } catch {
    // Non-throwing
  }
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
 * Extract insights from assistant response text and promote as learnings.
 * Called at every turn boundary (Stop hook) — captures analytical conclusions,
 * root causes, and key findings that live in the conversation text.
 * Non-throwing.
 */
export function captureInsightsAsLearnings(
  db: Database.Database,
  sessionId: string,
  project: string,
  assistantText: string,
): void {
  try {
    const insights = extractInsights(assistantText, 5);
    if (insights.length === 0) return;

    const learningTexts = insights.map(i => i.content);
    promoteLearnings({
      db,
      project,
      sessionLearnings: learningTexts,
    });

    // Store insights as flow entries for narrative (prefixed to distinguish from structural flows)
    for (const insight of insights.slice(0, 2)) {
      addJournalEntry(db, sessionId, project, 'flow', `[${insight.marker}] ${insight.content.slice(0, 190)}`);
    }
  } catch {
    // Non-throwing
  }
}

/**
 * Build a flow entry from structured data available in the DB.
 * Includes thread topic, recent decisions, and recent insights (from assistant text).
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

    // Recent insights from assistant text (flow entries prefixed with [marker])
    const flowEntries = getJournalBySession(db, sessionId, { entryType: 'flow' });
    const insightEntries = flowEntries
      .filter(j => /^\[(diagnosis|finding|conclusion|architecture|systemic)\]/.test(j.content))
      .slice(0, 3);
    if (insightEntries.length > 0) {
      const insightSnippets = insightEntries
        .map(i => i.content.slice(0, 60))
        .join('; ');
      parts.push(`Insights: ${insightSnippets}`);
    }

    if (parts.length === 0) return null;

    // Join and truncate to 300 chars (increased from 200 — insights are worth the space)
    const flow = parts.join(' — ');
    return flow.length > 300 ? flow.slice(0, 297) + '...' : flow;
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
  } catch (e) {
    // Non-throwing — journal capture must not break compaction
    try { emitTelemetry(db, sessionId, 'error', { subsystem: 'session_narrative/flow_entry', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }
}

/**
 * Run the compaction sequence: write checkpoint, promote learnings, mark post-compact.
 * Used by PreCompact (CC) and onCompact (bridge).
 */
export async function runCompactionSequence(params: CompactionParams): Promise<void> {
  // Capture flow entry BEFORE observations are marked consumed
  captureFlowEntry(params.db, params.sessionId, params.project);

  let checkpointSucceeded = false;
  try {
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
    checkpointSucceeded = result != null;
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'compaction/checkpoint', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  if (checkpointSucceeded) {
    // Mark old observations as consumed AFTER checkpoint succeeds
    // Observations older than 5 minutes ago that aren't in the most recent 10
    // Scoped to current session to prevent cross-session blindness
    try {
      const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
      markObservationsConsumed(params.db, params.project, params.sessionId, fiveMinutesAgo, 10);
    } catch (e) {
      try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'compaction/mark_consumed', error: sanitizeErrorForTelemetry(e) }); } catch {}
    }

    // Extract session learnings from two high-signal sources:
    // 1. Decisions (what was decided — already deduplicated, high intent signal)
    // 2. Edit/Write titles (what was changed — concrete actions, not file reads)
    // 3. Discovery-type observations (explicitly classified new findings)
    try {
      const sessionLearnings: string[] = [];

      // Source 1: Decisions from this session
      const decisions = getDecisionsBySession(params.db, params.sessionId, { limit: 10 });
      for (const d of decisions) {
        if (d.content && d.content.length > 15) {
          sessionLearnings.push(d.content);
        }
      }

      // Source 2: Discovery observations (rare but high-value)
      const discoveries = cachedPrepare(params.db,
        `SELECT DISTINCT title FROM observations
         WHERE session_id = ? AND project = ? AND deleted_at_epoch IS NULL
           AND obs_type = 'discovery'
           AND title IS NOT NULL AND LENGTH(title) > 10
         ORDER BY importance DESC
         LIMIT 5`
      ).all(params.sessionId, params.project) as Array<{ title: string }>;
      for (const d of discoveries) {
        sessionLearnings.push(d.title);
      }

      promoteLearnings({
        db: params.db,
        project: params.project,
        sessionLearnings,
      });
    } catch (e) {
      try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'compaction/promote_learnings', error: sanitizeErrorForTelemetry(e) }); } catch {}
    }

    // Create artifacts from learnings — deduped by artifact_ref to prevent
    // compaction from duplicating all 50 learnings on every cycle.
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
    } catch (e) {
      try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'compaction/learning_artifacts', error: sanitizeErrorForTelemetry(e) }); } catch {}
    }
  }

  // markPostCompactPending runs REGARDLESS of checkpoint success.
  // Post-compaction context recovery must fire even if checkpoint write failed —
  // the agent needs memory re-injection after compaction regardless.
  try {
    markPostCompactPending(params.db, params.sessionId);
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'compaction/mark_pending', error: sanitizeErrorForTelemetry(e) }); } catch {}
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
  } catch (e) {
    // Non-throwing — summary capture must not break session-end cleanup
    try { emitTelemetry(db, sessionId, 'error', { subsystem: 'session_narrative/summary', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }
}

/**
 * Run session-end cleanup: final checkpoint, decay, end session, prune telemetry.
 * Used by SessionEnd (CC) and plugin-entry session_end hook (bridge).
 */
export async function runSessionEndCleanup(params: SessionEndParams): Promise<void> {
  // Each operation wrapped independently — one failure must not skip subsequent operations.
  // Most critically: endSession must run even if earlier operations throw.

  try {
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
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'session_end/checkpoint', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  try {
    pruneObservations(params.db, params.project, {
      pruneThreshold: params.config.observations.prune_threshold,
      pruneCount: params.config.observations.prune_count,
    });
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'session_end/prune_observations', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  try {
    applyRetentionPolicy(params.db, params.project, params.config.observations.retention_days);
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'session_end/retention_policy', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  try {
    decayPressureStratified(params.db, params.project);
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'session_end/pressure_decay', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  // Promote session learnings (decisions + discoveries) before ending.
  // On 1M context, compaction may never fire — SessionEnd is the guaranteed trigger.
  // Skip if compaction already promoted during this session (avoid double-counting).
  try {
    const compactionCheckpoint = cachedPrepare(params.db,
      `SELECT 1 FROM checkpoint_meta WHERE session_id = ? AND trigger = 'compaction' LIMIT 1`
    ).get(params.sessionId);
    const compactionRan = !!compactionCheckpoint;

    if (!compactionRan) {
      const sessionLearnings: string[] = [];
      const decisions = getDecisionsBySession(params.db, params.sessionId, { limit: 10 });
      for (const d of decisions) {
        if (d.content && d.content.length > 15) sessionLearnings.push(d.content);
      }
      const discoveries = cachedPrepare(params.db,
        `SELECT DISTINCT title FROM observations
         WHERE session_id = ? AND project = ? AND deleted_at_epoch IS NULL
           AND obs_type = 'discovery' AND title IS NOT NULL AND LENGTH(title) > 10
         ORDER BY importance DESC LIMIT 5`
      ).all(params.sessionId, params.project) as Array<{ title: string }>;
      for (const d of discoveries) sessionLearnings.push(d.title);
      if (sessionLearnings.length > 0) {
        promoteLearnings({ db: params.db, project: params.project, sessionLearnings });
      }
    }
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'session_end/promote_learnings', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  // Capture session summary before ending session
  try {
    captureSessionSummary(params.db, params.sessionId, params.project);
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'session_end/summary', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  try {
    endSession(params.db, params.sessionId, 'completed');
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'session_end/end_session', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  try {
    pruneTelemetry(params.db, {
      retentionDays: params.config.observability.retention_days,
      retainErrorCount: params.config.observability.retain_error_count,
    });
  } catch (e) {
    try { emitTelemetry(params.db, params.sessionId, 'error', { subsystem: 'session_end/prune_telemetry', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }
}
