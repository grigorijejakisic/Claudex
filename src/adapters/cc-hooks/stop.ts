/**
 * Stop hook -> after_turn event.
 * Captures decisions, extracts insights, tracks thread, checks checkpoint threshold.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitTelemetry, sanitizeErrorForTelemetry } from '../../observability/telemetry.js';
import {
  captureDecisionsWithClassifier,
  captureInsightsAsLearnings,
  trackAfterTurn,
  checkpointIfThresholdMet,
} from '../shared/lifecycle.js';

const main = wrapHook('Stop', async (input, ctx) => {
  const lastAssistantText = (input.stop_assistant_turn as string)
    ?? (input.last_assistant_message as string)
    ?? (input.assistant_text as string)
    ?? undefined;
  const lastUserText = (input.prompt as string) ?? (input.user_prompt as string) ?? undefined;

  // Each operation isolated — if A fails, B and C still run

  // Decision capture with optional embedding classifier (built fresh each invocation)
  try {
    await captureDecisionsWithClassifier({
      db: ctx.db,
      sessionId: input.session_id,
      project: ctx.project,
      config: ctx.config,
      userText: lastUserText,
      assistantText: lastAssistantText,
    });
  } catch (e) {
    try { emitTelemetry(ctx.db, input.session_id, 'error', { subsystem: 'stop/decision_capture', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  // Insight extraction — analytical conclusions from assistant response
  try {
    if (lastAssistantText) {
      captureInsightsAsLearnings(ctx.db, input.session_id, ctx.project, lastAssistantText);
    }
  } catch (e) {
    try { emitTelemetry(ctx.db, input.session_id, 'error', { subsystem: 'stop/insight_extraction', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  // Thread tracking
  try {
    trackAfterTurn(ctx.db, input.session_id, lastUserText, lastAssistantText);
  } catch (e) {
    try { emitTelemetry(ctx.db, input.session_id, 'error', { subsystem: 'stop/track_after_turn', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

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
    try { emitTelemetry(ctx.db, input.session_id, 'error', { subsystem: 'stop/checkpoint', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  return {};
});

main();
