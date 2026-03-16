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
import {
  createPattern,
  classifyPatternScope,
  updatePatternScore,
  incrementUsefulCount,
} from '../../intelligence/experience-patterns.js';
import { detectEnrichmentProvider } from '../../intelligence/enrichment.js';
import { getExperienceFlags, setExperienceFlags } from '../../intelligence/experience-flags.js';
import { extractPatternFromAssistantText } from '../../intelligence/correction-detection.js';
import { tokenizeQuery } from '../../shared/search-utils.js';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Hook step runner — eliminates repeated try/catch boilerplate (O28).
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

  // ---------------------------------------------------------------------------
  // Experience pattern extraction + score feedback
  // ---------------------------------------------------------------------------
  let expFlags = {
    correction_flagged: false,
    injected_pattern_ids: [] as string[],
    injected_topic_keys: [] as string[],
    awaiting_feedback_ids: [] as string[],
    awaiting_topic_keys: [] as string[],
    correction_prompt: '',
  };
  let flagsReadOk = false;
  try {
    expFlags = getExperienceFlags(ctx.db, input.session_id);
    flagsReadOk = true;
    const {
      correction_flagged,
      awaiting_feedback_ids,
      awaiting_topic_keys,
      correction_prompt,
    } = expFlags;

    // 1. Pattern extraction — only when a correction was flagged this turn
    if (correction_flagged && lastAssistantText && lastUserText) {
      try {
        const extracted = extractPatternFromAssistantText(lastAssistantText, lastUserText);
        if (extracted) {
          // Detect enrichment provider for LLM-based scope classification (non-blocking)
          let enrichmentProvider: Awaited<ReturnType<typeof detectEnrichmentProvider>> = null;
          try {
            enrichmentProvider = await detectEnrichmentProvider(
              {
                baseUrl: ctx.config.enrichment.ollama_base_url,
                model: ctx.config.enrichment.ollama_model,
                enabled: ctx.config.enrichment.enabled,
              },
              CC_CAPABILITIES,
            );
          } catch {
            // Non-fatal — heuristic fallback handles this
          }

          // Classify scope: LLM → heuristic → default project-scoped
          const scopedProject = await classifyPatternScope(extracted, routedProject, enrichmentProvider);
          createPattern(ctx.db, extracted, input.session_id, scopedProject);
        }
      } catch (e) {
        emitErrorTelemetry(ctx.db, input.session_id, 'stop/exp_pattern_create', e);
      }
    }

    // 2. Topic-aware score feedback — score patterns from the PREVIOUS turn
    //    (awaiting_feedback_ids). These patterns were injected last turn; we now
    //    know whether the user corrected this turn.
    //
    //    When a correction IS detected, we compare the correction's topic words
    //    against each pattern's topic key. Only patterns whose topic overlaps
    //    the correction are penalised — unrelated patterns are skipped (no reward,
    //    no penalty) because we cannot confirm usefulness after a correction turn.
    //
    //    When NO correction is detected, all awaiting patterns are rewarded: the
    //    warning was shown and the user did not re-correct → it was useful.
    if (awaiting_feedback_ids.length > 0) {
      if (correction_flagged) {
        // Extract topic words from the stored correction prompt (set by
        // UserPromptSubmit when correction_flagged was raised).
        // Fall back to lastUserText when correction_prompt is absent (e.g.
        // older flags written before this field existed).
        const correctionSource = correction_prompt || lastUserText || '';
        const correctionWords = tokenizeQuery(correctionSource).slice(0, 5);

        for (let i = 0; i < awaiting_feedback_ids.length; i++) {
          try {
            const patternId = awaiting_feedback_ids[i];
            const topicKey = awaiting_topic_keys[i] ?? '';
            const patternWords = topicKey.split('_').filter(Boolean);

            // Overlap check: at least one shared word between correction and pattern topic.
            const hasOverlap = correctionWords.some(w => patternWords.includes(w));

            if (hasOverlap) {
              // This pattern is related to the correction — penalise it.
              updatePatternScore(ctx.db, patternId, -1);
            }
            // else: no topic overlap — ExpeL neutral path.
            // We cannot determine whether this pattern was helpful or harmful this
            // turn: the correction is about a different topic, so the pattern's
            // injection was irrelevant to what the user is correcting. Skip entirely
            // (no penalty, no reward) to avoid corrupting score with noisy signal.
          } catch (e) {
            emitErrorTelemetry(ctx.db, input.session_id, 'stop/exp_score_feedback', e);
          }
        }
      } else {
        // No correction this turn — all awaiting patterns were useful.
        for (const patternId of awaiting_feedback_ids) {
          try {
            incrementUsefulCount(ctx.db, patternId);
            updatePatternScore(ctx.db, patternId, 1);
          } catch (e) {
            emitErrorTelemetry(ctx.db, input.session_id, 'stop/exp_score_feedback', e);
          }
        }
      }
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'stop/exp_flags', e);
  } finally {
    // 3. Promote this turn's injected patterns + topic keys to awaiting_feedback
    //    for next turn. Clear correction state and current-turn injection lists.
    //    Only runs when flags were successfully read — avoids overwriting valid
    //    awaiting_feedback_ids with stale defaults if getExperienceFlags threw.
    if (flagsReadOk) {
      try {
        setExperienceFlags(ctx.db, input.session_id, {
          correction_flagged: false,
          correction_prompt: '',
          injected_pattern_ids: [],
          injected_topic_keys: [],
          awaiting_feedback_ids: expFlags.injected_pattern_ids,
          awaiting_topic_keys: expFlags.injected_topic_keys,
        }, expFlags);
      } catch (e) {
        emitErrorTelemetry(ctx.db, input.session_id, 'stop/exp_flags_clear', e);
      }
    }
  }

  return {};
});

main();
