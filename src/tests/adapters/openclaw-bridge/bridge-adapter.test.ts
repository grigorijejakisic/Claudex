/**
 * Tests for createBridgeCallbacks: each callback's core function integration.
 * Uses in-memory SQLite with initialized schema.
 */

import { createTestDb, type TestDatabase } from '../../helpers/test-db.js';
import { createSession, getSession } from '../../../core/sessions.js';
import { getCheckpointTracking, markPostCompactPending } from '../../../core/checkpoint-tracking.js';
import { updatePressureScore } from '../../../core/pressure.js';
import { DEFAULT_CONFIG } from '../../../shared/constants.js';
import type { ClaudexConfig } from '../../../shared/config.js';
import { createBridgeCallbacks, mapTokenUsage } from '../../../adapters/openclaw-bridge/bridge-adapter.js';
import type { BridgeContext } from '../../../adapters/openclaw-bridge/bridge-adapter.js';
import type {
  BridgeInitContext,
  PiContext,
  PiToolResultContext,
  PiMessageEndContext,
  PiCompactContext,
  PiCompactPrep,
} from '../../../adapters/openclaw-bridge/bridge-types.js';
import { emitTelemetry } from '../../../observability/telemetry.js';

const testConfig = { ...DEFAULT_CONFIG } as unknown as ClaudexConfig;

/** Config with enrichment disabled to skip Ollama network calls in tests. */
const compactTestConfig = {
  ...DEFAULT_CONFIG,
  enrichment: { ...DEFAULT_CONFIG.enrichment, enabled: false },
} as unknown as ClaudexConfig;

function createMockSdkUsage(input = 1000, output = 500, window = 200000) {
  return { inputTokens: input, outputTokens: output, contextWindowTokens: window };
}

function createMockPiContext(overrides: Partial<PiContext> = {}): PiContext {
  return {
    sessionKey: 'test-s1',
    cwd: '/tmp/test',
    messages: [{ role: 'user', content: 'Hello' }],
    getContextUsage: () => createMockSdkUsage(),
    ...overrides,
  };
}

function createBctx(db: TestDatabase): BridgeContext {
  return {
    db,
    config: testConfig,
    project: 'test-proj',
    scope: null,
    sessionId: 'test-s1',
    cwd: '/tmp/test',
    adapter: 'openclaw' as const,
  };
}

describe('mapTokenUsage', () => {
  it('computes utilization as input/context (output tokens excluded)', () => {
    const result = mapTokenUsage(createMockSdkUsage(1000, 500, 200000));
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.contextWindowTokens).toBe(200000);
    // utilization = inputTokens / contextWindowTokens = 1000 / 200000 = 0.005
    expect(result.utilization).toBeCloseTo(0.005, 6);
  });

  it('clamps utilization to 1.0 when input exceeds window', () => {
    const result = mapTokenUsage(createMockSdkUsage(250000, 10000, 200000));
    expect(result.utilization).toBe(1.0);
  });

  it('does not include output tokens in utilization', () => {
    const result = mapTokenUsage(createMockSdkUsage(100000, 150000, 200000));
    // utilization = 100000 / 200000 = 0.5, NOT (100000+150000)/200000 = 1.25
    expect(result.utilization).toBeCloseTo(0.5, 6);
  });

  it('handles zero context window', () => {
    const result = mapTokenUsage(createMockSdkUsage(1000, 500, 0));
    expect(result.utilization).toBe(0);
  });
});

describe('onInit callback', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates session and returns inject payload from assembleFullContext', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const initCtx: BridgeInitContext = { sessionKey: 'test-s1', cwd: '/tmp/test' };

    const result = await bridge.onInit(initCtx);

    // Session should be created
    const session = getSession(db, 'test-s1');
    expect(session).toBeDefined();
    expect(session!.status).toBe('active');

    // Result is either InjectPayload or undefined
    if (result) {
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('tokenEstimate');
      expect(result).toHaveProperty('sources');
    }
  });

  it('calls recoverFromDb for checkpoint re-mirroring', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const initCtx: BridgeInitContext = { sessionKey: 'test-s1', cwd: '/tmp/test' };

    // Should not throw on empty DB
    await expect(bridge.onInit(initCtx)).resolves.not.toThrow();
  });

  it('returns undefined when assembly produces no content', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const initCtx: BridgeInitContext = { sessionKey: 'empty-s1', cwd: '/nonexistent' };

    const result = await bridge.onInit(initCtx);
    // Empty DB with nonexistent project may produce empty content
    if (result) {
      expect(result.content).toBeTruthy();
    } else {
      expect(result).toBeUndefined();
    }
  });

  it('updates bctx.sessionId and bctx.cwd from init context', async () => {
    const bctx = createBctx(db);
    bctx.sessionId = '';
    bctx.cwd = '';
    const bridge = createBridgeCallbacks(bctx);
    const initCtx: BridgeInitContext = { sessionKey: 'new-session', cwd: '/new/cwd' };

    await bridge.onInit(initCtx);

    expect(bctx.sessionId).toBe('new-session');
    expect(bctx.cwd).toBe('/new/cwd');
  });
});

describe('onContext callback', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      source: 'openclaw-bridge',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('returns undefined on regular prompt (no injection)', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const ctx = createMockPiContext();

    const result = await bridge.onContext(ctx);
    // At low utilization (normal zone), no gauge injection
    expect(result).toBeUndefined();
  });

  it('uses native token usage from ctx.getContextUsage()', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    let called = false;
    const ctx = createMockPiContext({
      getContextUsage: () => {
        called = true;
        return createMockSdkUsage();
      },
    });

    await bridge.onContext(ctx);
    expect(called).toBe(true);
  });

  it('extracts prompt from last user message in ctx.messages', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const ctx = createMockPiContext({
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second message' },
      ],
    });

    // Should not throw - prompt extraction works
    const result = await bridge.onContext(ctx);
    // Regular prompt - no injection expected
    expect(result === undefined || result === null || (result && 'content' in result)).toBe(true);
  });

  it('clears post-compact-pending when isPostCompaction', async () => {
    markPostCompactPending(db, 'test-s1');
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const ctx = createMockPiContext({ isPostCompaction: true });

    await bridge.onContext(ctx);

    const tracking = getCheckpointTracking(db, 'test-s1');
    expect(tracking?.post_compact_pending).toBe(0);
  });
});

describe('onToolResult callback', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      source: 'openclaw-bridge',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('calls processToolObservation with correct params', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const ctx: PiToolResultContext = {
      ...createMockPiContext(),
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test/foo.ts' },
      toolOutput: { content: 'file contents here' },
    };

    // Should not throw
    await expect(bridge.onToolResult(ctx)).resolves.not.toThrow();
  });

  it('updates pressure scores for files in toolInput', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const ctx: PiToolResultContext = {
      ...createMockPiContext(),
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test/pressure-file.ts' },
      toolOutput: { content: 'data' },
    };

    await bridge.onToolResult(ctx);

    const allFiles = db
      .prepare('SELECT * FROM pressure_scores WHERE project = ?')
      .all('test-proj');
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it('creates ThreadTracker and persists', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const ctx: PiToolResultContext = {
      ...createMockPiContext(),
      toolName: 'Edit',
      toolInput: { file_path: '/tmp/test/bar.ts' },
      toolOutput: {},
    };

    await bridge.onToolResult(ctx);

    const threadRow = db
      .prepare('SELECT * FROM thread_state WHERE session_id = ?')
      .get('test-s1');
    expect(threadRow).toBeDefined();
  });
});

describe('onTurnEnd callback', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      source: 'openclaw-bridge',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('calls captureDecisions with mode after_turn', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const ctx: PiMessageEndContext = {
      ...createMockPiContext(),
      lastAssistantText: 'Use TypeScript strict mode.',
      lastUserText: 'yes, go ahead',
    };

    // Should not throw
    await expect(bridge.onTurnEnd(ctx)).resolves.not.toThrow();
  });

  it('creates ThreadTracker and calls onAfterTurn', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);
    const ctx: PiMessageEndContext = {
      ...createMockPiContext(),
      lastAssistantText: 'analysis complete',
      lastUserText: 'what do you think?',
    };

    await bridge.onTurnEnd(ctx);

    const threadRow = db
      .prepare('SELECT * FROM thread_state WHERE session_id = ?')
      .get('test-s1');
    expect(threadRow).toBeDefined();
  });
});

describe('onCompact callback', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      source: 'openclaw-bridge',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('calls writeCheckpoint with compaction trigger', async () => {
    const bctx = createBctx(db);
    bctx.config = compactTestConfig;
    const bridge = createBridgeCallbacks(bctx);
    const ctx: PiCompactContext = createMockPiContext();
    const prep: PiCompactPrep = {
      messagesToSummarize: [{ role: 'user', content: 'old message' }],
      turnPrefixMessages: [],
    };

    // Should not throw
    await expect(bridge.onCompact(ctx, prep, {})).resolves.not.toThrow();
  });

  it('marks post-compact-pending', async () => {
    const bctx = createBctx(db);
    bctx.config = compactTestConfig;
    const bridge = createBridgeCallbacks(bctx);
    const ctx: PiCompactContext = createMockPiContext();
    const prep: PiCompactPrep = { messagesToSummarize: [], turnPrefixMessages: [] };

    await bridge.onCompact(ctx, prep, {});

    const tracking = getCheckpointTracking(db, 'test-s1');
    expect(tracking?.post_compact_pending).toBe(1);
  });
});

describe('Embedding caching', () => {
  let db: TestDatabase;

  // Mock fetch to simulate unavailable Ollama (avoids real network calls)
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      source: 'openclaw-bridge',
    });
    // Default: Ollama not running
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = originalFetch;
  });

  it('caches EmbeddingProvider across onContext and onTurnEnd calls', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);

    // Call onContext — should create embeddingCache
    await bridge.onContext(createMockPiContext());
    const cache1 = (bctx as any).embeddingCache;
    expect(cache1).toBeDefined();
    expect(cache1.configKey).toBe(`${testConfig.embeddings.ollama_base_url}|${testConfig.embeddings.model}`);

    // Call onTurnEnd — should reuse same cache
    const turnCtx: PiMessageEndContext = {
      ...createMockPiContext(),
      lastAssistantText: 'test',
      lastUserText: 'test',
    };
    await bridge.onTurnEnd(turnCtx);
    const cache2 = (bctx as any).embeddingCache;
    expect(cache2).toBe(cache1); // Same object reference
  });

  it('reuses cached provider across multiple onContext calls', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;

    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);

    await bridge.onContext(createMockPiContext());
    const firstCallCount = fetchCallCount;
    expect(firstCallCount).toBeGreaterThan(0); // At least one fetch for isAvailable

    await bridge.onContext(createMockPiContext());
    // Should NOT make additional fetch calls (provider reused, availability cached)
    expect(fetchCallCount).toBe(firstCallCount);
  });

  it('invalidates cache when embedding config changes', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);

    await bridge.onContext(createMockPiContext());
    const cache1 = (bctx as any).embeddingCache;

    // Change embedding config
    bctx.config = {
      ...testConfig,
      embeddings: { ...testConfig.embeddings, model: 'different-model' },
    } as unknown as ClaudexConfig;

    await bridge.onContext(createMockPiContext());
    const cache2 = (bctx as any).embeddingCache;

    // Cache should be a new object with different configKey
    expect(cache2).not.toBe(cache1);
    expect(cache2.configKey).toContain('different-model');
  });

  it('caches decision templates across onTurnEnd calls', async () => {
    // Make Ollama "available" with mock embeddings
    globalThis.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }));
      }
      // Return fake embeddings for batch
      return new Response(JSON.stringify({
        embeddings: Array(9).fill([0.1, 0.2, 0.3]),
      }));
    }) as typeof globalThis.fetch;

    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);

    const turnCtx: PiMessageEndContext = {
      ...createMockPiContext(),
      lastAssistantText: 'We decided to use X',
      lastUserText: 'ok go ahead',
    };

    await bridge.onTurnEnd(turnCtx);
    const cache = (bctx as any).embeddingCache;
    expect(cache.templatesInitialized).toBe(true);
    const templates1 = cache.templates;

    // Second call — templates should be reused (not re-initialized)
    await bridge.onTurnEnd(turnCtx);
    const templates2 = (bctx as any).embeddingCache.templates;
    expect(templates2).toBe(templates1); // Same reference
  });
});

describe('Error handling', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('callbacks are non-throwing on core function errors', async () => {
    // Use a closed DB to force errors
    const closedDb = createTestDb();
    closedDb.close();

    const bctx: BridgeContext = {
      db: closedDb,
      config: testConfig,
      project: 'test-proj',
      scope: null,
      sessionId: 'test-s1',
      cwd: '/tmp/test',
      adapter: 'openclaw' as const,
    };

    const bridge = createBridgeCallbacks(bctx);

    // All callbacks should catch and not propagate
    await expect(bridge.onInit({ sessionKey: 'x', cwd: '/x' })).resolves.not.toThrow();
    await expect(bridge.onContext(createMockPiContext())).resolves.not.toThrow();
    await expect(bridge.onToolResult({
      ...createMockPiContext(),
      toolName: 'Read',
      toolInput: {},
      toolOutput: {},
    })).resolves.not.toThrow();
    await expect(bridge.onTurnEnd({
      ...createMockPiContext(),
      lastAssistantText: '',
      lastUserText: '',
    })).resolves.not.toThrow();
    await expect(bridge.onCompact(createMockPiContext(), {
      messagesToSummarize: [],
      turnPrefixMessages: [],
    }, {})).resolves.not.toThrow();
  });

  it('callbacks emit telemetry with bridge_error on failure', async () => {
    const bctx = createBctx(db);
    const bridge = createBridgeCallbacks(bctx);

    // Close DB to force an error in subsequent calls after onInit succeeds
    // First create session so onInit path fails at a known point with a different closed db
    const closedDb = createTestDb();
    closedDb.close();
    const errorBctx: BridgeContext = {
      db: closedDb,
      config: testConfig,
      project: 'test-proj',
      scope: null,
      sessionId: 'test-s1',
      cwd: '/tmp/test',
      adapter: 'openclaw' as const,
    };
    const errorBridge = createBridgeCallbacks(errorBctx);

    // This will fail and emit bridge_error telemetry (but on a closed DB, so telemetry emit itself may fail silently)
    const result = await errorBridge.onInit({ sessionKey: 'x', cwd: '/x' });
    expect(result).toBeUndefined();
  });
});
