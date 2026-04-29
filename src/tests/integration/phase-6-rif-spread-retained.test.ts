/**
 * Phase 6 Plan 05 — RETR-03 lock-down: RIF + spread activation behavior preserved.
 *
 * Phase 6 simplifies the multiplier chain in `hybrid-retrieval.ts`. RIF
 * (retrieval-induced forgetting) and spread activation are NOT part of the
 * multiplier chain — they are independent side-effects on `activation_score`
 * that the multiplier chain reads. This test asserts they survive Phase 6
 * intact:
 *
 *   1. RIF decrement: above-threshold non-selected candidates lose
 *      RIF_DECREMENT (0.03) from activation_score, floored at
 *      RIF_ACTIVATION_FLOOR (0.1).
 *   2. Spread activation: artifacts linked from a source via `artifact_links`
 *      gain SPREAD_FACTOR (0.3) × link.strength × source.activation_score,
 *      capped at 10.0.
 *
 * Constants are not exported, so the assertions are behavioral — observe the
 * delta on activation_score to infer the constant. If the constants change,
 * the assertions fail with a descriptive comparison.
 */

import { describe, it, expect } from 'vitest';
import { createTestDbWithSession } from '../helpers/test-db.js';
import { createArtifact } from '../../core/artifacts.js';
import {
  applyRetrievalInducedSuppression,
  spreadActivation,
} from '../../core/hybrid-retrieval.js';
import { getPolicy } from '../../intelligence/policy-registry.js';

describe('Phase 6 RETR-03 lock-down — RIF behavior preserved', () => {
  it('decrements activation_score by 0.03 on above-threshold non-selected candidates', () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rif-A');

    // Seed 6 near-duplicate artifacts. We'll mark id=1 selected; the other 5
    // should each lose 0.03 from activation_score.
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const id = createArtifact(
        db,
        sessionId,
        project,
        'observation',
        null,
        `Near-dup ${i}: rate limit polls window`,
        `near-dup ${i} content rate limit polls window shadowban backoff`,
        3,
      );
      // Set a known starting activation_score so the post-decrement value is observable.
      db.prepare('UPDATE artifacts SET activation_score = 0.8 WHERE id = ?').run(id);
      ids.push(id);
    }

    // Build rrfScores Map with all 6 above the suppression threshold per the
    // active policy (default: shouldSuppressCandidate(rrf >= 0.01)).
    const rrfScores = new Map<number, number>();
    for (const id of ids) rrfScores.set(id, 0.05);

    const selectedIds = new Set<number>([ids[0]]);

    applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

    // The selected candidate is unchanged.
    const selected = db.prepare(
      'SELECT activation_score FROM artifacts WHERE id = ?',
    ).get(ids[0]) as { activation_score: number };
    expect(selected.activation_score).toBeCloseTo(0.8, 6);

    // The 5 non-selected candidates each lost RIF_DECREMENT = 0.03.
    for (let i = 1; i < ids.length; i += 1) {
      const row = db.prepare(
        'SELECT activation_score FROM artifacts WHERE id = ?',
      ).get(ids[i]) as { activation_score: number };
      expect(row.activation_score).toBeCloseTo(0.77, 6); // 0.80 - 0.03
    }

    db.close();
  });

  it('clamps the decrement at RIF_ACTIVATION_FLOOR = 0.1', () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rif-B');

    // Seed a single non-selected candidate with activation already at the floor.
    const id = createArtifact(db, sessionId, project, 'observation', null, 'low', 'low content', 2);
    db.prepare('UPDATE artifacts SET activation_score = 0.1 WHERE id = ?').run(id);

    const rrfScores = new Map<number, number>([[id, 0.05]]);
    const selectedIds = new Set<number>(); // id is non-selected

    applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

    const after = db.prepare(
      'SELECT activation_score FROM artifacts WHERE id = ?',
    ).get(id) as { activation_score: number };
    // Floor is 0.1 — already at the floor, MAX(floor, x - decrement) = MAX(0.1, 0.07) = 0.1.
    expect(after.activation_score).toBeCloseTo(0.1, 6);

    db.close();
  });

  it('respects policy.shouldSuppressCandidate gate (default: rrf < threshold → not suppressed)', () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rif-C');

    const id = createArtifact(db, sessionId, project, 'observation', null, 'sub-thresh', 'sub-thresh content', 2);
    db.prepare('UPDATE artifacts SET activation_score = 0.8 WHERE id = ?').run(id);

    const policy = getPolicy();
    // Use an rrf score well below any reasonable threshold so suppression is gated off.
    // shouldSuppressCandidate(0.0001) should return false under the default policy.
    expect(policy.shouldSuppressCandidate(0.0001)).toBe(false);

    const rrfScores = new Map<number, number>([[id, 0.0001]]);
    const selectedIds = new Set<number>();

    applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

    const after = db.prepare(
      'SELECT activation_score FROM artifacts WHERE id = ?',
    ).get(id) as { activation_score: number };
    // Sub-threshold rrf → not suppressed → activation unchanged.
    expect(after.activation_score).toBeCloseTo(0.8, 6);

    db.close();
  });

  it('is non-throwing on a closed DB', () => {
    const { db } = createTestDbWithSession('sess-rif-closed');
    db.close();
    expect(() => {
      applyRetrievalInducedSuppression(db, new Map([[1, 0.05]]), new Set());
    }).not.toThrow();
  });
});

describe('Phase 6 RETR-03 lock-down — spread activation behavior preserved', () => {
  it('boosts linked targets by 0.3 × link.strength × source.activation_score', () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-spread-A');

    const sourceId = createArtifact(
      db, sessionId, project, 'observation', null, 'source artifact', 'source content', 4,
    );
    const targetB = createArtifact(
      db, sessionId, project, 'observation', null, 'target B', 'target B content', 3,
    );
    const targetC = createArtifact(
      db, sessionId, project, 'observation', null, 'target C', 'target C content', 3,
    );

    // Source activation = 1.0; target activations = 0 to make the delta clean.
    db.prepare('UPDATE artifacts SET activation_score = 1.0 WHERE id = ?').run(sourceId);
    db.prepare('UPDATE artifacts SET activation_score = 0 WHERE id = ?').run(targetB);
    db.prepare('UPDATE artifacts SET activation_score = 0 WHERE id = ?').run(targetC);

    // Two artifact_links: source → B (strength 1.0), source → C (strength 0.5).
    db.prepare(
      `INSERT INTO artifact_links (source_id, target_id, link_type, strength)
       VALUES (?, ?, 'related', 1.0), (?, ?, 'related', 0.5)`,
    ).run(sourceId, targetB, sourceId, targetC);

    spreadActivation(db, sourceId);

    const after = (id: number) => (db.prepare(
      'SELECT activation_score FROM artifacts WHERE id = ?',
    ).get(id) as { activation_score: number }).activation_score;

    // SPREAD_FACTOR = 0.3 → boost(B) = 0.3 × 1.0 × 1.0 = 0.30 (target was 0).
    expect(after(targetB)).toBeCloseTo(0.30, 6);
    // boost(C) = 0.3 × 0.5 × 1.0 = 0.15.
    expect(after(targetC)).toBeCloseTo(0.15, 6);

    db.close();
  });

  it('caps boosted activation at 10.0', () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-spread-B');

    const sourceId = createArtifact(
      db, sessionId, project, 'observation', null, 'big source', 'big', 5,
    );
    const targetId = createArtifact(
      db, sessionId, project, 'observation', null, 'soon-to-be-capped', 'capped', 3,
    );

    // Pump source to a high activation so boost would exceed the cap.
    db.prepare('UPDATE artifacts SET activation_score = 100.0 WHERE id = ?').run(sourceId);
    db.prepare('UPDATE artifacts SET activation_score = 9.9 WHERE id = ?').run(targetId);

    db.prepare(
      `INSERT INTO artifact_links (source_id, target_id, link_type, strength)
       VALUES (?, ?, 'related', 1.0)`,
    ).run(sourceId, targetId);

    spreadActivation(db, sourceId);

    const after = (db.prepare(
      'SELECT activation_score FROM artifacts WHERE id = ?',
    ).get(targetId) as { activation_score: number }).activation_score;

    // boost would be 0.3 × 1.0 × 100 = 30 → 9.9 + 30 = 39.9 → capped at 10.0.
    expect(after).toBeCloseTo(10.0, 6);

    db.close();
  });

  it('skips packed targets', () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-spread-C');

    const sourceId = createArtifact(db, sessionId, project, 'observation', null, 'src', 'src', 4);
    const targetId = createArtifact(db, sessionId, project, 'observation', null, 'tgt', 'tgt', 3);

    db.prepare('UPDATE artifacts SET activation_score = 1.0 WHERE id = ?').run(sourceId);
    db.prepare('UPDATE artifacts SET activation_score = 0, state = ? WHERE id = ?').run('packed', targetId);

    db.prepare(
      `INSERT INTO artifact_links (source_id, target_id, link_type, strength)
       VALUES (?, ?, 'related', 1.0)`,
    ).run(sourceId, targetId);

    spreadActivation(db, sourceId);

    const after = (db.prepare(
      'SELECT activation_score FROM artifacts WHERE id = ?',
    ).get(targetId) as { activation_score: number }).activation_score;
    // Packed target — boost skipped — score unchanged.
    expect(after).toBeCloseTo(0, 6);

    db.close();
  });

  it('is non-throwing on a closed DB', () => {
    const { db } = createTestDbWithSession('sess-spread-closed');
    db.close();
    expect(() => spreadActivation(db, 1)).not.toThrow();
  });
});
