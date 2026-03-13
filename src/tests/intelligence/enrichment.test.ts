import {
  detectEnrichmentProvider,
  enrichCheckpoint,
  mergeEnrichment,
  EnrichmentProvider,
  CheckpointData,
} from '../../intelligence/enrichment.js';
import type { RuntimeCapabilities } from '../../shared/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

const noCapabilities: RuntimeCapabilities = {
  hasFullMessageHistory: false,
  hasNativeContextUsage: false,
  hasTranscriptAccess: false,
  supportsSystemInjection: false,
  supportsAsyncEnrichment: false,
  hasLocalEmbeddings: false,
  supportsTurnEndEvent: false,
};

describe('detectEnrichmentProvider', () => {
  it('returns Ollama provider when Ollama has models', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ models: [{ name: 'glm-4:latest', size: 1000 }] }))
    );
    const result = await detectEnrichmentProvider({}, noCapabilities);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('ollama');
    expect(result!.model).toBe('glm-4:latest');
  });

  it('selects smallest model when config.model is "auto"', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        models: [
          { name: 'large-model:latest', size: 5000 },
          { name: 'tiny-model:latest', size: 100 },
          { name: 'medium-model:latest', size: 2000 },
        ],
      }))
    );
    const result = await detectEnrichmentProvider({ model: 'auto' }, noCapabilities);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('tiny-model:latest');
  });

  it('returns specific model when config.model names it', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        models: [
          { name: 'glm-4:latest', size: 1000 },
          { name: 'llama3:latest', size: 2000 },
        ],
      }))
    );
    const result = await detectEnrichmentProvider({ model: 'llama3' }, noCapabilities);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('llama3:latest');
  });

  it('returns null on non-2xx response from Ollama', async () => {
    mockFetch(async () => new Response('Service Unavailable', { status: 503 }));
    const result = await detectEnrichmentProvider({}, noCapabilities);
    expect(result).toBeNull();
  });

  it('returns null when Ollama has no models', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ models: [] }))
    );
    const result = await detectEnrichmentProvider({}, noCapabilities);
    expect(result).toBeNull();
  });

  it('returns null when Ollama is not running', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    const result = await detectEnrichmentProvider({}, noCapabilities);
    expect(result).toBeNull();
  });

  it('is non-throwing on error', async () => {
    mockFetch(async () => { throw new Error('crash'); });
    const result = await detectEnrichmentProvider({}, noCapabilities);
    expect(result).toBeNull();
  });

  it('returns null when config.enabled is false (skips network calls)', async () => {
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ models: [{ name: 'glm-4:latest', size: 1000 }] }));
    });
    const result = await detectEnrichmentProvider({ enabled: false }, noCapabilities);
    expect(result).toBeNull();
    expect(fetchCalled).toBe(false); // No network call made
  });

  it('proceeds normally when config.enabled is true', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ models: [{ name: 'glm-4:latest', size: 1000 }] }))
    );
    const result = await detectEnrichmentProvider({ enabled: true }, noCapabilities);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('ollama');
  });

  it('returns null (not model:undefined) when requested model is missing from Ollama', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        models: [
          { name: 'glm-4:latest', size: 1000 },
          { name: 'llama3:latest', size: 2000 },
        ],
      }))
    );
    // Request a model that does not exist in Ollama
    const result = await detectEnrichmentProvider({ model: 'nonexistent-model' }, noCapabilities);
    // Should NOT return { type: 'ollama', model: undefined }
    expect(result).toBeNull();
  });

  it('returns null when requested model missing (no native fallback)', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        models: [
          { name: 'glm-4:latest', size: 1000 },
        ],
      }))
    );
    const result = await detectEnrichmentProvider({ model: 'nonexistent-model' }, noCapabilities);
    // No native fallback — should return null
    expect(result).toBeNull();
  });
});

describe('enrichCheckpoint', () => {
  it('returns enriched data from Ollama chat completions', async () => {
    const enriched: Partial<CheckpointData> = {
      topic: 'Refined topic',
      decisions: ['Refined decision A'],
    };
    mockFetch(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(enriched) } }],
      }))
    );

    const data: CheckpointData = {
      topic: 'Original topic',
      decisions: ['Decision A'],
    };
    const provider: EnrichmentProvider = { type: 'ollama', model: 'test', baseUrl: 'http://localhost:11434' };
    const result = await enrichCheckpoint(data, provider);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('Refined topic');
    expect(result!.decisions).toEqual(['Refined decision A']);
  });

  it('returns null on HTTP error (thrown)', async () => {
    mockFetch(async () => { throw new Error('Internal Server Error'); });
    const data: CheckpointData = { topic: 'test' };
    const provider: EnrichmentProvider = { type: 'ollama', model: 'test', baseUrl: 'http://localhost:11434' };
    const result = await enrichCheckpoint(data, provider);
    expect(result).toBeNull();
  });

  it('returns null on non-2xx response from Ollama', async () => {
    mockFetch(async () => new Response('Bad Gateway', { status: 502 }));
    const data: CheckpointData = { topic: 'test' };
    const provider: EnrichmentProvider = { type: 'ollama', model: 'test', baseUrl: 'http://localhost:11434' };
    const result = await enrichCheckpoint(data, provider);
    expect(result).toBeNull();
  });

  it('returns null on malformed LLM response', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: 'not valid json at all' } }],
      }))
    );
    const data: CheckpointData = { topic: 'test' };
    const provider: EnrichmentProvider = { type: 'ollama', model: 'test', baseUrl: 'http://localhost:11434' };
    const result = await enrichCheckpoint(data, provider);
    expect(result).toBeNull();
  });

  it('is non-throwing on all error paths', async () => {
    mockFetch(async () => { throw new Error('crash'); });
    const data: CheckpointData = { topic: 'test' };
    const provider: EnrichmentProvider = { type: 'ollama', model: 'test', baseUrl: 'http://localhost:11434' };
    const result = await enrichCheckpoint(data, provider);
    expect(result).toBeNull();
  });
});

describe('mergeEnrichment', () => {
  it('accepts enriched array fields and preserves uncovered heuristic entries', () => {
    const heuristic: CheckpointData = {
      decisions: ['Decision A', 'Decision B', 'Decision C'],
    };
    const enriched: Partial<CheckpointData> = {
      decisions: ['Decision A refined', 'Decision B'],
    };
    const result = mergeEnrichment(heuristic, enriched);
    // C was uncovered — should be appended
    expect(result.decisions).toContain('Decision A refined');
    expect(result.decisions).toContain('Decision B');
    expect(result.decisions).toContain('Decision C');
  });

  it('handles enriched fields that are empty (keeps heuristic)', () => {
    const heuristic: CheckpointData = {
      decisions: ['A', 'B'],
    };
    const enriched: Partial<CheckpointData> = {
      decisions: [],
    };
    const result = mergeEnrichment(heuristic, enriched);
    // Empty enriched array does not override
    expect(result.decisions).toEqual(['A', 'B']);
  });

  it('prefers enriched string fields when non-empty', () => {
    const heuristic: CheckpointData = {
      topic: 'Original topic',
      summary: 'Original summary',
    };
    const enriched: Partial<CheckpointData> = {
      topic: 'Better topic',
    };
    const result = mergeEnrichment(heuristic, enriched);
    expect(result.topic).toBe('Better topic');
    expect(result.summary).toBe('Original summary');
  });

  it('keeps heuristic string fields when enriched is empty', () => {
    const heuristic: CheckpointData = {
      topic: 'Original',
      summary: 'Original summary',
    };
    const enriched: Partial<CheckpointData> = {
      topic: '',
    };
    const result = mergeEnrichment(heuristic, enriched);
    expect(result.topic).toBe('Original'); // empty string is falsy, keeps heuristic
  });

  it('detects semantic duplicates as covered (not appended)', () => {
    const heuristic: CheckpointData = {
      decisions: ['Use SQLite for the storage layer'],
    };
    const enriched: Partial<CheckpointData> = {
      decisions: ['SQLite should be the storage layer'], // paraphrase
    };
    const result = mergeEnrichment(heuristic, enriched);
    // Heuristic entry is semantically covered by enriched
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions![0]).toBe('SQLite should be the storage layer');
  });

  it('handles null/undefined enriched fields gracefully', () => {
    const heuristic: CheckpointData = {
      topic: 'Original',
      decisions: ['A'],
    };
    const enriched: Partial<CheckpointData> = {};
    const result = mergeEnrichment(heuristic, enriched);
    expect(result.topic).toBe('Original');
    expect(result.decisions).toEqual(['A']);
  });

  it('returns heuristic unchanged when enriched is empty object', () => {
    const heuristic: CheckpointData = {
      topic: 'Topic',
      task: 'Task',
      decisions: ['A'],
      learnings: ['B'],
    };
    const result = mergeEnrichment(heuristic, {});
    expect(result).toEqual(heuristic);
  });

  it('is non-throwing on error (returns heuristic)', () => {
    const heuristic: CheckpointData = { topic: 'test' };
    // Pass a bad enriched that might cause errors
    const result = mergeEnrichment(heuristic, null as unknown as Partial<CheckpointData>);
    expect(result.topic).toBe('test');
  });

  it('mergeEnrichment with all fields enriched (complete override + safety net)', () => {
    const heuristic: CheckpointData = {
      topic: 'Old topic',
      task: 'Old task',
      status: 'in progress',
      decisions: ['A', 'B', 'C'],
      open_items: ['X', 'Y'],
      learnings: ['L1'],
      summary: 'Old summary',
      key_exchanges: [{ role: 'user', gist: 'old' }],
    };
    const enriched: Partial<CheckpointData> = {
      topic: 'New topic',
      task: 'New task',
      status: 'completed',
      decisions: ['A refined', 'B'],
      open_items: ['X refined'],
      learnings: ['L1 improved'],
      summary: 'New summary',
      key_exchanges: [{ role: 'user', gist: 'new' }],
    };
    const result = mergeEnrichment(heuristic, enriched);
    expect(result.topic).toBe('New topic');
    expect(result.task).toBe('New task');
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('New summary');
    expect(result.key_exchanges).toEqual([{ role: 'user', gist: 'new' }]);
    // C was uncovered — should be appended
    expect(result.decisions).toContain('C');
    // Y was uncovered — should be appended
    expect(result.open_items).toContain('Y');
  });

  it('mergeEnrichment with mixed: some fields enriched, some not', () => {
    const heuristic: CheckpointData = {
      topic: 'Old topic',
      decisions: ['A', 'B'],
      open_items: ['X'],
      learnings: ['L1'],
    };
    const enriched: Partial<CheckpointData> = {
      decisions: ['A improved'],
      // open_items and learnings not enriched
    };
    const result = mergeEnrichment(heuristic, enriched);
    expect(result.topic).toBe('Old topic'); // not enriched
    expect(result.decisions).toContain('A improved');
    expect(result.decisions).toContain('B'); // uncovered
    expect(result.open_items).toEqual(['X']); // untouched
    expect(result.learnings).toEqual(['L1']); // untouched
  });
});
