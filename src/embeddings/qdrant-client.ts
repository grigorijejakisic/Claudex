/**
 * Qdrant vector database client — manages collections, upserts, and search.
 *
 * Dual-write pattern: SQLite is always written first (source of truth).
 * Qdrant upsert follows. If Qdrant is down, SQLite + FTS5 still works.
 * Qdrant is acceleration, not dependency.
 *
 * All public functions are non-throwing with safe defaults.
 *
 * Backend dispatch (Phase 2 of the Qdrant → sqlite-vec migration):
 * Each public function checks `CLAUDEX_VECTOR_BACKEND` at call time. If the
 * env var is set to "sqlite-vec", the call is forwarded to the corresponding
 * `*Vec` function in `./sqlite-vec-backend.ts`. Otherwise, the existing
 * Qdrant code path runs. Default backend is "qdrant" for rollback safety.
 * See context/specs/SQLITE_VEC_MIGRATION.md for the full plan.
 *
 * Setting the backend at runtime requires two things:
 *   1. `CLAUDEX_VECTOR_BACKEND=sqlite-vec` in the environment
 *   2. `setVectorStoreDb(db)` called with a live better-sqlite3 connection
 *      (exported here — re-exported from sqlite-vec-backend.ts)
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import * as vec from './sqlite-vec-backend.js';

// Re-export the db setter so callers have a single import point.
export { setVectorStoreDb, getVectorStoreDb, isSqliteVecReady } from './sqlite-vec-backend.js';

/**
 * Read the active vector backend from the environment.
 * Default: 'qdrant' (rollback-safe). Override with CLAUDEX_VECTOR_BACKEND=sqlite-vec.
 *
 * Checked at each function entry so flipping the env var takes effect on
 * the next call without process restart. Cheap string comparison.
 */
function getBackend(): 'qdrant' | 'sqlite-vec' {
  return process.env.CLAUDEX_VECTOR_BACKEND === 'sqlite-vec' ? 'sqlite-vec' : 'qdrant';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QdrantConfig {
  /** Qdrant HTTP endpoint. Default: http://localhost:6333 */
  url: string;
  /** Embedding dimension. Default: 1024 (snowflake-arctic-embed2) */
  dimensions: number;
  /** Connection timeout in ms. Default: 3000 */
  timeoutMs: number;
}

export interface ArtifactPayload {
  artifact_id: number;
  project: string;
  artifact_type: string;
  importance: number;
  confidence: number;
  activation_score: number;
  session_id: string;
  timestamp_epoch: number;
  superseded: boolean;
  summary: string;
}

export interface PatternPayload {
  pattern_id: string;
  project: string;
  pattern_type: string;
  severity: string;
  score: number;
  times_triggered: number;
  times_useful: number;
  verified: boolean;
  trigger_context: string;
}

export interface SearchResult {
  id: number | string;
  score: number;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Collection names
// ---------------------------------------------------------------------------

export const COLLECTIONS = {
  artifacts: 'claudex_artifacts',
  patterns: 'claudex_patterns',
  threads: 'claudex_threads',
  journal: 'claudex_journal',
  conversations: 'claudex_conversations',
} as const;

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_QDRANT_CONFIG: QdrantConfig = {
  url: 'http://localhost:6333',
  dimensions: 1024,
  timeoutMs: 3000,
};

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client: QdrantClient | null = null;
let _available: boolean | null = null;
let _lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/**
 * Get or create the Qdrant client singleton.
 * Returns null if Qdrant is unavailable.
 * Caches availability for 30 seconds.
 * Non-throwing.
 */
export async function getQdrantClient(config?: Partial<QdrantConfig>): Promise<QdrantClient | null> {
  try {
    const cfg = { ...DEFAULT_QDRANT_CONFIG, ...config };

    // Check cached availability
    const now = Date.now();
    if (_available === false && now - _lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) {
      return null;
    }

    if (!_client) {
      _client = new QdrantClient({
        url: cfg.url,
        timeout: cfg.timeoutMs,
      });
    }

    // Health check
    if (_available === null || now - _lastHealthCheck >= HEALTH_CHECK_INTERVAL_MS) {
      try {
        await _client.getCollections();
        _available = true;
      } catch {
        _available = false;
      }
      _lastHealthCheck = now;
    }

    return _available ? _client : null;
  } catch {
    _available = false;
    return null;
  }
}

/**
 * Check if Qdrant is available without creating a client.
 * Uses cached health state. Non-throwing.
 */
export function isQdrantAvailable(): boolean {
  return _available === true;
}

/**
 * Reset client state (for testing).
 */
export function resetQdrantClient(): void {
  _client = null;
  _available = null;
  _lastHealthCheck = 0;
}

// ---------------------------------------------------------------------------
// Collection management
// ---------------------------------------------------------------------------

/**
 * Ensures all required collections exist with correct schema.
 * Idempotent — safe to call on every startup.
 * Non-throwing.
 */
export async function ensureCollections(config?: Partial<QdrantConfig>): Promise<boolean> {
  if (getBackend() === 'sqlite-vec') {
    return vec.ensureVecCollections(config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return false;

    const cfg = { ...DEFAULT_QDRANT_CONFIG, ...config };

    const collections = [
      COLLECTIONS.artifacts,
      COLLECTIONS.patterns,
      COLLECTIONS.threads,
      COLLECTIONS.journal,
      COLLECTIONS.conversations,
    ];

    for (const name of collections) {
      try {
        const exists = await client.collectionExists(name);
        if (!exists.exists) {
          await client.createCollection(name, {
            vectors: { size: cfg.dimensions, distance: 'Cosine' },
          });
        }
      } catch {
        // Collection might already exist (race) — non-fatal
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Upsert operations
// ---------------------------------------------------------------------------

/**
 * Upsert an artifact embedding into Qdrant.
 * Point ID = artifact_id (integer). Payload includes all filterable metadata.
 * Non-throwing.
 */
export async function upsertArtifactEmbedding(
  artifactId: number,
  embedding: number[],
  payload: ArtifactPayload,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  if (getBackend() === 'sqlite-vec') {
    return vec.upsertArtifactEmbeddingVec(artifactId, embedding, payload, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return false;

    await client.upsert(COLLECTIONS.artifacts, {
      wait: false, // async — don't block the hook
      points: [{
        id: artifactId,
        vector: embedding,
        payload: payload as unknown as Record<string, unknown>,
      }],
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert a pattern embedding into Qdrant.
 * Point ID = auto-generated (Qdrant handles ULID→int mapping).
 * Non-throwing.
 */
export async function upsertPatternEmbedding(
  patternId: string,
  embedding: number[],
  payload: PatternPayload,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  if (getBackend() === 'sqlite-vec') {
    return vec.upsertPatternEmbeddingVec(patternId, embedding, payload, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return false;

    // Use a stable numeric ID derived from the ULID string
    const numericId = hashStringToInt(patternId);

    await client.upsert(COLLECTIONS.patterns, {
      wait: false,
      points: [{
        id: numericId,
        vector: embedding,
        payload: { ...payload as unknown as Record<string, unknown>, pattern_id_str: patternId },
      }],
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert a journal entry embedding into Qdrant.
 * Non-throwing.
 */
export async function upsertJournalEmbedding(
  journalId: number,
  embedding: number[],
  payload: Record<string, unknown>,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  if (getBackend() === 'sqlite-vec') {
    return vec.upsertJournalEmbeddingVec(journalId, embedding, payload, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return false;

    await client.upsert(COLLECTIONS.journal, {
      wait: false,
      points: [{
        id: journalId,
        vector: embedding,
        payload,
      }],
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert a conversation turn embedding into Qdrant.
 * Non-throwing.
 */
export async function upsertConversationEmbedding(
  turnId: number,
  embedding: number[],
  payload: Record<string, unknown>,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  if (getBackend() === 'sqlite-vec') {
    return vec.upsertConversationEmbeddingVec(turnId, embedding, payload, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return false;

    await client.upsert(COLLECTIONS.conversations, {
      wait: false,
      points: [{
        id: turnId,
        vector: embedding,
        payload,
      }],
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Search conversation turns by semantic similarity.
 * Used for recall — finding dialogue by how the user would describe it.
 * Non-throwing.
 */
export async function searchConversations(
  embedding: number[],
  project: string,
  limit: number = 5,
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  if (getBackend() === 'sqlite-vec') {
    return vec.searchConversationsVec(embedding, project, limit, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return [];

    const results = await client.search(COLLECTIONS.conversations, {
      vector: embedding,
      limit,
      filter: {
        must: [
          { key: 'project', match: { value: project } },
        ],
      },
      with_payload: true,
    });

    return results.map(r => ({
      id: r.id as number,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Search operations
// ---------------------------------------------------------------------------

/**
 * Semantic search across artifact embeddings with metadata filtering.
 * This is the key advantage over FTS5: query is semantic (vocabulary-mismatch tolerant)
 * AND metadata filters are applied inside the vector query (not post-hoc).
 *
 * @param embedding - query embedding vector
 * @param project - project scope filter
 * @param limit - max results
 * @param filters - optional metadata filters (importance, type, etc.)
 * @returns ranked search results with payloads
 */
export async function searchArtifacts(
  embedding: number[],
  project: string,
  limit: number = 10,
  filters?: {
    minImportance?: number;
    artifactTypes?: string[];
    excludeSuperseded?: boolean;
  },
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  if (getBackend() === 'sqlite-vec') {
    return vec.searchArtifactsVec(embedding, project, limit, filters, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return [];

    // Build Qdrant filter
    const must: Array<Record<string, unknown>> = [
      { key: 'project', match: { value: project } },
    ];

    if (filters?.excludeSuperseded !== false) {
      must.push({ key: 'superseded', match: { value: false } });
    }

    if (filters?.minImportance) {
      must.push({ key: 'importance', range: { gte: filters.minImportance } });
    }

    if (filters?.artifactTypes && filters.artifactTypes.length > 0) {
      must.push({
        key: 'artifact_type',
        match: { any: filters.artifactTypes },
      });
    }

    const results = await client.search(COLLECTIONS.artifacts, {
      vector: embedding,
      limit,
      filter: { must },
      with_payload: true,
    });

    return results.map(r => ({
      id: r.id as number,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}

/**
 * Search patterns by semantic similarity.
 * Used for matching experience patterns against user prompts.
 * Non-throwing.
 */
export async function searchPatterns(
  embedding: number[],
  project: string,
  limit: number = 5,
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  if (getBackend() === 'sqlite-vec') {
    return vec.searchPatternsVec(embedding, project, limit, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return [];

    const results = await client.search(COLLECTIONS.patterns, {
      vector: embedding,
      limit,
      filter: {
        must: [
          {
            should: [
              { key: 'project', match: { value: project } },
              { key: 'project', match: { value: '__global__' } },
            ],
          },
        ],
      },
      with_payload: true,
    });

    return results.map(r => ({
      id: r.id as number,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}

/**
 * Search journal entries by semantic similarity.
 * Used for recall — finding sessions by how the user would describe them.
 * Non-throwing.
 */
export async function searchJournal(
  embedding: number[],
  project: string,
  limit: number = 5,
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  if (getBackend() === 'sqlite-vec') {
    return vec.searchJournalVec(embedding, project, limit, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return [];

    const results = await client.search(COLLECTIONS.journal, {
      vector: embedding,
      limit,
      filter: {
        must: [
          { key: 'project', match: { value: project } },
        ],
      },
      with_payload: true,
    });

    return results.map(r => ({
      id: r.id as number,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Delete operations
// ---------------------------------------------------------------------------

/**
 * Upsert a thread embedding into the claudex_threads collection.
 * Called by Stop hook when a thread summary is embedded.
 * Non-throwing.
 */
export async function upsertThreadEmbedding(
  sessionId: string,
  embedding: number[],
  payload: Record<string, unknown>,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  if (getBackend() === 'sqlite-vec') {
    return vec.upsertThreadEmbeddingVec(sessionId, embedding, payload, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return false;

    // Use stable hash of session_id for Qdrant point ID
    const pointId = hashStringToInt(sessionId);

    await client.upsert(COLLECTIONS.threads, {
      wait: false,
      points: [{
        id: pointId,
        vector: embedding,
        payload: { ...payload, session_id: sessionId },
      }],
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Search thread summaries by semantic similarity.
 * Used for cross-session thread linking — finding related past threads.
 * Non-throwing.
 */
export async function searchThreads(
  embedding: number[],
  project: string,
  limit: number = 5,
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  if (getBackend() === 'sqlite-vec') {
    return vec.searchThreadsVec(embedding, project, limit, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return [];

    const results = await client.search(COLLECTIONS.threads, {
      vector: embedding,
      limit,
      filter: {
        must: [{ key: 'project', match: { value: project } }],
      },
      with_payload: true,
    });

    return results.map(r => ({
      id: r.id,
      score: r.score,
      payload: r.payload as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}

/**
 * Delete an artifact point from Qdrant (when superseded or pruned).
 * Non-throwing.
 */
export async function deleteArtifactPoint(
  artifactId: number,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  if (getBackend() === 'sqlite-vec') {
    return vec.deleteArtifactPointVec(artifactId, config);
  }
  try {
    const client = await getQdrantClient(config);
    if (!client) return false;

    await client.delete(COLLECTIONS.artifacts, {
      wait: false,
      points: [artifactId],
    });

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable hash: converts a string (ULID) to a positive 53-bit integer.
 * Qdrant requires integer or UUID point IDs. ULIDs are 26-char strings
 * that don't parse as UUIDs, so we hash them to integers.
 * Uses FNV-1a for speed and distribution.
 */
function hashStringToInt(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, keep unsigned 32-bit
  }
  // Ensure positive and within JS safe integer range
  return Math.abs(hash);
}
