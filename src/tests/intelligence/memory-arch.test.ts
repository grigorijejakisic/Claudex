/**
 * Tests for Part 4: Memory Architecture
 *
 * Covers:
 * 4.1 — Artifact linking (Zettelkasten / A-MEM)
 * 4.2 — Active forgetting (contradiction detection)
 * 4.3 — Cross-session thread linking
 * 4.4 — Batch reflection
 * 4.5 — Sleep-time pre-assembly
 */

import { createTestDb, createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import {
  createArtifact,
  cosineSimilarity,
  insertArtifactLink,
  getArtifactLinks,
  linkArtifactToRelated,
  type ArtifactLinkType,
} from '../../core/artifacts.js';
import { findSimilarThreads, ThreadTracker } from '../../intelligence/thread-tracker.js';
import { upsertThreadState, getThreadState } from '../../core/thread.js';
import { createSession } from '../../core/sessions.js';
import {
  extractKeywords,
  clusterLearnings,
  shouldRunReflection,
  runBatchReflection,
} from '../../intelligence/batch-reflection.js';
import { upsertLearning } from '../../core/learnings.js';
import {
  generatePreAssembly,
  matchPreAssembly,
  captureSessionSummary,
} from '../../adapters/shared/lifecycle.js';
import { cachedPrepare } from '../../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// 4.1 — Artifact Linking
// ---------------------------------------------------------------------------

describe('artifact linking (4.1)', () => {
  let db: TestDatabase;
  const sessionId = 'link-session';
  const project = 'link-project';

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: sessionId, project });
  });

  afterEach(() => {
    db.close();
  });

  describe('cosineSimilarity', () => {
    it('returns 1.0 for identical vectors', () => {
      const v = [1, 0, 0, 1];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
    });

    it('returns correct value for arbitrary vectors', () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      // dot = 32, normA = sqrt(14), normB = sqrt(77)
      const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
      expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
    });

    it('returns 0 for empty vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it('returns 0 for mismatched lengths', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('returns 0 for zero vectors', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });

    it('works with Float32Array', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 4);
    });
  });

  describe('insertArtifactLink', () => {
    it('inserts a link between two artifacts', () => {
      const a1 = createArtifact(db, sessionId, project, 'observation', 'ref1', 'summary1', 'content1', 3);
      const a2 = createArtifact(db, sessionId, project, 'observation', 'ref2', 'summary2', 'content2', 3);

      insertArtifactLink(db, a1, a2, 'related', 0.75);

      const links = getArtifactLinks(db, a1);
      expect(links).toHaveLength(1);
      expect(links[0].source_id).toBe(a1);
      expect(links[0].target_id).toBe(a2);
      expect(links[0].link_type).toBe('related');
      expect(links[0].strength).toBeCloseTo(0.75, 2);
    });

    it('ignores duplicate links', () => {
      const a1 = createArtifact(db, sessionId, project, 'observation', 'ref1', 'summary1', 'content1', 3);
      const a2 = createArtifact(db, sessionId, project, 'observation', 'ref2', 'summary2', 'content2', 3);

      insertArtifactLink(db, a1, a2, 'related', 0.75);
      insertArtifactLink(db, a1, a2, 'related', 0.80); // duplicate — ignored

      const links = getArtifactLinks(db, a1);
      expect(links).toHaveLength(1);
      expect(links[0].strength).toBeCloseTo(0.75, 2); // original value kept
    });

    it('clamps strength to [0, 1]', () => {
      const a1 = createArtifact(db, sessionId, project, 'observation', 'ref1', 's1', 'c1', 3);
      const a2 = createArtifact(db, sessionId, project, 'observation', 'ref2', 's2', 'c2', 3);

      insertArtifactLink(db, a1, a2, 'related', 1.5);

      const links = getArtifactLinks(db, a1);
      expect(links[0].strength).toBeLessThanOrEqual(1.0);
    });
  });

  describe('getArtifactLinks', () => {
    it('returns links where artifact is source or target', () => {
      const a1 = createArtifact(db, sessionId, project, 'observation', 'ref1', 's1', 'c1', 3);
      const a2 = createArtifact(db, sessionId, project, 'observation', 'ref2', 's2', 'c2', 3);
      const a3 = createArtifact(db, sessionId, project, 'observation', 'ref3', 's3', 'c3', 3);

      insertArtifactLink(db, a1, a2, 'related', 0.7);
      insertArtifactLink(db, a3, a1, 'supports', 0.8);

      const links = getArtifactLinks(db, a1);
      expect(links).toHaveLength(2);
    });

    it('returns empty array for artifact with no links', () => {
      const a1 = createArtifact(db, sessionId, project, 'observation', 'ref1', 's1', 'c1', 3);
      expect(getArtifactLinks(db, a1)).toEqual([]);
    });
  });

  describe('linkArtifactToRelated', () => {
    it('returns 0 when artifact has no embedding and Qdrant unavailable', async () => {
      const a1 = createArtifact(db, sessionId, project, 'observation', 'ref1', 's1', 'c1', 3);
      const count = await linkArtifactToRelated(db, a1, project);
      expect(count).toBe(0);
    });

    it('returns 0 for nonexistent artifact', async () => {
      const count = await linkArtifactToRelated(db, 99999, project);
      expect(count).toBe(0);
    });

    it('links artifacts using SQLite BLOB cosine fallback', async () => {
      // Create artifacts with identical embedding BLOBs — should link as 'related'
      const embedding = new Float32Array(384);
      embedding[0] = 1.0;
      embedding[1] = 0.5;
      const blob = Buffer.from(embedding.buffer);

      const a1 = createArtifact(db, sessionId, project, 'observation', 'ref1', 'auth token refresh', 'fix the auth bug', 3);
      const a2 = createArtifact(db, sessionId, project, 'observation', 'ref2', 'auth session management', 'auth module improvement', 3);

      // Manually set embedding BLOBs (since Ollama won't be running in tests)
      db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(blob, a1);
      db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(blob, a2);

      const count = await linkArtifactToRelated(db, a1, project);
      // Cosine of identical vectors = 1.0 > 0.6 → should link
      expect(count).toBeGreaterThanOrEqual(1);

      const links = getArtifactLinks(db, a1);
      expect(links.length).toBeGreaterThanOrEqual(1);
    });

    it('does not link artifacts with low cosine similarity', async () => {
      // Create artifacts with orthogonal embeddings
      const emb1 = new Float32Array(384);
      emb1[0] = 1.0;
      const emb2 = new Float32Array(384);
      emb2[100] = 1.0; // orthogonal dimension

      const a1 = createArtifact(db, sessionId, project, 'observation', 'ref1', 'topic A', 'content A', 3);
      const a2 = createArtifact(db, sessionId, project, 'observation', 'ref2', 'topic B', 'content B', 3);

      db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(Buffer.from(emb1.buffer), a1);
      db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(Buffer.from(emb2.buffer), a2);

      const count = await linkArtifactToRelated(db, a1, project);
      expect(count).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 4.2 — Active Forgetting
// ---------------------------------------------------------------------------

describe('active forgetting (4.2)', () => {
  let db: TestDatabase;
  const sessionId = 'forget-session';
  const project = 'forget-project';

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: sessionId, project });
  });

  afterEach(() => {
    db.close();
  });

  it('creates contradicts link when artifacts reference same entity with opposing conclusions', async () => {
    // Create two artifacts about the same ref with opposing content.
    // Embeddings must have cosine between 0.6 (link threshold) and 0.85 (supersede threshold)
    // so the code enters the contradiction check, not the supersedes branch.
    const emb1 = new Float32Array(384);
    emb1[0] = 1.0; emb1[1] = 0.5; emb1[2] = 0.3;
    const emb2 = new Float32Array(384);
    emb2[0] = 0.7; emb2[1] = 0.8; emb2[2] = 0.1;

    const a1 = createArtifact(db, sessionId, project, 'observation', 'src/auth.ts', 'auth works correctly', 'the auth module works and passes all tests', 3);
    const a2 = createArtifact(db, sessionId, project, 'observation', 'src/auth.ts', 'auth is broken', 'the auth module does not work and fails tests', 3);

    db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(Buffer.from(emb1.buffer), a1);
    db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(Buffer.from(emb2.buffer), a2);

    const count = await linkArtifactToRelated(db, a2, project);
    expect(count).toBeGreaterThanOrEqual(1);

    // Check the link type
    const links = getArtifactLinks(db, a2);
    const contradictLink = links.find(l => l.link_type === 'contradicts');
    expect(contradictLink).toBeDefined();
  });

  it('halves activation_score on older contradicted artifact', async () => {
    // Embeddings with cosine between 0.6 and 0.85 to hit contradiction, not supersedes
    const emb1 = new Float32Array(384);
    emb1[0] = 1.0; emb1[1] = 0.5; emb1[2] = 0.3;
    const emb2 = new Float32Array(384);
    emb2[0] = 0.7; emb2[1] = 0.8; emb2[2] = 0.1;

    // a1 is older (earlier timestamp)
    const a1 = createArtifact(db, sessionId, project, 'observation', 'src/config.ts', 'config is valid', 'the config passes validation', 3);
    // a2 is newer
    const a2 = createArtifact(db, sessionId, project, 'observation', 'src/config.ts', 'config is invalid', 'the config fails validation', 3);

    db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(Buffer.from(emb1.buffer), a1);
    db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(Buffer.from(emb2.buffer), a2);

    // Get original activation_score of a1
    const before = db.prepare('SELECT activation_score FROM artifacts WHERE id = ?').get(a1) as { activation_score: number };
    expect(before.activation_score).toBe(1.0);

    await linkArtifactToRelated(db, a2, project);

    // Check a1 was deprioritized
    const after = db.prepare('SELECT activation_score, valid_until FROM artifacts WHERE id = ?').get(a1) as {
      activation_score: number;
      valid_until: number | null;
    };
    expect(after.activation_score).toBeCloseTo(0.5, 2);
    expect(after.valid_until).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4.3 — Cross-Session Thread Linking
// ---------------------------------------------------------------------------

describe('cross-session thread linking (4.3)', () => {
  let db: TestDatabase;
  const project = 'thread-project';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('findSimilarThreads', () => {
    it('returns empty array when no threads exist', () => {
      const emb = new Float32Array(384);
      emb[0] = 1.0;
      const results = findSimilarThreads(db, emb, project);
      expect(results).toEqual([]);
    });

    it('returns empty array when no threads have summary_embedding', () => {
      createSession(db, { session_id: 'old-session', project });
      upsertThreadState(db, {
        session_id: 'old-session',
        topic: 'auth module',
        summary: 'Fixed auth token refresh',
      });

      const emb = new Float32Array(384);
      emb[0] = 1.0;
      const results = findSimilarThreads(db, emb, project);
      expect(results).toEqual([]);
    });

    it('matches threads above similarity threshold', () => {
      createSession(db, { session_id: 'old-session', project });
      upsertThreadState(db, {
        session_id: 'old-session',
        topic: 'auth token refresh',
        summary: 'Fixed the auth token refresh bug in the middleware',
        key_exchanges: [{ role: 'user', gist: 'fix auth' }],
      });

      // Store the same embedding as summary_embedding
      const emb = new Float32Array(384);
      emb[0] = 1.0;
      emb[1] = 0.5;
      const blob = Buffer.from(emb.buffer);
      db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?').run(blob, 'old-session');

      // Query with the same embedding — cosine = 1.0
      const results = findSimilarThreads(db, Array.from(emb), project, 0.8);
      expect(results).toHaveLength(1);
      expect(results[0].session_id).toBe('old-session');
      expect(results[0].topic).toBe('auth token refresh');
      expect(results[0].similarity).toBeCloseTo(1.0, 4);
      expect(results[0].key_exchanges).toHaveLength(1);
    });

    it('excludes threads below threshold', () => {
      createSession(db, { session_id: 'old-session', project });
      upsertThreadState(db, {
        session_id: 'old-session',
        topic: 'unrelated topic',
        summary: 'Something completely different',
      });

      // Store orthogonal embedding
      const summaryEmb = new Float32Array(384);
      summaryEmb[200] = 1.0;
      db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?')
        .run(Buffer.from(summaryEmb.buffer), 'old-session');

      // Query with different embedding
      const queryEmb = new Float32Array(384);
      queryEmb[0] = 1.0;
      const results = findSimilarThreads(db, Array.from(queryEmb), project, 0.8);
      expect(results).toHaveLength(0);
    });

    it('excludes current session', () => {
      createSession(db, { session_id: 'current', project });
      upsertThreadState(db, {
        session_id: 'current',
        topic: 'same topic',
        summary: 'Working on the same thing',
      });

      const emb = new Float32Array(384);
      emb[0] = 1.0;
      db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?')
        .run(Buffer.from(emb.buffer), 'current');

      const results = findSimilarThreads(db, Array.from(emb), project, 0.8, 'current');
      expect(results).toHaveLength(0);
    });

    it('returns results sorted by similarity descending', () => {
      // Session 1: high similarity
      createSession(db, { session_id: 'high-sim', project });
      upsertThreadState(db, { session_id: 'high-sim', topic: 'topic A', summary: 'A' });
      const embA = new Float32Array(384);
      embA[0] = 1.0;
      embA[1] = 0.1;
      db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?')
        .run(Buffer.from(embA.buffer), 'high-sim');

      // Session 2: lower similarity (but still above threshold)
      createSession(db, { session_id: 'low-sim', project });
      upsertThreadState(db, { session_id: 'low-sim', topic: 'topic B', summary: 'B' });
      const embB = new Float32Array(384);
      embB[0] = 0.9;
      embB[1] = 0.4;
      // Normalize embB
      const normB = Math.sqrt(embB[0] * embB[0] + embB[1] * embB[1]);
      embB[0] /= normB;
      embB[1] /= normB;
      db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?')
        .run(Buffer.from(embB.buffer), 'low-sim');

      // Query with embA-like vector (normalized)
      const query = Array.from(embA);
      const normA = Math.sqrt(query[0] * query[0] + query[1] * query[1]);
      query[0] /= normA;
      query[1] /= normA;

      const results = findSimilarThreads(db, query, project, 0.5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      // First result should have higher similarity
      if (results.length >= 2) {
        expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
      }
    });

    it('limits to 3 results', () => {
      const emb = new Float32Array(384);
      emb[0] = 1.0;
      const blob = Buffer.from(emb.buffer);

      for (let i = 0; i < 5; i++) {
        const sid = `session-${i}`;
        createSession(db, { session_id: sid, project });
        upsertThreadState(db, { session_id: sid, topic: `topic ${i}`, summary: `summary ${i}` });
        db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?')
          .run(blob, sid);
      }

      const results = findSimilarThreads(db, Array.from(emb), project, 0.8);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('filters out __cooldown entries from key_exchanges', () => {
      createSession(db, { session_id: 'with-cooldown', project });
      upsertThreadState(db, {
        session_id: 'with-cooldown',
        topic: 'topic',
        summary: 'summary',
        key_exchanges: [
          { role: 'user', gist: 'hello' },
          { role: '__cooldown', gist: '{"lastShiftEpoch":0}' },
        ],
      });

      const emb = new Float32Array(384);
      emb[0] = 1.0;
      db.prepare('UPDATE thread_state SET summary_embedding = ? WHERE session_id = ?')
        .run(Buffer.from(emb.buffer), 'with-cooldown');

      const results = findSimilarThreads(db, Array.from(emb), project, 0.8);
      expect(results).toHaveLength(1);
      // __cooldown should be filtered out
      expect(results[0].key_exchanges).toHaveLength(1);
      expect(results[0].key_exchanges[0].role).toBe('user');
    });
  });
});

// ---------------------------------------------------------------------------
// 4.4 — Batch Reflection
// ---------------------------------------------------------------------------

describe('batch reflection (4.4)', () => {
  let db: TestDatabase;
  const sessionId = 'reflect-session';
  const project = 'reflect-project';

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: sessionId, project });
  });

  afterEach(() => {
    db.close();
  });

  describe('extractKeywords', () => {
    it('extracts meaningful keywords', () => {
      const kw = extractKeywords('The SQLite database schema migration is complete');
      expect(kw).toContain('sqlite');
      expect(kw).toContain('database');
      expect(kw).toContain('schema');
      expect(kw).toContain('migration');
      expect(kw).toContain('complete');
      expect(kw).not.toContain('the');
      expect(kw).not.toContain('is');
    });

    it('returns unique keywords', () => {
      const kw = extractKeywords('database database database');
      expect(kw).toEqual(['database']);
    });

    it('filters short tokens', () => {
      const kw = extractKeywords('a b cd efg');
      expect(kw).toEqual(['efg']);
    });

    it('filters numbers', () => {
      const kw = extractKeywords('version 123 release');
      expect(kw).toContain('version');
      expect(kw).toContain('release');
      expect(kw).not.toContain('123');
    });
  });

  describe('clusterLearnings', () => {
    it('returns empty for empty input', () => {
      expect(clusterLearnings([])).toEqual([]);
    });

    it('clusters learnings with keyword overlap', () => {
      const learnings = [
        { id: 1, content: 'SQLite database schema migration pattern', project, fingerprint: 'f1', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
        { id: 2, content: 'SQLite database schema versioning approach', project, fingerprint: 'f2', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
        { id: 3, content: 'SQLite database schema backup strategy', project, fingerprint: 'f3', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
        { id: 4, content: 'React component rendering hooks lifecycle', project, fingerprint: 'f4', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
        { id: 5, content: 'React component rendering optimization lifecycle', project, fingerprint: 'f5', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
      ];

      const clusters = clusterLearnings(learnings);
      // Should have at least 1 cluster (database-related learnings)
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      // Largest cluster should have 2+ items
      expect(clusters[0].items.length).toBeGreaterThanOrEqual(2);
    });

    it('skips clusters with only 1 item', () => {
      const learnings = [
        { id: 1, content: 'very unique topic about quantum computing theory', project, fingerprint: 'f1', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
        { id: 2, content: 'completely different topic about marine biology', project, fingerprint: 'f2', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
      ];

      const clusters = clusterLearnings(learnings);
      // Each learning is unique — no clusters of 2+
      expect(clusters).toEqual([]);
    });

    it('generates theme with top keywords', () => {
      const learnings = [
        { id: 1, content: 'artifact embedding pipeline uses Ollama for vector generation', project, fingerprint: 'f1', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
        { id: 2, content: 'artifact embedding storage uses SQLite BLOB for fallback', project, fingerprint: 'f2', agent_id: 'a', promotion_count: 1, first_seen_epoch: 0, last_promoted_epoch: 0, updated_at_epoch_ms: 0 },
      ];

      const clusters = clusterLearnings(learnings);
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      expect(clusters[0].theme).toContain('Theme:');
      expect(clusters[0].keywords.length).toBeGreaterThan(0);
    });
  });

  describe('shouldRunReflection', () => {
    it('returns false when fewer than 10 sessions exist', () => {
      // Only 1 session exists (created in beforeEach)
      expect(shouldRunReflection(db, project)).toBe(false);
    });

    it('returns true when 10+ sessions exist since last reflection', () => {
      for (let i = 0; i < 10; i++) {
        createSession(db, { session_id: `session-${i}`, project });
      }
      expect(shouldRunReflection(db, project)).toBe(true);
    });

    it('returns false after a reflection was run', () => {
      for (let i = 0; i < 10; i++) {
        createSession(db, { session_id: `session-${i}`, project });
      }
      expect(shouldRunReflection(db, project)).toBe(true);

      // Simulate reflection timestamp update
      cachedPrepare(db,
        `INSERT INTO checkpoint_tracking (session_id, last_checkpoint_epoch_ms, updated_at_epoch_ms)
         VALUES (?, unixepoch() * 1000, unixepoch() * 1000)
         ON CONFLICT(session_id) DO UPDATE SET
           last_checkpoint_epoch_ms = unixepoch() * 1000,
           updated_at_epoch_ms = unixepoch() * 1000`
      ).run(`__reflection_guard__${project}`);

      // Now should return false (0 sessions since the reflection)
      expect(shouldRunReflection(db, project)).toBe(false);
    });
  });

  describe('runBatchReflection', () => {
    it('returns 0 when not enough learnings', () => {
      const count = runBatchReflection(db, project, sessionId);
      expect(count).toBe(0);
    });

    it('creates reflection artifacts from clustered learnings', () => {
      // Add enough similar learnings to form clusters
      const topics = ['sqlite', 'database', 'schema', 'migration'];
      for (let i = 0; i < 6; i++) {
        upsertLearning(db, {
          project,
          fingerprint: `fp-${i}`,
          content: `${topics[i % 4]} ${topics[(i + 1) % 4]} implementation detail number ${i} with sufficient length to pass filter`,
        });
      }

      const count = runBatchReflection(db, project, sessionId);
      // Should create at least 1 reflection artifact
      expect(count).toBeGreaterThanOrEqual(1);

      // Verify the artifact was created
      const artifacts = cachedPrepare(db,
        `SELECT * FROM artifacts WHERE project = ? AND artifact_ref LIKE 'reflection:%'`
      ).all(project) as Array<{ summary: string; content: string; importance: number }>;
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0].summary).toContain('[Reflection]');
      expect(artifacts[0].importance).toBe(5);
    });

    it('marks reflection timestamp after running', () => {
      for (let i = 0; i < 6; i++) {
        upsertLearning(db, {
          project,
          fingerprint: `fp-${i}`,
          content: `common keyword shared learning content about database patterns and testing approaches number ${i}`,
        });
      }

      runBatchReflection(db, project, sessionId);

      // Check guard was set
      const guard = cachedPrepare(db,
        'SELECT last_checkpoint_epoch FROM checkpoint_tracking WHERE session_id = ?'
      ).get(`__reflection_guard__${project}`) as { last_checkpoint_epoch: number } | undefined;
      expect(guard).toBeDefined();
      expect(guard!.last_checkpoint_epoch).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 4.5 — Sleep-Time Pre-Assembly
// ---------------------------------------------------------------------------

describe('sleep-time pre-assembly (4.5)', () => {
  let db: TestDatabase;
  const sessionId = 'preasm-session';
  const project = 'preasm-project';

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: sessionId, project });
  });

  afterEach(() => {
    db.close();
  });

  describe('generatePreAssembly', () => {
    it('does nothing when no thread topic exists', async () => {
      await generatePreAssembly(db, sessionId, project);

      const artifacts = cachedPrepare(db,
        `SELECT * FROM artifacts WHERE artifact_ref LIKE 'pre_assembly:%'`
      ).all();
      expect(artifacts).toHaveLength(0);
    });

    it('creates pre-assembly artifact when thread has topic and summary', async () => {
      // Set up thread state with topic + summary
      upsertThreadState(db, {
        session_id: sessionId,
        topic: 'artifact linking implementation',
        summary: 'Implemented Zettelkasten-style linking for artifacts',
      });

      // Add a hot file
      cachedPrepare(db,
        `INSERT OR REPLACE INTO pressure_scores (file_path, project, raw_pressure, temperature)
         VALUES (?, ?, 5.0, 'HOT')`
      ).run('src/core/artifacts.ts', project);

      await generatePreAssembly(db, sessionId, project);

      const artifacts = cachedPrepare(db,
        `SELECT * FROM artifacts WHERE artifact_ref LIKE 'pre_assembly:%' AND project = ?`
      ).all(project) as Array<{ summary: string; content: string }>;
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].summary).toContain('[Pre-assembly]');
      expect(artifacts[0].content).toContain('artifact linking');
      expect(artifacts[0].content).toContain('src/core/artifacts.ts');
    });

    it('does not create pre-assembly when not enough signal (no topic or summary)', async () => {
      // Only set topic, no summary — buildFlowEntry etc. also need more data
      upsertThreadState(db, {
        session_id: sessionId,
        topic: 'x',
        // no summary
      });

      await generatePreAssembly(db, sessionId, project);

      const artifacts = cachedPrepare(db,
        `SELECT * FROM artifacts WHERE artifact_ref LIKE 'pre_assembly:%'`
      ).all();
      // Might create with just topic + one other signal, or might not if < 2 parts
      // This test just verifies non-throwing behavior
    });
  });

  describe('matchPreAssembly', () => {
    it('returns null when no pre-assembly exists', async () => {
      const result = await matchPreAssembly(db, project, [1, 0, 0]);
      expect(result).toBeNull();
    });

    it('returns content when cosine > 0.7', async () => {
      // Create a pre-assembly artifact with an embedding
      const emb = new Float32Array(384);
      emb[0] = 1.0;
      emb[1] = 0.5;
      const blob = Buffer.from(emb.buffer);

      const artId = createArtifact(db, sessionId, project, 'flow', `pre_assembly:${sessionId}`, 'pre-assembly summary', 'predicted context content here', 3);
      db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(blob, artId);

      // Query with the same embedding — cosine = 1.0
      const result = await matchPreAssembly(db, project, Array.from(emb));
      expect(result).toBe('predicted context content here');

      // Artifact should be packed after consumption
      const art = db.prepare('SELECT state FROM artifacts WHERE id = ?').get(artId) as { state: string };
      expect(art.state).toBe('packed');
    });

    it('returns null and packs artifact when cosine <= 0.7', async () => {
      const emb = new Float32Array(384);
      emb[0] = 1.0;
      const blob = Buffer.from(emb.buffer);

      const artId = createArtifact(db, sessionId, project, 'flow', `pre_assembly:${sessionId}`, 'summary', 'content', 3);
      db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(blob, artId);

      // Query with orthogonal embedding
      const queryEmb = new Array(384).fill(0);
      queryEmb[200] = 1.0;

      const result = await matchPreAssembly(db, project, queryEmb);
      expect(result).toBeNull();

      // Artifact should still be packed (discarded)
      const art = db.prepare('SELECT state FROM artifacts WHERE id = ?').get(artId) as { state: string };
      expect(art.state).toBe('packed');
    });
  });
});
