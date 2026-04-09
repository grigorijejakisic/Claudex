/**
 * sqlite-vec extension loader.
 *
 * The sqlite-vec extension provides vector similarity search via vec0 virtual
 * tables — a single-SQLite-file alternative to running Qdrant as a separate
 * service. Loaded at DB open time via better-sqlite3's loadExtension() API.
 *
 * Loadable extensions do NOT persist across DB connections — every new
 * `new Database(...)` call must call `loadSqliteVec(db)` if it intends to
 * query vec0 tables. The migration runner and initializeSchema() call this
 * automatically; ad-hoc scripts must call it explicitly.
 *
 * Non-throwing: if the extension can't be loaded (package missing, binary
 * mismatch, platform not supported), logs a warning and returns false.
 * Callers should treat false as "vec0 virtual tables are unavailable" and
 * fall back to Qdrant or FTS5-only retrieval.
 *
 * Status: Phase 1 of the Qdrant → sqlite-vec migration
 * (see context/specs/SQLITE_VEC_MIGRATION.md). The virtual tables exist
 * alongside Qdrant as dormant storage — no caller writes or reads from
 * them yet. Phase 2 wires them into the retrieval pipeline via a facade.
 */

import type { Database } from 'better-sqlite3';

let loadAttempted = false;
let loadSucceeded = false;
let loadErrorMessage: string | null = null;

/**
 * Load the sqlite-vec extension into a better-sqlite3 database connection.
 *
 * Idempotent per-connection: calling this multiple times on the same db is
 * safe (the second call is a no-op from sqlite-vec's perspective; the
 * extension is already registered on that connection).
 *
 * Returns true if the extension is loaded and vec0 virtual tables are usable,
 * false otherwise.
 */
export function loadSqliteVec(db: Database): boolean {
  try {
    // Dynamic require so Node resolves the native binary at call time —
    // makes it possible to bundle without a hard link-time dependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec') as { load: (db: Database) => void };
    sqliteVec.load(db);

    // Smoke-check: vec_version() should return a non-null string on success.
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string } | undefined;
    if (!row?.v) {
      if (!loadAttempted) {
        loadErrorMessage = 'vec_version() returned null after load';
        loadAttempted = true;
      }
      return false;
    }

    loadAttempted = true;
    loadSucceeded = true;
    loadErrorMessage = null;
    return true;
  } catch (err) {
    if (!loadAttempted) {
      loadErrorMessage = err instanceof Error ? err.message : String(err);
      loadAttempted = true;
      loadSucceeded = false;
      // Log once at the first failure, not on every call.
      process.stderr.write(
        `[sqlite-vec] failed to load: ${loadErrorMessage} — vec0 tables unavailable, falling back to Qdrant\n`,
      );
    }
    return false;
  }
}

/**
 * Introspection helpers — useful for telemetry and health checks.
 */
export function sqliteVecLoadStatus(): { attempted: boolean; succeeded: boolean; error: string | null } {
  return { attempted: loadAttempted, succeeded: loadSucceeded, error: loadErrorMessage };
}

/**
 * Reset the module-level load tracking. Used by tests to simulate fresh state.
 */
export function resetSqliteVecLoadStatus(): void {
  loadAttempted = false;
  loadSucceeded = false;
  loadErrorMessage = null;
}

/**
 * Encode a vector for storage in a vec0 virtual table column.
 *
 * sqlite-vec expects Float32Array data as a Buffer. Passing a raw Float32Array
 * to better-sqlite3 binds it as a JS object which vec0 rejects. Wrapping in
 * Buffer.from(arr.buffer) gives better-sqlite3 a byte array it can bind as BLOB,
 * which vec0 interprets as a packed float[] value.
 */
export function encodeVector(embedding: Float32Array | number[]): Buffer {
  const f32 = embedding instanceof Float32Array
    ? embedding
    : new Float32Array(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
