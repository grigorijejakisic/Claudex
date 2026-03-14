/**
 * UserPromptSubmit hook -> before_prompt event.
 * Checks post-compaction, reads gauge, detects topic shift, assembles regular prompt.
 * @see Architecture Section 3.2
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getCheckpointTracking, clearPostCompactPending, updateCheckpointTracking } from '../../core/checkpoint-tracking.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES, getPressureZone } from '../../shared/constants.js';
import { assembleRegularPrompt } from '../../assembly/assembler.js';
import { writeCheckpoint } from '../../checkpoint/writer.js';
import { emitTelemetry, emitInjectionTelemetry } from '../../observability/telemetry.js';
import { TopicShiftDetector } from '../../intelligence/topic-shift.js';
import type { TopicShiftResult } from '../../intelligence/topic-shift.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { getIdentityDir } from '../../shared/paths.js';
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

  // Upgrade 7: Auto-checkpoint at advisory+ zones
  const zone = gauge ? getPressureZone(gauge.utilization) : 'normal';
  if (zone !== 'normal' && gauge) {
    try {
      const cpTracking = getCheckpointTracking(ctx.db, input.session_id);
      const nowEpoch = Math.floor(Date.now() / 1000);
      const cooldown = ctx.config.context?.checkpoint_cooldown_seconds ?? 300;
      const lastCp = cpTracking?.last_checkpoint_epoch ?? 0;
      if (nowEpoch - lastCp >= cooldown) {
        await writeCheckpoint({
          db: ctx.db,
          sessionId: input.session_id,
          project: ctx.project,
          projectDir: input.cwd,
          trigger: 'threshold',
          tokenUsage: gauge,
          scope: ctx.scope ?? undefined,
        });
        // Update checkpoint tracking so cooldown timer works
        try {
          updateCheckpointTracking(ctx.db, input.session_id, 0);
        } catch { /* non-fatal */ }
      }
    } catch {
      // Non-fatal — checkpoint failure shouldn't block prompt
    }
  }

  let topicShift: TopicShiftResult | null = null;
  if (!isPostCompaction && prompt) {
    try {
      const embedProvider = new EmbeddingProvider({
        baseUrl: ctx.config.embeddings.ollama_base_url,
        model: ctx.config.embeddings.model,
      });
      const available = await embedProvider.isAvailable();
      // Restore cooldown state from DB so it persists across CC hook invocations
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
          jaccardShiftThreshold: ctx.config.embeddings.jaccard_shift_threshold,
        },
      });
      // Persist updated cooldown state back to DB
      setCooldownState(ctx.db, input.session_id, detector.getCooldownState());
    } catch {
      topicShift = null;
    }
  }

  if (topicShift?.shifted && ctx.config.observability.enabled) {
    emitTelemetry(ctx.db, input.session_id, 'topic_shift', {
      method: topicShift.method ?? 'jaccard',
      similarity: topicShift.confidence ?? 0,
      shifted: topicShift.shifted,
      // Omit old_topic/new_topic to avoid persisting unredacted user content in telemetry
    });
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
    sessionId: input.session_id,
  });

  if (ctx.config.observability.enabled && payload.content) {
    emitInjectionTelemetry(ctx.db, input.session_id, {
      trigger: isPostCompaction ? 'post_compaction' : topicShift?.shifted ? 'topic_shift' : 'gauge',
      sectionsIncluded: payload.sources,
      totalTokens: payload.tokenEstimate,
      budgetTokens: ctx.config.injection.budget_tokens,
    });
  }

  if (isPostCompaction) {
    clearPostCompactPending(ctx.db, input.session_id);
  }

  if (payload.content) {
    return { systemMessage: payload.content };
  }
  return {};
});

main();
