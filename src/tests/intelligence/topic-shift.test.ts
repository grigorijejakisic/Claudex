import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { upsertThreadState } from '../../core/thread.js';
import { TopicShiftDetector } from '../../intelligence/topic-shift.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { cosineSimilarity } from '../../embeddings/cosine.js';

describe('topic-shift detection', () => {
  let db: TestDatabase;
  const sessionId = 'test-session';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  /** Set topic in thread state for the test session. */
  function setTopic(topic: string) {
    upsertThreadState(db, { session_id: sessionId, topic, summary: topic });
  }

  /** Create a mock embedding provider. */
  function createMockProvider(embedFn: (text: string) => number[] | null): EmbeddingProvider {
    const provider = new EmbeddingProvider();
    (provider as any).available = true;
    provider.embed = async (text: string) => embedFn(text);
    return provider;
  }

  // --- Layer 1: Explicit pivot ---

  describe('Layer 1 — explicit pivot', () => {
    it('detects "now let\'s work on the API" as explicit shift', async () => {
      setTopic('database implementation');
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: "now let's work on the API",
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('explicit');
      expect(result.confidence).toBe(1.0);
    });

    it('detects "switch to the frontend" as explicit shift', async () => {
      setTopic('backend services');
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: 'switch to the frontend components',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('explicit');
    });

    it('detects "back to the parser" as explicit shift', async () => {
      setTopic('testing');
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: 'back to the parser module',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('explicit');
    });

    it('detects "actually, let\'s focus on testing" as explicit shift', async () => {
      setTopic('parser implementation');
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: "actually, let's focus on testing now",
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('explicit');
    });

    it('does not fire on regular question "can you fix this?"', async () => {
      setTopic('database implementation');
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: 'can you fix this bug in the database module?',
        db,
        sessionId,
      });
      // Might fire on Layer 3 Jaccard depending on overlap, but NOT on Layer 1
      if (result.shifted) {
        expect(result.method).not.toBe('explicit');
      }
    });
  });

  // --- Layer 2: Embedding similarity ---

  describe('Layer 2 — embedding similarity', () => {
    it('detects shift when similarity < 0.35 and avgRecent < 0.40', async () => {
      setTopic('database storage implementation');

      // Mock: topic and prompt have very different embeddings
      const provider = createMockProvider((text: string) => {
        if (text.includes('database')) return [1, 0, 0, 0, 0];
        return [0, 0, 0, 0, 1]; // Very different direction
      });

      const detector = new TopicShiftDetector(provider);
      const result = await detector.detectTopicShift({
        prompt: 'deploy the frontend to production now',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('embedding');
    });

    it('does not fire when similarity > 0.35', async () => {
      setTopic('database storage implementation');

      // Mock: similar embeddings
      const provider = createMockProvider(() => [1, 0, 0, 0, 0]);

      const detector = new TopicShiftDetector(provider);
      const result = await detector.detectTopicShift({
        prompt: 'add an index to the database table',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(false);
    });

    it('does not fire when avgRecent > 0.40 despite low topic similarity', async () => {
      setTopic('database storage implementation');

      let callCount = 0;
      const provider = createMockProvider((text: string) => {
        callCount++;
        if (text.includes('database')) return [1, 0, 0, 0, 0]; // topic
        // All prompts are similar to each other but different from topic
        return [0, 0.8, 0.6, 0, 0]; // Similar to each other
      });

      const detector = new TopicShiftDetector(provider);

      // Fill window with similar prompts
      await detector.detectTopicShift({ prompt: 'working on frontend auth', db, sessionId });
      await detector.detectTopicShift({ prompt: 'fixing frontend auth bugs', db, sessionId });

      // Third prompt — similar to recent, so avgRecent should be high
      const result = await detector.detectTopicShift({
        prompt: 'more frontend auth work needed',
        db,
        sessionId,
      });
      // avgRecent of similar prompts should be > 0.40
      expect(result.shifted).toBe(false);
    });

    it('uses cached topic embedding on second call with same topic', async () => {
      setTopic('database storage');

      let embedCallCount = 0;
      const provider = createMockProvider((text: string) => {
        embedCallCount++;
        return [1, 0, 0, 0, 0];
      });

      const detector = new TopicShiftDetector(provider);
      await detector.detectTopicShift({ prompt: 'query A', db, sessionId });
      const firstCount = embedCallCount;
      await detector.detectTopicShift({ prompt: 'query B', db, sessionId });
      // Second call should NOT re-embed topic (cached)
      // embed is called for: topic (once, cached), prompt A, prompt B = 3 total
      expect(embedCallCount).toBe(firstCount + 1); // only prompt B added
    });

    it('invalidates topic cache on detected shift', async () => {
      setTopic('database storage');

      const provider = createMockProvider((text: string) => {
        if (text === 'database storage') return [1, 0, 0, 0, 0];
        return [0, 0, 0, 0, 1]; // Very different
      });

      const detector = new TopicShiftDetector(provider);
      const result = await detector.detectTopicShift({
        prompt: 'deploy to production now',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      // Cache should be invalidated (internal state)
      expect((detector as any).topicEmbeddingCache).toBeNull();
    });

    it('maintains sliding window of last 3 prompt embeddings', async () => {
      setTopic('database storage');

      const provider = createMockProvider(() => [1, 0, 0, 0, 0]);

      const detector = new TopicShiftDetector(provider);
      await detector.detectTopicShift({ prompt: 'q1', db, sessionId });
      await detector.detectTopicShift({ prompt: 'q2', db, sessionId });
      await detector.detectTopicShift({ prompt: 'q3', db, sessionId });
      await detector.detectTopicShift({ prompt: 'q4', db, sessionId });

      // Window should be 3, not 4
      expect((detector as any).recentPromptEmbeddings.length).toBe(3);
    });
  });

  // --- Layer 3: Jaccard fallback ---

  describe('Layer 3 — Jaccard fallback', () => {
    it('falls back to Jaccard when provider is null', async () => {
      setTopic('database storage implementation');
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: 'completely unrelated topic about cooking recipes and food preparation',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('jaccard');
    });

    it('detects shift when Jaccard overlap < 0.15', async () => {
      setTopic('database storage implementation');
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: 'deploy frontend application to production server environment',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('jaccard');
    });

    it('does not fire when Jaccard overlap >= 0.15', async () => {
      setTopic('database storage implementation');
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: 'fix the database storage migration implementation',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(false);
    });

    it('falls back to Jaccard when embed call returns null', async () => {
      setTopic('database storage implementation');

      const provider = createMockProvider(() => null);
      const detector = new TopicShiftDetector(provider);
      const result = await detector.detectTopicShift({
        prompt: 'completely unrelated cooking topic with no keyword overlap whatsoever',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('jaccard');
    });
  });

  // --- Graceful degradation ---

  describe('graceful degradation', () => {
    it('returns { shifted: false } when no topic set in thread state', async () => {
      // Thread state exists but no topic
      upsertThreadState(db, { session_id: sessionId, summary: 'something' });
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: 'anything goes here',
        db,
        sessionId,
      });
      expect(result.shifted).toBe(false);
    });

    it('returns { shifted: false } when thread state not found', async () => {
      // No thread state at all
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: 'anything goes here',
        db,
        sessionId,
      });
      // Layer 1 won't match, no topic for Layer 2/3 → shifted: false
      expect(result.shifted).toBe(false);
    });

    it('is non-throwing on all error paths', async () => {
      db.close();
      const detector = new TopicShiftDetector(null);
      const result = await detector.detectTopicShift({
        prompt: "now let's shift topic",
        db,
        sessionId,
      });
      // Either catches error or returns false
      expect(result).toBeDefined();
      expect(typeof result.shifted).toBe('boolean');
      // Reopen for afterEach
      db = createTestDb();
    });
  });

  // --- Config flag enforcement ---

  describe('config flag — embeddingsEnabled', () => {
    it('skips embedding layer and falls back to Jaccard when embeddingsEnabled=false', async () => {
      setTopic('database storage implementation');

      let embedCalled = false;
      const provider = createMockProvider((text: string) => {
        embedCalled = true;
        return [1, 0, 0, 0, 0];
      });

      const detector = new TopicShiftDetector(provider);
      const result = await detector.detectTopicShift({
        prompt: 'completely unrelated cooking topic with no keyword overlap whatsoever',
        db,
        sessionId,
        config: { embeddingsEnabled: false },
      });
      // Should NOT have called embed — provider was bypassed
      expect(embedCalled).toBe(false);
      // Should use Jaccard fallback
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('jaccard');
    });

    it('still uses embeddings when embeddingsEnabled is not set (defaults to true)', async () => {
      setTopic('database storage implementation');

      let embedCalled = false;
      const provider = createMockProvider((text: string) => {
        embedCalled = true;
        if (text.includes('database')) return [1, 0, 0, 0, 0];
        return [0, 0, 0, 0, 1];
      });

      const detector = new TopicShiftDetector(provider);
      await detector.detectTopicShift({
        prompt: 'deploy the frontend to production now',
        db,
        sessionId,
      });
      expect(embedCalled).toBe(true);
    });

    it('still detects explicit pivots even when embeddingsEnabled=false', async () => {
      setTopic('database implementation');
      const provider = createMockProvider(() => [1, 0, 0, 0, 0]);
      const detector = new TopicShiftDetector(provider);
      const result = await detector.detectTopicShift({
        prompt: "now let's work on the API",
        db,
        sessionId,
        config: { embeddingsEnabled: false },
      });
      expect(result.shifted).toBe(true);
      expect(result.method).toBe('explicit');
    });
  });

  describe('clearCache', () => {
    it('clears topic cache and recent prompt window', async () => {
      setTopic('database storage');

      const provider = createMockProvider(() => [1, 0, 0, 0, 0]);
      const detector = new TopicShiftDetector(provider);

      await detector.detectTopicShift({ prompt: 'query', db, sessionId });
      expect((detector as any).recentPromptEmbeddings.length).toBeGreaterThan(0);

      detector.clearCache();
      expect((detector as any).recentPromptEmbeddings).toHaveLength(0);
      expect((detector as any).topicEmbeddingCache).toBeNull();
    });
  });
});
