/**
 * Stop hook -> after_turn event.
 *
 * B7: Must use command-type (wrapHook), NOT agent-type.
 * Agent-type hooks silently fail on Stop events (CC #40010).
 *
 * MECHANICAL operations only — fast, deterministic, no LLM calls:
 *   Decision capture, thread tracking, conversation turn storage,
 *   checkpoint check, retrieval feedback, activation decay, session summary.
 *
 * REFLECTIVE operations moved to Angel (src/angel/):
 *   Experience pattern extraction, structured failure analysis, tip/strategy creation,
 *   causal attribution, contrastive extraction. The Angel sees full conversations
 *   holistically — hooks only see 2-second snapshots.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import { updateRecallText } from '../../core/journal.js';
import {
  captureDecisionsWithClassifier,
  captureInsightsAsLearnings,
  trackAfterTurn,
  storeConversationTurn,
  updateConversationTurnAssistant,
  checkpointIfThresholdMet,
  captureRecallFlowEntry,
  detectIdleSession,
} from '../shared/lifecycle.js';
import { routeByContent, buildProjectIndex, type ProjectSignature } from '../../shared/content-router.js';
import { detectProjectScope, registerProject } from '../../shared/scope-detector.js';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionEvents, synthesizeSessionSummary, saveSessionSummary, recordEvent } from '../../core/session-events.js';
import { processRetrievalFeedback, applySessionSuccessBonus, recordWasReferenced } from '../../intelligence/retrieval-feedback.js';
import { getExperienceFlags } from '../../intelligence/experience-flags.js';
import { recordDomainInteraction, extractDomain } from '../../intelligence/capability-tracker.js';
import {
  incrementVerificationCount, pruneDeadPatterns, updatePatternScore,
  computeConfidence, checkMaturityPromotion, shouldInvertToWarning,
  updatePatternConfidence, promotePatternMaturity, invertToWarning,
  decayPatternConfidence, escalatePattern, type ExperiencePattern,
} from '../../intelligence/experience-patterns.js';
import { applyExperienceFeedback } from '../../intelligence/experience-scoring.js';
import { getThreadState } from '../../core/thread.js';
import { linkArtifactToRelated } from '../../core/artifacts.js';
import { decayActivationScores } from '../../core/hybrid-retrieval.js';
import { penalizeUnreferencedArtifacts } from '../../intelligence/retrieval-feedback.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { embedText, embedJournalEntry } from '../../embeddings/embed-pipeline.js';
import { upsertConversationEmbedding, upsertThreadEmbedding } from '../../embeddings/qdrant-client.js';
import {
  updateTemporalProfile,
  updateActionTransitions,
  recordPredictionAccuracy,
  determineActualIntent,
} from '../../intelligence/intent-predictor.js';
import { getPolicy } from '../../intelligence/policy-registry.js';
import { advanceTTL, resetTTL } from '../../intelligence/critical-reminders.js';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Hook step runner — eliminates repeated try/catch boilerplate.
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

  // Auto-register unregistered projects discovered via content routing.
  // When work is rerouted to a project that exists on disk but isn't in projects.json,
  // register it so future sessions can find its path for handoff routing.
  if (routedProject !== ctx.project) {
    runHookStep('auto_register_project', () => {
      const sig = projectIndex.find((p: ProjectSignature) => p.id === routedProject);
      if (sig?.fullPath && detectProjectScope(sig.fullPath) === null) {
        registerProject(routedProject, sig.fullPath);
      }
    }, ctx.db, input.session_id);
  }

  // Each operation isolated — if A fails, B and C still run

  // Decision capture with optional embedding classifier
  const turnStartEpoch = Math.floor(Date.now() / 1000) - 2;
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

  // Record captured decisions as session events
  runHookStep('decision_events', () => {
    const newDecisions = cachedPrepare(ctx.db,
      `SELECT content, source FROM decisions
       WHERE session_id = ? AND timestamp_epoch >= ?
       ORDER BY timestamp_epoch DESC LIMIT 10`
    ).all(input.session_id, turnStartEpoch) as Array<{ content: string; source: string }>;
    for (const d of newDecisions) {
      recordEvent(ctx.db, input.session_id, routedProject, 'decision', d.source, 'decided', d.content.slice(0, 200));
    }
  }, ctx.db, input.session_id);

  // Insight extraction
  try {
    if (lastAssistantText) {
      await captureInsightsAsLearnings(ctx.db, input.session_id, routedProject, lastAssistantText);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/insight_extraction', e);
  }

  // Thread tracking
  runHookStep('track_after_turn', () => {
    trackAfterTurn(ctx.db, input.session_id, lastUserText, lastAssistantText);
  }, ctx.db, input.session_id);

  // Store conversation turn + dual-write embedding (SQLite BLOB + Qdrant)
  // Split-write: UserPromptSubmit creates the row with user_text,
  // Stop completes it with assistant_text. Fallback: insert new row if no pending turn.
  runHookStep('store_conversation_turn', () => {
    if (lastAssistantText) {
      const updated = updateConversationTurnAssistant(ctx.db, input.session_id, lastAssistantText);
      if (!updated) {
        // No pending turn from UserPromptSubmit — create a full turn (fallback)
        storeConversationTurn(ctx.db, input.session_id, routedProject, undefined, lastAssistantText);
      }
    }
    // Note: CC's Stop hook does NOT receive user text (only last_assistant_message).
    // User text is stored by UserPromptSubmit via the split-write pattern.
  }, ctx.db, input.session_id);

  try {
    const turnText = [lastUserText, lastAssistantText].filter(Boolean).join('\n\n');
    if (turnText.length > 20) {
      const toEmbed = turnText.substring(0, 2000);
      const turnEmbedding = await embedText(toEmbed);
      if (turnEmbedding) {
        const blob = Buffer.from(new Float32Array(turnEmbedding).buffer);
        const latestTurn = cachedPrepare(ctx.db,
          `SELECT id, turn_number FROM conversation_turns
           WHERE session_id = ? ORDER BY id DESC LIMIT 1`
        ).get(input.session_id) as { id: number; turn_number: number } | undefined;

        if (latestTurn) {
          cachedPrepare(ctx.db,
            `UPDATE conversation_turns SET embedding = ? WHERE id = ?`
          ).run(blob, latestTurn.id);

          await upsertConversationEmbedding(latestTurn.id, turnEmbedding, {
            turn_id: latestTurn.id,
            session_id: input.session_id,
            project: routedProject,
            turn_number: latestTurn.turn_number,
            timestamp_epoch: Math.floor(Date.now() / 1000),
            user_text_preview: (lastUserText ?? '').slice(0, 200),
            assistant_text_preview: (lastAssistantText ?? '').slice(0, 200),
          });
        }
      }
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/conversation_embedding', e);
  }

  // Embed thread summary — dual-write to SQLite BLOB + Qdrant claudex_threads
  try {
    const thread = getThreadState(ctx.db, input.session_id);
    if (thread?.summary) {
      const embedding = await embedText(thread.summary);
      if (embedding) {
        const blob = Buffer.from(new Float32Array(embedding).buffer);
        ctx.db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?')
          .run(blob, input.session_id);

        // Push to Qdrant for cross-session semantic thread search
        const pushed = await upsertThreadEmbedding(input.session_id, embedding, {
          project: routedProject,
          topic: thread.topic ?? '',
          summary: thread.summary.slice(0, 500),
          timestamp_epoch: Math.floor(Date.now() / 1000),
        });
        if (pushed) {
          ctx.db.prepare('UPDATE thread_state SET qdrant_synced = 1 WHERE session_id = ?')
            .run(input.session_id);
        }
      }
    }
  } catch { /* non-fatal */ }

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

  // Retrieval feedback — score recently-active artifacts based on assistant reference
  try {
    if (lastAssistantText) {
      const recentArtifacts = cachedPrepare(ctx.db,
        `SELECT id, summary FROM artifacts
         WHERE project = ? AND state IN ('fresh', 'materialized')
         ORDER BY timestamp_epoch DESC LIMIT 15`
      ).all(routedProject) as Array<{ id: number; summary: string }>;

      if (recentArtifacts.length > 0) {
        const flags = getExperienceFlags(ctx.db, input.session_id);
        processRetrievalFeedback(
          ctx.db,
          recentArtifacts.map(r => r.id),
          lastAssistantText,
          flags.correction_flagged,
          new Map(recentArtifacts.map(r => [r.id, r.summary])),
          input.session_id,
        );
      }
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/retrieval_feedback', e);
  }

  // Record was_referenced for unscored retrieval events — Phase 14 negative learning.
  // Checks if artifact summary tokens appear in session assistant text.
  // Must run AFTER conversation turns are stored (above) so assistant text is available.
  runHookStep('record_was_referenced', () => {
    recordWasReferenced(ctx.db, input.session_id);
  }, ctx.db, input.session_id);

  // Capability boundary tracking — record domain interaction
  runHookStep('capability_tracking', () => {
    const thread = getThreadState(ctx.db, input.session_id);
    if (thread?.topic) {
      const domain = extractDomain(thread.topic);
      if (domain) {
        const flags = getExperienceFlags(ctx.db, input.session_id);
        recordDomainInteraction(ctx.db, routedProject, domain, flags.correction_flagged);
      }
    }
  }, ctx.db, input.session_id);

  // Pattern verification + helpful scoring — MECHANICAL feedback loop.
  // If patterns were injected this turn and no correction followed:
  //   1. Increment verification_count (-> verified at 2, gets 1.5x boost)
  //   2. Increment helpful_count via updatePatternScore(+1) (-> ACE ranking)
  //   3. Update confidence (Laplace smoothing) and check maturity promotion (Phase 15)
  // If correction WAS flagged:
  //   4. Apply 4x harmful multiplier to score (Phase 15) — via policy.evaluatePattern()
  //   5. Check anti-pattern inversion for persistently harmful patterns (Phase 15)
  // This teaches the system which patterns are useful.
  runHookStep('pattern_verification', () => {
    const policy = getPolicy();
    const flags = getExperienceFlags(ctx.db, input.session_id);
    const triggeredIds: string[] = [];

    if (flags.injected_pattern_ids?.length > 0) {
      for (const pid of flags.injected_pattern_ids) {
        triggeredIds.push(pid);

        if (!flags.correction_flagged) {
          // Helpful path: no correction -> pattern was useful
          // Note: times_useful is incremented by the deferred awaiting_feedback path
          // in experience-scoring.ts on the NEXT turn. Don't double-count here.
          // The display (sections.ts) uses helpful_count, not times_useful.
          incrementVerificationCount(ctx.db, pid);
          updatePatternScore(ctx.db, pid, 1); // +1 score, +1 helpful_count
        } else {
          // Harmful path: correction detected -> 4x harmful multiplier (via policy)
          updatePatternScore(ctx.db, pid, -4); // -4 score, +1 harmful_count
          escalatePattern(ctx.db, pid); // Check if harmful_count triggers escalation
        }

        // Recompute confidence and check maturity promotion via policy
        const row = cachedPrepare(ctx.db,
          `SELECT helpful_count, harmful_count, times_triggered, verification_count,
                  maturity, confidence FROM experience_patterns WHERE id = ?`
        ).get(pid) as Pick<ExperiencePattern, 'helpful_count' | 'harmful_count' | 'times_triggered' | 'verification_count' | 'maturity' | 'confidence'> | undefined;

        if (row) {
          // Update confidence via Laplace smoothing
          const newConfidence = computeConfidence(row.helpful_count, row.harmful_count);
          updatePatternConfidence(ctx.db, pid, newConfidence);

          // Delegate promotion/inversion decision to memory policy
          const patternAction = policy.evaluatePattern(
            row.helpful_count,
            row.harmful_count,
            row.times_triggered,
            row.verification_count,
            row.maturity || 'candidate',
          );

          if (patternAction === 'promote') {
            // Determine promotion target from current maturity
            const promotion = checkMaturityPromotion(row as ExperiencePattern);
            if (promotion) {
              promotePatternMaturity(ctx.db, pid, promotion);
            }
          } else if (patternAction === 'invert') {
            invertToWarning(ctx.db, pid);
          }
        }
      }
    }

    // Slow confidence decay for non-triggered patterns (0.995x per turn)
    decayPatternConfidence(ctx.db, triggeredIds);
  }, ctx.db, input.session_id);

  // Experience scoring — full feedback loop (extraction, topic-aware scoring, flag rotation).
  // Runs AFTER pattern_verification (which reads injected_pattern_ids for current turn)
  // because the finally block in applyExperienceFeedback rotates injected → awaiting.
  try {
    await applyExperienceFeedback(
      ctx.db,
      input.session_id,
      lastAssistantText,
      lastUserText,
      routedProject,
      ctx.config,
    );
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/experience_feedback', e);
  }

  // Prune dead patterns — remove patterns scored to 0 (ExpeL "die at 0" rule)
  runHookStep('prune_dead_patterns', () => {
    pruneDeadPatterns(ctx.db);
  }, ctx.db, input.session_id);

  // Session success bonus — once per session, boost retrieval scores for non-corrected sessions
  runHookStep('session_success_bonus', () => {
    const flags = getExperienceFlags(ctx.db, input.session_id);
    if (!flags.correction_flagged) {
      // Guard: use session_events to prevent double-application (not checkpoint_tracking)
      const guard = cachedPrepare(ctx.db,
        `SELECT id FROM session_events WHERE session_id = ? AND event_type = 'session_success_bonus' LIMIT 1`
      ).get(input.session_id) as { id: number } | undefined;
      if (guard) return;

      const activeArtifacts = cachedPrepare(ctx.db,
        `SELECT id FROM artifacts
         WHERE project = ? AND state IN ('fresh', 'materialized')
         ORDER BY timestamp_epoch DESC LIMIT 20`
      ).all(routedProject) as Array<{ id: number }>;
      if (activeArtifacts.length > 0) {
        applySessionSuccessBonus(ctx.db, activeArtifacts.map(a => a.id));
        recordEvent(ctx.db, input.session_id, routedProject, 'session_success_bonus', 'system', 'applied',
          `${activeArtifacts.length} artifacts boosted`);
      }
    }
  }, ctx.db, input.session_id);

  // B4: Duplicate compaction agent detection — log-only telemetry.
  // Duplicate compaction agents can consume up to 65% of session quota.
  // Heuristic: cache_creation_input_tokens > 200K in a single stop event is anomalous.
  runHookStep('duplicate_compaction_detection', () => {
    const usage = input.usage as Record<string, unknown> | undefined;
    if (!usage) return;
    const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
    if (cacheCreation > 200_000) {
      recordEvent(ctx.db, input.session_id, routedProject,
        'duplicate_compaction_detected', 'stop', 'warning',
        JSON.stringify({
          cache_creation_input_tokens: cacheCreation,
          input_tokens: Number(usage.input_tokens ?? 0),
          output_tokens: Number(usage.output_tokens ?? 0),
        }),
      );
    }
  }, ctx.db, input.session_id);

  // Load session events ONCE — shared across summary, recall, and idle detection
  let sessionEvents: import('../../core/session-events.js').SessionEvent[] = [];
  try {
    sessionEvents = getSessionEvents(ctx.db, input.session_id);
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/load_events', e);
  }

  // Session summary synthesis
  try {
    const summary = synthesizeSessionSummary(sessionEvents);
    if (summary) {
      saveSessionSummary(ctx.db, input.session_id, summary);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/session_summary', e);
  }

  // Recall flow entry at boundaries
  const hasRecentTopicShift = sessionEvents.some(e =>
    e.event_type === 'topic_shift' &&
    e.timestamp_epoch > Math.floor(Date.now() / 1000) - 120
  );
  const hasCompaction = sessionEvents.some(e => e.event_type === 'compaction');
  if (hasRecentTopicShift || hasCompaction) {
    runHookStep('recall_flow', () => {
      captureRecallFlowEntry(ctx.db, input.session_id, routedProject, sessionEvents);
    }, ctx.db, input.session_id);
  }

  // Idle session detection
  let idleWarning = '';
  try {
    if (detectIdleSession(ctx.db, input.session_id, sessionEvents)) {
      idleWarning = '## Session Idle\nBack-to-back compactions detected with minimal work between them. Consider running `/endsession` to preserve session state.';
    }
  } catch { /* non-throwing */ }

  // Embed recent journal entries
  try {
    const unembedded = cachedPrepare(ctx.db,
      `SELECT id, content, recall_text, project, entry_type FROM session_journal
       WHERE session_id = ? AND embedding IS NULL
       ORDER BY id DESC LIMIT 10`
    ).all(input.session_id) as Array<{
      id: number; content: string; recall_text: string | null;
      project: string; entry_type: string;
    }>;
    for (const entry of unembedded) {
      // Backfill recall_text for entries missing it — extract key terms from content
      if (!entry.recall_text && entry.content) {
        const words = entry.content.split(/[\s_\-/.,;:!?()[\]{}]+/).filter(w => w.length >= 4);
        const unique = [...new Set(words.map(w => w.toLowerCase()))].slice(0, 8);
        if (unique.length >= 2) {
          updateRecallText(ctx.db, entry.id, unique.join(' | '));
          entry.recall_text = unique.join(' | ');
        }
      }
      await embedJournalEntry(ctx.db, entry.id, entry.content, entry.recall_text ?? undefined, {
        project: entry.project,
        session_id: input.session_id,
        entry_type: entry.entry_type,
      });
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/journal_embedding', e);
  }

  // Artifact linking — link recent unlinked artifacts to related ones
  try {
    const unlinked = cachedPrepare(ctx.db,
      `SELECT a.id FROM artifacts a
       LEFT JOIN artifact_links al ON al.source_id = a.id
       WHERE a.project = ? AND a.embedding IS NOT NULL AND al.source_id IS NULL
       ORDER BY a.id DESC LIMIT 5`
    ).all(routedProject) as Array<{ id: number }>;
    for (const a of unlinked) {
      await linkArtifactToRelated(ctx.db, a.id, routedProject);
    }
  } catch { /* non-fatal */ }

  // Activation decay
  runHookStep('activation_decay', () => {
    decayActivationScores(ctx.db, routedProject);
  }, ctx.db, input.session_id);

  // Penalize unreferenced artifacts
  runHookStep('penalize_unreferenced', () => {
    penalizeUnreferencedArtifacts(ctx.db, routedProject);
  }, ctx.db, input.session_id);

  // === Phase 19: Temporal profile + action transitions + prediction accuracy ===
  // These run at the END after all other phases' sections.

  // Update temporal profile — records session time slot for future prediction
  runHookStep('temporal_profile', () => {
    updateTemporalProfile(ctx.db, routedProject, input.session_id);
  }, ctx.db, input.session_id);

  // Update action transitions — Markov chain for next-action prediction
  runHookStep('action_transitions', () => {
    updateActionTransitions(ctx.db, routedProject, input.session_id);
  }, ctx.db, input.session_id);

  // Record prediction accuracy — compares session-start prediction with actual intent
  runHookStep('prediction_accuracy', () => {
    // Check if a prediction was recorded at session-start
    const predictionEvent = cachedPrepare(ctx.db,
      `SELECT action, detail FROM session_events
       WHERE session_id = ? AND event_type = 'intent_prediction'
       LIMIT 1`
    ).get(input.session_id) as { action: string; detail: string | null } | undefined;

    if (predictionEvent) {
      const actualIntent = determineActualIntent(ctx.db, input.session_id);
      const predictedIntent = predictionEvent.action;

      // Check if predicted context was referenced in assistant responses
      let wasReferenced = false;
      try {
        const detail = predictionEvent.detail ? JSON.parse(predictionEvent.detail) : {};
        const predTopic = (detail.topic ?? '').toLowerCase();
        if (predTopic.length > 5) {
          const turns = cachedPrepare(ctx.db,
            `SELECT assistant_text FROM conversation_turns
             WHERE session_id = ? AND assistant_text IS NOT NULL
             LIMIT 5`
          ).all(input.session_id) as Array<{ assistant_text: string }>;
          // Simple check: any assistant text references the predicted topic?
          const topicWords = predTopic.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
          for (const turn of turns) {
            const lower = turn.assistant_text.toLowerCase();
            if (topicWords.some(w => lower.includes(w))) {
              wasReferenced = true;
              break;
            }
          }
        }
      } catch { /* non-fatal */ }

      recordPredictionAccuracy(
        ctx.db, input.session_id, routedProject,
        predictedIntent, actualIntent, wasReferenced,
      );
    }
  }, ctx.db, input.session_id);

  // ---------------------------------------------------------------------------
  // Critical Reminders: deterministic meta-rule enforcement (Phase 2)
  // These are behavioral checks that would degrade into ceremonial compliance
  // if injected as prompt text. Enforced as hook-level warnings instead.
  // ---------------------------------------------------------------------------

  let readBeforeEditWarning = '';
  runHookStep('read_before_edit_check', () => {
    const edits = cachedPrepare(ctx.db,
      `SELECT DISTINCT entity FROM session_events
       WHERE session_id = ? AND event_type = 'file' AND action = 'edit'`
    ).all(input.session_id) as Array<{ entity: string }>;

    for (const edit of edits) {
      const readExists = cachedPrepare(ctx.db,
        `SELECT 1 FROM session_events
         WHERE session_id = ? AND event_type = 'file' AND action = 'read' AND entity = ?
         LIMIT 1`
      ).get(input.session_id, edit.entity);
      if (!readExists) {
        readBeforeEditWarning = `## Behavioral Warning\nFile "${edit.entity}" was edited without being read first this session. Read before editing to understand existing code.`;
        break;
      }
    }
  }, ctx.db, input.session_id);

  let testWarning = '';
  runHookStep('tests_before_done_check', () => {
    const stopReason = (input.stop_reason as string) ?? '';
    if (stopReason !== 'end_turn') return;

    const hasTests = cachedPrepare(ctx.db,
      `SELECT 1 FROM session_events
       WHERE session_id = ? AND event_type = 'command'
         AND (entity LIKE '%test%' OR entity LIKE '%vitest%')
       LIMIT 1`
    ).get(input.session_id);

    const hasEdits = cachedPrepare(ctx.db,
      `SELECT 1 FROM session_events
       WHERE session_id = ? AND event_type = 'file' AND action IN ('edit', 'write')
       LIMIT 1`
    ).get(input.session_id);

    if (hasEdits && !hasTests) {
      testWarning = '## Behavioral Warning\nCode was modified this session but no tests were run. Consider running tests before concluding.';
    }
  }, ctx.db, input.session_id);

  // Leitner feedback loop — advance or reset TTL on critical rules based on session compliance.
  // Rules injected this session (last_injected_turn > 0) get Leitner advancement if no violations
  // were detected, or reset if corrections/violations occurred.
  runHookStep('leitner_feedback', () => {
    const leitnerFlags = getExperienceFlags(ctx.db, input.session_id);
    // Find critical rules that were injected during this session
    const injectedRules = cachedPrepare(ctx.db,
      `SELECT id FROM critical_rules
       WHERE project = ? AND last_injected_turn IS NOT NULL AND last_injected_turn > 0`
    ).all(routedProject) as Array<{ id: number }>;

    for (const rule of injectedRules) {
      if (leitnerFlags.correction_flagged) {
        resetTTL(ctx.db, rule.id);
      } else {
        advanceTTL(ctx.db, rule.id);
      }
    }
  }, ctx.db, input.session_id);

  // Build gate warning
  let gateWarning = '';
  try {
    const srcDir = path.join(input.cwd, 'src', 'adapters', 'cc-hooks');
    const distDir = path.join(input.cwd, 'dist', 'adapters', 'cc-hooks');
    if (fs.existsSync(srcDir) && fs.existsSync(distDir)) {
      const srcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'));
      let newestSrc = 0;
      for (const f of srcFiles) {
        try {
          const mt = fs.statSync(path.join(srcDir, f)).mtimeMs;
          if (mt > newestSrc) newestSrc = mt;
        } catch { /* skip */ }
      }
      const distFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.cjs'));
      let newestDist = 0;
      for (const f of distFiles) {
        try {
          const mt = fs.statSync(path.join(distDir, f)).mtimeMs;
          if (mt > newestDist) newestDist = mt;
        } catch { /* skip */ }
      }
      if (newestSrc > newestDist + 1000) {
        gateWarning = '## Workflow Warning\nHook source files are newer than dist/ — run `bun run build && bun run setup` before ending the session.';
      }
    }
  } catch { /* non-throwing */ }

  const warnings = [gateWarning, idleWarning, readBeforeEditWarning, testWarning].filter(Boolean).join('\n\n');
  if (warnings) {
    return { systemMessage: warnings };
  }

  return {};
});

main();
