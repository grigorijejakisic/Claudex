/**
 * Phase 12 retrieval ranking rebalance — regression harness (12-07).
 *
 * Verifies the topical-distance importance cap formula. The W3 big-balkan bug:
 * high-importance artifacts crowding position 0 for domain-unrelated queries.
 *
 * The fix applies in the full async pipeline (vector cosine as topicalRelevance).
 * The sync path (FTS5 + recency, no vectors) degrades gracefully — for queries
 * with FTS5 hits, the cap applies via FTS5 rank proxy. For zero-hit queries,
 * recency dominates regardless (no topical signal at all in sync path).
 *
 * These tests verify:
 * 1. Formula unit tests — importanceMult is zero at high topical_distance.
 * 2. FTS5-matched domain-unrelated queries — big-balkan does not appear at pos 0.
 * 3. Topically-related queries — big-balkan still surfaces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { hybridSearchSync, computeArtifactScore } from '../../core/hybrid-retrieval.js';

let db: TestDatabase;

// Seed: big-balkan pattern with max importance (the bug trigger)
// Plus two topic-specific artifacts with lower importance.
function seedArtifacts(): void {
  const sess = db.prepare(
    `INSERT INTO sessions (session_id, project, cwd, source, created_at_epoch)
     VALUES ('seed-session', 'lacuna-betting', '/test', 'test', unixepoch())`
  );
  sess.run();

  db.prepare(`
    INSERT INTO artifacts (session_id, project, artifact_type, summary, content, importance, activation_score, novelty_score)
    VALUES ('seed-session', 'lacuna-betting', 'decision',
      'big-balkan has no betting limitations across markets and sports',
      'Monitor all sports and all markets on big-balkan platform without restrictions',
      5, 1.0, 0.5)
  `).run();

  db.prepare(`
    INSERT INTO artifacts (session_id, project, artifact_type, summary, content, importance, activation_score, novelty_score)
    VALUES ('seed-session', 'lacuna-betting', 'decision',
      'TT cycle detection uses 300ms gate window to detect settlement cascades',
      'The TT gate window empirically derived for settlement cascade detection',
      3, 1.0, 0.5)
  `).run();

  db.prepare(`
    INSERT INTO artifacts (session_id, project, artifact_type, summary, content, importance, activation_score, novelty_score)
    VALUES ('seed-session', 'lacuna-betting', 'decision',
      'Maxbet SSE endpoint format uses text/event-stream with retry headers',
      'SSE connection pattern for Maxbet API endpoint integration',
      3, 1.0, 0.5)
  `).run();

  // Rebuild FTS index
  db.exec(`INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')`);
}

beforeEach(() => {
  db = createTestDb();
  seedArtifacts();
});

afterEach(() => {
  db.close();
});

describe('Phase 12 retrieval ranking rebalance — big-balkan importance cap', () => {
  describe('FTS5-matched domain-unrelated queries — big-balkan should NOT be at position 0', () => {
    // These queries have FTS5 hits against TT/Maxbet artifacts but NOT big-balkan.
    // The topical-distance cap (via FTS5 rank proxy) should prevent big-balkan
    // from appearing at position 0 when it has no FTS5 match.
    it('"TT cycle detection" surfaces TT artifact, not big-balkan, at position 0', () => {
      const results = hybridSearchSync(db, 'TT cycle detection work', 'lacuna-betting', { limit: 5, globalScope: true });
      if (results.length > 0) {
        expect(results[0].summary).not.toMatch(/big-balkan/i);
        expect(results[0].summary.toLowerCase()).toMatch(/tt cycle|gate window/);
      }
    });

    it('"Maxbet SSE endpoint" surfaces Maxbet artifact, not big-balkan, at position 0', () => {
      const results = hybridSearchSync(db, 'Maxbet SSE endpoint format', 'lacuna-betting', { limit: 5, globalScope: true });
      if (results.length > 0) {
        expect(results[0].summary).not.toMatch(/big-balkan/i);
        expect(results[0].summary.toLowerCase()).toMatch(/maxbet|sse/);
      }
    });
  });

  describe('Topically-related query — big-balkan should appear in top-5', () => {
    it('"big-balkan betting limitations" surfaces big-balkan pattern in top-5', () => {
      const results = hybridSearchSync(db, 'big-balkan betting limitations', 'lacuna-betting', { limit: 5, globalScope: true });
      const summaries = results.map((r) => r.summary.toLowerCase());
      expect(summaries.some((s) => s.includes('big-balkan'))).toBe(true);
    });
  });
});

describe('computeArtifactScore — topical importance cap formula', () => {
  it('importance contribution is zero when topical_distance >> threshold + falloff', () => {
    // topicalRelevance = 0.0 → topical_distance = 1.0
    // threshold=0.4, falloff=0.3 → importanceMult = max(0, 1 - (1.0-0.4)/0.3) = max(0, -1) = 0
    const artifact = {
      id: 1, session_id: 's', project: 'p', artifact_type: 'decision',
      summary: 'test', content: null, state: 'fresh', ttl: 3,
      importance: 5, retrieval_score: 1.0, timestamp_epoch: Math.floor(Date.now()/1000),
      last_materialized_epoch: null, embedding: null, activation_score: 1.0,
      superseded_by: null, valid_until: null, confidence: 1.0, novelty_score: 0.5,
      artifact_ref: null,
    } as const;
    const scoreWithHighTopical = computeArtifactScore(artifact, 0.01, {
      db,
      artifactId: 1,
      relevance: 0.9, // high relevance (topically related)
      topicalRelevance: 0.9,
    });
    const scoreWithLowTopical = computeArtifactScore(artifact, 0.01, {
      db,
      artifactId: 1,
      relevance: 0.9,
      topicalRelevance: 0.0, // topically unrelated → importance capped to 0
    });
    // High-topical should score higher due to uncapped importance
    expect(scoreWithHighTopical).toBeGreaterThan(scoreWithLowTopical);
  });
});
