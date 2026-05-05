/**
 * Two-turn end-to-end integration test for the experience-patterns inject → promote → score cycle.
 *
 * Tests the full lifecycle exercised by UserPromptSubmit (injection), Stop/finally
 * (promotion to awaiting), and the next Stop (score feedback) — without spawning
 * real hook processes.
 *
 * Turn 1 injection is simulated via direct flag writes (UserPromptSubmit's job),
 * then applyExperienceFeedback() is called for the Stop hook — testing the real
 * production scoring + flag rotation path.
 *
 * Scenario:
 *   Turn 1 — UserPromptSubmit injects two patterns (A and B).
 *             Stop (applyExperienceFeedback) promotes them to awaiting.
 *   Turn 2 — UserPromptSubmit detects a correction whose topic overlaps only pattern A.
 *             Stop (applyExperienceFeedback) scores: A gets -1, B unchanged (ExpeL neutral).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession, allowLegacyPatternInsert, type TestDatabase } from '../helpers/test-db.js';
import {
  createPattern,
  generateTopicKey,
  type ExtractionInput,
  type ExperiencePattern,
} from '../../intelligence/experience-patterns.js';
import {
  getExperienceFlags,
  setExperienceFlags,
} from '../../intelligence/experience-flags.js';
import { applyExperienceFeedback } from '../../intelligence/experience-scoring.js';
import { DEFAULT_CONFIG } from '../../shared/constants.js';
import type { ClaudexConfig } from '../../shared/config.js';

const testConfig = {
  ...DEFAULT_CONFIG,
  enrichment: { ...DEFAULT_CONFIG.enrichment, enabled: false },
} as unknown as ClaudexConfig;

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
    allowLegacyPatternInsert(db);
  });

  afterEach(() => { db.close(); });

  it('matching pattern gets -1, non-matching pattern unchanged after correction', async () => {
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
    // Turn 1 Step 2: Call applyExperienceFeedback (Stop hook).
    // No awaiting patterns yet → scoring is a no-op.
    // Finally block promotes injected → awaiting for next turn.
    // -----------------------------------------------------------------------
    await applyExperienceFeedback(db, sessionId, undefined, undefined, project, testConfig);

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
    // Turn 2 Step 2: Call applyExperienceFeedback (Stop hook).
    // Scores awaiting patterns: A penalised (topic overlap), B neutral.
    // Pass undefined for assistant/user text to skip pattern extraction —
    // we only care about the scoring path here.
    // -----------------------------------------------------------------------
    await applyExperienceFeedback(db, sessionId, undefined, undefined, project, testConfig);

    // -----------------------------------------------------------------------
    // Assertions: A penalised (2 → 1), B unchanged (2)
    // -----------------------------------------------------------------------
    expect(getById(db, idA)!.score).toBe(1);
    expect(getById(db, idB)!.score).toBe(2);
  });

  it('all awaiting patterns rewarded when no correction in turn 2', async () => {
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

    // Turn 1 Stop: applyExperienceFeedback promotes injected → awaiting
    await applyExperienceFeedback(db, sessionId, undefined, undefined, project, testConfig);

    // Turn 2: no correction detected (correction_flagged remains false from promotion)
    // Call applyExperienceFeedback for Turn 2 Stop — should reward all awaiting patterns.
    await applyExperienceFeedback(db, sessionId, undefined, undefined, project, testConfig);

    // Both patterns rewarded: score 2 → 3, times_useful 0 → 1
    const rowA = getById(db, idA)!;
    const rowB = getById(db, idB)!;
    expect(rowA.score).toBe(3);
    expect(rowA.times_useful).toBe(1);
    expect(rowB.score).toBe(3);
    expect(rowB.times_useful).toBe(1);
  });
});
