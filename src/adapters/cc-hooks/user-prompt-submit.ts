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
import { persistTopicIfShifted, ensureInitialTopic, captureFlowEntry, captureExplicitDecisions, captureUserFraming } from '../shared/lifecycle.js';
import { searchArtifactsGlobal, materializeArtifacts } from '../../core/artifacts.js';
import { getCooldownState, setCooldownState } from '../../core/thread.js';
import { routeByContent, buildProjectIndex } from '../../shared/content-router.js';
import { setExperienceFlags, getExperienceFlags } from '../../intelligence/experience-flags.js';
import { detectCorrectionSignal } from '../../intelligence/correction-detection.js';
import { recordEvent } from '../../core/session-events.js';
import { findSimilarThreads } from '../../intelligence/thread-tracker.js';
import { shouldRunReflection, runBatchReflection } from '../../intelligence/batch-reflection.js';
import { extractDomain, generateDomainAdvisory, getWeakDomains } from '../../intelligence/capability-tracker.js';
import { getThreadState } from '../../core/thread.js';
import { getPendingMessages, markMessagesDelivered } from '../../angel/message-sender.js';

/** CC internal messages that should not trigger any context processing. */
const CC_INTERNAL_RE = /^(tasknotification\s|outputfile)/i;

const main = wrapHook('UserPromptSubmit', async (input, ctx) => {
  const prompt = (input.prompt as string) || (input.user_prompt as string) || '';

  // Early exit: CC internal notifications (task completions, output file refs)
  // should not set topics, capture decisions, trigger experience patterns, or
  // consume assembly budget. Let them pass through with zero injection.
  if (CC_INTERNAL_RE.test(prompt)) {
    return {};
  }

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

  // Record topic shift as a session event for summary synthesis
  if (topicShift?.shifted && topicShift.newTopic) {
    try {
      recordEvent(ctx.db, input.session_id, ctx.project, 'topic_shift', topicShift.newTopic, 'shifted');
    } catch { /* non-throwing */ }
  }

  // Set initial topic from user prompt if none exists yet
  if (prompt && !topicShift?.shifted) {
    ensureInitialTopic(ctx.db, input.session_id, prompt);
  }

  // Capture user framing for recall metadata (user's verbatim description)
  if (prompt && prompt.length >= 15) {
    try {
      captureUserFraming(ctx.db, input.session_id, ctx.project, prompt);
    } catch { /* non-throwing */ }
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

  // Consume pending trigger domains — search for domain-relevant artifacts
  // (task-aware assembly: tool input drove the search, not the user's prompt)
  const triggerFlags = getExperienceFlags(ctx.db, input.session_id);
  const pendingDomains = triggerFlags.pending_trigger_domains;
  if (pendingDomains.length > 0) {
    try {
      const domainQuery = pendingDomains.join(' ');
      const domainMatches = searchArtifactsGlobal(ctx.db, routedProject, domainQuery, 5);
      if (domainMatches.length > 0) {
        materializeArtifacts(ctx.db, domainMatches.map(a => a.id), ctx.project);
      }
      // Clear consumed domains
      setExperienceFlags(ctx.db, input.session_id, {
        pending_trigger_domains: [],
      }, triggerFlags);
    } catch (e) {
      emitErrorTelemetry(ctx.db, input.session_id, 'trigger_domain_materialize', e);
    }
  }

  // Materialize artifacts for assembly turns only (post-compaction and topic shift).
  // Regular turns don't render materialized artifacts — no point searching every prompt.
  // Global search: artifacts are the cross-project knowledge layer. routedProject is
  // used as the priority bias so content-routed project results surface first.
  if (isPostCompaction || topicShift?.shifted) {
    try {
      const query = prompt || topicShift?.newTopic;
      if (query) {
        const matches = searchArtifactsGlobal(ctx.db, routedProject, query, 10);
        if (matches.length > 0) {
          // Only materialize same-project artifacts — cross-project ones surface
          // via global search without contaminating their home project's state
          materializeArtifacts(ctx.db, matches.map(a => a.id), ctx.project);
        }
      }
    } catch (e) {
      emitErrorTelemetry(ctx.db, input.session_id, 'artifact_materialize', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Experience pattern detection
  // ---------------------------------------------------------------------------

  // Reset correction flags at turn start — stale flags from a previous turn
  // must not leak into this turn's Stop hook processing (R6).
  setExperienceFlags(ctx.db, input.session_id, {
    correction_flagged: false,
    correction_prompt: '',
  });

  // Correction signal detection — flag the turn for Stop hook extraction.
  // Pattern matching and injection is handled exclusively by the assembler;
  // the hook only detects corrections to avoid double injection and inflated counts.
  if (prompt) {
    try {
      const correctionFlagged = detectCorrectionSignal(prompt);
      if (correctionFlagged) {
        setExperienceFlags(ctx.db, input.session_id, {
          correction_flagged: true,
          // Store the prompt text so Stop hook can extract topic words for
          // per-pattern scoring. Cap at 500 chars to bound storage size.
          correction_prompt: prompt.slice(0, 500),
        });
      }
    } catch (e) {
      emitErrorTelemetry(ctx.db, input.session_id, 'exp_correction_detect', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-session thread linking (4.3)
  // Detect if this prompt continues a thread from a previous session.
  // Only runs on first prompt of a session (no existing topic in thread_state).
  // ---------------------------------------------------------------------------
  let crossSessionContext = '';
  if (prompt && !topicShift?.shifted) {
    try {
      const existingThread = getThreadState(ctx.db, input.session_id);
      const isFirstPrompt = !existingThread?.topic;

      if (isFirstPrompt) {
        const { embedText } = await import('../../embeddings/embed-pipeline.js');
        const promptEmbedding = await embedText(prompt);
        if (promptEmbedding) {
          // 4.5: Check pre-assembly match first (faster session start)
          try {
            const { matchPreAssembly } = await import('../shared/lifecycle.js');
            const preAssembled = await matchPreAssembly(ctx.db, ctx.project, promptEmbedding);
            if (preAssembled) {
              crossSessionContext = preAssembled;
            }
          } catch { /* non-fatal */ }

          // 4.3: Cross-session thread linking
          if (!crossSessionContext) {
            const similarThreads = findSimilarThreads(
              ctx.db, promptEmbedding, ctx.project, 0.8, input.session_id
            );
            if (similarThreads.length > 0) {
              const best = similarThreads[0];
              const parts: string[] = [];
              parts.push(`[Thread Continuity] This looks like a continuation of "${best.topic ?? 'previous work'}" from session ${best.session_id}.`);
              if (best.summary) {
                parts.push(`Previous summary: ${best.summary}`);
              }
              // Include last 3 key exchanges from the matched thread
              const recentExchanges = best.key_exchanges.slice(-3);
              if (recentExchanges.length > 0) {
                parts.push('Recent exchanges: ' + recentExchanges.map(e => `[${e.role}] ${e.gist}`).join(' | '));
              }
              crossSessionContext = parts.join('\n');
            }
          }
        }
      }
    } catch (e) {
      emitErrorTelemetry(ctx.db, input.session_id, 'cross_session_thread', e);
    }
  }

  // Cross-session coordination — detect file conflicts with other active sessions (BossCat pattern)
  try {
    const { getCrossSessionActivity, detectFileConflicts, formatCrossSessionAwareness } = await import('../../intelligence/cross-session-coordination.js');
    const activities = getCrossSessionActivity(ctx.db, ctx.project, input.session_id);
    const conflicts = detectFileConflicts(ctx.db, ctx.project, input.session_id);
    const awareness = formatCrossSessionAwareness(activities, conflicts);
    if (awareness) {
      crossSessionContext = crossSessionContext
        ? crossSessionContext + '\n\n' + awareness
        : awareness;
    }
  } catch { /* non-fatal */ }

  // 4.4 Batch reflection — every 10 sessions, synthesize cross-session insights
  try {
    if (shouldRunReflection(ctx.db, ctx.project)) {
      runBatchReflection(ctx.db, ctx.project, input.session_id);
    }
  } catch { /* non-fatal */ }

  // Session messages consumer — read pending messages from the Angel
  // NOTE: Messages are marked delivered AFTER confirmed injection (below),
  // not here. Budget gating could drop extraContent, causing message loss.
  let angelMessages = '';
  let pendingMessageIds: number[] = [];
  try {
    const pending = getPendingMessages(ctx.db, input.session_id);
    if (pending.length > 0) {
      const parts = pending.map(m => {
        const prefix = m.priority === 'urgent' ? '**[URGENT]** ' : '';
        return `${prefix}${m.content}`;
      });
      angelMessages = `## Angel Messages\n${parts.join('\n\n')}`;
      pendingMessageIds = pending.map(m => m.id);
    }
  } catch { /* non-fatal */ }

  // 3.6 Domain advisory — inject warning when correction rate is high for current topic
  let domainAdvisory = '';
  try {
    const thread = getThreadState(ctx.db, input.session_id);
    if (thread?.topic) {
      const domain = extractDomain(thread.topic);
      if (domain) {
        const advisory = generateDomainAdvisory(ctx.db, ctx.project, domain);
        if (advisory) {
          domainAdvisory = advisory;
        }
      }
    }

    // On assembly turns, surface all weak domains (not just current topic's)
    if (isPostCompaction || topicShift?.shifted) {
      const weakDomains = getWeakDomains(ctx.db, ctx.project);
      if (weakDomains.length > 0) {
        const currentDomain = thread?.topic ? extractDomain(thread.topic) : null;
        const otherWeak = weakDomains.filter(d => d.domain !== currentDomain);
        if (otherWeak.length > 0) {
          const lines = otherWeak.map(d => {
            const pct = Math.round(d.correction_rate * 100);
            return `- **${d.domain}**: ${pct}% correction rate (${d.corrections}/${d.total_interactions})`;
          });
          domainAdvisory += (domainAdvisory ? '\n\n' : '') +
            `## Known Weak Areas\n${lines.join('\n')}`;
        }
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

  // Combine cross-session context + angel messages + domain advisory + assembly output.
  // Trim to respect injection budget — cross-session/advisory content must not exceed
  // the remaining budget after assembly has done its work.
  const extraContent = [angelMessages, crossSessionContext, domainAdvisory].filter(Boolean).join('\n\n');
  let combinedContent = payload.content || '';
  if (extraContent) {
    const budgetTokens = ctx.config.injection.budget_tokens;
    const extraTokens = Math.ceil(extraContent.length / 4); // rough token estimate
    const payloadTokens = payload.tokenEstimate;
    if (payloadTokens + extraTokens <= budgetTokens) {
      combinedContent = [extraContent, combinedContent].filter(Boolean).join('\n\n');
      // Mark Angel messages as delivered only AFTER confirmed injection
      if (pendingMessageIds.length > 0) {
        try { markMessagesDelivered(ctx.db, pendingMessageIds); } catch { /* non-fatal */ }
      }
    }
    // else: skip extra content to stay within budget — messages NOT marked delivered
  }

  if (combinedContent) {
    // Commit deferred side effects — experience pattern trigger counts, flags, etc.
    // Only now, after confirming the payload will be injected into context.
    try { payload.commitEffects?.(); } catch { /* non-fatal */ }

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: combinedContent,
      },
    };
  }
  return {};
});

main();
