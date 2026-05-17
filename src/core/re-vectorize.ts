/**
 * Phase 14-07a — arctic-embed2 re-vectorization helper.
 *
 * Invoked by 14-07c at cutover to re-vectorize all V17 unified artifact rows
 * from scratch into `vec_artifact_v17`. Deterministic: same artifact content
 * → byte-identical 1024-d vector across runs (arctic-embed2 produces
 * deterministic output for identical input).
 *
 * NOT invoked at production scale by 14-07a. This file ships the helper +
 * determinism tests; 14-07c invokes it at cutover, gated on operator.
 *
 * Architecture:
 * - `callOllamaEmbed(text, params)` → number[] (1024 floats)
 * - `reVectorizeArtifact(db, artifact_id, params)` → inserts 1024-d vector into vec_artifact_v17
 * - `reVectorizeAll(db, params)` → bulk re-vectorize with progress + failure handling
 * - `verifyDeterminism(sample_text, params)` → determinism check (gates 14-07c pre-cutover)
 * - `_setOllamaEmbedCallableForTest(fn)` → inject mock for testing (no real Ollama in CI)
 */

import type { Database } from 'better-sqlite3';
import { loadSqliteVec, encodeVector } from './sqlite-vec-loader.js';

// ─── Types ────────────────────────────────────────────────────────────────

/** A 1024-dimensional arctic-embed2 embedding vector. */
export type EmbeddingVector = Float32Array;

/** Configuration for Ollama /api/embed calls. */
export interface ReVectorizeParams {
  /** Ollama base URL. Default: 'http://localhost:11434' */
  ollama_base_url?: string;
  /** Embedding model name. Default: 'snowflake-arctic-embed2' — DO NOT CHANGE. */
  model?: string;
  /** Per-request timeout in milliseconds. Default: 10000 */
  timeout_ms?: number;
}

export interface ReVectorizeAllParams extends ReVectorizeParams {
  /** Number of artifacts processed per batch before emitting a progress callback. Default: 100 */
  batch_size?: number;
  /** Fired after each batch completes. `done` = total rows processed so far, `total` = grand total. */
  on_progress?: (done: number, total: number) => void;
  /**
   * Base delay in milliseconds between retry attempts. Default: 500.
   * Set to 0 in tests to avoid sleep overhead (the injectable callable eliminates
   * the need for real backoff in test scenarios).
   */
  retry_base_delay_ms?: number;
}

export interface ReVectorizeAllResult {
  total: number;
  succeeded: number;
  failed: number;
}

export interface DeterminismResult {
  deterministic: boolean;
  first_bytes: Uint8Array;
  second_bytes: Uint8Array;
}

// ─── Test Injection Point ─────────────────────────────────────────────────

/**
 * Injectable callable for the Ollama /api/embed endpoint.
 * Production: null (uses real fetch path).
 * Tests: set to a mock via `_setOllamaEmbedCallableForTest`.
 */
let _ollamaEmbedCallable: ((text: string) => Promise<number[]>) | null = null;

/**
 * Test-only: inject a callable for the Ollama /api/embed endpoint.
 * Pass null to restore the production fetch path.
 *
 * The callable receives the input text and must return a number[] of the
 * expected 1024-element dimension. It MAY throw to simulate Ollama errors.
 *
 * Example:
 *   _setOllamaEmbedCallableForTest(() => Promise.resolve(new Array(1024).fill(0.5)));
 */
export function _setOllamaEmbedCallableForTest(
  fn: ((text: string) => Promise<number[]>) | null
): void {
  _ollamaEmbedCallable = fn;
}

// ─── Core Ollama Call ─────────────────────────────────────────────────────

/**
 * Call Ollama /api/embed and return the raw float array.
 *
 * @throws If the HTTP response is non-2xx, if the response has no embeddings,
 *         or if the AbortController fires the timeout.
 */
async function callOllamaEmbed(
  text: string,
  params: ReVectorizeParams
): Promise<number[]> {
  const base = params.ollama_base_url ?? 'http://localhost:11434';
  const model = params.model ?? 'snowflake-arctic-embed2';
  const timeout = params.timeout_ms ?? 10_000;

  // Use the injected callable if set (test mode).
  if (_ollamaEmbedCallable !== null) {
    return _ollamaEmbedCallable(text);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `Ollama /api/embed returned HTTP ${response.status} ${response.statusText}`
    );
  }

  const json = (await response.json()) as { embeddings?: number[][] };
  const embedding = json.embeddings?.[0];
  if (!embedding || embedding.length === 0) {
    throw new Error(`Ollama /api/embed returned no embeddings`);
  }

  return embedding;
}

// ─── Single-Artifact Re-Vectorization ────────────────────────────────────

/**
 * Re-vectorize a single V17 artifact by its TEXT ID.
 *
 * Reads `title` and `body` from the V17 `artifact` table, concatenates them
 * as the input text, calls Ollama /api/embed, and writes the resulting 1024-d
 * vector into `vec_artifact_v17` (replacing any existing vector at the same rowid).
 *
 * The embedding input text is: `COALESCE(title, '') + '\n' + body` (matches
 * the convention used by the existing embed-pipeline for artifact content).
 *
 * @returns The 1024-element Float32Array for inspection in tests.
 * @throws On Ollama HTTP error, timeout, dimension mismatch, or missing artifact.
 */
export async function reVectorizeArtifact(
  db: Database,
  artifact_id: string,
  params?: ReVectorizeParams
): Promise<EmbeddingVector> {
  const p = params ?? {};

  // Fetch artifact content from V17 kernel.
  const row = db.prepare(
    `SELECT title, body, rowid FROM artifact WHERE id = ?`
  ).get(artifact_id) as { title: string | null; body: string; rowid: number | bigint } | undefined;

  if (!row) {
    throw new Error(`reVectorizeArtifact: artifact not found: ${artifact_id}`);
  }

  const inputText = `${row.title ?? ''}\n${row.body}`.trim();

  // Call Ollama (or injected mock in tests).
  const rawVector = await callOllamaEmbed(inputText, p);

  // Validate dimension.
  if (rawVector.length !== 1024) {
    throw new Error(
      `reVectorizeArtifact: expected 1024-dim vector from arctic-embed2, got ${rawVector.length}`
    );
  }

  const f32 = new Float32Array(rawVector);
  const vecBlob = encodeVector(f32);

  // Ensure sqlite-vec is loaded on this connection.
  loadSqliteVec(db);

  // Upsert into vec_artifact_v17 using artifact rowid as the vec0 rowid.
  // vec0 does not support ON CONFLICT clauses, so we DELETE + INSERT.
  // Coerce rowid to a plain integer (better-sqlite3 may return bigint for large rowids).
  const vecRowid = Number(row.rowid);
  db.prepare(`DELETE FROM vec_artifact_v17 WHERE rowid = ?`).run(vecRowid);
  db.prepare(`INSERT INTO vec_artifact_v17(rowid, embedding) VALUES (?, ?)`).run(
    vecRowid,
    vecBlob
  );

  return f32;
}

// ─── Bulk Re-Vectorization ────────────────────────────────────────────────

/**
 * Bulk re-vectorize all V17 artifact rows.
 *
 * Iterates the `artifact` table, calls `reVectorizeArtifact` per row,
 * and logs failures to the `telemetry` table (event_kind='re_vectorize_failed').
 *
 * Per-row failures do NOT abort the bulk operation. Failures are counted and
 * returned in the result. The 14-07c cutover script enforces the 5% failure
 * threshold: `failed / total > 0.05 → ABORT cutover`.
 *
 * Progress callback fires after each batch (default batch_size=100) with
 * `(done, total)` where `done` is cumulative rows processed (succeeded + failed).
 *
 * Retry policy: 3 attempts per artifact with 500ms + 1000ms + 2000ms backoff
 * on transient errors. Permanent errors (e.g., dimension mismatch) are logged
 * immediately without retry.
 */
export async function reVectorizeAll(
  db: Database,
  params?: ReVectorizeAllParams
): Promise<ReVectorizeAllResult> {
  const p = params ?? {};
  const batchSize = p.batch_size ?? 100;
  const onProgress = p.on_progress;
  const retryBaseDelay = p.retry_base_delay_ms ?? 500;

  // Fetch all artifact IDs from V17 kernel.
  const allIds = (
    db.prepare(`SELECT id FROM artifact ORDER BY created_at_epoch_ms ASC`).all() as Array<{ id: string }>
  ).map(r => r.id);

  const total = allIds.length;
  let succeeded = 0;
  let failed = 0;
  let done = 0;

  for (let i = 0; i < allIds.length; i++) {
    const artifact_id = allIds[i];
    let lastError: unknown = null;
    let ok = false;

    // Retry up to 3 times with exponential backoff.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await reVectorizeArtifact(db, artifact_id, p);
        ok = true;
        break;
      } catch (err) {
        lastError = err;
        // Permanent error (dimension mismatch, missing artifact) — no retry.
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes('expected 1024-dim') ||
          msg.includes('artifact not found')
        ) {
          break;
        }
        // Transient error — wait before retry.
        if (attempt < 2) {
          await sleep([500, 1000, 2000][attempt]);
        }
      }
    }

    if (ok) {
      succeeded++;
    } else {
      failed++;
      // Log failure to telemetry (non-throwing — telemetry is best-effort).
      try {
        db.prepare(`
          INSERT INTO telemetry(session_id, event_kind, detail)
          VALUES ('re_vectorize', 're_vectorize_failed', json_object(
            'artifact_id', ?,
            'error', ?
          ))
        `).run(
          artifact_id,
          lastError instanceof Error ? lastError.message : String(lastError)
        );
      } catch { /* telemetry failure is non-fatal */ }
    }

    done++;
    if (onProgress && (done % batchSize === 0 || done === total)) {
      onProgress(done, total);
    }
  }

  return { total, succeeded, failed };
}

// ─── Determinism Verification ─────────────────────────────────────────────

/**
 * Verify that Ollama produces byte-identical vectors for identical input.
 *
 * Calls Ollama /api/embed twice with the same `sample_text` and compares
 * the resulting byte representations. If arctic-embed2 is deterministic
 * (the expected behavior), `deterministic === true`.
 *
 * If non-deterministic (e.g., because the model was rebuilt or Ollama updated
 * its quantization), `deterministic === false` and both byte arrays are
 * returned for diagnostic comparison.
 *
 * This function is the pre-cutover sanity gate for 14-07c. If non-deterministic,
 * hold cutover and surface to operator — do NOT loosen the gate.
 */
export async function verifyDeterminism(
  sample_text: string,
  params?: ReVectorizeParams
): Promise<DeterminismResult> {
  const p = params ?? {};

  const first = await callOllamaEmbed(sample_text, p);
  const second = await callOllamaEmbed(sample_text, p);

  const firstBytes = new Uint8Array(new Float32Array(first).buffer);
  const secondBytes = new Uint8Array(new Float32Array(second).buffer);

  let deterministic = firstBytes.length === secondBytes.length;
  if (deterministic) {
    for (let i = 0; i < firstBytes.length; i++) {
      if (firstBytes[i] !== secondBytes[i]) {
        deterministic = false;
        break;
      }
    }
  }

  return {
    deterministic,
    first_bytes: firstBytes,
    second_bytes: secondBytes,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
