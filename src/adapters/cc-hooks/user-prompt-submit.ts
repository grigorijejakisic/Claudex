/**
 * UserPromptSubmit hook -> before_prompt event.
 * Checks post-compaction, reads gauge, detects topic shift, assembles regular prompt.
 * @see Architecture Section 3.2
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getCheckpointTracking, clearPostCompactPending } from '../../core/checkpoint-tracking.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { assembleRegularPrompt } from '../../assembly/assembler.js';
import { TopicShiftDetector } from '../../intelligence/topic-shift.js';
import type { TopicShiftResult } from '../../intelligence/topic-shift.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { getIdentityDir } from '../../shared/paths.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { persistTopicIfShifted, captureFlowEntry } from '../shared/lifecycle.js';
import { searchArtifacts, materializeArtifacts } from '../../core/artifacts.js';
import { getCooldownState, setCooldownState } from '../../core/thread.js';

const main = wrapHook('UserPromptSubmit', async (input, ctx) => {
  const prompt = (input.user_prompt as string) || '';

  const tracking = getCheckpointTracking(ctx.db, input.session_id);
  const isPostCompaction = tracking?.post_compact_pending === 1;

  const gauge = getTokenGauge({
    capabilities: CC_CAPABILITIES,
    transcriptPath: getTranscriptPath(input),
    model: (input.model as string) ?? undefined,
  });

  let topicShift: TopicShiftResult | null = null;
  if (!isPostCompaction && prompt) {
    try {
      const embedProvider = new EmbeddingProvider({
        baseUrl: ctx.config.embeddings.ollama_base_url,
        model: ctx.config.embeddings.model,
      });
      const available = await embedProvider.isAvailable();
      // CTR-002: Load cooldown state from DB so fresh detector instances
      // (created each hook invocation) respect existing cooldown windows.
      const cooldown = getCooldownState(ctx.db, input.session_id);
      const detector = new TopicShiftDetector(
        available ? embedProvider : null,
        cooldown ?? undefined,
      );
      topicShift = await detector.detectTopicShift({
        prompt,
        db: ctx.db,
        sessionId: input.session_id,
        config: {
          topicShiftThreshold: ctx.config.embeddings.topic_shift_threshold,
          topicShiftWindow: ctx.config.embeddings.topic_shift_window,
        },
      });
      // CTR-002: Persist updated cooldown state so next hook invocation
      // (fresh process / fresh detector) picks up where we left off.
      try {
        setCooldownState(ctx.db, input.session_id, detector.getCooldownState());
      } catch { /* non-fatal */ }
    } catch {
      topicShift = null;
    }
  }

  // Persist topic update to thread_state when a shift is detected
  persistTopicIfShifted(ctx.db, input.session_id, topicShift);

  // Capture flow entry at topic shift boundaries — natural narrative breakpoints.
  // This supplements compaction-time flow capture, ensuring flow is recorded
  // even in long sessions that never hit compaction (especially on 1M context).
  if (topicShift?.shifted) {
    captureFlowEntry(ctx.db, input.session_id, ctx.project);
  }

  // Materialize artifacts matching the current prompt/topic BEFORE assembly reads them.
  // Assembly is pure read-render; state updates happen here at the turn boundary (ARCH-002).
  try {
    const query = prompt || topicShift?.newTopic;
    if (query) {
      const matches = searchArtifacts(ctx.db, ctx.project, query, 10);
      if (matches.length > 0) {
        materializeArtifacts(ctx.db, matches.map(a => a.id));
      }
    }
  } catch { /* non-fatal */ }

  const payload = assembleRegularPrompt({
    isPostCompaction,
    prompt,
    gauge,
    topicShift,
    db: ctx.db,
    project: ctx.project,
    projectDir: input.cwd,
    config: ctx.config,
    identityDir: getIdentityDir(),
    sessionId: input.session_id,
  });

  if (isPostCompaction) {
    clearPostCompactPending(ctx.db, input.session_id);
  }

  if (payload.tokenEstimate > 0) {
    try {
      const trigger = isPostCompaction
        ? 'post_compaction' as const
        : payload.sources.includes('topic_pivot')
          ? 'topic_shift' as const
          : 'gauge' as const;
      emitTelemetry(ctx.db, input.session_id, 'injection', {
        trigger,
        sections_included: payload.sources,
        sections_skipped: [],
        total_tokens: payload.tokenEstimate,
        budget_remaining: ctx.config.injection.budget_tokens - payload.tokenEstimate,
      });
    } catch { /* non-fatal */ }
  }

  if (payload.content) {
    return { systemMessage: payload.content };
  }
  return {};
});

main();
