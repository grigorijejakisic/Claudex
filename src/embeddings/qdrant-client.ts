/**
 * Vector store client (historical filename — `qdrant-client.ts`).
 *
 * As of session 47 (Phase 5 of the Qdrant → sqlite-vec migration), this
 * module is a thin facade over the sqlite-vec backend. Qdrant has been
 * removed; every vector operation routes through the vec0 virtual tables
 * in the shared SQLite database.
 *
 * The filename is preserved to avoid churning imports in the ~27 caller
 * files that reference `qdrant-client.js`. A follow-up rename to
 * `vector-store.ts` is tracked in `context/specs/SQLITE_VEC_MIGRATION.md`
 * (Phase 5b). Callers see the same public API they always had:
 *
 *   - Types: ArtifactPayload, PatternPayload, SearchResult, QdrantConfig
 *   - Collection constants: COLLECTIONS (kept for backward compat with
 *     any code that imports them as identifiers)
 *   - Upsert functions: upsertArtifactEmbedding, upsertPatternEmbedding,
 *     upsertJournalEmbedding, upsertConversationEmbedding, upsertThreadEmbedding
 *   - Search functions: searchArtifacts, searchPatterns, searchJournal,
 *     searchConversations, searchThreads
 *   - Lifecycle: ensureCollections, deleteArtifactPoint, setVectorStoreDb
 *   - Compat shims: getQdrantClient (always null), isQdrantAvailable
 *     (delegates to isSqliteVecReady), resetQdrantClient (no-op)
 *
 * Dual-write pattern is now trivial: SQLite is the source of truth AND
 * the vector store. A single transaction can insert both the row and
 * its embedding atomically (see sqlite-vec-backend.ts for the actual
 * vec0 operations).
 *
 * All public functions are non-throwing with safe defaults.
 */

import * as vec from './sqlite-vec-backend.js';

// Re-export the lifecycle setter so callers have a single import point.
export { setVectorStoreDb, getVectorStoreDb, isSqliteVecReady } from './sqlite-vec-backend.js';

// ---------------------------------------------------------------------------
// Types (preserved from the Qdrant-era API for caller backward compat)
// ---------------------------------------------------------------------------

export interface QdrantConfig {
  /** Ignored after Phase 5. Preserved in the type for API backward compat. */
  url?: string;
  /** Embedding dimension. Default: 1024 (snowflake-arctic-embed2). */
  dimensions?: number;
  /** Connection timeout in ms. Ignored after Phase 5. */
  timeoutMs?: number;
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
// Collection name constants (kept for backward compat — some callers
// reference these as identifiers even though sqlite-vec uses different
// table names under the hood).
// ---------------------------------------------------------------------------

export const COLLECTIONS = {
  artifacts: 'claudex_artifacts',
  patterns: 'claudex_patterns',
  threads: 'claudex_threads',
  journal: 'claudex_journal',
  conversations: 'claudex_conversations',
} as const;

// ---------------------------------------------------------------------------
// Compatibility shims — Qdrant-era functions kept as no-ops or aliases.
// Callers that import these continue to work without changes.
// ---------------------------------------------------------------------------

/**
 * Historical Qdrant singleton accessor. Post-Phase 5 this always returns
 * null — there is no separate vector DB client in the sqlite-vec world.
 * Callers that were probing `!client` for graceful degradation still work
 * correctly because the non-throwing sqlite-vec backend takes over.
 */
export async function getQdrantClient(_config?: Partial<QdrantConfig>): Promise<null> {
  return null;
}

/**
 * Historical Qdrant availability check. Now returns the sqlite-vec
 * readiness state — the semantic meaning ("is the vector store usable?")
 * is preserved even though the implementation changed.
 */
export function isQdrantAvailable(): boolean {
  return vec.isSqliteVecReady();
}

/**
 * Historical Qdrant client reset (used by tests for isolation).
 * Post-Phase 5 this is a no-op — the sqlite-vec backend's state lives
 * in the connected Database, which tests already create fresh per-case.
 */
export function resetQdrantClient(): void {
  // No-op.
}

// ---------------------------------------------------------------------------
// Collection lifecycle
// ---------------------------------------------------------------------------

/**
 * Verifies the vec0 virtual tables exist and the sqlite-vec extension is
 * loaded. Created by the V14→V15 migration; this function is idempotent
 * and non-throwing.
 */
export async function ensureCollections(config?: Partial<QdrantConfig>): Promise<boolean> {
  return vec.ensureVecCollections(config);
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

export async function upsertArtifactEmbedding(
  artifactId: number,
  embedding: number[],
  payload: ArtifactPayload,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return vec.upsertArtifactEmbeddingVec(artifactId, embedding, payload, config);
}

export async function upsertPatternEmbedding(
  patternId: string,
  embedding: number[],
  payload: PatternPayload,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return vec.upsertPatternEmbeddingVec(patternId, embedding, payload, config);
}

export async function upsertJournalEmbedding(
  journalId: number,
  embedding: number[],
  payload: Record<string, unknown>,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return vec.upsertJournalEmbeddingVec(journalId, embedding, payload, config);
}

export async function upsertConversationEmbedding(
  turnId: number,
  embedding: number[],
  payload: Record<string, unknown>,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return vec.upsertConversationEmbeddingVec(turnId, embedding, payload, config);
}

export async function upsertThreadEmbedding(
  sessionId: string,
  embedding: number[],
  payload: Record<string, unknown>,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return vec.upsertThreadEmbeddingVec(sessionId, embedding, payload, config);
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

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
  return vec.searchArtifactsVec(embedding, project, limit, filters, config);
}

export async function searchPatterns(
  embedding: number[],
  project: string,
  limit: number = 5,
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return vec.searchPatternsVec(embedding, project, limit, config);
}

export async function searchJournal(
  embedding: number[],
  project: string,
  limit: number = 5,
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return vec.searchJournalVec(embedding, project, limit, config);
}

export async function searchConversations(
  embedding: number[],
  project: string,
  limit: number = 5,
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return vec.searchConversationsVec(embedding, project, limit, config);
}

export async function searchThreads(
  embedding: number[],
  project: string,
  limit: number = 5,
  config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return vec.searchThreadsVec(embedding, project, limit, config);
}

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

export async function deleteArtifactPoint(
  artifactId: number,
  config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return vec.deleteArtifactPointVec(artifactId, config);
}
