/**
 * Stop hook -> after_turn event.
 * Captures decisions, extracts insights, tracks thread, checks checkpoint threshold.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
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
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/decision_capture', e);
  }

  // Insight extraction — analytical conclusions from assistant response
  try {
    if (lastAssistantText) {
      captureInsightsAsLearnings(ctx.db, input.session_id, ctx.project, lastAssistantText);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/insight_extraction', e);
  }

  // Thread tracking
  try {
    trackAfterTurn(ctx.db, input.session_id, lastUserText, lastAssistantText);
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/track_after_turn', e);
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
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/checkpoint', e);
  }

  return {};
});

main();
