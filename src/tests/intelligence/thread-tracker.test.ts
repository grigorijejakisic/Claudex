import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { getThreadState } from '../../core/thread.js';
import { ThreadTracker, extractGist, extractTopic } from '../../intelligence/thread-tracker.js';

describe('thread tracker', () => {
  let db: TestDatabase;
  const sessionId = 'test-session';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // --- Construction/init ---

  describe('construction', () => {
    it('initializes with empty state for new session', () => {
      const tracker = new ThreadTracker(db, sessionId);
      expect(tracker.getTopic()).toBeNull();
      expect(tracker.getKeyExchanges()).toEqual([]);
      expect(tracker.getSummary()).toBeNull();
    });

    it('restores existing state from DB', () => {
      // Set up state first
      const t1 = new ThreadTracker(db, sessionId);
      t1.onAfterTurn('Fix the auth token refresh bug', 'Found the stale snapshot issue in the auth module.');
      expect(t1.getTopic()).not.toBeNull();

      // New tracker should restore
      const t2 = new ThreadTracker(db, sessionId);
      expect(t2.getTopic()).toBe(t1.getTopic());
      expect(t2.getKeyExchanges().length).toBeGreaterThan(0);
    });
  });

  // --- onAfterTool ---

  describe('onAfterTool', () => {
    it('accumulates user text and tool action in pending buffer', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTool('Fix the bug', 'Read', { file_path: 'src/auth.ts' });
      // Buffer is internal — verified via onAfterTurn flush
      tracker.onAfterTurn(undefined, 'Found the issue in auth module.');
      expect(tracker.getKeyExchanges().length).toBeGreaterThanOrEqual(1);
    });

    it('only adds user text once per turn (first call only)', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTool('Fix the bug', 'Read', { file_path: 'src/auth.ts' });
      tracker.onAfterTool('Fix the bug', 'Edit', { file_path: 'src/auth.ts' });
      tracker.onAfterTurn(undefined, 'Fixed the auth bug.');
      // Should have 1 user entry + 1 agent entry (tool entries are collapsed)
      const userEntries = tracker.getKeyExchanges().filter((e) => e.role === 'user');
      expect(userEntries).toHaveLength(1);
    });

    it('does not persist to DB (buffer only)', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTool('Fix the bug', 'Read', { file_path: 'src/auth.ts' });
      const state = getThreadState(db, sessionId);
      expect(state).toBeUndefined();
    });
  });

  // --- onAfterTurn ---

  describe('onAfterTurn', () => {
    it('flushes pending buffer, extracts gists, updates keyExchanges', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTool('Fix the auth bug', 'Read', { file_path: 'src/auth.ts' });
      tracker.onAfterTurn(undefined, 'Found and fixed the stale snapshot issue.');
      expect(tracker.getKeyExchanges().length).toBeGreaterThanOrEqual(1);
    });

    it('persists state to DB after flush', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTurn('Fix the auth bug', 'Fixed the stale snapshot issue.');
      const state = getThreadState(db, sessionId);
      expect(state).toBeDefined();
      expect(state!.key_exchanges.length).toBeGreaterThan(0);
    });

    it('clears pending buffer after flush', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTool('Fix the bug', 'Read', { file_path: 'src/auth.ts' });
      tracker.onAfterTurn(undefined, 'Fixed it.');
      const countAfterFirst = tracker.getKeyExchanges().length;
      // Second turn with no new data
      tracker.onAfterTurn(undefined, undefined);
      // Should not have added duplicate entries from cleared buffer
      expect(tracker.getKeyExchanges().length).toBe(countAfterFirst);
    });
  });

  // --- Gist extraction ---

  describe('gist extraction', () => {
    it('short text (< 120 chars) returned as-is', () => {
      expect(extractGist('user', 'Fix the auth token refresh bug')).toBe(
        'Fix the auth token refresh bug'
      );
    });

    it('long text truncated at sentence boundary', () => {
      const long =
        'Found the root cause in the auth module. The snapshot was stale because it cached at startup and never refreshed during the OAuth token lifecycle which caused intermittent failures.';
      const gist = extractGist('agent', long);
      expect(gist.length).toBeLessThanOrEqual(120);
      expect(gist).toMatch(/\.$/); // Should end at a sentence boundary
    });

    it('long text without sentence boundary truncated at 120 with ellipsis', () => {
      const long = 'A'.repeat(200);
      const gist = extractGist('user', long);
      expect(gist.length).toBe(123); // 120 + "..."
      expect(gist).toMatch(/\.\.\.$/);
    });

    it('never exceeds 120 chars (excluding ellipsis)', () => {
      const long =
        'This is a very long message that goes on and on without any clear sentence boundaries so we need to truncate it at the character limit';
      const gist = extractGist('user', long);
      // Allow up to 123 (120 + "...")
      expect(gist.length).toBeLessThanOrEqual(123);
    });
  });

  // --- Topic extraction ---

  describe('topic extraction', () => {
    it('extracts topic from first substantive message', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTurn(
        'Fix the authentication token refresh bug in the gateway',
        'Working on it.'
      );
      expect(tracker.getTopic()).not.toBeNull();
      expect(tracker.getTopic()!.length).toBeGreaterThan(0);
    });

    it('skips greetings as non-substantive', () => {
      expect(extractTopic('hello')).toBeNull();
      expect(extractTopic('hi there')).toBeNull();
      expect(extractTopic('thanks')).toBeNull();
    });

    it('removes stop words from topic', () => {
      const topic = extractTopic('Fix the authentication bug in the OAuth gateway module');
      expect(topic).not.toBeNull();
      expect(topic).not.toMatch(/\bthe\b/);
      expect(topic).not.toMatch(/\bin\b/);
    });

    it('topic set once, not overwritten by subsequent messages', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTurn('Fix the auth token refresh bug', 'Working on it.');
      const firstTopic = tracker.getTopic();
      tracker.onAfterTurn('Now switch to database optimization', 'Sure.');
      expect(tracker.getTopic()).toBe(firstTopic);
    });
  });

  // --- Key exchanges window ---

  describe('key exchanges window', () => {
    it('maintains rolling window of 8 entries', () => {
      const tracker = new ThreadTracker(db, sessionId);
      for (let i = 0; i < 10; i++) {
        tracker.onAfterTurn(`User message number ${i} for testing`, `Agent response number ${i} for testing`);
      }
      expect(tracker.getKeyExchanges().length).toBeLessThanOrEqual(8);
    });

    it('evicts oldest entry when 9th arrives (FIFO)', () => {
      const tracker = new ThreadTracker(db, sessionId);
      // Fill with 4 turns (each turn adds 2 entries: user + agent)
      for (let i = 0; i < 4; i++) {
        tracker.onAfterTurn(`User msg ${i} with some content`, `Agent msg ${i} with some response`);
      }
      expect(tracker.getKeyExchanges().length).toBe(8);

      // Add one more turn — should evict oldest
      tracker.onAfterTurn('New user message five here', 'New agent response five');
      expect(tracker.getKeyExchanges().length).toBe(8);
      // First entry should not be msg 0
      expect(tracker.getKeyExchanges()[0].gist).not.toContain('msg 0');
    });

    it('preserves role and gist in each entry', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTurn('Fix the auth bug in the system', 'Found and fixed it now.');
      const exchanges = tracker.getKeyExchanges();
      expect(exchanges[0]).toHaveProperty('role');
      expect(exchanges[0]).toHaveProperty('gist');
      expect(typeof exchanges[0].role).toBe('string');
      expect(typeof exchanges[0].gist).toBe('string');
    });
  });

  // --- Summary ---

  describe('summary', () => {
    it('builds summary from topic + last 2-3 agent gists', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTurn('Fix the auth token refresh bug', 'Found the stale snapshot issue.');
      tracker.onAfterTurn('What about PKCE flow?', 'Implemented PKCE parameters.');
      const summary = tracker.getSummary();
      expect(summary).not.toBeNull();
      expect(summary!.length).toBeGreaterThan(0);
    });

    it('omits topic prefix when no topic set', () => {
      const tracker = new ThreadTracker(db, sessionId);
      // Short message won't set topic
      tracker.onAfterTurn('hi', 'Hello! How can I help you today?');
      const summary = tracker.getSummary();
      // Should still have agent gist
      expect(summary).toBeDefined();
    });

    it('handles empty keyExchanges gracefully', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTurn(undefined, undefined);
      // Should not crash
      expect(tracker.getSummary()).toBeDefined();
    });
  });

  // --- Persist ---

  describe('persist', () => {
    it('upserts thread state to DB', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTurn('Implement the new feature', 'Starting implementation now.');
      const state = getThreadState(db, sessionId);
      expect(state).toBeDefined();
      expect(state!.session_id).toBe(sessionId);
    });

    it('round-trips through DB correctly (save then load)', () => {
      const t1 = new ThreadTracker(db, sessionId);
      t1.onAfterTurn('Fix the auth token refresh bug', 'Found and fixed the stale snapshot.');
      t1.onAfterTurn('Now handle PKCE flow please', 'Implementing PKCE parameters now.');

      const t2 = new ThreadTracker(db, sessionId);
      expect(t2.getTopic()).toBe(t1.getTopic());
      expect(t2.getKeyExchanges()).toEqual(t1.getKeyExchanges());
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('onAfterTool is non-throwing on bad input', () => {
      const tracker = new ThreadTracker(db, sessionId);
      expect(() =>
        tracker.onAfterTool(undefined, null as unknown as string, null as unknown as Record<string, unknown>)
      ).not.toThrow();
    });

    it('onAfterTurn is non-throwing on bad input', () => {
      const tracker = new ThreadTracker(db, sessionId);
      expect(() => tracker.onAfterTurn(undefined, undefined)).not.toThrow();
    });

    it('handles missing userText/assistantText', () => {
      const tracker = new ThreadTracker(db, sessionId);
      tracker.onAfterTurn(undefined, 'Agent response with no user text.');
      expect(tracker.getKeyExchanges().length).toBeGreaterThanOrEqual(1);
    });
  });
});
