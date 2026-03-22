/**
 * End-to-end test: Qdrant client against a live Qdrant instance.
 *
 * SKIP conditions: This test suite only runs when Qdrant is actually reachable
 * at localhost:6333. It is skipped automatically if Qdrant is not running.
 * This is an integration test, not a unit test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getQdrantClient,
  resetQdrantClient,
  ensureCollections,
  upsertArtifactEmbedding,
  searchArtifacts,
  deleteArtifactPoint,
  COLLECTIONS,
  type ArtifactPayload,
} from '../../embeddings/qdrant-client.js';
import { QdrantClient } from '@qdrant/js-client-rest';

// ---------------------------------------------------------------------------
// Check Qdrant availability before suite runs
// ---------------------------------------------------------------------------

async function checkQdrant(): Promise<boolean> {
  try {
    const client = new QdrantClient({
      url: 'http://localhost:6333',
      timeout: 2000,
      checkCompatibility: false,
    });
    await client.getCollections();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// E2E tests
// ---------------------------------------------------------------------------

const skip = !(await checkQdrant());

afterAll(() => {
  resetQdrantClient();
});

describe.skipIf(skip)('Qdrant E2E (live instance)', () => {
  it('getQdrantClient returns a client', async () => {
    resetQdrantClient();
    const client = await getQdrantClient({ timeoutMs: 5000 });
    expect(client).not.toBeNull();
  });

  it('ensureCollections creates all 4 collections', async () => {
    resetQdrantClient();
    const result = await ensureCollections();
    expect(result).toBe(true);

    // Verify collections exist
    const client = new QdrantClient({
      url: 'http://localhost:6333',
      timeout: 5000,
      checkCompatibility: false,
    });
    const { collections } = await client.getCollections();
    const names = collections.map(c => c.name);

    expect(names).toContain(COLLECTIONS.artifacts);
    expect(names).toContain(COLLECTIONS.patterns);
    expect(names).toContain(COLLECTIONS.threads);
    expect(names).toContain(COLLECTIONS.journal);
  });

  it('upsert + search round-trip works', async () => {
    resetQdrantClient();
    await ensureCollections();

    // Create two similar vectors and one different
    const vec1 = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1));
    const vec2 = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1 + 0.05));
    const vecDiff = Array.from({ length: 384 }, (_, i) => Math.cos(i * 0.5));

    // Normalize
    const normalize = (v: number[]) => {
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return v.map(x => x / n);
    };

    const payload1: ArtifactPayload = {
      artifact_id: 99901,
      project: 'e2e-test',
      artifact_type: 'decision',
      importance: 5,
      confidence: 1.0,
      activation_score: 1.0,
      session_id: 'e2e-session',
      timestamp_epoch: Math.floor(Date.now() / 1000),
      superseded: false,
      summary: 'Fix migration bug in schema',
    };

    const payload2: ArtifactPayload = {
      ...payload1,
      artifact_id: 99902,
      artifact_type: 'observation',
      importance: 3,
      summary: 'Auth endpoint implementation',
    };

    const payload3: ArtifactPayload = {
      ...payload1,
      artifact_id: 99903,
      project: 'other-project',
      summary: 'Unrelated observation',
    };

    // Upsert all three
    expect(await upsertArtifactEmbedding(99901, normalize(vec1), payload1)).toBe(true);
    expect(await upsertArtifactEmbedding(99902, normalize(vec2), payload2)).toBe(true);
    expect(await upsertArtifactEmbedding(99903, normalize(vecDiff), payload3)).toBe(true);

    // Wait for indexing
    await new Promise(r => setTimeout(r, 500));

    // Search for similar to vec1 in project e2e-test
    const results = await searchArtifacts(normalize(vec1), 'e2e-test', 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].id).toBe(99901); // Exact match
    expect(results[0].score).toBeCloseTo(1.0, 2);

    // Should NOT include the other-project point
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(99903);

    // Cleanup
    await deleteArtifactPoint(99901);
    await deleteArtifactPoint(99902);
    await deleteArtifactPoint(99903);
  });

  it('search with importance filter works', async () => {
    resetQdrantClient();
    await ensureCollections();

    const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.3));
    const normalize = (v: number[]) => {
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return v.map(x => x / n);
    };

    const basePayload: ArtifactPayload = {
      artifact_id: 99904,
      project: 'filter-test',
      artifact_type: 'observation',
      importance: 2,
      confidence: 1.0,
      activation_score: 1.0,
      session_id: 'e2e-session',
      timestamp_epoch: Math.floor(Date.now() / 1000),
      superseded: false,
      summary: 'Low importance',
    };

    const highPayload: ArtifactPayload = {
      ...basePayload,
      artifact_id: 99905,
      importance: 5,
      summary: 'High importance',
    };

    await upsertArtifactEmbedding(99904, normalize(vec), basePayload);
    await upsertArtifactEmbedding(99905, normalize(vec), highPayload);
    await new Promise(r => setTimeout(r, 500));

    // Filter: minImportance >= 4
    const results = await searchArtifacts(normalize(vec), 'filter-test', 10, { minImportance: 4 });
    expect(results.every(r => (r.payload as Record<string, unknown>).importance as number >= 4)).toBe(true);

    // Cleanup
    await deleteArtifactPoint(99904);
    await deleteArtifactPoint(99905);
  });

  it('deleteArtifactPoint removes the point', async () => {
    resetQdrantClient();
    await ensureCollections();

    const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.7));
    const normalize = (v: number[]) => {
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return v.map(x => x / n);
    };

    const payload: ArtifactPayload = {
      artifact_id: 99906,
      project: 'delete-test',
      artifact_type: 'learning',
      importance: 3,
      confidence: 1.0,
      activation_score: 1.0,
      session_id: 'e2e-session',
      timestamp_epoch: Math.floor(Date.now() / 1000),
      superseded: false,
      summary: 'Deletable point',
    };

    await upsertArtifactEmbedding(99906, normalize(vec), payload);
    await new Promise(r => setTimeout(r, 300));

    // Verify it exists
    let results = await searchArtifacts(normalize(vec), 'delete-test', 5);
    expect(results.some(r => r.id === 99906)).toBe(true);

    // Delete it
    expect(await deleteArtifactPoint(99906)).toBe(true);
    await new Promise(r => setTimeout(r, 300));

    // Verify it's gone
    results = await searchArtifacts(normalize(vec), 'delete-test', 5);
    expect(results.some(r => r.id === 99906)).toBe(false);
  });
});
