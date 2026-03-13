import { initTemplates, classifyDecision, DecisionTemplates } from '../../embeddings/templates.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';

/** Create a mock provider that returns deterministic fake embeddings. */
function createMockProvider(available: boolean, embedFn?: (text: string) => number[] | null): EmbeddingProvider {
  const provider = new EmbeddingProvider();
  (provider as any).available = available;
  if (embedFn) {
    provider.embed = async (text: string) => embedFn(text);
    provider.embedBatch = async (texts: string[]) => texts.map(t => embedFn(t));
  } else if (!available) {
    provider.embed = async () => null;
    provider.embedBatch = async (texts: string[]) => texts.map(() => null);
  }
  return provider;
}

/** Generate a simple deterministic embedding from text (for testing only). */
function fakeEmbed(text: string): number[] {
  const vec = new Array(10).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % 10] += text.charCodeAt(i) / 1000;
  }
  // Normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return mag > 0 ? vec.map((v) => v / mag) : vec;
}

describe('initTemplates', () => {
  it('returns DecisionTemplates with 5 positive and 4 negative entries when provider is available', async () => {
    const provider = createMockProvider(true, fakeEmbed);
    const templates = await initTemplates(provider);
    expect(templates).not.toBeNull();
    expect(templates!.positive.size).toBe(5);
    expect(templates!.negative.size).toBe(4);
  });

  it('returns null when provider is unavailable', async () => {
    const provider = createMockProvider(false);
    const templates = await initTemplates(provider);
    expect(templates).toBeNull();
  });

  it('returns null when any single template embed fails', async () => {
    let batchCallCount = 0;
    const provider = createMockProvider(true, fakeEmbed);
    // Override embedBatch to return null for one position
    provider.embedBatch = async (texts: string[]) => {
      batchCallCount++;
      return texts.map((t, i) => {
        // Fail on the 3rd template
        if (i === 2) return null;
        return fakeEmbed(t);
      });
    };
    const templates = await initTemplates(provider);
    expect(templates).toBeNull();
    expect(batchCallCount).toBe(1);
  });

  it('is non-throwing on error', async () => {
    const provider = createMockProvider(true);
    provider.embed = async () => { throw new Error('crash'); };
    provider.embedBatch = async () => { throw new Error('crash'); };
    const templates = await initTemplates(provider);
    expect(templates).toBeNull();
  });

  it('uses embedBatch for all 9 templates in a single call', async () => {
    let batchCallCount = 0;
    let batchTexts: string[] = [];
    const provider = createMockProvider(true, fakeEmbed);
    provider.embedBatch = async (texts: string[]) => {
      batchCallCount++;
      batchTexts = texts;
      return texts.map(t => fakeEmbed(t));
    };
    const templates = await initTemplates(provider);
    expect(templates).not.toBeNull();
    expect(batchCallCount).toBe(1); // Single batch call
    expect(batchTexts.length).toBe(9); // All 5 positive + 4 negative
  });
});

describe('classifyDecision', () => {
  function buildTemplates(): DecisionTemplates {
    // Positive templates point toward [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    const positive = new Map<string, number[]>();
    positive.set('t1', [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    positive.set('t2', [0.9, 0.1, 0, 0, 0, 0, 0, 0, 0, 0]);

    // Negative templates point toward [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
    const negative = new Map<string, number[]>();
    negative.set('n1', [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    negative.set('n2', [0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.9]);

    return { positive, negative };
  }

  it('returns positive score for decision-like embedding', () => {
    const templates = buildTemplates();
    // Candidate close to positive templates
    const candidate = [0.95, 0.05, 0, 0, 0, 0, 0, 0, 0, 0];
    const score = classifyDecision(candidate, templates);
    expect(score).toBeGreaterThan(0);
  });

  it('returns negative score for filler-like embedding', () => {
    const templates = buildTemplates();
    // Candidate close to negative templates
    const candidate = [0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.95];
    const score = classifyDecision(candidate, templates);
    expect(score).toBeLessThan(0);
  });

  it('returns 0 for equally similar to both', () => {
    const templates = buildTemplates();
    // Equidistant: orthogonal to both
    const candidate = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    const score = classifyDecision(candidate, templates);
    expect(score).toBeCloseTo(0, 1);
  });

  it('returns 0 on error (empty templates)', () => {
    const templates: DecisionTemplates = {
      positive: new Map(),
      negative: new Map(),
    };
    const score = classifyDecision([1, 0], templates);
    expect(score).toBe(0);
  });

  it('handles empty positive/negative maps gracefully', () => {
    const posOnly: DecisionTemplates = {
      positive: new Map([['t1', [1, 0]]]),
      negative: new Map(),
    };
    // Should still work — maxNegative defaults to 0
    const score = classifyDecision([1, 0], posOnly);
    expect(score).toBeGreaterThan(0);
  });
});

describe('integration', () => {
  it('full classify flow: init templates then classify candidate', async () => {
    const provider = createMockProvider(true, fakeEmbed);
    const templates = await initTemplates(provider);
    expect(templates).not.toBeNull();

    // Get a candidate embedding
    const candidateEmb = fakeEmbed('We decided to use PostgreSQL instead of MongoDB');
    const score = classifyDecision(candidateEmb, templates!);
    // Score should be a number (specific value depends on fake embeddings)
    expect(typeof score).toBe('number');
  });
});
