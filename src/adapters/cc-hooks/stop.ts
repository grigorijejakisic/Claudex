/**
 * Stop hook -> after_turn event.
 * Captures decisions, tracks thread, checks checkpoint threshold.
 * @see Architecture Section 3.2
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import {
  captureDecisionsWithClassifier,
  trackAfterTurn,
  checkpointIfThresholdMet,
} from '../shared/lifecycle.js';

const main = wrapHook('Stop', async (input, ctx) => {
  const lastAssistantText = (input.stop_assistant_turn as string)
    ?? (input.assistant_text as string)
    ?? undefined;
  const lastUserText = (input.user_prompt as string) ?? undefined;

  // Decision capture with optional embedding classifier (built fresh each invocation)
  await captureDecisionsWithClassifier({
    db: ctx.db,
    sessionId: input.session_id,
    project: ctx.project,
    config: ctx.config,
    userText: lastUserText,
    assistantText: lastAssistantText,
  });

  // Thread tracking
  trackAfterTurn(ctx.db, input.session_id, lastUserText, lastAssistantText);

  // Checkpoint threshold check
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

  return {};
});

main();
