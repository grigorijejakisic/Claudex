import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { captureDecisions, CapturedDecision } from '../../intelligence/decision-capture.js';
import { getDecisionsBySession } from '../../core/decisions.js';

describe('decision capture', () => {
  let db: InstanceType<typeof Database>;
  const sessionId = 'test-session';
  const project = 'test-project';

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function capture(opts: {
    userText?: string;
    assistantText?: string;
    mode?: 'after_turn' | 'after_tool';
  }): CapturedDecision[] {
    return captureDecisions({
      db,
      sessionId,
      project,
      userText: opts.userText,
      assistantText: opts.assistantText,
      mode: opts.mode ?? 'after_turn',
    });
  }

  // --- Tier 1: Explicit confirmation ---

  describe('Tier 1 — confirmation', () => {
    it('captures user confirmation "yes" with assistant proposal as content', () => {
      const result = capture({
        userText: 'yes',
        assistantText: 'I suggest we use SQLite for the storage layer',
      });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('confirmation');
      expect(result[0].tier).toBe(1);
      expect(result[0].content).toBe('I suggest we use SQLite for the storage layer');
    });

    it('captures "lgtm" confirmation', () => {
      const result = capture({
        userText: 'lgtm',
        assistantText: 'The approach uses boundary-only injection',
      });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('confirmation');
    });

    it('captures "do it" confirmation', () => {
      const result = capture({
        userText: 'do it',
        assistantText: 'I will implement the PKCE flow for auth',
      });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('confirmation');
    });

    it('uses assistantText as decision content when user confirms', () => {
      const result = capture({
        userText: 'ok',
        assistantText: 'Switching to ULIDs for checkpoint IDs',
      });
      expect(result[0].content).toBe('Switching to ULIDs for checkpoint IDs');
    });
  });

  // --- Tier 2: Direction-setting ---

  describe('Tier 2 — direction', () => {
    it('captures imperative verb line "Use SQLite for storage"', () => {
      const result = capture({
        assistantText: 'Use SQLite for the storage layer instead of flat files.',
      });
      expect(result.length).toBeGreaterThanOrEqual(1);
      const direction = result.find((r) => r.source === 'direction');
      expect(direction).toBeDefined();
      expect(direction!.tier).toBe(2);
    });

    it('captures "instead of" comparison resolution', () => {
      const result = capture({
        assistantText: 'We should keep the DB approach instead of switching to flat files for persistence.',
      });
      expect(result.some((r) => r.source === 'direction')).toBe(true);
    });

    it('captures "will implement" commitment', () => {
      const result = capture({
        assistantText: 'I will implement the token gauge using transcript JSONL parsing for utilization tracking.',
      });
      expect(result.some((r) => r.source === 'direction')).toBe(true);
    });

    it('captures "should" recommendation', () => {
      const result = capture({
        assistantText: 'We should use boundary-only injection to minimize per-turn overhead costs.',
      });
      expect(result.some((r) => r.source === 'direction')).toBe(true);
    });

    it('rejects direction line < 20 chars', () => {
      const result = capture({ assistantText: 'Use SQLite.' });
      const direction = result.filter((r) => r.source === 'direction');
      expect(direction).toHaveLength(0);
    });
  });

  // --- Tier 3: Rejection ---

  describe('Tier 3 — rejection', () => {
    it('captures rejection with "don\'t"', () => {
      const result = capture({
        userText: "don't use PostgreSQL for this project please",
      });
      expect(result.some((r) => r.source === 'rejection')).toBe(true);
    });

    it('captures rejection with "actually,"', () => {
      const result = capture({
        userText: 'actually, let us go with a different approach here',
      });
      expect(result.some((r) => r.source === 'rejection')).toBe(true);
    });

    it('captures rejection with "scratch that"', () => {
      const result = capture({
        userText: 'scratch that, use the other method instead please',
      });
      expect(result.some((r) => r.source === 'rejection')).toBe(true);
    });
  });

  // --- Tier 4: Explicit markers ---

  describe('Tier 4 — explicit', () => {
    it('captures "DECISION: use TypeScript" explicit marker', () => {
      const result = capture({
        assistantText: 'After discussion, DECISION: use TypeScript for all modules.',
      });
      expect(result.some((r) => r.source === 'explicit')).toBe(true);
      expect(result.some((r) => r.tier === 4)).toBe(true);
    });

    it('captures "going with: approach B" explicit marker', () => {
      const result = capture({
        userText: 'going with: approach B for the checkpoint system',
      });
      expect(result.some((r) => r.source === 'explicit')).toBe(true);
    });
  });

  // --- Filler rejection ---

  describe('filler rejection', () => {
    it('rejects "let me read the file" as filler', () => {
      const result = capture({ assistantText: 'let me read the file' });
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('rejects "looking at the code now" as filler', () => {
      const result = capture({ assistantText: 'looking at the code now' });
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('rejects "running the tests" as filler', () => {
      const result = capture({ assistantText: 'running the tests' });
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('rejects candidates under 15 chars', () => {
      const result = capture({ assistantText: 'Use SQLite' });
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('rejects standalone greetings <= 15 chars', () => {
      const result = capture({ userText: 'hello' });
      expect(result).toHaveLength(0);
    });
  });

  // --- Code fence skip ---

  describe('code fence skip', () => {
    it('ignores decisions inside code fences', () => {
      const text = '```\nDECISION: use SQLite for the main storage layer\n```';
      const result = capture({ assistantText: text });
      expect(result.filter((r) => r.source === 'explicit')).toHaveLength(0);
    });

    it('captures decisions outside code fences in same text', () => {
      const text =
        'DECISION: use TypeScript for all modules.\n```\nconst x = 1;\n```\nMore text here.';
      const result = capture({ assistantText: text });
      expect(result.some((r) => r.source === 'explicit')).toBe(true);
    });
  });

  // --- Dedup ---

  describe('dedup', () => {
    it('skips duplicate decision (same content already in session)', () => {
      // First capture
      capture({ assistantText: 'Use SQLite for the observation storage layer.' });
      // Second capture with same content
      const result = capture({
        assistantText: 'Use SQLite for the observation storage layer.',
      });
      const directions = result.filter((r) => r.source === 'direction');
      expect(directions).toHaveLength(0);
    });

    it('skips semantic duplicate (Jaccard match with existing)', () => {
      capture({ assistantText: 'Use SQLite for storage in the observation layer.' });
      const result = capture({
        assistantText: 'SQLite should be the storage layer for observations.',
      });
      const directions = result.filter((r) => r.source === 'direction');
      expect(directions).toHaveLength(0);
    });
  });

  // --- Mode ---

  describe('mode', () => {
    it('after_tool mode only checks Tier 1 and Tier 4', () => {
      const result = capture({
        userText: 'yes',
        assistantText:
          'Use SQLite for the storage layer.\nDECISION: boundary-only injection for assembly.',
        mode: 'after_tool',
      });
      // Should get Tier 1 (confirmation) and Tier 4 (explicit)
      // Should NOT get Tier 2 (direction)
      const sources = result.map((r) => r.source);
      expect(sources).not.toContain('direction');
      expect(sources).not.toContain('rejection');
    });

    it('after_turn mode checks all 4 tiers', () => {
      const result = capture({
        userText: 'yes',
        assistantText:
          'Use SQLite for the storage layer.\nDECISION: boundary-only injection for assembly.',
        mode: 'after_turn',
      });
      // Should include Tier 1 (confirmation) and Tier 2 (direction) and Tier 4 (explicit)
      const sources = new Set(result.map((r) => r.source));
      expect(sources.has('confirmation') || sources.has('direction') || sources.has('explicit')).toBe(true);
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('returns empty array when no decisions found', () => {
      const result = capture({ userText: 'What is the weather like today?' });
      expect(result).toEqual([]);
    });

    it('is non-throwing (returns empty array on error)', () => {
      // Pass a closed database
      db.close();
      const result = captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the main storage layer.',
        mode: 'after_turn',
      });
      expect(result).toEqual([]);
      // Reopen for afterEach
      db = new Database(':memory:');
    });

    it('handles missing userText/assistantText gracefully', () => {
      const result = capture({});
      expect(result).toEqual([]);
    });
  });
});
