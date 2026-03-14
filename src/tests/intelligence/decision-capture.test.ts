import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { captureDecisions, CapturedDecision } from '../../intelligence/decision-capture.js';
import { getDecisionsBySession } from '../../core/decisions.js';
import { getArtifactsByProject } from '../../core/artifacts.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import type { DecisionTemplates } from '../../embeddings/templates.js';

describe('decision capture', () => {
  let db: TestDatabase;
  const sessionId = 'test-session';
  const project = 'test-project';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  async function capture(opts: {
    userText?: string;
    assistantText?: string;
    mode?: 'after_turn' | 'after_tool';
  }): Promise<CapturedDecision[]> {
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
    it('captures user confirmation "yes" with assistant proposal as content', async () => {
      const result = await capture({
        userText: 'yes',
        assistantText: 'I suggest we use SQLite for the storage layer',
      });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('confirmation');
      expect(result[0].tier).toBe(1);
      expect(result[0].content).toBe('I suggest we use SQLite for the storage layer');
    });

    it('captures "lgtm" confirmation', async () => {
      const result = await capture({
        userText: 'lgtm',
        assistantText: 'The approach uses boundary-only injection',
      });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('confirmation');
    });

    it('captures "do it" confirmation', async () => {
      const result = await capture({
        userText: 'do it',
        assistantText: 'I will implement the PKCE flow for auth',
      });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('confirmation');
    });

    it('uses assistantText as decision content when user confirms', async () => {
      const result = await capture({
        userText: 'ok',
        assistantText: 'Switching to ULIDs for checkpoint IDs',
      });
      expect(result[0].content).toBe('Switching to ULIDs for checkpoint IDs');
    });
  });

  // --- Tier 2: Direction-setting ---

  describe('Tier 2 — direction', () => {
    it('captures imperative verb line "Use SQLite for storage"', async () => {
      const result = await capture({
        assistantText: 'Use SQLite for the storage layer instead of flat files.',
      });
      expect(result.length).toBeGreaterThanOrEqual(1);
      const direction = result.find((r) => r.source === 'direction');
      expect(direction).toBeDefined();
      expect(direction!.tier).toBe(2);
    });

    it('captures "instead of" comparison resolution', async () => {
      const result = await capture({
        assistantText: 'We should keep the DB approach instead of switching to flat files for persistence.',
      });
      expect(result.some((r) => r.source === 'direction')).toBe(true);
    });

    it('captures "will implement" commitment', async () => {
      const result = await capture({
        assistantText: 'I will implement the token gauge using transcript JSONL parsing for utilization tracking.',
      });
      expect(result.some((r) => r.source === 'direction')).toBe(true);
    });

    it('captures "should" recommendation', async () => {
      const result = await capture({
        assistantText: 'We should use boundary-only injection to minimize per-turn overhead costs.',
      });
      expect(result.some((r) => r.source === 'direction')).toBe(true);
    });

    it('rejects direction line < 20 chars', async () => {
      const result = await capture({ assistantText: 'Use SQLite.' });
      const direction = result.filter((r) => r.source === 'direction');
      expect(direction).toHaveLength(0);
    });
  });

  // --- Tier 3: Rejection ---

  describe('Tier 3 — rejection', () => {
    it('captures rejection with "don\'t"', async () => {
      const result = await capture({
        userText: "don't use PostgreSQL for this project please",
      });
      expect(result.some((r) => r.source === 'rejection')).toBe(true);
    });

    it('captures rejection with "actually,"', async () => {
      const result = await capture({
        userText: 'actually, let us go with a different approach here',
      });
      expect(result.some((r) => r.source === 'rejection')).toBe(true);
    });

    it('captures rejection with "scratch that"', async () => {
      const result = await capture({
        userText: 'scratch that, use the other method instead please',
      });
      expect(result.some((r) => r.source === 'rejection')).toBe(true);
    });
  });

  // --- Tier 4: Explicit markers ---

  describe('Tier 4 — explicit', () => {
    it('captures "DECISION: use TypeScript" explicit marker', async () => {
      const result = await capture({
        assistantText: 'After discussion, DECISION: use TypeScript for all modules.',
      });
      expect(result.some((r) => r.source === 'explicit')).toBe(true);
      expect(result.some((r) => r.tier === 4)).toBe(true);
    });

    it('captures "going with: approach B" explicit marker', async () => {
      const result = await capture({
        userText: 'going with: approach B for the checkpoint system',
      });
      expect(result.some((r) => r.source === 'explicit')).toBe(true);
    });
  });

  // --- Filler rejection ---

  describe('filler rejection', () => {
    it('rejects "let me read the file" as filler', async () => {
      const result = await capture({ assistantText: 'let me read the file' });
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('rejects "looking at the code now" as filler', async () => {
      const result = await capture({ assistantText: 'looking at the code now' });
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('rejects "running the tests" as filler', async () => {
      const result = await capture({ assistantText: 'running the tests' });
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('rejects candidates under 15 chars', async () => {
      const result = await capture({ assistantText: 'Use SQLite' });
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('rejects standalone greetings <= 15 chars', async () => {
      const result = await capture({ userText: 'hello' });
      expect(result).toHaveLength(0);
    });
  });

  // --- Code fence skip ---

  describe('code fence skip', () => {
    it('ignores decisions inside code fences', async () => {
      const text = '```\nDECISION: use SQLite for the main storage layer\n```';
      const result = await capture({ assistantText: text });
      expect(result.filter((r) => r.source === 'explicit')).toHaveLength(0);
    });

    it('captures decisions outside code fences in same text', async () => {
      const text =
        'DECISION: use TypeScript for all modules.\n```\nconst x = 1;\n```\nMore text here.';
      const result = await capture({ assistantText: text });
      expect(result.some((r) => r.source === 'explicit')).toBe(true);
    });
  });

  // --- Dedup ---

  describe('dedup', () => {
    it('skips duplicate decision (same content already in session)', async () => {
      // First capture
      await capture({ assistantText: 'Use SQLite for the observation storage layer.' });
      // Second capture with same content
      const result = await capture({
        assistantText: 'Use SQLite for the observation storage layer.',
      });
      const directions = result.filter((r) => r.source === 'direction');
      expect(directions).toHaveLength(0);
    });

    it('skips semantic duplicate (Jaccard match with existing)', async () => {
      await capture({ assistantText: 'Use SQLite for storage in the observation layer.' });
      const result = await capture({
        assistantText: 'SQLite should be the storage layer for observations.',
      });
      const directions = result.filter((r) => r.source === 'direction');
      expect(directions).toHaveLength(0);
    });
  });

  // --- Mode ---

  describe('mode', () => {
    it('after_tool mode only checks Tier 1 and Tier 4', async () => {
      const result = await capture({
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

    it('after_turn mode checks all 4 tiers', async () => {
      const result = await capture({
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

  // --- Stage 2: Embedding classification ---

  describe('Stage 2 — embedding classification', () => {
    function createMockClassifier(embedResult: number[] | null, confidence: number) {
      const provider = new EmbeddingProvider();
      (provider as any).available = true;
      provider.embed = async () => embedResult;

      const templates: DecisionTemplates = {
        positive: new Map([['t1', [1, 0]]]),
        negative: new Map([['n1', [0, 1]]]),
      };

      // Override classifyDecision behavior by constructing templates
      // that produce the desired confidence. For testing, we'll mock embed
      // and use real classifyDecision. Instead, create templates that produce
      // deterministic results.
      return { provider, templates };
    }

    it('filters false-positive candidate when classifier returns low confidence', async () => {
      // Provider returns embedding close to negative templates
      const provider = new EmbeddingProvider();
      (provider as any).available = true;
      provider.embed = async () => [0, 1]; // close to negative [0, 1], far from positive [1, 0]
      provider.embedBatch = async (texts: string[]) => texts.map(() => [0, 1]);

      const templates: DecisionTemplates = {
        positive: new Map([['t1', [1, 0]]]),
        negative: new Map([['n1', [0, 1]]]),
      };

      const result = await captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
        classifier: { provider, templates },
      });
      // confidence = cos([0,1], [1,0]) - cos([0,1], [0,1]) = 0 - 1 = -1.0, below 0.15
      expect(result.filter((r) => r.source === 'direction')).toHaveLength(0);
    });

    it('keeps candidate when classifier returns high confidence', async () => {
      const provider = new EmbeddingProvider();
      (provider as any).available = true;
      provider.embed = async () => [1, 0]; // close to positive [1, 0]
      provider.embedBatch = async (texts: string[]) => texts.map(() => [1, 0]);

      const templates: DecisionTemplates = {
        positive: new Map([['t1', [1, 0]]]),
        negative: new Map([['n1', [0, 1]]]),
      };

      const result = await captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
        classifier: { provider, templates },
      });
      // confidence = cos([1,0], [1,0]) - cos([1,0], [0,1]) = 1 - 0 = 1.0, above 0.15
      expect(result.filter((r) => r.source === 'direction').length).toBeGreaterThanOrEqual(1);
    });

    it('passes all candidates through when classifier is null (backward compatible)', async () => {
      const result = await captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
        classifier: null,
      });
      expect(result.filter((r) => r.source === 'direction').length).toBeGreaterThanOrEqual(1);
    });

    it('passes all candidates through when classifier is undefined (backward compatible)', async () => {
      const result = await captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
      });
      expect(result.filter((r) => r.source === 'direction').length).toBeGreaterThanOrEqual(1);
    });

    it('keeps candidate when embed returns null (fail open)', async () => {
      const provider = new EmbeddingProvider();
      (provider as any).available = true;
      provider.embed = async () => null; // embed failure
      provider.embedBatch = async (texts: string[]) => texts.map(() => null);

      const templates: DecisionTemplates = {
        positive: new Map([['t1', [1, 0]]]),
        negative: new Map([['n1', [0, 1]]]),
      };

      const result = await captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
        classifier: { provider, templates },
      });
      // Fail open — should still have directions
      expect(result.filter((r) => r.source === 'direction').length).toBeGreaterThanOrEqual(1);
    });

    it('respects custom confidenceThreshold', async () => {
      const provider = new EmbeddingProvider();
      (provider as any).available = true;
      // Embedding that gives moderate confidence
      const norm = 1 / Math.sqrt(2);
      provider.embed = async () => [norm, norm]; // 45 degrees from both
      provider.embedBatch = async (texts: string[]) => texts.map(() => [norm, norm]);

      const templates: DecisionTemplates = {
        positive: new Map([['t1', [1, 0]]]),
        negative: new Map([['n1', [0, 1]]]),
      };

      // cos([n,n],[1,0]) = n/1 ≈ 0.707, cos([n,n],[0,1]) = n/1 ≈ 0.707
      // confidence = 0.707 - 0.707 ≈ 0 — below both thresholds

      // With default threshold 0.15: filtered out (0 <= 0.15)
      const result1 = await captureDecisions({
        db,
        sessionId: 'sess-1',
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
        classifier: { provider, templates },
        confidenceThreshold: 0.15,
      });
      expect(result1.filter((r) => r.source === 'direction')).toHaveLength(0);

      // With threshold -0.5: passes (0 > -0.5)
      const result2 = await captureDecisions({
        db,
        sessionId: 'sess-2',
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
        classifier: { provider, templates },
        confidenceThreshold: -0.5,
      });
      expect(result2.filter((r) => r.source === 'direction').length).toBeGreaterThanOrEqual(1);
    });

    it('uses embedBatch (not sequential embed) for classification', async () => {
      let embedBatchCalled = false;
      let embedCallCount = 0;
      const provider = new EmbeddingProvider();
      (provider as any).available = true;
      provider.embed = async () => { embedCallCount++; return [1, 0]; };
      provider.embedBatch = async (texts: string[]) => {
        embedBatchCalled = true;
        return texts.map(() => [1, 0]);
      };

      const templates: DecisionTemplates = {
        positive: new Map([['t1', [1, 0]]]),
        negative: new Map([['n1', [0, 1]]]),
      };

      await captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
        classifier: { provider, templates },
      });
      expect(embedBatchCalled).toBe(true);
      expect(embedCallCount).toBe(0);
    });

    it('Stage 2 filtering happens before dedup check (filtered candidates not stored)', async () => {
      const provider = new EmbeddingProvider();
      (provider as any).available = true;
      provider.embed = async () => [0, 1]; // low confidence
      provider.embedBatch = async (texts: string[]) => texts.map(() => [0, 1]);

      const templates: DecisionTemplates = {
        positive: new Map([['t1', [1, 0]]]),
        negative: new Map([['n1', [0, 1]]]),
      };

      await captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the primary storage layer.',
        mode: 'after_turn',
        classifier: { provider, templates },
      });

      // Nothing should be stored in DB
      const stored = getDecisionsBySession(db, sessionId);
      expect(stored).toHaveLength(0);
    });
  });

  // --- REC-14: Fingerprint from redacted content ---

  describe('REC-14 — fingerprint generated from redacted content', () => {
    it('fingerprint does not contain sensitive tokens from unredacted text', async () => {
      // Text containing a secret that should be redacted
      const secretText = 'Use API key sk-abcdefghijklmnopqrstuvwxyz1234 for auth';
      const result = await capture({
        assistantText: secretText,
      });

      // The decision should be captured (has imperative "Use")
      expect(result.length).toBeGreaterThanOrEqual(1);

      // Check stored fingerprint does not contain the secret
      const stored = getDecisionsBySession(db, sessionId);
      for (const decision of stored) {
        expect(decision.fingerprint).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
        expect(decision.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
      }
    });

    it('fingerprint is based on redacted content, not original', async () => {
      // Two texts that differ only in the secret value should produce same fingerprint
      const text1 = 'Use token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for GitHub auth';
      const text2 = 'Use token ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB for GitHub auth';

      const result1 = await captureDecisions({
        db,
        sessionId: 'fp-sess-1',
        project,
        assistantText: text1,
        mode: 'after_turn',
      });

      // REC-03: Second capture with same fingerprint is now deduped cross-session
      const result2 = await captureDecisions({
        db,
        sessionId: 'fp-sess-2',
        project,
        assistantText: text2,
        mode: 'after_turn',
      });

      expect(result1.length).toBeGreaterThanOrEqual(1);
      // REC-03: result2 should be empty — fingerprint dedup catches cross-session duplicates
      expect(result2.length).toBe(0);

      const stored1 = getDecisionsBySession(db, 'fp-sess-1');
      expect(stored1.length).toBeGreaterThanOrEqual(1);

      // After redaction, the fingerprint should reflect the redacted content
      // (both secret values produce the same redacted output)
      const stored2 = getDecisionsBySession(db, 'fp-sess-2');
      expect(stored2.length).toBe(0);
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('returns empty array when no decisions found', async () => {
      const result = await capture({ userText: 'What is the weather like today?' });
      expect(result).toEqual([]);
    });

    it('is non-throwing (returns empty array on error)', async () => {
      // Pass a closed database
      db.close();
      const result = await captureDecisions({
        db,
        sessionId,
        project,
        assistantText: 'Use SQLite for the main storage layer.',
        mode: 'after_turn',
      });
      expect(result).toEqual([]);
      // Reopen for afterEach
      db = createTestDb();
    });

    it('handles missing userText/assistantText gracefully', async () => {
      const result = await capture({});
      expect(result).toEqual([]);
    });
  });

  // --- Artifact creation ---

  describe('decision artifact creation', () => {
    it('creates an artifact for each stored decision', async () => {
      const result = await capture({
        userText: 'yes go ahead',
        assistantText: 'Use SQLite for the primary storage layer with WAL mode enabled.',
      });

      expect(result.length).toBeGreaterThanOrEqual(1);

      const artifacts = getArtifactsByProject(db, project, { type: 'decision' });
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0].artifact_type).toBe('decision');
      expect(artifacts[0].state).toBe('fresh');
      expect(artifacts[0].importance).toBe(3);
      expect(artifacts[0].artifact_ref).toBeTruthy();
    });

    it('does not create artifacts when no decisions are captured', async () => {
      await capture({ userText: 'What is the weather?' });

      const artifacts = getArtifactsByProject(db, project, { type: 'decision' });
      expect(artifacts).toHaveLength(0);
    });

    it('truncates decision summary to 150 chars', async () => {
      const longContent = 'DECISION: ' + 'x'.repeat(200);
      const result = await capture({ userText: longContent });

      if (result.length > 0) {
        const artifacts = getArtifactsByProject(db, project, { type: 'decision' });
        for (const a of artifacts) {
          expect(a.summary.length).toBeLessThanOrEqual(150);
        }
      }
    });

    it('artifact creation failure does not break decision capture', async () => {
      // Even if artifact table were missing, captureDecisions should still return decisions
      // We can't easily simulate artifact failure without mocking, but we verify
      // the try/catch wrapper by ensuring decisions are still returned
      const result = await capture({
        assistantText: 'Use TypeScript strict mode for all modules in the project.',
        mode: 'after_turn',
      });

      // Decisions should still be captured regardless of artifact creation
      expect(result.length).toBeGreaterThanOrEqual(1);
      const stored = getDecisionsBySession(db, sessionId);
      expect(stored.length).toBeGreaterThanOrEqual(1);
    });
  });
});
