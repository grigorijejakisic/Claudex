/**
 * UserPromptSubmit hook -> before_prompt event.
 * Checks post-compaction, reads gauge, detects topic shift, assembles regular prompt.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { ensureAngelRunning } from './angel-launcher.js';
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
import { persistTopicIfShifted, ensureInitialTopic, captureFlowEntry, captureExplicitDecisions, captureUserFraming, storeConversationTurnUserText } from '../shared/lifecycle.js';
import { searchArtifactsGlobal, materializeArtifacts } from '../../core/artifacts.js';
import { findMatchingPatternsHybrid } from '../../intelligence/experience-patterns.js';
import { getCooldownState, setCooldownState } from '../../core/thread.js';
import { routeByContent, buildProjectIndex } from '../../shared/content-router.js';
import { setExperienceFlags, getExperienceFlags } from '../../intelligence/experience-flags.js';
import { detectCorrectionSignal } from '../../intelligence/correction-detection.js';
import { recordEvent } from '../../core/session-events.js';
import { findSimilarThreadsAsync } from '../../intelligence/thread-tracker.js';
import { parseWrappers } from '../../extraction/wrapper-parser.js';
import { shouldRunReflection, runBatchReflection } from '../../intelligence/batch-reflection.js';
import { extractDomain, generateDomainAdvisory, getWeakDomains } from '../../intelligence/capability-tracker.js';
import { getThreadState } from '../../core/thread.js';
import { getPendingMessages, markMessagesDelivered } from '../../angel/message-sender.js';
import { getActiveSignals, formatSignalsForInjection } from '../../core/session-signals.js';
import { autoNameSession } from '../../core/session-discovery.js';
import { acknowledgeTransfer } from '../../core/session-transfer.js';
import { classifyIntent, getRetrievalConfigForIntent } from '../../intelligence/intent-classifier.js';
import type { IntentType, RetrievalConfig } from '../../intelligence/intent-classifier.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { appendTurnToSessionFile, nowIso } from './session-writer.js';

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

  // Phase 13 Plan 01: per-turn fsync write of user turn to Sessions/ markdown.
  // Runs BEFORE Angel liveness so user turns are durable even if Angel is down.
  if (prompt) {
    try {
      const writeErr = appendTurnToSessionFile({
        cwd: input.cwd as string,
        sessionId: input.session_id as string,
        role: 'user',
        body: prompt,
        timestampIso: nowIso(),
      });
      if (writeErr) {
        emitErrorTelemetry(ctx.db, input.session_id, 'sessions_write_error', writeErr);
      }
    } catch { /* non-blocking — never fail the hook */ }
  }

  // Plan 04-06-03 (hook-driven Angel liveness) — each user turn verifies
  // Angel is alive and restarts if dead. This is the chosen recovery path in
  // place of a separate detached AngelSupervisor launcher process — see
  // SUMMARY.md decision record. The check is a cheap PID-file existence +
  // kill(pid, 0) probe when Angel is healthy; only on death do we pay the
  // spawn cost. Non-throwing: if Angel can't come up, the user turn still
  // assembles context normally.
  try {
    await ensureAngelRunning(ctx.db, input.session_id, ctx.project, /* isUserTurn */ true);
  } catch { /* Angel is optional */ }

  // Phase 6 EBD-02: heartbeat tick. Plan 04's boundary detector reads
  // sessions.last_heartbeat_ts to decide ALIVE/DORMANT/TERMINATED.
  // Best-effort: a DB lock or schema mismatch must NEVER fail the hook.
  try {
    const now = Math.floor(Date.now() / 1000);
    cachedPrepare(ctx.db,
      `UPDATE sessions SET last_heartbeat_ts = ? WHERE session_id = ?`
    ).run(now, input.session_id);
  } catch { /* swallow — column write is best-effort */ }

  // ---------------------------------------------------------------------------
  // Intent classification (Phase 18) — pure regex, <1ms, non-throwing.
  // Classified early so retrieval calls downstream can use intent-driven config.
  // ---------------------------------------------------------------------------
  let intentType: IntentType = 'continuation';
  let intentConfig: RetrievalConfig = getRetrievalConfigForIntent('continuation');
  if (prompt) {
    try {
      intentType = classifyIntent(prompt);
      intentConfig = getRetrievalConfigForIntent(intentType);
      // Store intent classification as session event for future analysis
      recordEvent(ctx.db, input.session_id, ctx.project, 'intent_classification', intentType, 'classified');
    } catch { /* non-throwing — use defaults */ }
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

  // Store user prompt as conversation turn (assistant_text added by Stop hook).
  // Split-write: survives power loss between UserPromptSubmit and Stop.
  if (prompt) {
    try {
      storeConversationTurnUserText(ctx.db, input.session_id, routedProject, prompt);
    } catch { /* non-throwing */ }
  }

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

  // Skip expensive operations post-compaction — SessionStart just did full assembly.
  // Materialization, experience patterns, cross-session linking, and batch reflection
  // are all redundant immediately after compaction.
  let hybridPatterns: Awaited<ReturnType<typeof findMatchingPatternsHybrid>> | undefined;
  if (!isPostCompaction) {
    // Materialize artifacts on assembly turns (topic shift) and
    // on regular turns when the prompt strongly matches high-importance artifacts.
    // Phase 18: intent-driven limit adjusts how many artifacts we materialize.
    if (topicShift?.shifted) {
      // Full materialization on topic-shift assembly turns
      try {
        const query = prompt || topicShift?.newTopic;
        if (query) {
          const materializeLimit = intentConfig.limit ?? 10;
          const matches = searchArtifactsGlobal(ctx.db, routedProject, query, materializeLimit);
          if (matches.length > 0) {
            materializeArtifacts(ctx.db, matches.map(a => a.id), ctx.project);
          }
        }
      } catch (e) {
        emitErrorTelemetry(ctx.db, input.session_id, 'artifact_materialize', e);
      }
    } else if (prompt && prompt.length >= 30) {
      // Lightweight importance probe on regular turns — only materialize
      // high-importance artifacts (decisions, learnings) that strongly match.
      // This catches cases where the user mentions a topic with existing artifacts
      // but the topic-shift detector didn't fire.
      try {
        const probeLimit = Math.min(intentConfig.limit ?? 5, 5);
        const probeResults = searchArtifactsGlobal(ctx.db, routedProject, prompt, probeLimit);
        const highImportance = probeResults.filter(a => a.importance >= 4);
        if (highImportance.length > 0) {
          materializeArtifacts(ctx.db, highImportance.map(a => a.id), ctx.project);
        }
      } catch { /* non-fatal — regular turn materialization is supplementary */ }
    }

    // ---------------------------------------------------------------------------
    // Experience pattern detection
    // ---------------------------------------------------------------------------

    // Run hybrid pattern search (FTS5 + Qdrant vector) on EVERY turn.
    // Previously only ran on assembly turns (post-compaction/topic-shift).
    // Vector search catches semantically similar patterns that keyword matching misses —
    // this is the primary fix for the "broad rules never surface" problem.
    // Results are passed to assembleRegularPrompt to avoid re-querying sync FTS5.
    if (prompt && prompt.length >= 20) {
      try {
        hybridPatterns = await findMatchingPatternsHybrid(ctx.db, prompt, routedProject, 5);
      } catch { /* non-fatal — FTS5 path is the safety net */ }
    }
  }

  // Reset correction flags at turn start — stale flags from a previous turn
  // must not leak into this turn's Stop hook processing (R6).
  setExperienceFlags(ctx.db, input.session_id, {
    correction_flagged: false,
    correction_prompt: '',
  });

  // Correction signal detection — flag the turn for Stop hook extraction.
  // Pattern matching and injection is handled exclusively by the assembler;
  // the hook only detects corrections to avoid double injection and inflated counts.
  // Strip system-injected tags before detection to prevent false positives
  // from <task-notification>, <system-reminder>, <experience-data> content.
  if (prompt) {
    try {
      const { organic: userText } = parseWrappers(prompt);
      const correctionFlagged = detectCorrectionSignal(userText);
      if (correctionFlagged) {
        setExperienceFlags(ctx.db, input.session_id, {
          correction_flagged: true,
          // Store the prompt text so Stop hook can extract topic words for
          // per-pattern scoring. Cap at 500 chars to bound storage size.
          correction_prompt: prompt.slice(0, 500),
        });
        // Record correction_detected event — consumed by Angel's pattern extractor
        // (measureSessionOutcome) and session summary synthesis.
        recordEvent(ctx.db, input.session_id, routedProject, 'correction_detected', 'user', 'corrected', prompt.slice(0, 200));
      }
    } catch (e) {
      emitErrorTelemetry(ctx.db, input.session_id, 'exp_correction_detect', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-session thread linking (4.3) + batch reflection
  // Skip post-compaction — SessionStart already has session continuity context.
  // ---------------------------------------------------------------------------
  let crossSessionContext = '';
  if (!isPostCompaction && prompt && !topicShift?.shifted) {
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
            const similarThreads = await findSimilarThreadsAsync(
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
  // Skip post-compaction — conflicts were resolved before compaction.
  if (!isPostCompaction) {
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
  }

  // Session messages consumer — read pending messages from the Angel
  // NOTE: Messages are marked delivered AFTER confirmed injection (below),
  // not here. Budget gating could drop extraContent, causing message loss.
  let angelMessages = '';
  let pendingMessageIds: number[] = [];
  try {
    const pending = getPendingMessages(ctx.db, input.session_id);
    if (pending.length > 0) {
      const angelParts: string[] = [];
      const sessionParts: string[] = [];
      for (const m of pending) {
        const prefix = m.priority === 'urgent' ? '**[URGENT]** ' : '';
        if (m.sender_type === 'session') {
          // Resolve sender to human-readable identity (name + project)
          let senderLabel = `Session ${m.sender.slice(0, 8)}`;
          try {
            const senderInfo = cachedPrepare(ctx.db,
              `SELECT name, project FROM sessions WHERE session_id = ?`
            ).get(m.sender) as { name: string | null; project: string | null } | undefined;
            if (senderInfo?.name) {
              const proj = senderInfo.project ? ` (${senderInfo.project})` : '';
              senderLabel = `Agent "${senderInfo.name}"${proj}`;
            }
          } catch { /* fallback to truncated ID */ }

          const typeLabel = m.message_type === 'request' ? 'asks'
            : m.message_type === 'response' ? 'replies'
            : m.message_type === 'transfer' ? 'transfers context'
            : m.message_type === 'acknowledge' ? 'confirms'
            : 'says';
          sessionParts.push(`${prefix}**${senderLabel}** ${typeLabel}: ${m.content}`);
          // Auto-acknowledge transfer messages (I-PASS read-back protocol)
          if (m.message_type === 'transfer') {
            acknowledgeTransfer(ctx.db, input.session_id, m.sender, 'Transfer received and injected.');
          }
        } else {
          angelParts.push(`${prefix}${m.content}`);
        }
      }
      const sections: string[] = [];
      if (sessionParts.length > 0) sections.push(`## Session Messages\n${sessionParts.join('\n\n')}`);
      if (angelParts.length > 0) sections.push(`## Angel Messages\n${angelParts.join('\n\n')}`);
      angelMessages = sections.join('\n\n');
      pendingMessageIds = pending.map(m => m.id);
    }
  } catch { /* non-fatal */ }

  // 3.6 Stigmergic signals — inject active cross-session signals
  let signalsSection = '';
  try {
    const signals = getActiveSignals(ctx.db, ctx.project, input.session_id);
    signalsSection = formatSignalsForInjection(signals);
  } catch { /* non-fatal */ }

  // 3.7 Auto-name session from thread topic (first time only)
  try {
    const thread = getThreadState(ctx.db, input.session_id);
    if (thread?.topic) {
      autoNameSession(ctx.db, input.session_id, thread.topic);
    }
  } catch { /* non-fatal */ }

  // 3.8 Domain advisory — inject warning when correction rate is high for current topic.
  // TTL: inject every 10 turns to avoid repeating identical advisory (~50-100 tokens/turn).
  // Always inject on topic shift or post-compaction (context boundaries).
  let domainAdvisory = '';
  try {
    const thread = getThreadState(ctx.db, input.session_id);
    const turnCount = (cachedPrepare(ctx.db,
      `SELECT COUNT(*) as cnt FROM conversation_turns WHERE session_id = ?`
    ).get(input.session_id) as { cnt: number })?.cnt ?? 0;
    const domainCooldownPassed = turnCount % 10 === 0 || isPostCompaction || topicShift?.shifted;

    if (thread?.topic && domainCooldownPassed) {
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
    hybridPatterns,
    classifiedIntent: intentType,
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
  const extraContent = [angelMessages, signalsSection, crossSessionContext, domainAdvisory].filter(Boolean).join('\n\n');
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

  // Phase 13 Plan 04: per-turn timestamp injection — keeps long sessions
  // timestamp-fresh so the agent can compute elapsed time across turns even
  // when the SessionStart injection has scrolled out of cache.
  const currentTimeLine = `**Current time:** ${nowIso()}`;
  combinedContent = combinedContent
    ? currentTimeLine + '\n\n' + combinedContent
    : currentTimeLine;

  // Commit deferred side effects — experience pattern trigger counts, flags, etc.
  // Only now, after confirming the payload will be injected into context.
  try { payload.commitEffects?.(); } catch { /* non-fatal */ }

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: combinedContent,
    },
  };
});

main();
