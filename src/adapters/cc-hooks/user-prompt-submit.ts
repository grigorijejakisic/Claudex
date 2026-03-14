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
      const detector = new TopicShiftDetector(available ? embedProvider : null);
      topicShift = await detector.detectTopicShift({
        prompt,
        db: ctx.db,
        sessionId: input.session_id,
        config: {
          topicShiftThreshold: ctx.config.embeddings.topic_shift_threshold,
          topicShiftWindow: ctx.config.embeddings.topic_shift_window,
        },
      });
    } catch {
      topicShift = null;
    }
  }

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
