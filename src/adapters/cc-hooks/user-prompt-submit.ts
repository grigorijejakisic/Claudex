/**
 * UserPromptSubmit hook -> before_prompt event.
 * Checks post-compaction, reads gauge, detects topic shift, assembles regular prompt.
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
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import { persistTopicIfShifted, ensureInitialTopic, captureFlowEntry, captureExplicitDecisions } from '../shared/lifecycle.js';
import { searchArtifacts, materializeArtifacts } from '../../core/artifacts.js';
import { getCooldownState, setCooldownState } from '../../core/thread.js';
import { routeByContent, buildProjectIndex } from '../../shared/content-router.js';

const main = wrapHook('UserPromptSubmit', async (input, ctx) => {
  const prompt = (input.prompt as string) || (input.user_prompt as string) || '';

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
      // Load cooldown state from DB — fresh detector instances
      // (created each hook invocation) need to respect existing cooldown windows.
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
      // Persist updated cooldown state so next hook invocation
      // (fresh process / fresh detector) picks up where we left off.
      try {
        setCooldownState(ctx.db, input.session_id, detector.getCooldownState());
      } catch (e) {
        emitErrorTelemetry(ctx.db, input.session_id, 'cooldown_persist', e);
      }
    } catch {
      topicShift = null;
    }
  }

  // Persist topic update to thread_state when a shift is detected
  persistTopicIfShifted(ctx.db, input.session_id, topicShift);

  // Set initial topic from user prompt if none exists yet
  if (prompt && !topicShift?.shifted) {
    ensureInitialTopic(ctx.db, input.session_id, prompt);
  }

  // Content-aware routing — route decisions/artifacts to the correct project
  const routedProject = prompt
    ? routeByContent(prompt, ctx.project, buildProjectIndex())
    : ctx.project;

  // Capture explicit decision markers (Tier 4 only) from user prompt.
  // Tier 1 confirmations are captured in Stop hook where assistant text is
  // available — so the confirmed CONTENT (not the user's "yes") is stored.
  if (prompt) {
    try {
      await captureExplicitDecisions({
        db: ctx.db,
        sessionId: input.session_id,
        project: routedProject,
        userText: prompt,
      });
    } catch (e) {
      emitErrorTelemetry(ctx.db, input.session_id, 'explicit_decisions', e);
    }
  }

  // Capture flow entry at topic shift boundaries — natural narrative breakpoints.
  // This supplements compaction-time flow capture, ensuring flow is recorded
  // even in long sessions that never hit compaction (especially on 1M context).
  if (topicShift?.shifted) {
    captureFlowEntry(ctx.db, input.session_id, routedProject);
  }

  // Materialize artifacts matching the current prompt/topic BEFORE assembly reads them.
  // Assembly is pure read-render; state updates happen here at the turn boundary (ARCH-002).
  // Search across BOTH CWD project and routed project for cross-project retrieval.
  try {
    const query = prompt || topicShift?.newTopic;
    if (query) {
      const matches = searchArtifacts(ctx.db, ctx.project, query, 10);
      // Also search routed project if different from CWD
      if (routedProject !== ctx.project) {
        const crossMatches = searchArtifacts(ctx.db, routedProject, query, 5);
        matches.push(...crossMatches);
      }
      if (matches.length > 0) {
        materializeArtifacts(ctx.db, matches.map(a => a.id));
      }
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'artifact_materialize', e);
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
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: payload.content,
      },
    };
  }
  return {};
});

main();
