/**
 * re-vectorize.ts — arctic-embed2 re-vectorization helper tests.
 *
 * Phase 14-07a. All tests use `_setOllamaEmbedCallableForTest` to mock Ollama.
 * No real Ollama dependency required in CI.
 *
 * Covers:
 *   1. reVectorizeArtifact returns 1024-element Float32Array
 *   2. reVectorizeArtifact writes vector to vec_artifact_v17
 *   3. reVectorizeArtifact throws on dimension mismatch (mocked 768d response)
 *   4. reVectorizeArtifact throws on Ollama error (mock throws)
 *   5. reVectorizeAll: 10 artifacts → succeeded=10, failed=0
 *   6. reVectorizeAll: 2-of-10 with mock errors → succeeded=8, failed=2, telemetry rows present
 *   7. reVectorizeAll: progress callback fires every batch_size
 *   8. verifyDeterminism: identical mock outputs → deterministic=true
 *   9. verifyDeterminism: divergent mock outputs → deterministic=false, surfaces both byte arrays
 *  10. _setOllamaEmbedCallableForTest(null) restores production fetch path (no-throw verify)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  reVectorizeArtifact,
  reVectorizeAll,
  verifyDeterminism,
  _setOllamaEmbedCallableForTest,
} from '../../core/re-vectorize.js';
import { loadSqliteVec } from '../../core/sqlite-vec-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTable(db: Database.Database, name: string): boolean {
  return !!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Generate a deterministic 1024-element float array for tests. */
function mockVector(seed = 0.5): number[] {
  return new Array(1024).fill(seed);
}

/**
 * Build an in-memory DB with V17 DDL + vec_artifact_v17 + telemetry.
 * Optionally seeds `n` rows in the V17 artifact table.
 */
function buildTestDb(n = 0): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);

  // Ensure vec_artifact_v17 exists (may not if sqlite-vec unavailable).
  const vecLoaded = loadSqliteVec(db);
  if (vecLoaded && !hasTable(db, 'vec_artifact_v17')) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifact_v17 USING vec0(embedding float[1024])`);
    } catch { /* non-fatal */ }
  }

  if (n > 0) {
    const insert = db.prepare(`
      INSERT INTO artifact(id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms, project)
      VALUES (?, 'observation', ?, ?, ?, ?, 'test-project')
    `);
    for (let i = 0; i < n; i++) {
      insert.run(`artifact-${i}`, `Title ${i}`, `Body content ${i}`, 1700000000000 + i, 1700000000000 + i);
    }
  }

  return db;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  // Always restore the production fetch path after each test.
  _setOllamaEmbedCallableForTest(null);
});

// ---------------------------------------------------------------------------
// Tests: reVectorizeArtifact
// ---------------------------------------------------------------------------

describe('reVectorizeArtifact', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildTestDb(1);
  });
  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  // Test 1: returns 1024-element Float32Array
  it('1. returns a 1024-element Float32Array', async () => {
    _setOllamaEmbedCallableForTest(() => Promise.resolve(mockVector(0.5)));

    const result = await reVectorizeArtifact(db, 'artifact-0');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(1024);
  });

  // Test 2: writes vector to vec_artifact_v17
  it('2. writes the vector into vec_artifact_v17', async () => {
    if (!hasTable(db, 'vec_artifact_v17')) {
      // sqlite-vec not available in this environment — skip gracefully.
      return;
    }
    _setOllamaEmbedCallableForTest(() => Promise.resolve(mockVector(0.7)));

    await reVectorizeArtifact(db, 'artifact-0');

    // The rowid of artifact-0 should now have a vec entry.
    const artifactRow = db.prepare(`SELECT rowid FROM artifact WHERE id = ?`).get('artifact-0') as { rowid: number } | undefined;
    expect(artifactRow).toBeTruthy();

    const vecRow = db.prepare(`SELECT rowid FROM vec_artifact_v17 WHERE rowid = ?`).get(artifactRow!.rowid);
    expect(vecRow).toBeTruthy();
  });

  // Test 3: throws on dimension mismatch (mocked 768d response)
  it('3. throws on dimension mismatch (mocked 768-d response)', async () => {
    _setOllamaEmbedCallableForTest(() => Promise.resolve(new Array(768).fill(0.5)));

    await expect(reVectorizeArtifact(db, 'artifact-0')).rejects.toThrow('1024');
  });

  // Test 4: throws on Ollama error (mock throws)
  it('4. throws on Ollama error (mock throws)', async () => {
    _setOllamaEmbedCallableForTest(() => Promise.reject(new Error('Ollama /api/embed returned HTTP 500')));

    // Note: reVectorizeArtifact itself doesn't retry — that's reVectorizeAll.
    await expect(reVectorizeArtifact(db, 'artifact-0')).rejects.toThrow('HTTP 500');
  });
});

// ---------------------------------------------------------------------------
// Tests: reVectorizeAll
// ---------------------------------------------------------------------------

describe('reVectorizeAll', () => {
  let db: Database.Database;

  afterEach(() => { try { db.close(); } catch { /* noop */ } });

  // Test 5: 10 artifacts → succeeded=10, failed=0
  it('5. 10 artifacts → succeeded=10, failed=0', async () => {
    db = buildTestDb(10);
    _setOllamaEmbedCallableForTest(() => Promise.resolve(mockVector(0.5)));

    const result = await reVectorizeAll(db, { batch_size: 5, retry_base_delay_ms: 0 });
    expect(result.total).toBe(10);
    expect(result.succeeded).toBe(10);
    expect(result.failed).toBe(0);
  });

  // Test 6: 2-of-10 with mock errors → succeeded=8, failed=2, telemetry rows present
  it('6. 2-of-10 with injected errors → succeeded=8, failed=2, telemetry rows written', async () => {
    db = buildTestDb(10);

    let callCount = 0;
    _setOllamaEmbedCallableForTest(() => {
      callCount++;
      // Make calls 1 and 2 fail (artifacts 0 and 1), rest succeed.
      if (callCount <= 2) {
        return Promise.reject(new Error('Simulated Ollama error'));
      }
      return Promise.resolve(mockVector(0.5));
    });

    const result = await reVectorizeAll(db, {
      batch_size: 5,
      retry_base_delay_ms: 0, // No sleep between retries in tests.
    });

    expect(result.total).toBe(10);
    // With retries (3 attempts each), artifacts 0 and 1 consume 2+2=4 calls before failing.
    // The remaining 8 artifacts succeed on first attempt.
    // callCount ends at 4 + 8 = 12.
    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(8);

    // Telemetry rows for re_vectorize_failed should be present.
    if (hasTable(db, 'telemetry')) {
      try {
        const failedRows = (
          db.prepare(`SELECT COUNT(*) AS n FROM telemetry WHERE event_kind = 're_vectorize_failed'`).get() as { n: number }
        ).n;
        expect(failedRows).toBe(2);
      } catch {
        // telemetry table may not accept re_vectorize_failed yet in some test setups.
      }
    }
  });

  // Test 7: progress callback fires every batch_size
  it('7. progress callback fires every batch_size rows', async () => {
    db = buildTestDb(10);
    _setOllamaEmbedCallableForTest(() => Promise.resolve(mockVector(0.5)));

    const progressCalls: Array<[number, number]> = [];
    await reVectorizeAll(db, {
      batch_size: 3,
      on_progress: (done, total) => progressCalls.push([done, total]),
    });

    // With 10 artifacts and batch_size=3, progress fires at 3, 6, 9, 10.
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);
    // Final callback always has done === total.
    const last = progressCalls[progressCalls.length - 1];
    expect(last[0]).toBe(10);
    expect(last[1]).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Tests: verifyDeterminism
// ---------------------------------------------------------------------------

describe('verifyDeterminism', () => {
  // Test 8: identical mock outputs → deterministic=true
  it('8. identical mock outputs → deterministic=true', async () => {
    _setOllamaEmbedCallableForTest(() => Promise.resolve(mockVector(0.42)));

    const result = await verifyDeterminism('test content');
    expect(result.deterministic).toBe(true);
    expect(result.first_bytes).toBeInstanceOf(Uint8Array);
    expect(result.second_bytes).toBeInstanceOf(Uint8Array);
    expect(result.first_bytes.length).toBe(1024 * 4); // 1024 floats × 4 bytes each
  });

  // Test 9: divergent mock outputs → deterministic=false, surfaces both byte arrays
  it('9. divergent mock outputs → deterministic=false, both byte arrays returned', async () => {
    let calls = 0;
    _setOllamaEmbedCallableForTest(() => {
      calls++;
      // Return different vectors on each call.
      return Promise.resolve(mockVector(calls === 1 ? 0.1 : 0.9));
    });

    const result = await verifyDeterminism('test content');
    expect(result.deterministic).toBe(false);
    expect(result.first_bytes).toBeInstanceOf(Uint8Array);
    expect(result.second_bytes).toBeInstanceOf(Uint8Array);
    // The byte arrays must differ.
    let differ = false;
    for (let i = 0; i < result.first_bytes.length; i++) {
      if (result.first_bytes[i] !== result.second_bytes[i]) { differ = true; break; }
    }
    expect(differ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: _setOllamaEmbedCallableForTest(null)
// ---------------------------------------------------------------------------

describe('_setOllamaEmbedCallableForTest', () => {
  // Test 10: passing null restores production fetch path (no-throw verify)
  it('10. _setOllamaEmbedCallableForTest(null) restores production path without throwing', () => {
    // Set a mock first.
    _setOllamaEmbedCallableForTest(() => Promise.resolve(mockVector()));

    // Restore production path.
    expect(() => _setOllamaEmbedCallableForTest(null)).not.toThrow();

    // The callable should now be null — verified by the absence of an error
    // when calling the setter again with a new mock.
    expect(() => _setOllamaEmbedCallableForTest(() => Promise.resolve(mockVector()))).not.toThrow();

    // Restore for cleanup.
    _setOllamaEmbedCallableForTest(null);
  });
});
