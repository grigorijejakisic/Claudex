/**
 * Shared adapter lifecycle logic.
 * Composable functions used by both CC hooks and OpenClaw bridge adapters.
 * Eliminates ~300 lines of duplication across the two adapter implementations.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ClaudexConfig } from '../../shared/config.js';
import type { TokenUsage } from '../../shared/types.js';
import { processToolObservation, processToolObservationAsync, checkNovelty } from '../../extraction/extractor.js';
import { updatePressureScore } from '../../core/pressure.js';
import { sanitizePath, redactContent } from '../../extraction/redaction.js';
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
import { pruneTelemetry, emitTelemetry } from '../../observability/telemetry.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import { addJournalEntry, getJournalBySession, getSessionMilestones } from '../../core/journal.js';
import type { RecallMetadata } from '../../core/journal.js';
import { dualWriteUserPrompt, dualWriteAssistantMessage } from '../../core/episodic-events.js';
import { parseWrappers } from '../../extraction/wrapper-parser.js';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
import { getSessionEvents } from '../../core/session-events.js';
import { recordEvent } from '../../core/session-events.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { getThreadState } from '../../core/thread.js';
import { getDecisionsBySession } from '../../core/decisions.js';
import { getObservationById } from '../../core/observations.js';
import { createArtifact, tickArtifactTTL, packAllArtifacts, getConfidenceScore, setArtifactConfidence, setArtifactNovelty, flagSupersededArtifacts } from '../../core/artifacts.js';
import { getLearningsByProject } from '../../core/learnings.js';
import { extractInsights, extractInsightsCombined } from '../../intelligence/insight-extractor.js';
import { embedArtifact } from '../../embeddings/embed-pipeline.js';

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
// Learning content quality filter
// ---------------------------------------------------------------------------

/** Tool name prefixes that indicate raw observation titles, not knowledge. */
const TOOL_TITLE_PREFIX = /^(Edit|Read|Write|Bash|Grep|Glob|NotebookEdit|WebFetch|WebSearch|Run):/;

/** Conversational filler that leaks from decision capture. */
const FILLER_PATTERNS = /^(yes|no|yeah|ok|sure|send|go|done|please|let me|I see|I think)\b/i;

/**
 * Returns true if content is worth promoting to cross-session learnings.
 * Filters out raw tool titles, short user quotes, markdown-only content,
 * conversational filler, and vague/generic sentences that leak from
 * the insight extractor. A real learning must have substance.
 */
function isPromotableContent(content: string): boolean {
  const trimmed = content.trim();
  // Too short to be knowledge — raised from 30 to 60 to filter fragments
  if (trimmed.length < 60) return false;
  // Raw tool output titles
  if (TOOL_TITLE_PREFIX.test(trimmed)) return false;
  // Conversational filler
  if (FILLER_PATTERNS.test(trimmed)) return false;
  // Pure markdown formatting (e.g. "**What artifacts SHOULD be:**")
  const stripped = trimmed.replace(/[*_#`~>-]/g, '').trim();
  if (stripped.length < 40) return false;
  // Vague/generic statements that aren't actionable knowledge
  // Only filter if the statement is JUST a vague assertion without substance
  if (/^(this confirms|so the|back to)\b/i.test(stripped)) return false;
  // "The architecture was/is sound/clear/right" — vague praise without specifics
  if (/^the architecture (was|is) (sound|clear|right|correct)\b/i.test(stripped)) return false;
  // Questions aren't learnings
  if (trimmed.endsWith('?')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Shared lifecycle functions
// ---------------------------------------------------------------------------

/**
 * Ensure checkpoint_tracking has a last_tick_epoch_ms column for cross-process
 * artifact TTL throttling. Idempotent — safe to call on every invocation.
 * Module-level flag prevents redundant ALTER TABLE after first successful call.
 */
let _tickColumnEnsured = false;
function ensureTickEpochColumn(db: Database.Database): void {
  if (_tickColumnEnsured) return;
  try {
    // Check if column exists via pragma
    const cols = db.pragma('table_info(checkpoint_tracking)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'last_tick_epoch_ms')) {
      db.exec('ALTER TABLE checkpoint_tracking ADD COLUMN last_tick_epoch_ms INTEGER NOT NULL DEFAULT 0');
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
function shouldTickArtifactTTL(db: Database.Database, sessionId: string, nowMs: number, project?: string): boolean {
  try {
    ensureTickEpochColumn(db);

    // Use project-scoped guard to prevent concurrent sessions from double-ticking.
    // tickArtifactTTL operates on ALL artifacts for a project, so the guard must
    // be project-scoped — not session-scoped — to prevent N sessions draining
    // TTL N times faster than intended.
    const guardKey = project ? `__ttl_guard__${project}` : sessionId;
    const threshold = nowMs - 120_000; // 120 seconds in ms

    // Single atomic UPSERT with WHERE guard on the ON CONFLICT path.
    // - New row (no conflict): INSERT succeeds → changes = 1 → tick allowed.
    // - Existing row, elapsed >= 120s: ON CONFLICT UPDATE fires, WHERE passes → changes = 1 → tick allowed.
    // - Existing row, elapsed < 120s: ON CONFLICT UPDATE fires, WHERE fails → changes = 0 → tick skipped.
    // No SELECT+UPDATE race window — SQLite guarantees atomicity of a single statement.
    const result = cachedPrepare(db,
      `INSERT INTO checkpoint_tracking (session_id, last_tick_epoch_ms, updated_at_epoch_ms)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(session_id) DO UPDATE SET
         last_tick_epoch_ms = excluded.last_tick_epoch_ms,
         updated_at_epoch_ms = unixepoch() * 1000
       WHERE checkpoint_tracking.last_tick_epoch_ms IS NULL OR checkpoint_tracking.last_tick_epoch_ms <= ?`
    ).run(guardKey, nowMs, threshold);

    return result.changes > 0;
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
export async function processToolAndPressure(params: ToolObservationParams): Promise<void> {
  // Each operation isolated — one failure must not kill subsequent operations
  let observationId: number | null = null;
  try {
    // Use async dedup-aware path — semantic duplicate detection via Qdrant.
    // Falls through to sync insertObservation() if Qdrant is unavailable.
    const dedupResult = await processToolObservationAsync({
      db: params.db,
      sessionId: params.sessionId,
      project: params.project,
      toolName: params.toolName,
      toolInput: params.toolInput,
      toolOutput: params.toolOutput,
      projectRoot: params.cwd,
    });
    if (dedupResult) {
      // Only create artifacts for newly inserted observations.
      // Skipped (same-session dup) and updated (cross-session dup) observations
      // already have artifacts from their original insertion.
      observationId = dedupResult.action === 'inserted' ? dedupResult.id : null;
    }
  } catch (e) {
    // Async dedup failed entirely — fall back to sync path
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
    } catch (e2) {
      emitErrorTelemetry(params.db, params.sessionId, 'tool_processing/observation', e2);
    }
  }

  // Create artifact from high-signal observations only — routine low-importance
  // observations (imp 1-2) are noise that shouldn't occupy artifact slots.
  if (observationId != null) {
    try {
      const obs = getObservationById(params.db, observationId);
      if (obs && obs.importance >= 3) {
        const artifactId = createArtifact(
          params.db,
          params.sessionId,
          params.project,
          'observation',
          String(observationId),
          obs.title.slice(0, 150),
          obs.content,
          obs.importance,
        );

        if (artifactId > 0) {
          // Set confidence based on tool source (2.6)
          try {
            const confidence = getConfidenceScore('observation', params.toolName);
            setArtifactConfidence(params.db, artifactId, confidence);
          } catch { /* non-fatal */ }

          // Embed artifact — must be awaited because CC hooks die after return.
          // Fire-and-forget doesn't work in ephemeral hook processes.
          try {
            const embedded = await embedArtifact(params.db, artifactId, obs.content, {
              project: params.project,
              artifact_type: 'observation',
              importance: obs.importance,
              session_id: params.sessionId,
              summary: obs.title.slice(0, 150),
            });

            if (embedded) {
              // After embedding stored, check novelty (2.5) and superseded (2.3)
              try {
                const novelty = await checkNovelty(obs.content, params.project);
                setArtifactNovelty(params.db, artifactId, novelty.noveltyScore);
              } catch { /* non-fatal */ }
              // Flag older superseded artifacts (2.3)
              try { flagSupersededArtifacts(params.db, artifactId, params.project, obs.title); } catch {}
            }
          } catch { /* embedding failure is non-fatal */ }
        }
      }
    } catch (e) {
      emitErrorTelemetry(params.db, params.sessionId, 'tool_processing/artifact_create', e);
    }

    // Contradiction detection: check if new high-importance observation
    // contradicts existing decisions or proven patterns.
    try {
      const obs = getObservationById(params.db, observationId);
      if (obs && obs.importance >= 3) {
        const { detectContradiction } = await import('../../intelligence/contradiction-detector.js');
        detectContradiction(params.db, obs.content, params.project, params.sessionId);
        // If contradiction found, a 'danger' signal is auto-created by the detector
      }
    } catch { /* non-fatal */ }
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
    emitErrorTelemetry(params.db, params.sessionId, 'tool_processing/pressure', e);
  }

  // Tick artifact TTL once per turn, not per tool call.
  // In tool-heavy turns with 10+ calls, ticking per call over-decrements TTL.
  // Guard: DB-persisted epoch check — works cross-process (CC hooks are separate Node processes).
  try {
    const now = Date.now();
    if (shouldTickArtifactTTL(params.db, params.sessionId, now, params.project)) {
      tickArtifactTTL(params.db, params.project);
    }
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'tool_processing/ttl_tick', e);
  }

  // Milestone detection — capture significant tool outcomes.
  try {
    captureMilestone(params.db, params.sessionId, params.project, params.toolName, params.toolOutput);
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'tool_processing/milestone', e);
  }
}

/** Result of milestone detection — text description + structured metadata. */
export interface MilestoneResult {
  text: string;
  metadata: Record<string, unknown>;
}

/**
 * Detect milestone events from tool execution results.
 * Returns a concise milestone string with structured metadata, or null if no milestone detected.
 * Pure function — no side effects.
 */
export function detectMilestone(toolName: string, toolOutput: string): MilestoneResult | null {
  if (!toolOutput) return null;

  // Test suite results
  const testMatch = toolOutput.match(/(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/i);
  const testFail = toolOutput.match(/(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ure)?/i);
  if (testMatch || testFail) {
    const passed = testMatch ? parseInt(testMatch[1]) : 0;
    const failed = testFail ? parseInt(testFail[1]) : 0;
    const fileMatch = toolOutput.match(/(\d+)\s+(?:test\s+)?files?/i);
    const files = fileMatch ? parseInt(fileMatch[1]) : undefined;
    if (failed > 0) {
      return { text: `Tests: ${passed} passed, ${failed} failed`, metadata: { test_count: passed + failed, pass_count: passed, fail_count: failed, ...(files !== undefined ? { file_count: files } : {}) } };
    }
    if (passed > 0) {
      return { text: `Tests: ${passed} passing`, metadata: { test_count: passed, pass_count: passed, fail_count: 0, ...(files !== undefined ? { file_count: files } : {}) } };
    }
  }

  // Build results
  if (/build/i.test(toolOutput) && /success|clean|complete/i.test(toolOutput)) {
    const durationMatch = toolOutput.match(/(\d+)\s*ms/);
    return { text: 'Build succeeded', metadata: { build_tool: toolName, ...(durationMatch ? { build_duration_ms: parseInt(durationMatch[1]) } : {}) } };
  }

  // Git commits (match [branch abc1234] pattern)
  if (toolName === 'Bash') {
    const commitMatch = toolOutput.match(/\[\S+\s+([a-f0-9]{7,})\]/);
    if (commitMatch) {
      const hash = commitMatch[1].slice(0, 7);
      return { text: `Committed ${hash}`, metadata: { commit_hash: hash } };
    }
  }

  // Deployment/team events
  if (/workers?\s+(?:deployed|spawned|started)/i.test(toolOutput) ||
      /agents?\s+(?:deployed|spawned|started)/i.test(toolOutput)) {
    return { text: 'Team agents deployed', metadata: { event: 'team_deploy' } };
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
      const content = milestone.text.length > 100 ? milestone.text.slice(0, 97) + '...' : milestone.text;
      addJournalEntry(db, sessionId, project, 'milestone', content, milestone.metadata);
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
 * Store a conversation turn (user prompt + assistant response) for session reconstruction.
 * Called by Stop hook after each turn. Non-throwing.
 */
export function storeConversationTurn(
  db: Database.Database,
  sessionId: string,
  project: string,
  userText: string | undefined,
  assistantText: string | undefined,
): void {
  if (!userText && !assistantText) return;
  // V5 Plan 01-02: keep the v4 contract (non-throwing INSERT) but route
  // through the dual-write helpers so the episodic substrate captures every
  // turn. Two distinct call patterns:
  //   - Both texts present  -> a fresh user prompt + assistant message in one
  //     conversational turn. Wrap in two helper calls so the substrate gets
  //     1 organic user_prompt + 1 organic assistant_message + (N injected if
  //     the user text contains wrappers). The legacy table ends up with one
  //     row that has BOTH user_text and assistant_text populated — preserved
  //     by dualWriteAssistantMessage's "UPDATE pending row" fallback.
  //   - Only assistant text  -> defer to the assistant-message helper.
  //   - Only user text       -> defer to the user-prompt helper (legacy
  //     callers that mirror the split-write pattern).
  try {
    if (userText) {
      dualWriteUserPrompt(db, sessionId, project, userText);
    }
    if (assistantText) {
      dualWriteAssistantMessage(db, sessionId, project, assistantText);
    }
  } catch {
    // Non-throwing — conversation storage failure must never break the hook.
    // Telemetry-on-rollback inside the helper has already captured the
    // failure with provenance-aware detail.
  }
}

/**
 * Store the user's prompt as a new conversation turn (assistant_text filled later by Stop hook).
 * Called by UserPromptSubmit. Non-throwing.
 *
 * Split-write pattern: UserPromptSubmit creates the row with user_text,
 * Stop hook fills in assistant_text via updateConversationTurnAssistant.
 * This ensures user messages survive even if the session dies before Stop fires.
 *
 * V5 Plan 01-02: now routes through dualWriteUserPrompt so the same call
 * also lands the organic + injected episodic_events rows in a single
 * transaction. The external signature is unchanged; callers see the same
 * non-throwing void contract.
 */
export function storeConversationTurnUserText(
  db: Database.Database,
  sessionId: string,
  project: string,
  userText: string,
): void {
  if (!userText) return;
  try {
    dualWriteUserPrompt(db, sessionId, project, userText);
  } catch {
    // Non-throwing — failure already recorded as telemetry by the helper.
  }
}

/**
 * Fill in assistant_text on the latest turn that's missing it.
 * Called by Stop hook to complete the split-write from UserPromptSubmit.
 * Returns true if a row was updated, false if no pending turn was found.
 * Non-throwing.
 *
 * V5 Plan 01-02: when the UPDATE succeeds, ALSO write the matching
 * episodic_events row (assistant_message, organic provenance) inside the
 * same transaction. When the UPDATE finds no pending row, the caller's
 * fallback (`storeConversationTurn(undefined, assistantText)`) routes
 * through the dual-write helper, so the substrate is filled exactly once
 * either way. The boolean return preserves the v4 contract — true on
 * UPDATE-succeeded, false on no-pending-row OR error.
 */
export function updateConversationTurnAssistant(
  db: Database.Database,
  sessionId: string,
  assistantText: string,
): boolean {
  try {
    let updated = false;
    let pendingProject: string | null = null;
    let pendingTurn: number | null = null;

    const tx = db.transaction(() => {
      const pending = cachedPrepare(db,
        `SELECT id, project, turn_number FROM conversation_turns
         WHERE session_id = ? AND assistant_text IS NULL
         ORDER BY turn_number DESC LIMIT 1`
      ).get(sessionId) as { id: number; project: string; turn_number: number } | undefined;

      if (!pending) return;

      cachedPrepare(db,
        `UPDATE conversation_turns SET assistant_text = ? WHERE id = ?`
      ).run(assistantText, pending.id);
      updated = true;
      pendingProject = pending.project;
      pendingTurn = pending.turn_number;

      // Mirror to episodic_events with the same turn_number — keeps the
      // organic user_prompt and organic assistant_message visibly threaded.
      cachedPrepare(db,
        `INSERT INTO episodic_events
           (session_id, project, turn_number, type, source, content, provenance, parent_event_id, content_hash, metadata_json)
         VALUES (?, ?, ?, 'assistant_message', 'cc-hooks/stop', ?, 'organic', NULL, ?, NULL)`
      ).run(sessionId, pending.project, pending.turn_number, assistantText, sha256(assistantText));
    });
    tx();
    void pendingProject;
    void pendingTurn;
    return updated;
  } catch {
    return false;
  }
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
 * Capture explicit decision markers (Tier 4 only: "DECISION:", "decided:", etc.)
 * from the user's prompt at submit time. Tier 1 confirmations are intentionally
 * NOT captured here — they're captured in the Stop hook where assistant text is
 * available, so the confirmed CONTENT is stored instead of the raw "yes" message.
 * Non-throwing.
 */
export async function captureExplicitDecisions(params: {
  db: Database.Database;
  sessionId: string;
  project: string;
  userText: string;
}): Promise<void> {
  try {
    await captureDecisions({
      db: params.db,
      sessionId: params.sessionId,
      project: params.project,
      userText: params.userText,
      mode: 'explicit_only',
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
export async function captureInsightsAsLearnings(
  db: Database.Database,
  sessionId: string,
  project: string,
  assistantText: string,
): Promise<void> {
  try {
    // Phase 7 (MIG-02 / VAL-02 extension): strip wrapper-tagged content from
    // assistant text before extracting insights. Phase 1's parseWrappers is
    // the single source-of-truth for the KNOWN_WRAPPER_TAGS list. This makes
    // the Mem0-trap vector structurally impossible for the learnings surface
    // — same discipline episodic_events.provenance enforces via EPI-04.
    // Insights are never extracted from <system-reminder>, <experience-data>,
    // <file-content>, etc.; learnings.provenance is therefore always 'organic'
    // by construction.
    const { organic } = parseWrappers(assistantText);
    if (!organic) return;

    // Combined: regex (floor) + semantic embedding (boost) when Ollama available
    let insights = await extractInsightsCombined(organic, 5).catch(() => extractInsights(organic, 5));
    if (insights.length === 0) return;

    // Quality gate: filter insights through isPromotableContent before promotion.
    // Without this gate, loose regex matches ("so the X", "the architecture is Y")
    // get promoted as cross-session learnings — filling the DB with garbage.
    const learningTexts = insights.map(i => i.content).filter(isPromotableContent);
    if (learningTexts.length === 0) return;

    promoteLearnings({
      db,
      project,
      sessionLearnings: learningTexts,
    });

    // Store insights as flow entries for narrative (prefixed to distinguish from structural flows)
    for (const insight of insights.slice(0, 2)) {
      // Strip any existing [marker] prefix to prevent doubling (e.g. [diagnosis] [diagnosis])
      const cleaned = insight.content.replace(/^\[(diagnosis|finding|conclusion|architecture|systemic)\]\s*/i, '');
      addJournalEntry(db, sessionId, project, 'flow', `[${insight.marker}] ${cleaned.slice(0, 190)}`);
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
    emitErrorTelemetry(db, sessionId, 'session_narrative/flow_entry', e);
  }
}

/**
 * Builds recall metadata from accumulated DB signals (heuristic tier).
 * Generates recall aliases in the user's voice by extracting:
 * - User framings (verbatim first descriptions stored at UserPromptSubmit)
 * - High-frequency concepts from topic shifts
 * - Thread topic evolution chain
 * - Situational tags from correction/frustration signals
 * Non-throwing.
 */
export function buildRecallMetadata(
  db: Database.Database,
  sessionId: string,
  project: string,
  preloadedEvents?: import('../../core/session-events.js').SessionEvent[],
): { recallText: string; metadata: RecallMetadata } | null {
  try {
    const aliases: string[] = [];
    const situationalTags: string[] = [];
    const relatedConcepts: string[] = [];

    // 1. User framings — verbatim user descriptions stored at UserPromptSubmit
    const events = preloadedEvents ?? getSessionEvents(db, sessionId);
    const framings = events
      .filter(e => e.event_type === 'user_framing')
      .map(e => e.detail ?? e.entity);
    if (framings.length > 0) {
      // First framing = primary alias (user's exact words)
      aliases.push(framings[0]);
      // Additional framings as secondary aliases
      for (const f of framings.slice(1, 3)) {
        if (f && !aliases.includes(f)) aliases.push(f);
      }
    }

    // 2. Topic evolution chain — all topic shifts in this session
    const topicShifts = events
      .filter(e => e.event_type === 'topic_shift')
      .map(e => e.entity);
    for (const topic of topicShifts) {
      if (topic && !relatedConcepts.includes(topic)) {
        relatedConcepts.push(topic);
      }
      // Topic names also become aliases
      if (topic && !aliases.includes(topic)) {
        aliases.push(topic);
      }
    }

    // 3. Thread topic (current)
    const thread = getThreadState(db, sessionId);
    if (thread?.topic && !aliases.includes(thread.topic)) {
      aliases.push(thread.topic);
    }

    // 4. Decisions — extract key phrases
    const decisions = getDecisionsBySession(db, sessionId, { limit: 5 });
    for (const d of decisions.slice(0, 3)) {
      const snippet = d.content.slice(0, 80);
      if (!relatedConcepts.includes(snippet)) {
        relatedConcepts.push(snippet);
      }
    }

    // 5. Situational tags from signals
    const corrections = events.filter(e =>
      e.event_type === 'decision' && e.action === 'decided' &&
      e.detail && /correct|fix|wrong|mistake|actually|no,?\s/i.test(e.detail)
    );
    if (corrections.length > 0) situationalTags.push('correction');

    const hasUnresolved = events.filter(e => e.event_type === 'topic_shift').length > 2;
    if (hasUnresolved) situationalTags.push('multi-topic');

    const testEvents = events.filter(e => e.event_type === 'test_run');
    const hasTestFailures = testEvents.some(e => e.action === 'failed');
    if (hasTestFailures) situationalTags.push('test-failures');

    const buildEvents = events.filter(e => e.event_type === 'build');
    if (buildEvents.some(e => e.action === 'error')) situationalTags.push('build-errors');

    if (events.filter(e => e.event_type === 'file_edit').length === 0 &&
        events.filter(e => e.event_type === 'file_create').length === 0) {
      situationalTags.push('design-discussion');
    }

    // 6. Build narrative from what we have
    const narrativeParts: string[] = [];
    if (framings.length > 0) narrativeParts.push(framings[0]);
    if (thread?.topic) narrativeParts.push(`Topic: ${thread.topic}`);
    if (decisions.length > 0) narrativeParts.push(`${decisions.length} decisions`);
    const narrative = narrativeParts.join(' — ') || undefined;

    if (aliases.length === 0 && relatedConcepts.length === 0) return null;

    // Build FTS5-searchable recall_text from aliases
    const recallText = aliases.join(' | ');

    const metadata: RecallMetadata = {
      recall_aliases: aliases.length > 0 ? aliases : undefined,
      narrative,
      situational_tags: situationalTags.length > 0 ? situationalTags : undefined,
      related_concepts: relatedConcepts.length > 0 ? relatedConcepts : undefined,
    };

    return { recallText, metadata };
  } catch {
    return null;
  }
}

/**
 * Captures an enriched recall flow entry with recall metadata.
 * Called at session boundaries (Stop hook after summary, compaction).
 * Non-throwing.
 */
export function captureRecallFlowEntry(
  db: Database.Database,
  sessionId: string,
  project: string,
  preloadedEvents?: import('../../core/session-events.js').SessionEvent[],
): void {
  try {
    const recall = buildRecallMetadata(db, sessionId, project, preloadedEvents);

    // Build content from flow + recall narrative
    const flowContent = buildFlowEntry(db, sessionId, project);

    if (!recall) {
      // Fall back to plain flow entry when recall metadata is unavailable
      if (flowContent) {
        addJournalEntry(db, sessionId, project, 'flow', flowContent.slice(0, 500));
      }
      return;
    }

    const content = flowContent
      ? `${flowContent} — Recall: ${recall.metadata.narrative ?? ''}`
      : `Recall: ${recall.metadata.narrative ?? 'session boundary'}`;

    addJournalEntry(db, sessionId, project, 'flow', content.slice(0, 500), recall.metadata, recall.recallText);
  } catch {
    // Non-throwing
  }
}

/**
 * Records a user framing — the user's verbatim description of what they're working on.
 * Called from UserPromptSubmit when a meaningful user prompt is detected.
 * Stores the first N framings per session as recall signal data.
 * Non-throwing.
 */
export function captureUserFraming(
  db: Database.Database,
  sessionId: string,
  project: string,
  prompt: string,
): void {
  try {
    // Only capture first 3 framings per session to avoid noise
    const existing = cachedPrepare(db,
      `SELECT COUNT(*) as cnt FROM session_events
       WHERE session_id = ? AND event_type = 'user_framing'`
    ).get(sessionId) as { cnt: number };
    if (existing.cnt >= 3) return;

    // Extract a clean framing from the prompt (first meaningful sentence, max 150 chars)
    const cleaned = prompt
      .replace(/^\/\w+\s*/, '')           // Strip /commands
      .replace(/```[\s\S]*?```/g, '')     // Strip code blocks
      .replace(/<[^>]+>/g, '')            // Strip tags
      .trim();
    if (cleaned.length < 10) return;      // Too short to be meaningful

    const truncated = cleaned.length > 150 ? cleaned.slice(0, 147) + '...' : cleaned;
    const framing = redactContent(truncated);
    recordEvent(db, sessionId, project, 'user_framing', 'prompt', 'framed', framing);
  } catch {
    // Non-throwing
  }
}

/**
 * Checks for back-to-back compaction with minimal work between.
 * Returns true if auto-endsession should be suggested.
 * Non-throwing.
 */
export function detectIdleSession(
  db: Database.Database,
  sessionId: string,
  preloadedEvents?: import('../../core/session-events.js').SessionEvent[],
): boolean {
  try {
    const events = preloadedEvents ?? getSessionEvents(db, sessionId);
    const compactions = events.filter(e => e.event_type === 'compaction');
    if (compactions.length < 2) return false;

    // Count tool-producing events between last two compactions
    const lastCompaction = compactions[compactions.length - 1];
    const prevCompaction = compactions[compactions.length - 2];
    const workBetween = events.filter(e =>
      e.timestamp_epoch_ms > prevCompaction.timestamp_epoch_ms &&
      e.timestamp_epoch_ms < lastCompaction.timestamp_epoch_ms &&
      e.event_type !== 'compaction' &&
      e.event_type !== 'user_framing' &&
      e.event_type !== 'topic_shift'
    );

    return workBetween.length < 3;
  } catch {
    return false;
  }
}

/**
 * Run the compaction sequence: write checkpoint, promote learnings, mark post-compact.
 * Used by PreCompact (CC) and onCompact (bridge).
 */
export async function runCompactionSequence(params: CompactionParams): Promise<void> {
  // Record compaction event for idle detection
  try {
    recordEvent(params.db, params.sessionId, params.project, 'compaction', 'context', 'compacted');
  } catch { /* non-throwing */ }

  // Capture enriched recall flow entry BEFORE observations are marked consumed
  captureRecallFlowEntry(params.db, params.sessionId, params.project);

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
    emitErrorTelemetry(params.db, params.sessionId, 'compaction/checkpoint', e);
  }

  if (checkpointSucceeded) {
    // Mark old observations as consumed AFTER checkpoint succeeds
    // Observations older than 5 minutes ago that aren't in the most recent 10
    // Scoped to current session to prevent cross-session blindness
    try {
      const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
      markObservationsConsumed(params.db, params.project, params.sessionId, fiveMinutesAgo, 10);
    } catch (e) {
      emitErrorTelemetry(params.db, params.sessionId, 'compaction/mark_consumed', e);
    }

    // Pack all existing artifacts into the reference layer before creating new ones.
    // Without this, pre-compaction artifacts stay fresh/materialized indefinitely.
    try {
      packAllArtifacts(params.db, params.project);
    } catch (e) {
      emitErrorTelemetry(params.db, params.sessionId, 'compaction/pack_artifacts', e);
    }

    // Extract session learnings from two high-signal sources:
    // 1. Decisions (what was decided — already deduplicated, high intent signal)
    // 2. Discovery-type observations (explicitly classified new findings)
    try {
      const sessionLearnings: string[] = [];

      // Source 1: Decisions from this session
      const decisions = getDecisionsBySession(params.db, params.sessionId, { limit: 10 });
      for (const d of decisions) {
        if (d.content && isPromotableContent(d.content)) {
          sessionLearnings.push(d.content);
        }
      }

      // Source 2: Discovery observations (rare but high-value)
      const discoveries = cachedPrepare(params.db,
        `SELECT DISTINCT title FROM observations
         WHERE session_id = ? AND project = ? AND deleted_at_epoch_ms IS NULL
           AND obs_type = 'discovery'
           AND title IS NOT NULL AND LENGTH(title) > 10
         ORDER BY importance DESC
         LIMIT 5`
      ).all(params.sessionId, params.project) as Array<{ title: string }>;
      for (const d of discoveries) {
        if (isPromotableContent(d.title)) {
          sessionLearnings.push(d.title);
        }
      }

      promoteLearnings({
        db: params.db,
        project: params.project,
        sessionLearnings,
      });
    } catch (e) {
      emitErrorTelemetry(params.db, params.sessionId, 'compaction/promote_learnings', e);
    }

    // Create artifacts from learnings — deduped by artifact_ref to prevent
    // compaction from duplicating all 50 learnings on every cycle.
    try {
      const learnings = getLearningsByProject(params.db, params.project, { limit: 50 });
      for (const learning of learnings) {
        const ref = String(learning.id);
        const exists = cachedPrepare(params.db,
          "SELECT 1 FROM artifacts WHERE artifact_type = 'learning' AND artifact_ref = ? AND project = ? LIMIT 1"
        ).get(ref, params.project);
        if (!exists) {
          const artId = createArtifact(params.db, params.sessionId, params.project, 'learning', ref, learning.content.slice(0, 150), learning.content, 4);
          // Embed learning artifact — awaited because hooks are ephemeral
          if (artId > 0) {
            try {
              await embedArtifact(params.db, artId, learning.content, {
                project: params.project, artifact_type: 'learning',
                importance: 4, session_id: params.sessionId,
                summary: learning.content.slice(0, 150),
              });
            } catch { /* embedding is supplementary */ }
          }
        }
      }
    } catch (e) {
      emitErrorTelemetry(params.db, params.sessionId, 'compaction/learning_artifacts', e);
    }
  }

  // markPostCompactPending runs REGARDLESS of checkpoint success.
  // Post-compaction context recovery must fire even if checkpoint write failed —
  // the agent needs memory re-injection after compaction regardless.
  try {
    markPostCompactPending(params.db, params.sessionId);
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'compaction/mark_pending', e);
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
    emitErrorTelemetry(db, sessionId, 'session_narrative/summary', e);
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
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/checkpoint', e);
  }

  try {
    pruneObservations(params.db, params.project, {
      pruneThreshold: params.config.observations.prune_threshold,
      pruneCount: params.config.observations.prune_count,
    });
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/prune_observations', e);
  }

  try {
    applyRetentionPolicy(params.db, params.project, params.config.observations.retention_days);
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/retention_policy', e);
  }

  try {
    decayPressureStratified(params.db, params.project);
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/pressure_decay', e);
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
        if (d.content && isPromotableContent(d.content)) sessionLearnings.push(d.content);
      }
      const discoveries = cachedPrepare(params.db,
        `SELECT DISTINCT title FROM observations
         WHERE session_id = ? AND project = ? AND deleted_at_epoch_ms IS NULL
           AND obs_type = 'discovery' AND title IS NOT NULL AND LENGTH(title) > 10
         ORDER BY importance DESC LIMIT 5`
      ).all(params.sessionId, params.project) as Array<{ title: string }>;
      for (const d of discoveries) {
        if (isPromotableContent(d.title)) sessionLearnings.push(d.title);
      }
      if (sessionLearnings.length > 0) {
        promoteLearnings({ db: params.db, project: params.project, sessionLearnings });
      }
    }
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/promote_learnings', e);
  }

  // Capture session summary before ending session
  try {
    captureSessionSummary(params.db, params.sessionId, params.project);
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/summary', e);
  }

  try {
    endSession(params.db, params.sessionId, 'completed');
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/end_session', e);
  }

  try {
    pruneTelemetry(params.db, {
      retentionDays: params.config.observability.retention_days,
      retainErrorCount: params.config.observability.retain_error_count,
    });
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/prune_telemetry', e);
  }

  // Pre-assembly: predict likely context for next session (4.5 Sleep-Time Pre-Assembly)
  try {
    await generatePreAssembly(params.db, params.sessionId, params.project);
  } catch (e) {
    emitErrorTelemetry(params.db, params.sessionId, 'session_end/pre_assembly', e);
  }
}

// ---------------------------------------------------------------------------
// Sleep-Time Pre-Assembly (4.5)
// ---------------------------------------------------------------------------

/**
 * At session-end, pre-compute likely-needed context for the next session.
 * Analyzes: active topic, hot files, relevant patterns.
 * Stores as a 'pre_assembled' artifact. At next session-start, if the
 * opening prompt matches (cosine > 0.7), the pre-assembled block is used.
 *
 * Best-effort optimization — graceful degradation if prediction misses.
 * Non-throwing.
 */
export async function generatePreAssembly(
  db: Database.Database,
  sessionId: string,
  project: string,
): Promise<void> {
  try {
    const parts: string[] = [];

    // 1. Active topic from thread state
    const thread = getThreadState(db, sessionId);
    if (!thread?.topic && !thread?.summary) return; // No topic = nothing to predict

    if (thread.topic) {
      parts.push(`[Predicted Context] Continuing work on: ${thread.topic}`);
    }

    // 2. Hot files (top 5 by pressure)
    try {
      const hotFiles = cachedPrepare(db,
        `SELECT file_path, raw_pressure FROM pressure_scores
         WHERE project = ? AND temperature = 'HOT'
         ORDER BY raw_pressure DESC
         LIMIT 5`
      ).all(project) as Array<{ file_path: string; raw_pressure: number }>;
      if (hotFiles.length > 0) {
        parts.push('Hot files: ' + hotFiles.map(f => f.file_path).join(', '));
      }
    } catch { /* non-fatal */ }

    // 3. Recent decisions (last 3)
    try {
      const decisions = getDecisionsBySession(db, sessionId, { limit: 3 });
      if (decisions.length > 0) {
        parts.push('Recent decisions: ' + decisions.map(d => d.content.slice(0, 80)).join('; '));
      }
    } catch { /* non-fatal */ }

    // 4. Recent learnings relevant to topic
    if (thread.topic) {
      try {
        const learnings = getLearningsByProject(db, project, { limit: 5 });
        const topicKeywords = thread.topic.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const relevant = learnings.filter(l => {
          const lowerContent = l.content.toLowerCase();
          return topicKeywords.some(kw => lowerContent.includes(kw));
        }).slice(0, 3);
        if (relevant.length > 0) {
          parts.push('Relevant learnings: ' + relevant.map(l => l.content.slice(0, 80)).join('; '));
        }
      } catch { /* non-fatal */ }
    }

    // 5. Thread summary for context continuity
    if (thread.summary) {
      parts.push('Session summary: ' + thread.summary);
    }

    if (parts.length < 2) return; // Not enough signal to pre-assemble

    const content = parts.join('\n');
    const summary = `[Pre-assembly] ${thread.topic ?? 'continuation'} — predicted context`;

    // Store as a special artifact type
    const artifactId = createArtifact(
      db, sessionId, project, 'flow',
      `pre_assembly:${sessionId}`,
      summary, content, 3,
    );

    // Embed the pre-assembly for cosine matching at next session-start
    if (artifactId > 0) {
      try {
        const { embedArtifact: embedArt } = await import('../../embeddings/embed-pipeline.js');
        await embedArt(db, artifactId, content, {
          project,
          artifact_type: 'flow',
          importance: 3,
          session_id: sessionId,
          summary,
        });
      } catch { /* non-fatal */ }
    }
  } catch {
    // Non-throwing
  }
}

/**
 * Check if a pre-assembled context block matches the current prompt.
 * If cosine > 0.7, returns the pre-assembled content. Otherwise null.
 *
 * Called from UserPromptSubmit on first prompt of a session.
 * Non-throwing.
 */
export async function matchPreAssembly(
  db: Database.Database,
  project: string,
  promptEmbedding: number[],
): Promise<string | null> {
  try {
    // Find the most recent pre_assembly artifact for this project
    const preAssembly = cachedPrepare(db,
      `SELECT id, content, embedding FROM artifacts
       WHERE project = ? AND artifact_ref LIKE 'pre_assembly:%'
       AND state != 'packed' AND embedding IS NOT NULL
       ORDER BY timestamp_epoch_ms DESC
       LIMIT 1`
    ).get(project) as {
      id: number;
      content: string | null;
      embedding: Buffer;
    } | undefined;

    if (!preAssembly || !preAssembly.content) return null;

    // Compute cosine similarity
    const { cosineSimilarity } = await import('../../core/artifacts.js');
    const vec = new Float32Array(
      preAssembly.embedding.buffer,
      preAssembly.embedding.byteOffset,
      preAssembly.embedding.byteLength / 4,
    );
    const sim = cosineSimilarity(promptEmbedding, vec);

    if (sim > 0.7) {
      // Match! Pack the pre-assembly artifact (consumed)
      cachedPrepare(db,
        "UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?"
      ).run(preAssembly.id);
      return preAssembly.content;
    }

    // No match — discard pre-assembly
    cachedPrepare(db,
      "UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?"
    ).run(preAssembly.id);
    return null;
  } catch {
    return null;
  }
}
