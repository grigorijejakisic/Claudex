/**
 * Stop hook -> after_turn event.
 * Captures decisions, extracts insights, tracks thread, checks checkpoint threshold.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import {
  captureDecisionsWithClassifier,
  captureInsightsAsLearnings,
  trackAfterTurn,
  checkpointIfThresholdMet,
} from '../shared/lifecycle.js';
import { routeByContent, buildProjectIndex } from '../../shared/content-router.js';
import { applyExperienceFeedback } from '../../intelligence/experience-scoring.js';
import { getSessionEvents, synthesizeSessionSummary, saveSessionSummary } from '../../core/session-events.js';
import { processRetrievalFeedback } from '../../intelligence/retrieval-feedback.js';
import { getExperienceFlags } from '../../intelligence/experience-flags.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Hook step runner — eliminates repeated try/catch boilerplate.
// Synchronous steps only; async callers wrap their own try/catch.
// ---------------------------------------------------------------------------

function runHookStep(
  name: string,
  fn: () => void,
  db: Database,
  sessionId: string,
): void {
  try {
    fn();
  } catch (e) {
    try {
      emitErrorTelemetry(db, sessionId, `stop/${name}`, e);
    } catch {
      // Double-fault: telemetry itself failed — nothing we can do
    }
  }
}

const main = wrapHook('Stop', async (input, ctx) => {
  const lastAssistantText = (input.stop_assistant_turn as string)
    ?? (input.last_assistant_message as string)
    ?? (input.assistant_text as string)
    ?? undefined;
  const lastUserText = (input.prompt as string) ?? (input.user_prompt as string) ?? undefined;

  // Content-aware routing — route decisions/insights to the correct project
  const routingContent = ((lastUserText || '') + ' ' + (lastAssistantText || '')).substring(0, 5000);
  const projectIndex = buildProjectIndex();
  const routedProject = routeByContent(routingContent, ctx.project, projectIndex);

  // Each operation isolated — if A fails, B and C still run

  // Decision capture with optional embedding classifier (built fresh each invocation)
  try {
    await captureDecisionsWithClassifier({
      db: ctx.db,
      sessionId: input.session_id,
      project: routedProject,
      config: ctx.config,
      userText: lastUserText,
      assistantText: lastAssistantText,
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/decision_capture', e);
  }

  // Insight extraction — analytical conclusions from assistant response
  runHookStep('insight_extraction', () => {
    if (lastAssistantText) {
      captureInsightsAsLearnings(ctx.db, input.session_id, routedProject, lastAssistantText);
    }
  }, ctx.db, input.session_id);

  // Thread tracking
  runHookStep('track_after_turn', () => {
    trackAfterTurn(ctx.db, input.session_id, lastUserText, lastAssistantText);
  }, ctx.db, input.session_id);

  // Checkpoint threshold check
  try {
    const gauge = getTokenGauge({
      capabilities: CC_CAPABILITIES,
      transcriptPath: getTranscriptPath(input),
    });

    await checkpointIfThresholdMet({
      db: ctx.db,
      sessionId: input.session_id,
      project: ctx.project,
      cwd: input.cwd,
      scope: ctx.scope ?? undefined,
      config: ctx.config,
      gauge,
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/checkpoint', e);
  }

  // Experience pattern extraction + score feedback + flag rotation
  await applyExperienceFeedback(
    ctx.db,
    input.session_id,
    lastAssistantText,
    lastUserText,
    routedProject,
    ctx.config,
  );

  // Retrieval feedback — score injected artifacts based on assistant output
  try {
    const flags = getExperienceFlags(ctx.db, input.session_id);
    if (flags.injected_pattern_ids.length > 0) {
      // Load artifact IDs that were injected this turn (materialized artifacts)
      // Pattern IDs are experience patterns, not artifact IDs — but we can score
      // any artifacts that were materialized during this session's assembly
      const materializedRows = cachedPrepare(ctx.db,
        `SELECT id, summary FROM artifacts
         WHERE project = ? AND state = 'materialized'
         ORDER BY last_materialized_epoch DESC LIMIT 10`
      ).all(routedProject) as Array<{ id: number; summary: string }>;

      if (materializedRows.length > 0) {
        const artifactIds = materializedRows.map(r => r.id);
        const summaryMap = new Map(materializedRows.map(r => [r.id, r.summary]));
        processRetrievalFeedback(
          ctx.db,
          artifactIds,
          lastAssistantText,
          flags.correction_flagged,
          summaryMap,
        );
      }
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/retrieval_feedback', e);
  }

  // Pre-compute session summary from events (for next session's reconstruction)
  try {
    const events = getSessionEvents(ctx.db, input.session_id);
    const summary = synthesizeSessionSummary(events);
    if (summary) {
      saveSessionSummary(ctx.db, input.session_id, summary);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/session_summary', e);
  }

  return {};
});

main();
