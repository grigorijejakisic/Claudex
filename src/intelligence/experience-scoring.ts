/**
 * Experience pattern scoring — extracted from Stop hook for single-responsibility.
 *
 * Handles:
 *   1. Pattern extraction from correction signals
 *   2. Topic-aware score feedback (reward/penalise patterns from previous turn)
 *   3. Flag rotation (promote injected → awaiting, clear correction state)
 *
 * All operations are non-throwing — failures are logged to error telemetry
 * and the remaining steps continue.
 */

import type { Database } from 'better-sqlite3';
import type { ClaudexConfig } from '../shared/config.js';
import { CC_CAPABILITIES } from '../shared/constants.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';
import {
  createPattern,
  classifyPatternScope,
  updatePatternScore,
  incrementUsefulCount,
  escalatePattern,
} from './experience-patterns.js';
import { detectEnrichmentProvider } from './enrichment.js';
import { getExperienceFlags, setExperienceFlags, type ExperienceFlags } from './experience-flags.js';
import { extractPatternFromAssistantText, extractLessonFromUserCorrection, findCausalEvent, storeCausalAttribution } from './correction-detection.js';
import { tokenizeQuery } from '../shared/search-utils.js';

/**
 * Runs experience pattern extraction, score feedback, and flag rotation.
 *
 * Called by the Stop hook after all other lifecycle steps have completed.
 * Each sub-step is independently guarded so failures don't cascade.
 */
export async function applyExperienceFeedback(
  db: Database,
  sessionId: string,
  lastAssistantText: string | undefined,
  lastUserText: string | undefined,
  routedProject: string,
  config: ClaudexConfig,
): Promise<void> {
  let expFlags: ExperienceFlags = {
    correction_flagged: false,
    injected_pattern_ids: [] as string[],
    injected_topic_keys: [] as string[],
    awaiting_feedback_ids: [] as string[],
    awaiting_topic_keys: [] as string[],
    correction_prompt: '',
    pending_trigger_domains: [] as string[],
  };
  let flagsReadOk = false;

  try {
    expFlags = getExperienceFlags(db, sessionId);
    flagsReadOk = true;
    const {
      correction_flagged,
      awaiting_feedback_ids,
      awaiting_topic_keys,
      correction_prompt,
    } = expFlags;

    // 1. Pattern extraction — only when a correction was flagged this turn.
    //    Two-path extraction (Meta-Policy Reflexion / ExpeL inspired):
    //    PRIMARY: extract from user's correction text (most reliable — user
    //    literally states the lesson: "always use X", "never do Y")
    //    SUPPLEMENTARY: extract from assistant's response (self-reflective
    //    acknowledgement phrases like "the fix is...", "going forward...")
    if (correction_flagged && lastUserText) {
      try {
        // Primary: user correction — the user states the lesson directly
        let extracted = extractLessonFromUserCorrection(lastUserText);

        // Supplementary: assistant response — structured self-reflection
        if (!extracted && lastAssistantText) {
          extracted = extractPatternFromAssistantText(lastAssistantText, lastUserText);
        }

        if (extracted) {
          // Detect enrichment provider for LLM-based scope classification (non-blocking)
          let enrichmentProvider: Awaited<ReturnType<typeof detectEnrichmentProvider>> = null;
          try {
            enrichmentProvider = await detectEnrichmentProvider(
              {
                baseUrl: config.enrichment.ollama_base_url,
                model: config.enrichment.ollama_model,
                enabled: config.enrichment.enabled,
              },
              CC_CAPABILITIES,
            );
          } catch {
            // Non-fatal — heuristic fallback handles this
          }

          // Classify scope: LLM -> heuristic -> default project-scoped
          const scopedProject = await classifyPatternScope(extracted, routedProject, enrichmentProvider);
          const patternId = createPattern(db, extracted, sessionId, scopedProject);

          // Wire causal attribution: trace which session event the user is correcting
          // and link it to the pattern for richer root-cause analysis.
          try {
            const causal = findCausalEvent(db, sessionId, lastUserText);
            if (causal) {
              storeCausalAttribution(db, patternId, causal.event_id);
            }
          } catch { /* Non-critical — pattern created regardless */ }
        }
      } catch (e) {
        emitErrorTelemetry(db, sessionId, 'stop/exp_pattern_create', e);
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
    //    warning was shown and the user did not re-correct -> it was useful.
    if (awaiting_feedback_ids.length > 0) {
      if (correction_flagged) {
        // Extract topic words from the stored correction prompt (set by
        // UserPromptSubmit when correction_flagged was raised).
        // Fall back to lastUserText when correction_prompt is absent (e.g.
        // older flags written before this field existed).
        const correctionSource = correction_prompt || lastUserText || '';
        // Cap at 5 tokens — matches generateTopicKey's 3-word granularity.
        // Higher caps increase false positive overlap with unrelated patterns.
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
              updatePatternScore(db, patternId, -1);
              // ACE escalation: if harmful_count hits threshold, escalate injection level
              escalatePattern(db, patternId);
            }
            // else: no topic overlap — ExpeL neutral path.
            // We cannot determine whether this pattern was helpful or harmful this
            // turn: the correction is about a different topic, so the pattern's
            // injection was irrelevant to what the user is correcting. Skip entirely
            // (no penalty, no reward) to avoid corrupting score with noisy signal.
          } catch (e) {
            emitErrorTelemetry(db, sessionId, 'stop/exp_score_feedback', e);
          }
        }
      } else {
        // No correction this turn — all awaiting patterns were useful.
        for (const patternId of awaiting_feedback_ids) {
          try {
            incrementUsefulCount(db, patternId);
            updatePatternScore(db, patternId, 1);
          } catch (e) {
            emitErrorTelemetry(db, sessionId, 'stop/exp_score_feedback', e);
          }
        }
      }
    }
  } catch (e) {
    emitErrorTelemetry(db, sessionId, 'stop/exp_flags', e);
  } finally {
    // 3. Promote this turn's injected patterns + topic keys to awaiting_feedback
    //    for next turn. Clear correction state and current-turn injection lists.
    //    Only runs when flags were successfully read — avoids overwriting valid
    //    awaiting_feedback_ids with stale defaults if getExperienceFlags threw.
    if (flagsReadOk) {
      try {
        setExperienceFlags(db, sessionId, {
          correction_flagged: false,
          correction_prompt: '',
          injected_pattern_ids: [],
          injected_topic_keys: [],
          awaiting_feedback_ids: expFlags.injected_pattern_ids,
          awaiting_topic_keys: expFlags.injected_topic_keys,
          pending_trigger_domains: [],
        }, expFlags);
      } catch (e) {
        emitErrorTelemetry(db, sessionId, 'stop/exp_flags_clear', e);
      }
    }
  }
}
