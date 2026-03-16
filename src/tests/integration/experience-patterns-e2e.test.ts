/**
 * Two-turn end-to-end integration test for the experience-patterns inject → promote → score cycle.
 *
 * Tests the full lifecycle exercised by UserPromptSubmit (injection), Stop/finally
 * (promotion to awaiting), and the next Stop (score feedback) — without spawning
 * real hook processes.  All DB interactions go through the same functions the
 * hooks call, so this test exercises the real pipeline at the unit-integration
 * boundary.
 *
 * Scenario:
 *   Turn 1 — UserPromptSubmit injects two patterns (A and B).
 *             Stop/finally promotes them to awaiting_feedback_ids + awaiting_topic_keys.
 *   Turn 2 — UserPromptSubmit detects a correction whose topic overlaps only pattern A.
 *             Stop scores: A gets -1, B is unchanged (ExpeL neutral path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import {
  createPattern,
  updatePatternScore,
  incrementUsefulCount,
  generateTopicKey,
  type ExtractionInput,
  type ExperiencePattern,
} from '../../intelligence/experience-patterns.js';
import {
  getExperienceFlags,
  setExperienceFlags,
} from '../../intelligence/experience-flags.js';
import { tokenizeQuery } from '../../shared/search-utils.js';

function makePattern(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    pattern_type: 'correction',
    trigger_context: 'server migration OAuth token transfer credentials',
    lesson: 'Always copy OAuth token from ~/.claude/.credentials.json when migrating',
    anti_pattern: 'Assumed old token would work on new machine',
    severity: 'important',
    ...overrides,
  };
}

function getById(db: TestDatabase, id: string): ExperiencePattern | undefined {
  return db.prepare('SELECT * FROM experience_patterns WHERE id = ?').get(id) as ExperiencePattern | undefined;
}

describe('experience-patterns two-turn e2e: inject → promote → score', () => {
  let db: TestDatabase;
  let sessionId: string;
  const project = 'test-project';

  beforeEach(() => {
    ({ db, sessionId } = createTestDbWithSession('e2e-session', project));
  });

  afterEach(() => { db.close(); });

  it('matching pattern gets -1, non-matching pattern unchanged after correction', () => {
    // -----------------------------------------------------------------------
    // Setup: create two patterns in the DB
    // -----------------------------------------------------------------------
    const idA = createPattern(db, makePattern({
      trigger_context: 'server migration OAuth token transfer credentials',
      lesson: 'Copy OAuth token during server migration',
    }), sessionId, project);

    const idB = createPattern(db, makePattern({
      trigger_context: 'flexbox grid layout responsive design columns',
      lesson: 'Use CSS grid for two-dimensional layouts',
    }), sessionId, project);

    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();

    // -----------------------------------------------------------------------
    // Turn 1 Step 1: Simulate UserPromptSubmit injecting patterns A and B.
    // The assembler records injected_pattern_ids + injected_topic_keys.
    // -----------------------------------------------------------------------
    const topicKeyA = generateTopicKey({ id: idA, trigger_context: 'server migration OAuth token transfer credentials' });
    const topicKeyB = generateTopicKey({ id: idB, trigger_context: 'flexbox grid layout responsive design columns' });

    setExperienceFlags(db, sessionId, {
      injected_pattern_ids: [idA, idB],
      injected_topic_keys: [topicKeyA, topicKeyB],
      correction_flagged: false,
      correction_prompt: '',
    });

    // Verify injection was recorded
    const flagsAfterInject = getExperienceFlags(db, sessionId);
    expect(flagsAfterInject.injected_pattern_ids).toEqual([idA, idB]);
    expect(flagsAfterInject.injected_topic_keys).toEqual([topicKeyA, topicKeyB]);

    // -----------------------------------------------------------------------
    // Turn 1 Step 2: Simulate Stop/finally promoting injected patterns to
    // awaiting_feedback_ids + awaiting_topic_keys for the next turn.
    // Clears correction state and current-turn injection lists.
    // -----------------------------------------------------------------------
    setExperienceFlags(db, sessionId, {
      correction_flagged: false,
      correction_prompt: '',
      injected_pattern_ids: [],
      injected_topic_keys: [],
      awaiting_feedback_ids: flagsAfterInject.injected_pattern_ids,
      awaiting_topic_keys: flagsAfterInject.injected_topic_keys,
    }, flagsAfterInject);

    // Verify promotion
    const flagsAfterPromote = getExperienceFlags(db, sessionId);
    expect(flagsAfterPromote.awaiting_feedback_ids).toEqual([idA, idB]);
    expect(flagsAfterPromote.awaiting_topic_keys).toEqual([topicKeyA, topicKeyB]);
    expect(flagsAfterPromote.injected_pattern_ids).toEqual([]);
    expect(flagsAfterPromote.correction_flagged).toBe(false);

    // -----------------------------------------------------------------------
    // Turn 2 Step 1: Simulate UserPromptSubmit detecting a correction whose
    // topic overlaps pattern A (OAuth/migration) but NOT pattern B (flexbox/grid).
    // -----------------------------------------------------------------------
    const correctionPrompt = 'you keep forgetting OAuth token migration credentials every time';
    setExperienceFlags(db, sessionId, {
      correction_flagged: true,
      correction_prompt: correctionPrompt,
    }, flagsAfterPromote);

    // -----------------------------------------------------------------------
    // Turn 2 Step 2: Simulate Stop score feedback — replicate the exact logic
    // from stop.ts: topic-overlap check, -1 for overlap, neutral for no overlap.
    // -----------------------------------------------------------------------
    const flagsForScoring = getExperienceFlags(db, sessionId);
    const { awaiting_feedback_ids, awaiting_topic_keys, correction_flagged, correction_prompt: storedPrompt } = flagsForScoring;

    expect(correction_flagged).toBe(true);
    expect(awaiting_feedback_ids).toEqual([idA, idB]);

    const correctionWords = tokenizeQuery(storedPrompt).slice(0, 5);

    for (let i = 0; i < awaiting_feedback_ids.length; i++) {
      const patternId = awaiting_feedback_ids[i];
      const topicKey = awaiting_topic_keys[i] ?? '';
      const patternWords = topicKey.split('_').filter(Boolean);
      const hasOverlap = correctionWords.some(w => patternWords.includes(w));

      if (hasOverlap) {
        updatePatternScore(db, patternId, -1);
      }
      // else: ExpeL neutral path — no penalty, no reward
    }

    // -----------------------------------------------------------------------
    // Assertions: A penalised (2 → 1), B unchanged (2)
    // -----------------------------------------------------------------------
    expect(getById(db, idA)!.score).toBe(1);
    expect(getById(db, idB)!.score).toBe(2);
  });

  it('all awaiting patterns rewarded when no correction in turn 2', () => {
    // -----------------------------------------------------------------------
    // Setup: two patterns injected and promoted
    // -----------------------------------------------------------------------
    const idA = createPattern(db, makePattern({
      trigger_context: 'server migration OAuth token transfer credentials',
      lesson: 'Copy OAuth token during migration',
    }), sessionId, project);

    const idB = createPattern(db, makePattern({
      trigger_context: 'flexbox grid layout responsive design columns',
      lesson: 'CSS grid lesson',
    }), sessionId, project);

    const topicKeyA = generateTopicKey({ id: idA, trigger_context: 'server migration OAuth token transfer credentials' });
    const topicKeyB = generateTopicKey({ id: idB, trigger_context: 'flexbox grid layout responsive design columns' });

    // Turn 1: inject
    setExperienceFlags(db, sessionId, {
      injected_pattern_ids: [idA, idB],
      injected_topic_keys: [topicKeyA, topicKeyB],
    });

    const flagsAfterInject = getExperienceFlags(db, sessionId);

    // Turn 1 Stop/finally: promote
    setExperienceFlags(db, sessionId, {
      correction_flagged: false,
      correction_prompt: '',
      injected_pattern_ids: [],
      injected_topic_keys: [],
      awaiting_feedback_ids: flagsAfterInject.injected_pattern_ids,
      awaiting_topic_keys: flagsAfterInject.injected_topic_keys,
    }, flagsAfterInject);

    // Turn 2: no correction detected
    const flagsForScoring = getExperienceFlags(db, sessionId);
    const { awaiting_feedback_ids, correction_flagged } = flagsForScoring;

    expect(correction_flagged).toBe(false);

    // Reward all awaiting patterns (Stop hook "no correction" branch)
    for (const patternId of awaiting_feedback_ids) {
      incrementUsefulCount(db, patternId);
      updatePatternScore(db, patternId, 1);
    }

    // Both patterns rewarded: score 2 → 3, times_useful 0 → 1
    const rowA = getById(db, idA)!;
    const rowB = getById(db, idB)!;
    expect(rowA.score).toBe(3);
    expect(rowA.times_useful).toBe(1);
    expect(rowB.score).toBe(3);
    expect(rowB.times_useful).toBe(1);
  });
});
