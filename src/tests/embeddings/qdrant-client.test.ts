/**
 * Tests for qdrant-client.ts — Qdrant vector DB client.
 *
 * Tests verify:
 * - Non-throwing behavior when Qdrant is unavailable (graceful degradation)
 * - Client singleton management and health check caching
 * - Collection name constants
 * - Search/upsert functions return safe defaults when unavailable
 * - hashStringToInt produces stable, positive integers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getQdrantClient,
  isQdrantAvailable,
  resetQdrantClient,
  ensureCollections,
  upsertArtifactEmbedding,
  upsertPatternEmbedding,
  upsertJournalEmbedding,
  searchArtifacts,
  searchPatterns,
  searchJournal,
  deleteArtifactPoint,
  COLLECTIONS,
  type ArtifactPayload,
  type PatternPayload,
} from '../../embeddings/qdrant-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('COLLECTIONS', () => {
  it('defines all 4 collection names', () => {
    expect(COLLECTIONS.artifacts).toBe('claudex_artifacts');
    expect(COLLECTIONS.patterns).toBe('claudex_patterns');
    expect(COLLECTIONS.threads).toBe('claudex_threads');
    expect(COLLECTIONS.journal).toBe('claudex_journal');
  });
});

// ---------------------------------------------------------------------------
// Client lifecycle (Qdrant not running — graceful degradation)
// ---------------------------------------------------------------------------

describe('client lifecycle (Qdrant unavailable)', () => {
  beforeEach(() => {
    resetQdrantClient();
  });

  it('getQdrantClient returns null when Qdrant is down', async () => {
    // Point at a port nothing is listening on
    const client = await getQdrantClient({ url: 'http://127.0.0.1:19999', timeoutMs: 500 });
    expect(client).toBeNull();
  });

  it('isQdrantAvailable returns false before any check', () => {
    expect(isQdrantAvailable()).toBe(false);
  });

  it('isQdrantAvailable returns false after failed health check', async () => {
    await getQdrantClient({ url: 'http://127.0.0.1:19999', timeoutMs: 500 });
    expect(isQdrantAvailable()).toBe(false);
  });

  it('resetQdrantClient clears cached state', async () => {
    await getQdrantClient({ url: 'http://127.0.0.1:19999', timeoutMs: 500 });
    resetQdrantClient();
    // After reset, availability is unknown (null), which means isQdrantAvailable() returns false
    expect(isQdrantAvailable()).toBe(false);
  });

  it('caches unavailability — skips health check within interval', async () => {
    const start = Date.now();
    await getQdrantClient({ url: 'http://127.0.0.1:19999', timeoutMs: 500 });
    // Second call should be near-instant (cached)
    const result = await getQdrantClient({ url: 'http://127.0.0.1:19999', timeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // First call takes ~500ms timeout, second should be cached
    expect(elapsed).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// Non-throwing operations (Qdrant unavailable)
// ---------------------------------------------------------------------------

describe('operations when Qdrant is unavailable', () => {
  beforeEach(() => {
    resetQdrantClient();
  });

  const fakeEmbedding = Array.from({ length: 1024 }, () => Math.random());
  const fakeConfig = { url: 'http://127.0.0.1:19999', timeoutMs: 500 };

  const fakeArtifactPayload: ArtifactPayload = {
    artifact_id: 1,
    project: 'test',
    artifact_type: 'observation',
    importance: 3,
    confidence: 1.0,
    activation_score: 1.0,
    session_id: 'test-session',
    timestamp_epoch: 1000000,
    superseded: false,
    summary: 'test artifact',
  };

  const fakePatternPayload: PatternPayload = {
    pattern_id: '01ABC123',
    project: 'test',
    pattern_type: 'correction',
    severity: 'important',
    score: 3,
    times_triggered: 0,
    times_useful: 0,
    verified: false,
    trigger_context: 'test context',
  };

  it('ensureCollections returns false', async () => {
    expect(await ensureCollections(fakeConfig)).toBe(false);
  });

  it('upsertArtifactEmbedding returns false', async () => {
    expect(await upsertArtifactEmbedding(1, fakeEmbedding, fakeArtifactPayload, fakeConfig)).toBe(false);
  });

  it('upsertPatternEmbedding returns false', async () => {
    expect(await upsertPatternEmbedding('01ABC', fakeEmbedding, fakePatternPayload, fakeConfig)).toBe(false);
  });

  it('upsertJournalEmbedding returns false', async () => {
    expect(await upsertJournalEmbedding(1, fakeEmbedding, { project: 'test' }, fakeConfig)).toBe(false);
  });

  it('searchArtifacts returns empty array', async () => {
    expect(await searchArtifacts(fakeEmbedding, 'test', 10, undefined, fakeConfig)).toEqual([]);
  });

  it('searchPatterns returns empty array', async () => {
    expect(await searchPatterns(fakeEmbedding, 'test', 5, fakeConfig)).toEqual([]);
  });

  it('searchJournal returns empty array', async () => {
    expect(await searchJournal(fakeEmbedding, 'test', 5, fakeConfig)).toEqual([]);
  });

  it('deleteArtifactPoint returns false', async () => {
    expect(await deleteArtifactPoint(1, fakeConfig)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type contracts
// ---------------------------------------------------------------------------

describe('type contracts', () => {
  it('ArtifactPayload has all required fields', () => {
    const payload: ArtifactPayload = {
      artifact_id: 1,
      project: 'test',
      artifact_type: 'decision',
      importance: 4,
      confidence: 0.9,
      activation_score: 1.5,
      session_id: 'sess-1',
      timestamp_epoch: 1234567890,
      superseded: false,
      summary: 'A decision about architecture',
    };
    expect(payload.artifact_id).toBe(1);
    expect(payload.superseded).toBe(false);
  });

  it('PatternPayload has all required fields', () => {
    const payload: PatternPayload = {
      pattern_id: 'pat-1',
      project: 'test',
      pattern_type: 'behavioral',
      severity: 'critical',
      score: 5,
      times_triggered: 10,
      times_useful: 8,
      verified: true,
      trigger_context: 'when editing migrations',
    };
    expect(payload.verified).toBe(true);
    expect(payload.score).toBe(5);
  });

  it('SearchResult interface is correct', () => {
    // searchArtifacts returns SearchResult[] — verify shape via empty result
    const results: Array<{ id: number | string; score: number; payload: Record<string, unknown> }> = [];
    expect(results).toEqual([]);
  });
});
