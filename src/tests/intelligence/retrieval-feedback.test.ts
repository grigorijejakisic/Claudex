/**
 * Tests for retrieval feedback (implicit scoring of injected context).
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { createArtifact } from '../../core/artifacts.js';
import {
  updateRetrievalScore,
  wasArtifactReferenced,
  processRetrievalFeedback,
} from '../../intelligence/retrieval-feedback.js';

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
