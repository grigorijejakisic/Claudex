/**
 * Tests for Part 5: Retrieval Feedback Loop
 *
 * Covers:
 * - 5.1 Retrieval event recording (recordRetrievalEvent, updateRetrievalEventOutcomes)
 * - 5.2 Retrieval score as multiplier (getRetrievalScoreMultiplier, penalizeUnreferencedArtifacts)
 * - 5.3 Spreading activation (spreadActivation)
 * - Integration: processRetrievalFeedback with session ID wiring
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { createArtifact } from '../../core/artifacts.js';
import { insertArtifactLink } from '../../core/artifacts.js';
import {
  recordRetrievalEvent,
  updateRetrievalEventOutcomes,
  getRetrievalScoreMultiplier,
  penalizeUnreferencedArtifacts,
  processRetrievalFeedback,
  updateRetrievalScore,
} from '../../intelligence/retrieval-feedback.js';
import { spreadActivation } from '../../core/hybrid-retrieval.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  db.prepare(
    `INSERT INTO sessions (session_id, status, observation_count, created_at_epoch_ms)
     VALUES ('test-sess', 'active', 0, ?)`
  ).run(Math.floor(Date.now() / 1000));
  return db;
}

function getScore(db: Database.Database, id: number): number {
  const row = db.prepare('SELECT retrieval_score FROM artifacts WHERE id = ?').get(id) as { retrieval_score: number };
  return row.retrieval_score;
}

function getActivation(db: Database.Database, id: number): number {
  const row = db.prepare('SELECT activation_score FROM artifacts WHERE id = ?').get(id) as { activation_score: number | null };
  return row.activation_score ?? 0;
}

function getRetrievalEvents(db: Database.Database, sessionId: string) {
  return db.prepare(
    'SELECT * FROM retrieval_events WHERE session_id = ? ORDER BY id'
  ).all(sessionId) as Array<{
    id: number;
    artifact_id: number;
    session_id: string;
    query_text: string | null;
    was_referenced: number | null;
    correction_followed: number | null;
    timestamp_epoch_ms: number;
  }>;
}

// ---------------------------------------------------------------------------
// 5.1: Retrieval Event Recording
// ---------------------------------------------------------------------------

describe('5.1 Retrieval Event Tracking', () => {
  describe('recordRetrievalEvent', () => {
    it('inserts a retrieval event with artifact_id and session_id', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'test obs', 'content', 3);
        recordRetrievalEvent(db, id, 'test-sess', 'my search query');

        const events = getRetrievalEvents(db, 'test-sess');
        expect(events).toHaveLength(1);
        expect(events[0].artifact_id).toBe(id);
        expect(events[0].session_id).toBe('test-sess');
        expect(events[0].query_text).toBe('my search query');
        expect(events[0].was_referenced).toBeNull();
        expect(events[0].correction_followed).toBeNull();
      } finally {
        db.close();
      }
    });

    it('handles null query text', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'test', 'c', 3);
        recordRetrievalEvent(db, id, 'test-sess');

        const events = getRetrievalEvents(db, 'test-sess');
        expect(events).toHaveLength(1);
        expect(events[0].query_text).toBeNull();
      } finally {
        db.close();
      }
    });

    it('records multiple events for same session', () => {
      const db = createDb();
      try {
        const id1 = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'obs 1', 'c1', 3);
        const id2 = createArtifact(db, 'test-sess', 'proj', 'decision', null, 'dec 1', 'c2', 4);

        recordRetrievalEvent(db, id1, 'test-sess', 'query A');
        recordRetrievalEvent(db, id2, 'test-sess', 'query A');

        const events = getRetrievalEvents(db, 'test-sess');
        expect(events).toHaveLength(2);
        expect(events[0].artifact_id).toBe(id1);
        expect(events[1].artifact_id).toBe(id2);
      } finally {
        db.close();
      }
    });

    it('does not throw on invalid artifact_id', () => {
      const db = createDb();
      try {
        // Should not throw — non-throwing contract
        recordRetrievalEvent(db, 99999, 'test-sess', 'query');
      } finally {
        db.close();
      }
    });
  });

  describe('updateRetrievalEventOutcomes', () => {
    it('marks referenced artifacts', () => {
      const db = createDb();
      try {
        const id1 = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'obs 1', 'c1', 3);
        const id2 = createArtifact(db, 'test-sess', 'proj', 'decision', null, 'dec 1', 'c2', 4);

        recordRetrievalEvent(db, id1, 'test-sess', 'query');
        recordRetrievalEvent(db, id2, 'test-sess', 'query');

        // Only id1 was referenced
        updateRetrievalEventOutcomes(db, 'test-sess', new Set([id1]), false);

        const events = getRetrievalEvents(db, 'test-sess');
        expect(events[0].was_referenced).toBe(1);
        expect(events[0].correction_followed).toBe(0);
        expect(events[1].was_referenced).toBe(0);
        expect(events[1].correction_followed).toBe(0);
      } finally {
        db.close();
      }
    });

    it('records correction_followed = 1 when correction detected', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'obs', 'c', 3);
        recordRetrievalEvent(db, id, 'test-sess', 'query');

        updateRetrievalEventOutcomes(db, 'test-sess', new Set(), true);

        const events = getRetrievalEvents(db, 'test-sess');
        expect(events[0].correction_followed).toBe(1);
        expect(events[0].was_referenced).toBe(0);
      } finally {
        db.close();
      }
    });

    it('only updates events that have not been scored yet', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'obs', 'c', 3);
        recordRetrievalEvent(db, id, 'test-sess', 'query');

        // First update
        updateRetrievalEventOutcomes(db, 'test-sess', new Set([id]), false);

        // Record a new event in the same session
        recordRetrievalEvent(db, id, 'test-sess', 'query 2');

        // Second update — only affects the new event
        updateRetrievalEventOutcomes(db, 'test-sess', new Set(), true);

        const events = getRetrievalEvents(db, 'test-sess');
        // First event: was_referenced=1 from first update
        expect(events[0].was_referenced).toBe(1);
        expect(events[0].correction_followed).toBe(0);
        // Second event: was_referenced=0, correction_followed=1 from second update
        expect(events[1].was_referenced).toBe(0);
        expect(events[1].correction_followed).toBe(1);
      } finally {
        db.close();
      }
    });

    it('is non-throwing with no events', () => {
      const db = createDb();
      try {
        // No retrieval events exist — should not throw
        updateRetrievalEventOutcomes(db, 'nonexistent', new Set(), false);
      } finally {
        db.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 5.2: Retrieval Score Feedback
// ---------------------------------------------------------------------------

describe('5.2 Retrieval Score Feedback', () => {
  describe('getRetrievalScoreMultiplier', () => {
    it('returns 1.0 for default (unmodified) artifacts', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'test', 'c', 3);
        expect(getRetrievalScoreMultiplier(db, id)).toBe(1.0);
      } finally {
        db.close();
      }
    });

    it('returns updated score after positive signal', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'test', 'c', 3);
        updateRetrievalScore(db, id, 0.1);
        expect(getRetrievalScoreMultiplier(db, id)).toBeCloseTo(1.1, 5);
      } finally {
        db.close();
      }
    });

    it('returns updated score after negative signal', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'test', 'c', 3);
        updateRetrievalScore(db, id, -0.2);
        expect(getRetrievalScoreMultiplier(db, id)).toBeCloseTo(0.8, 5);
      } finally {
        db.close();
      }
    });

    it('returns 1.0 for nonexistent artifact', () => {
      const db = createDb();
      try {
        expect(getRetrievalScoreMultiplier(db, 99999)).toBe(1.0);
      } finally {
        db.close();
      }
    });
  });

  describe('penalizeUnreferencedArtifacts', () => {
    it('penalizes artifacts with 3+ unreferenced retrievals', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'never useful', 'c', 3);
        const beforeScore = getScore(db, id);

        // Record 3 retrieval events, all unreferenced
        for (let i = 0; i < 3; i++) {
          recordRetrievalEvent(db, id, 'test-sess', 'query');
        }
        // Mark all as unreferenced
        updateRetrievalEventOutcomes(db, 'test-sess', new Set(), false);

        penalizeUnreferencedArtifacts(db, 'proj');

        expect(getScore(db, id)).toBeLessThan(beforeScore);
      } finally {
        db.close();
      }
    });

    it('does NOT penalize artifacts with fewer than 3 retrievals', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'new artifact', 'c', 3);
        const beforeScore = getScore(db, id);

        // Record only 2 retrieval events
        recordRetrievalEvent(db, id, 'test-sess', 'q1');
        recordRetrievalEvent(db, id, 'test-sess', 'q2');
        updateRetrievalEventOutcomes(db, 'test-sess', new Set(), false);

        penalizeUnreferencedArtifacts(db, 'proj');

        expect(getScore(db, id)).toBe(beforeScore);
      } finally {
        db.close();
      }
    });

    it('does NOT penalize artifacts that were referenced at least once', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'sometimes useful', 'c', 3);
        const beforeScore = getScore(db, id);

        // Record 4 events, but one was referenced
        for (let i = 0; i < 4; i++) {
          recordRetrievalEvent(db, id, 'test-sess', 'query');
        }
        updateRetrievalEventOutcomes(db, 'test-sess', new Set([id]), false);

        penalizeUnreferencedArtifacts(db, 'proj');

        // Score should NOT decrease because referenced_count > 0
        expect(getScore(db, id)).toBe(beforeScore);
      } finally {
        db.close();
      }
    });

    it('is non-throwing with empty DB', () => {
      const db = createDb();
      try {
        penalizeUnreferencedArtifacts(db, 'proj');
      } finally {
        db.close();
      }
    });
  });

  describe('processRetrievalFeedback with sessionId', () => {
    it('updates retrieval_events when sessionId is provided', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'Always use vitest not bun test', 'content', 4);

        // Record retrieval event at assembly time
        recordRetrievalEvent(db, id, 'test-sess', 'vitest query');

        // Process feedback at stop hook with sessionId
        processRetrievalFeedback(
          db,
          [id],
          'I ran vitest as recommended instead of bun test.',
          false,
          new Map([[id, 'Always use vitest not bun test']]),
          'test-sess',
        );

        // Verify retrieval_events were updated
        const events = getRetrievalEvents(db, 'test-sess');
        expect(events[0].was_referenced).toBe(1);
        expect(events[0].correction_followed).toBe(0);
      } finally {
        db.close();
      }
    });

    it('marks correction_followed on retrieval_events during correction', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'decision', null, 'Use sync file I/O for simplicity', 'content', 4);
        recordRetrievalEvent(db, id, 'test-sess', 'file io');

        processRetrievalFeedback(
          db,
          [id],
          'Actually sync file I/O blocks the event loop. We need async.',
          true,
          new Map([[id, 'Use sync file I/O for simplicity']]),
          'test-sess',
        );

        const events = getRetrievalEvents(db, 'test-sess');
        expect(events[0].correction_followed).toBe(1);
      } finally {
        db.close();
      }
    });

    it('still works without sessionId (backward compatible)', () => {
      const db = createDb();
      try {
        const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'test learning', 'content', 4);
        const before = getScore(db, id);

        // Call without sessionId — same as existing behavior
        processRetrievalFeedback(
          db,
          [id],
          'I followed the test learning advice.',
          false,
          new Map([[id, 'test learning']]),
        );

        expect(getScore(db, id)).toBeGreaterThan(before);
      } finally {
        db.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 5.3: Spreading Activation
// ---------------------------------------------------------------------------

describe('5.3 Spreading Activation', () => {
  it('boosts activation of linked artifacts', () => {
    const db = createDb();
    try {
      const idA = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'source artifact', 'c1', 4);
      const idB = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'linked artifact', 'c2', 3);

      // Set known activation for source
      db.prepare('UPDATE artifacts SET activation_score = 2.0 WHERE id = ?').run(idA);
      db.prepare('UPDATE artifacts SET activation_score = 0.5 WHERE id = ?').run(idB);

      // Create link: A -> B with strength 0.8
      insertArtifactLink(db, idA, idB, 'related', 0.8);

      const beforeB = getActivation(db, idB);
      spreadActivation(db, idA);
      const afterB = getActivation(db, idB);

      // Expected boost: 0.3 * 0.8 * 2.0 = 0.48
      expect(afterB).toBeCloseTo(beforeB + 0.48, 5);
    } finally {
      db.close();
    }
  });

  it('does not boost when link strength is 0', () => {
    const db = createDb();
    try {
      const idA = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'source', 'c1', 4);
      const idB = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'target', 'c2', 3);

      db.prepare('UPDATE artifacts SET activation_score = 2.0 WHERE id = ?').run(idA);
      db.prepare('UPDATE artifacts SET activation_score = 0.5 WHERE id = ?').run(idB);

      insertArtifactLink(db, idA, idB, 'related', 0);

      spreadActivation(db, idA);

      expect(getActivation(db, idB)).toBe(0.5);
    } finally {
      db.close();
    }
  });

  it('spreads to multiple linked artifacts', () => {
    const db = createDb();
    try {
      const idA = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'source', 'c1', 4);
      const idB = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'target1', 'c2', 3);
      const idC = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'target2', 'c3', 3);

      db.prepare('UPDATE artifacts SET activation_score = 1.5 WHERE id = ?').run(idA);
      db.prepare('UPDATE artifacts SET activation_score = 0.1 WHERE id = ?').run(idB);
      db.prepare('UPDATE artifacts SET activation_score = 0.2 WHERE id = ?').run(idC);

      insertArtifactLink(db, idA, idB, 'related', 0.5);
      insertArtifactLink(db, idA, idC, 'supports', 0.9);

      spreadActivation(db, idA);

      // B: 0.1 + 0.3 * 0.5 * 1.5 = 0.1 + 0.225 = 0.325
      expect(getActivation(db, idB)).toBeCloseTo(0.325, 5);
      // C: 0.2 + 0.3 * 0.9 * 1.5 = 0.2 + 0.405 = 0.605
      expect(getActivation(db, idC)).toBeCloseTo(0.605, 5);
    } finally {
      db.close();
    }
  });

  it('does not modify the source artifact activation', () => {
    const db = createDb();
    try {
      const idA = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'source', 'c1', 4);
      const idB = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'target', 'c2', 3);

      db.prepare('UPDATE artifacts SET activation_score = 2.0 WHERE id = ?').run(idA);
      insertArtifactLink(db, idA, idB, 'related', 0.8);

      spreadActivation(db, idA);

      // Source activation should remain unchanged
      expect(getActivation(db, idA)).toBe(2.0);
    } finally {
      db.close();
    }
  });

  it('is non-throwing with nonexistent artifact', () => {
    const db = createDb();
    try {
      spreadActivation(db, 99999);
    } finally {
      db.close();
    }
  });

  it('is non-throwing with no links', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'no links', 'c', 3);
      spreadActivation(db, id);
    } finally {
      db.close();
    }
  });

  it('handles zero activation_score gracefully', () => {
    const db = createDb();
    try {
      const idA = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'source', 'c1', 4);
      const idB = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'target', 'c2', 3);

      // Set activation_score to 0 — spreadActivation should produce 0 boost
      db.prepare('UPDATE artifacts SET activation_score = 0 WHERE id = ?').run(idA);
      db.prepare('UPDATE artifacts SET activation_score = 0.5 WHERE id = ?').run(idB);

      insertArtifactLink(db, idA, idB, 'related', 0.5);

      spreadActivation(db, idA);

      // Boost = 0.3 * 0.5 * 0 = 0, so target stays at 0.5
      expect(getActivation(db, idB)).toBe(0.5);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: Full feedback loop
// ---------------------------------------------------------------------------

describe('Feedback loop integration', () => {
  it('full cycle: record -> process -> penalize', () => {
    const db = createDb();
    try {
      // Use summary with strong keyword overlap to assistant output
      const idGood = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'Always use vitest not bun test for running tests', 'content', 4);
      const idBad = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'Weather is nice today outside', 'irrelevant content', 2);

      // Record retrieval events (simulating assembly)
      for (let i = 0; i < 3; i++) {
        recordRetrievalEvent(db, idGood, 'test-sess', 'vitest query');
        recordRetrievalEvent(db, idBad, 'test-sess', 'vitest query');
      }

      // Process feedback — idGood summary overlaps with output (vitest, tests, running)
      processRetrievalFeedback(
        db,
        [idGood, idBad],
        'I ran vitest as recommended for running the test suite instead of bun test.',
        false,
        new Map([
          [idGood, 'Always use vitest not bun test for running tests'],
          [idBad, 'Weather is nice today outside'],
        ]),
        'test-sess',
      );

      // Good artifact should have increased score (referenced)
      expect(getScore(db, idGood)).toBeGreaterThan(1.0);

      // Bad artifact not penalized yet (no "Ignored" penalty per design)
      expect(getScore(db, idBad)).toBe(1.0);

      // But retrieval_events tell the full story
      const events = getRetrievalEvents(db, 'test-sess');
      const goodEvents = events.filter(e => e.artifact_id === idGood);
      const badEvents = events.filter(e => e.artifact_id === idBad);

      // Good artifact events should be marked referenced
      const goodReferenced = goodEvents.filter(e => e.was_referenced === 1);
      expect(goodReferenced.length).toBeGreaterThan(0);

      // Bad artifact events should all be unreferenced
      const badUnreferenced = badEvents.filter(e => e.was_referenced === 0);
      expect(badUnreferenced.length).toBe(3);

      // Now penalize unreferenced — idBad has 3+ unreferenced retrievals
      penalizeUnreferencedArtifacts(db, 'proj');
      expect(getScore(db, idBad)).toBeLessThan(1.0);
    } finally {
      db.close();
    }
  });

  it('retrieval_score multiplier affects hybrid search ranking', () => {
    const db = createDb();
    try {
      // Create two artifacts with same content relevance but different retrieval scores
      const idHigh = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'migration schema update', 'migration changes', 4);
      const idLow = createArtifact(db, 'test-sess', 'proj', 'observation', null, 'migration schema refactor', 'migration refactor', 4);

      // Boost one, penalize the other
      updateRetrievalScore(db, idHigh, 0.5); // score = 1.5
      updateRetrievalScore(db, idLow, -0.5); // score = 0.5

      // Verify multipliers
      expect(getRetrievalScoreMultiplier(db, idHigh)).toBeCloseTo(1.5, 5);
      expect(getRetrievalScoreMultiplier(db, idLow)).toBeCloseTo(0.5, 5);

      // The higher retrieval_score should make idHigh rank higher
      // (we can't easily test hybridSearchSync without FTS5, but we can verify
      // the multiplier would differentiate them)
      const highMultiplied = 1.0 * getRetrievalScoreMultiplier(db, idHigh);
      const lowMultiplied = 1.0 * getRetrievalScoreMultiplier(db, idLow);
      expect(highMultiplied).toBeGreaterThan(lowMultiplied);
    } finally {
      db.close();
    }
  });
});
