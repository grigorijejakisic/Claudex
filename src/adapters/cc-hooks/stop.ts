/**
 * Stop hook -> after_turn event.
 * Captures decisions, extracts insights, tracks thread, checks checkpoint threshold.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import {
  captureDecisionsWithClassifier,
  captureInsightsAsLearnings,
  trackAfterTurn,
  checkpointIfThresholdMet,
  captureRecallFlowEntry,
  detectIdleSession,
} from '../shared/lifecycle.js';
import { routeByContent, buildProjectIndex } from '../../shared/content-router.js';
import { applyExperienceFeedback } from '../../intelligence/experience-scoring.js';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionEvents, synthesizeSessionSummary, saveSessionSummary, recordEvent } from '../../core/session-events.js';
import { processRetrievalFeedback, applySessionSuccessBonus } from '../../intelligence/retrieval-feedback.js';
import { getExperienceFlags } from '../../intelligence/experience-flags.js';
import { recordDomainInteraction, extractDomain, generateDomainAdvisory } from '../../intelligence/capability-tracker.js';
import { incrementVerificationCount, createTipAndStrategy } from '../../intelligence/experience-patterns.js';
import { getThreadState } from '../../core/thread.js';
import { linkArtifactToRelated } from '../../core/artifacts.js';
import { decayActivationScores } from '../../core/hybrid-retrieval.js';
import { penalizeUnreferencedArtifacts } from '../../intelligence/retrieval-feedback.js';
import { analyzeFailure, storeStructuredAnalysis } from '../../intelligence/structured-analysis.js';
import { findCausalEvent, storeCausalAttribution } from '../../intelligence/correction-detection.js';
import { shouldRunContrastiveExtraction, runContrastiveExtraction } from '../../intelligence/contrastive-extraction.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { embedText, embedJournalEntry } from '../../embeddings/embed-pipeline.js';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Hook step runner — eliminates repeated try/catch boilerplate.
// Synchronous steps only; async callers wrap their own try/catch.
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

  // Decision capture with optional embedding classifier (built fresh each invocation)
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

  // Record captured decisions as session events (for summary synthesis)
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

  // Insight extraction — analytical conclusions from assistant response
  runHookStep('insight_extraction', () => {
    if (lastAssistantText) {
      captureInsightsAsLearnings(ctx.db, input.session_id, routedProject, lastAssistantText);
    }
  }, ctx.db, input.session_id);

  // Thread tracking
  runHookStep('track_after_turn', () => {
    trackAfterTurn(ctx.db, input.session_id, lastUserText, lastAssistantText);
  }, ctx.db, input.session_id);

  // Embed thread summary (awaited — ephemeral process requires completion before exit)
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

  // Experience pattern extraction + score feedback + flag rotation
  await applyExperienceFeedback(
    ctx.db,
    input.session_id,
    lastAssistantText,
    lastUserText,
    routedProject,
    ctx.config,
  );

  // Retrieval feedback — score ALL recently-active artifacts, regardless of state.
  // Fresh artifacts (from recent tool use) and materialized artifacts (from triggers)
  // both appear in assembly output. Score them all based on whether the assistant
  // referenced their content.
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

  // Capability boundary tracking (3.6) — record domain interaction + correction rate
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

  // Verification gate (3.3) — if patterns were injected and no correction, increment verification
  runHookStep('pattern_verification', () => {
    const flags = getExperienceFlags(ctx.db, input.session_id);
    if (!flags.correction_flagged && flags.injected_pattern_ids) {
      try {
        const patternIds = JSON.parse(flags.injected_pattern_ids) as string[];
        for (const pid of patternIds) {
          incrementVerificationCount(ctx.db, pid);
        }
      } catch { /* non-fatal — injected_pattern_ids may not be valid JSON */ }
    }
  }, ctx.db, input.session_id);

  // Session success bonus — if no corrections this session, reward all recently-active artifacts.
  // Closes the retrieval feedback loop for the positive signal (applySessionSuccessBonus was
  // implemented but never wired — now connected).
  runHookStep('session_success_bonus', () => {
    const flags = getExperienceFlags(ctx.db, input.session_id);
    if (!flags.correction_flagged) {
      const activeArtifacts = cachedPrepare(ctx.db,
        `SELECT id FROM artifacts
         WHERE project = ? AND state IN ('fresh', 'materialized')
         ORDER BY timestamp_epoch DESC LIMIT 20`
      ).all(routedProject) as Array<{ id: number }>;
      if (activeArtifacts.length > 0) {
        applySessionSuccessBonus(ctx.db, activeArtifacts.map(a => a.id));
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

  // Pre-compute session summary from events (for next session's reconstruction)
  try {
    const summary = synthesizeSessionSummary(sessionEvents);
    if (summary) {
      saveSessionSummary(ctx.db, input.session_id, summary);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/session_summary', e);
  }

  // Capture enriched recall flow entry (heuristic tier) — only at boundaries
  // (topic shifts or compaction), not every turn, to avoid write amplification
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

  // Idle session detection — suggest /endsession when back-to-back compactions
  // with minimal work between them indicate the user walked away.
  let idleWarning = '';
  try {
    if (detectIdleSession(ctx.db, input.session_id, sessionEvents)) {
      idleWarning = '## Session Idle\nBack-to-back compactions detected with minimal work between them. Consider running `/endsession` to preserve session state.';
    }
  } catch { /* non-throwing */ }

  // Embed recent journal entries (awaited — ephemeral process requires completion before exit).
  // Batches all unembedded entries from this session instead of embedding inline in addJournalEntry.
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

  // ---------------------------------------------------------------------------
  // V9 Intelligence Wiring — semantic upgrade features that run at end-of-turn
  // ---------------------------------------------------------------------------

  // 3.1 Structured failure analysis — when correction detected, analyze it
  try {
    const flags = getExperienceFlags(ctx.db, input.session_id);
    if (flags.correction_flagged && lastUserText && lastAssistantText) {
      const analysis = await analyzeFailure(lastUserText, lastAssistantText);
      if (analysis) {
        // Find the most recent pattern created this session to attach analysis to
        const recentPattern = cachedPrepare(ctx.db,
          `SELECT id FROM experience_patterns WHERE source_session = ? ORDER BY created_at_epoch DESC LIMIT 1`
        ).get(input.session_id) as { id: string } | undefined;
        if (recentPattern) {
          storeStructuredAnalysis(ctx.db, recentPattern.id, analysis);
        }
      }
    }
  } catch { /* non-fatal */ }

  // 3.2 Tips/strategies — create both levels on correction
  // (applyExperienceFeedback already ran above and may have created patterns via createPattern.
  //  We check for fresh corrections and create the strategy-level duplicate.)
  try {
    const flags = getExperienceFlags(ctx.db, input.session_id);
    if (flags.correction_flagged && lastUserText) {
      // Find tip patterns created this turn (no strategy pair yet)
      const freshTips = cachedPrepare(ctx.db,
        `SELECT id, trigger_context, lesson, pattern_type, severity FROM experience_patterns
         WHERE source_session = ? AND abstraction_level = 'tip'
           AND created_at_epoch > ? ORDER BY created_at_epoch DESC LIMIT 3`
      ).all(input.session_id, Math.floor(Date.now() / 1000) - 30) as Array<{
        id: string; trigger_context: string; lesson: string;
        pattern_type: string; severity: string;
      }>;
      for (const tip of freshTips) {
        // Check if strategy already exists for this tip's lesson
        const hasStrategy = cachedPrepare(ctx.db,
          `SELECT 1 FROM experience_patterns WHERE source_session = ? AND abstraction_level = 'strategy'
           AND trigger_context = ? LIMIT 1`
        ).get(input.session_id, tip.trigger_context);
        if (!hasStrategy) {
          createTipAndStrategy(ctx.db, {
            pattern_type: tip.pattern_type as 'correction' | 'behavioral' | 'discovery',
            trigger_context: tip.trigger_context,
            lesson: tip.lesson,
            severity: tip.severity as 'critical' | 'important' | 'minor',
          }, input.session_id, routedProject);
        }
      }
    }
  } catch { /* non-fatal */ }

  // 3.7 Causal attribution — trace correction back to causing tool call
  try {
    const flags = getExperienceFlags(ctx.db, input.session_id);
    if (flags.correction_flagged && lastUserText) {
      const causalEvent = findCausalEvent(ctx.db, input.session_id, lastUserText);
      if (causalEvent) {
        const recentPattern = cachedPrepare(ctx.db,
          `SELECT id FROM experience_patterns WHERE source_session = ? ORDER BY created_at_epoch DESC LIMIT 1`
        ).get(input.session_id) as { id: string } | undefined;
        if (recentPattern) {
          storeCausalAttribution(ctx.db, recentPattern.id, causalEvent.id);
        }
      }
    }
  } catch { /* non-fatal */ }

  // 3.5 Contrastive extraction — every 10 sessions, compare success vs failure
  try {
    if (shouldRunContrastiveExtraction(ctx.db, routedProject)) {
      runContrastiveExtraction(ctx.db, routedProject, input.session_id);
    }
  } catch { /* non-fatal */ }

  // 4.1 Artifact linking — link recent unlinked artifacts to related ones
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

  // 2.4 Activation decay — decay scores for this project (lightweight, runs every turn)
  runHookStep('activation_decay', () => {
    decayActivationScores(ctx.db, routedProject);
  }, ctx.db, input.session_id);

  // 5.2 Penalize unreferenced artifacts — artifacts retrieved 3+ times but never used
  runHookStep('penalize_unreferenced', () => {
    penalizeUnreferencedArtifacts(ctx.db, routedProject);
  }, ctx.db, input.session_id);

  // Behavioral gate: check if hook source is newer than dist (edited but not rebuilt)
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
    // Stop hooks don't support hookSpecificOutput/additionalContext —
    // only UserPromptSubmit and PostToolUse do. Use top-level systemMessage instead.
    return { systemMessage: warnings };
  }

  return {};
});

main();
