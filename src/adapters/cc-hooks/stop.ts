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
} from '../shared/lifecycle.js';
import { routeByContent, buildProjectIndex } from '../../shared/content-router.js';
import { applyExperienceFeedback } from '../../intelligence/experience-scoring.js';
import * as fs from 'fs';
import * as path from 'path';
import { getSessionEvents, synthesizeSessionSummary, saveSessionSummary, recordEvent } from '../../core/session-events.js';
import { processRetrievalFeedback } from '../../intelligence/retrieval-feedback.js';
import { getExperienceFlags } from '../../intelligence/experience-flags.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
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
        );
      }
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/retrieval_feedback', e);
  }

  // Pre-compute session summary from events (for next session's reconstruction)
  try {
    const events = getSessionEvents(ctx.db, input.session_id);
    const summary = synthesizeSessionSummary(events);
    if (summary) {
      saveSessionSummary(ctx.db, input.session_id, summary);
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/session_summary', e);
  }

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

  if (gateWarning) {
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: gateWarning,
      },
    };
  }

  return {};
});

main();
