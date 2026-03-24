/**
 * Tests for retrieval feedback (implicit scoring of injected context).
 * Phase 14: Negative retrieval learning tests added.
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { createArtifact } from '../../core/artifacts.js';
import {
  updateRetrievalScore,
  wasArtifactReferenced,
  processRetrievalFeedback,
  getRetrievalScoreMultiplier,
  recordRetrievalEvent,
  recordWasReferenced,
} from '../../intelligence/retrieval-feedback.js';
import { applyRetrievalInducedSuppression } from '../../core/hybrid-retrieval.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  db.prepare(
    `INSERT INTO sessions (session_id, status, observation_count, created_at_epoch)
     VALUES ('test-sess', 'active', 0, ?)`
  ).run(Math.floor(Date.now() / 1000));
  return db;
}

function getScore(db: Database.Database, id: number): number {
  const row = db.prepare('SELECT retrieval_score FROM artifacts WHERE id = ?').get(id) as { retrieval_score: number };
  return row.retrieval_score;
}

function getActivation(db: Database.Database, id: number): number {
  const row = db.prepare('SELECT activation_score FROM artifacts WHERE id = ?').get(id) as { activation_score: number };
  return row.activation_score;
}

/** Helper: insert N retrieval events with specified was_referenced values. */
function insertRetrievalEvents(
  db: Database.Database,
  artifactId: number,
  sessionId: string,
  wasReferencedValues: (0 | 1)[],
): void {
  const stmt = db.prepare(
    `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced)
     VALUES (?, ?, ?)`
  );
  for (const val of wasReferencedValues) {
    stmt.run(artifactId, sessionId, val);
  }
}

describe('updateRetrievalScore', () => {
  it('increases score on positive signal', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'decision', null, 'test decision', 'content', 4);
      const before = getScore(db, id);
      updateRetrievalScore(db, id, 0.1);
      const after = getScore(db, id);
      expect(after).toBeGreaterThan(before);
    } finally {
      db.close();
    }
  });

  it('decreases score on negative signal', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'decision', null, 'test', 'content', 4);
      const before = getScore(db, id);
      updateRetrievalScore(db, id, -0.2);
      const after = getScore(db, id);
      expect(after).toBeLessThan(before);
    } finally {
      db.close();
    }
  });

  it('clamps score to [0.1, 3.0]', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'decision', null, 'test', 'content', 4);
      // Repeatedly apply negative signal
      for (let i = 0; i < 100; i++) updateRetrievalScore(db, id, -1.0);
      expect(getScore(db, id)).toBeGreaterThanOrEqual(0.1);

      // Repeatedly apply positive signal
      for (let i = 0; i < 100; i++) updateRetrievalScore(db, id, 1.0);
      expect(getScore(db, id)).toBeLessThanOrEqual(3.0);
    } finally {
      db.close();
    }
  });
});

describe('wasArtifactReferenced', () => {
  it('returns true when output contains artifact keywords', () => {
    const output = 'I used the migration pattern you described to handle the schema changes safely.';
    const summary = 'Migration pattern for safe schema changes';
    expect(wasArtifactReferenced(output, summary)).toBe(true);
  });

  it('returns false when output has no overlap', () => {
    const output = 'The weather is nice today.';
    const summary = 'Migration pattern for safe schema changes';
    expect(wasArtifactReferenced(output, summary)).toBe(false);
  });

  it('handles empty inputs gracefully', () => {
    expect(wasArtifactReferenced('', 'test')).toBe(false);
    expect(wasArtifactReferenced('test', '')).toBe(false);
  });
});

describe('processRetrievalFeedback', () => {
  it('boosts score when artifact is referenced', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'Always use vitest not bun test', 'content', 4);
      const before = getScore(db, id);

      processRetrievalFeedback(
        db,
        [id],
        'I ran vitest as recommended instead of bun test. All tests passed.',
        false,
        new Map([[id, 'Always use vitest not bun test']]),
      );

      expect(getScore(db, id)).toBeGreaterThan(before);
    } finally {
      db.close();
    }
  });

  it('penalizes score on correction with topic overlap', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'decision', null, 'Use sync file I/O for simplicity', 'content', 4);
      const before = getScore(db, id);

      processRetrievalFeedback(
        db,
        [id],
        'Actually sync file I/O blocks the event loop. We need async.',
        true, // correction detected
        new Map([[id, 'Use sync file I/O for simplicity']]),
      );

      expect(getScore(db, id)).toBeLessThan(before);
    } finally {
      db.close();
    }
  });

  it('does NOT penalize when context is simply ignored (no "Ignored" penalty)', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'Never use bun test', 'content', 4);
      const before = getScore(db, id);

      // Output has zero overlap with injected context — but no correction
      processRetrievalFeedback(
        db,
        [id],
        'I implemented the file ingester with async readdir and readFile.',
        false,
        new Map([[id, 'Never use bun test']]),
      );

      // Score should NOT decrease — no "Ignored" penalty
      expect(getScore(db, id)).toBe(before);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Negative Retrieval Learning
// ---------------------------------------------------------------------------

describe('getRetrievalScoreMultiplier — negative learning', () => {
  it('returns base score when fewer than 3 unreferenced retrievals', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'test summary', 'content', 4);
      // Insert 2 unreferenced retrievals (below threshold)
      insertRetrievalEvents(db, id, 'test-sess', [0, 0]);

      const multiplier = getRetrievalScoreMultiplier(db, id);
      const baseScore = getScore(db, id);
      expect(multiplier).toBe(baseScore);
    } finally {
      db.close();
    }
  });

  it('suppresses after 5 unreferenced retrievals (~0.7x)', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'test summary', 'content', 4);
      // 5 unreferenced, 0 referenced → suppression = max(-0.5, -0.1*(5-2)) = -0.3
      // multiplier = 1.0 * (1.0 + (-0.3)) = 0.7
      insertRetrievalEvents(db, id, 'test-sess', [0, 0, 0, 0, 0]);

      const multiplier = getRetrievalScoreMultiplier(db, id);
      // base retrieval_score defaults to 1.0; 1.0 * 0.7 = 0.7
      expect(multiplier).toBeCloseTo(0.7, 1);
    } finally {
      db.close();
    }
  });

  it('floors at 0.5 multiplier for heavily unreferenced artifacts', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'test summary', 'content', 4);
      // 10 unreferenced → suppression = max(-0.5, -0.1*(10-2)) = max(-0.5, -0.8) = -0.5
      // multiplier = 1.0 * (1.0 + (-0.5)) = 0.5 (floor)
      insertRetrievalEvents(db, id, 'test-sess', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

      const multiplier = getRetrievalScoreMultiplier(db, id);
      expect(multiplier).toBeGreaterThanOrEqual(0.5);
    } finally {
      db.close();
    }
  });

  it('no suppression when artifact is always referenced', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'test summary', 'content', 4);
      // 5 referenced, 0 unreferenced → no suppression
      insertRetrievalEvents(db, id, 'test-sess', [1, 1, 1, 1, 1]);

      const multiplier = getRetrievalScoreMultiplier(db, id);
      const baseScore = getScore(db, id);
      // No suppression: unreferenced (0) < threshold (3), so base returned directly
      expect(multiplier).toBe(baseScore);
    } finally {
      db.close();
    }
  });

  it('mild suppression when referenced once among many unreferenced', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'test summary', 'content', 4);
      // 4 unreferenced, 1 referenced
      // suppression = max(-0.5, -0.1*(4-2)) = -0.2
      // ratio = 4 / (4 + 1) = 0.8
      // scaled suppression = -0.2 * 0.8 = -0.16
      // multiplier = 1.0 * (1.0 + (-0.16)) = 0.84
      insertRetrievalEvents(db, id, 'test-sess', [0, 0, 0, 0, 1]);

      const multiplier = getRetrievalScoreMultiplier(db, id);
      // Should be less than 1.0 but more than the pure-unreferenced case
      expect(multiplier).toBeGreaterThan(0.5);
      expect(multiplier).toBeLessThan(1.0);
      expect(multiplier).toBeCloseTo(0.84, 1);
    } finally {
      db.close();
    }
  });

  it('recovery: increasing references lifts suppression', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'test summary', 'content', 4);
      // Start with heavy unreferenced history
      insertRetrievalEvents(db, id, 'test-sess', [0, 0, 0, 0, 0]);
      const suppressedMultiplier = getRetrievalScoreMultiplier(db, id);

      // Now add positive references
      insertRetrievalEvents(db, id, 'test-sess', [1, 1, 1, 1, 1]);
      const recoveredMultiplier = getRetrievalScoreMultiplier(db, id);

      // Recovery: more references → ratio changes → less suppression
      expect(recoveredMultiplier).toBeGreaterThan(suppressedMultiplier);
    } finally {
      db.close();
    }
  });
});

describe('recordWasReferenced', () => {
  it('marks events as referenced when summary tokens match assistant text', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null,
        'migration pattern schema changes database', 'content', 4);

      // Insert retrieval event with NULL was_referenced
      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced)
         VALUES (?, 'test-sess', NULL)`
      ).run(id);

      // Insert conversation turn with matching content
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, assistant_text)
         VALUES ('test-sess', 'proj', 1, 'I used the migration pattern for the database schema changes.')`
      ).run();

      recordWasReferenced(db, 'test-sess');

      const event = db.prepare(
        `SELECT was_referenced FROM retrieval_events WHERE artifact_id = ?`
      ).get(id) as { was_referenced: number };
      expect(event.was_referenced).toBe(1);
    } finally {
      db.close();
    }
  });

  it('marks events as unreferenced when no matching tokens', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null,
        'migration pattern schema changes database', 'content', 4);

      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced)
         VALUES (?, 'test-sess', NULL)`
      ).run(id);

      // Assistant text about a completely different topic
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, assistant_text)
         VALUES ('test-sess', 'proj', 1, 'The weather forecast looks good for tomorrow.')`
      ).run();

      recordWasReferenced(db, 'test-sess');

      const event = db.prepare(
        `SELECT was_referenced FROM retrieval_events WHERE artifact_id = ?`
      ).get(id) as { was_referenced: number };
      expect(event.was_referenced).toBe(0);
    } finally {
      db.close();
    }
  });

  it('marks all as unreferenced when no assistant text exists', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null,
        'some important learning', 'content', 4);

      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced)
         VALUES (?, 'test-sess', NULL)`
      ).run(id);

      // No conversation turns inserted

      recordWasReferenced(db, 'test-sess');

      const event = db.prepare(
        `SELECT was_referenced FROM retrieval_events WHERE artifact_id = ?`
      ).get(id) as { was_referenced: number };
      expect(event.was_referenced).toBe(0);
    } finally {
      db.close();
    }
  });

  it('does not re-score already scored events', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null,
        'test summary tokens here', 'content', 4);

      // Already scored event (was_referenced = 1)
      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced)
         VALUES (?, 'test-sess', 1)`
      ).run(id);

      recordWasReferenced(db, 'test-sess');

      // Should still be 1 — not re-evaluated
      const event = db.prepare(
        `SELECT was_referenced FROM retrieval_events WHERE artifact_id = ?`
      ).get(id) as { was_referenced: number };
      expect(event.was_referenced).toBe(1);
    } finally {
      db.close();
    }
  });

  it('handles missing artifacts gracefully', () => {
    const db = createDb();
    try {
      // Insert retrieval event for non-existent artifact
      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced)
         VALUES (99999, 'test-sess', NULL)`
      ).run();

      // Should not throw
      recordWasReferenced(db, 'test-sess');

      const event = db.prepare(
        `SELECT was_referenced FROM retrieval_events WHERE artifact_id = 99999`
      ).get() as { was_referenced: number };
      expect(event.was_referenced).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('applyRetrievalInducedSuppression (RIF)', () => {
  it('decrements activation for non-selected candidates above RRF threshold', () => {
    const db = createDb();
    try {
      const selectedId = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'selected artifact', 'content', 4);
      const suppressedId = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'suppressed artifact', 'content', 4);

      // Set known activation scores
      db.prepare('UPDATE artifacts SET activation_score = 1.0 WHERE id = ?').run(selectedId);
      db.prepare('UPDATE artifacts SET activation_score = 1.0 WHERE id = ?').run(suppressedId);

      const rrfScores = new Map<number, number>([
        [selectedId, 0.5],    // high score, will be selected
        [suppressedId, 0.15], // above 0.1 threshold, but not selected
      ]);
      const selectedIds = new Set([selectedId]);

      applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

      // Selected artifact unchanged
      expect(getActivation(db, selectedId)).toBe(1.0);
      // Suppressed artifact decremented by 0.03
      expect(getActivation(db, suppressedId)).toBeCloseTo(0.97, 2);
    } finally {
      db.close();
    }
  });

  it('does not suppress candidates below RRF threshold', () => {
    const db = createDb();
    try {
      const belowThresholdId = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'below threshold', 'content', 4);
      db.prepare('UPDATE artifacts SET activation_score = 1.0 WHERE id = ?').run(belowThresholdId);

      const rrfScores = new Map<number, number>([
        [belowThresholdId, 0.005], // below 0.01 threshold
      ]);
      const selectedIds = new Set<number>();

      applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

      // Not suppressed — below threshold
      expect(getActivation(db, belowThresholdId)).toBe(1.0);
    } finally {
      db.close();
    }
  });

  it('respects activation floor of 0.1', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'near floor', 'content', 4);
      db.prepare('UPDATE artifacts SET activation_score = 0.11 WHERE id = ?').run(id);

      const rrfScores = new Map<number, number>([[id, 0.2]]);
      const selectedIds = new Set<number>();

      applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

      // Should not go below 0.1
      expect(getActivation(db, id)).toBeGreaterThanOrEqual(0.1);
    } finally {
      db.close();
    }
  });

  it('accumulates over multiple queries', () => {
    const db = createDb();
    try {
      const id = createArtifact(db, 'test-sess', 'proj', 'learning', null, 'accumulate test', 'content', 4);
      db.prepare('UPDATE artifacts SET activation_score = 1.0 WHERE id = ?').run(id);

      const rrfScores = new Map<number, number>([[id, 0.15]]);
      const selectedIds = new Set<number>();

      // Apply RIF 10 times (simulating 10 queries where this artifact was a candidate but never selected)
      for (let i = 0; i < 10; i++) {
        applyRetrievalInducedSuppression(db, rrfScores, selectedIds);
      }

      // 1.0 - (10 * 0.03) = 0.7
      expect(getActivation(db, id)).toBeCloseTo(0.7, 2);
    } finally {
      db.close();
    }
  });
});
