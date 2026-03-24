/**
 * Stop hook -> after_turn event.
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
import {
  captureDecisionsWithClassifier,
  captureInsightsAsLearnings,
  trackAfterTurn,
  storeConversationTurn,
  checkpointIfThresholdMet,
  captureRecallFlowEntry,
  detectIdleSession,
} from '../shared/lifecycle.js';
import { routeByContent, buildProjectIndex } from '../../shared/content-router.js';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionEvents, synthesizeSessionSummary, saveSessionSummary, recordEvent } from '../../core/session-events.js';
import { processRetrievalFeedback, applySessionSuccessBonus } from '../../intelligence/retrieval-feedback.js';
import { getExperienceFlags } from '../../intelligence/experience-flags.js';
import { recordDomainInteraction, extractDomain } from '../../intelligence/capability-tracker.js';
import { incrementVerificationCount, pruneDeadPatterns, updatePatternScore } from '../../intelligence/experience-patterns.js';
import { applyExperienceFeedback } from '../../intelligence/experience-scoring.js';
import { getThreadState } from '../../core/thread.js';
import { linkArtifactToRelated } from '../../core/artifacts.js';
import { decayActivationScores } from '../../core/hybrid-retrieval.js';
import { penalizeUnreferencedArtifacts } from '../../intelligence/retrieval-feedback.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { embedText, embedJournalEntry } from '../../embeddings/embed-pipeline.js';
import { upsertConversationEmbedding } from '../../embeddings/qdrant-client.js';
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
  runHookStep('store_conversation_turn', () => {
    storeConversationTurn(ctx.db, input.session_id, routedProject, lastUserText, lastAssistantText);
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
  } catch { /* non-fatal */ }

  // Embed thread summary
  try {
    const thread = getThreadState(ctx.db, input.session_id);
    if (thread?.summary) {
      const embedding = await embedText(thread.summary);
      if (embedding) {
        const blob = Buffer.from(new Float32Array(embedding).buffer);
        ctx.db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?')
          .run(blob, input.session_id);
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
  //   1. Increment verification_count (→ verified at 2, gets 1.5x boost)
  //   2. Increment helpful_count via updatePatternScore(+1) (→ ACE ranking)
  // This teaches the system which patterns are useful.
  runHookStep('pattern_verification', () => {
    const flags = getExperienceFlags(ctx.db, input.session_id);
    if (!flags.correction_flagged && flags.injected_pattern_ids?.length > 0) {
      for (const pid of flags.injected_pattern_ids) {
        incrementVerificationCount(ctx.db, pid);
        updatePatternScore(ctx.db, pid, 1); // +1 score, +1 helpful_count
      }
    }
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
      await embedJournalEntry(ctx.db, entry.id, entry.content, entry.recall_text ?? undefined, {
        project: entry.project,
        session_id: input.session_id,
        entry_type: entry.entry_type,
      });
    }
  } catch { /* non-fatal */ }

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

  const warnings = [gateWarning, idleWarning].filter(Boolean).join('\n\n');
  if (warnings) {
    return { systemMessage: warnings };
  }

  return {};
});

main();
