/**
 * Unified embedding pipeline — embed-at-write for all artifact types.
 *
 * Orchestrates: Ollama embedding generation → Qdrant upsert → SQLite BLOB fallback.
 * Graceful degradation chain:
 *   Ollama + Qdrant → full semantic search
 *   Ollama only → SQLite BLOB + app-level cosine (slower fallback)
 *   Neither → FTS5-only (current behavior, always works)
 *
 * All public functions are non-throwing. Embedding failures must never
 * block the primary write path (SQLite observation/artifact creation).
 */

import { EmbeddingProvider } from './embedding-provider.js';
import {
  upsertArtifactEmbedding,
  upsertPatternEmbedding,
  upsertJournalEmbedding,
  isQdrantAvailable,
  type ArtifactPayload,
  type PatternPayload,
} from './qdrant-client.js';

// ---------------------------------------------------------------------------
// Module-level embedding provider (lazy init, cached)
// ---------------------------------------------------------------------------

let _provider: EmbeddingProvider | null = null;
let _providerChecked = false;

/**
 * Get the shared EmbeddingProvider instance. Returns null if embeddings
 * are unavailable (Ollama not running). Caches result.
 * Non-throwing.
 */
export async function getEmbeddingProvider(config?: {
  baseUrl?: string;
  model?: string;
}): Promise<EmbeddingProvider | null> {
  try {
    if (_providerChecked && _provider === null) return null;

    if (!_provider) {
      _provider = new EmbeddingProvider({
        baseUrl: config?.baseUrl ?? 'http://localhost:11434',
        model: config?.model ?? 'nomic-embed-text',
      });
    }

    if (!_providerChecked) {
      const ok = await _provider.isAvailable();
      _providerChecked = true;
      if (!ok) {
        _provider = null;
        return null;
      }
    }

    return _provider;
  } catch {
    _providerChecked = true;
    _provider = null;
    return null;
  }
}

/**
 * Reset provider state (for testing).
 */
export function resetEmbeddingPipeline(): void {
  _provider = null;
  _providerChecked = false;
}

// ---------------------------------------------------------------------------
// Matryoshka truncation
// ---------------------------------------------------------------------------

/** Target dimension for Matryoshka truncation. nomic-embed-text supports 768→384→256. */
const MATRYOSHKA_DIM = 384;

/**
 * Truncate a full-dimension embedding to Matryoshka target dimension and re-normalize.
 * nomic-embed-text v1.5 produces independently meaningful prefixes at 384 dims.
 * Re-normalization is required after truncation for cosine distance to work correctly.
 */
function matryoshkaTruncate(vec: number[], dim: number = MATRYOSHKA_DIM): number[] {
  if (vec.length <= dim) return vec; // Already at or below target
  const truncated = vec.slice(0, dim);
  const norm = Math.sqrt(truncated.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return truncated;
  return truncated.map(v => v / norm);
}

// ---------------------------------------------------------------------------
// Embed text
// ---------------------------------------------------------------------------

/**
 * Embed a text string. Returns the 384-dim vector or null if unavailable.
 * Applies Matryoshka truncation + re-normalization from 768→384 dims.
 * Non-throwing.
 */
export async function embedText(
  text: string,
  config?: { baseUrl?: string; model?: string },
): Promise<number[] | null> {
  try {
    const provider = await getEmbeddingProvider(config);
    if (!provider) return null;

    // Truncate to ~512 tokens (~2048 chars) for consistent embedding quality
    const truncated = text.length > 2048 ? text.slice(0, 2048) : text;
    const raw = await provider.embed(truncated);
    if (!raw) return null;
    return matryoshkaTruncate(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline: embed + store for each entity type
// ---------------------------------------------------------------------------

/**
 * Embed an artifact and upsert to Qdrant + store BLOB in SQLite.
 * Called after createArtifact() in the tool processing pipeline.
 *
 * @param db - SQLite database for BLOB storage
 * @param artifactId - the artifact ID from SQLite
 * @param content - text content to embed
 * @param metadata - artifact metadata for Qdrant payload
 * @returns true if embedding was stored (either Qdrant or SQLite), false if unavailable
 */
export async function embedArtifact(
  db: import('better-sqlite3').Database,
  artifactId: number,
  content: string,
  metadata: {
    project: string;
    artifact_type: string;
    importance: number;
    session_id: string;
    summary: string;
    timestamp_epoch?: number;
  },
): Promise<boolean> {
  try {
    const embedding = await embedText(content);
    if (!embedding) return false;

    // 1. Store BLOB in SQLite (fallback path)
    try {
      const blob = Buffer.from(new Float32Array(embedding).buffer);
      db.prepare('UPDATE artifacts SET embedding = ? WHERE id = ?').run(blob, artifactId);
    } catch {
      // SQLite BLOB storage failure is non-fatal — Qdrant may still work
    }

    // 2. Upsert to Qdrant (acceleration path)
    const payload: ArtifactPayload = {
      artifact_id: artifactId,
      project: metadata.project,
      artifact_type: metadata.artifact_type,
      importance: metadata.importance,
      confidence: 1.0,
      activation_score: 1.0,
      session_id: metadata.session_id,
      timestamp_epoch: metadata.timestamp_epoch ?? Math.floor(Date.now() / 1000),
      superseded: false,
      summary: metadata.summary,
    };

    await upsertArtifactEmbedding(artifactId, embedding, payload);

    return true;
  } catch {
    return false;
  }
}

/**
 * Embed an experience pattern and upsert to Qdrant.
 * Called after createPattern() in the experience scoring pipeline.
 * Non-throwing.
 */
export async function embedPattern(
  db: import('better-sqlite3').Database,
  patternId: string,
  triggerContext: string,
  lesson: string,
  metadata: {
    project: string;
    pattern_type: string;
    severity: string;
    score: number;
  },
): Promise<boolean> {
  try {
    // Embed the combined trigger + lesson for better semantic matching
    const textToEmbed = `${triggerContext}\n${lesson}`;
    const embedding = await embedText(textToEmbed);
    if (!embedding) return false;

    // 1. Store BLOB in SQLite
    try {
      const blob = Buffer.from(new Float32Array(embedding).buffer);
      db.prepare('UPDATE experience_patterns SET embedding = ? WHERE id = ?').run(blob, patternId);
    } catch { /* non-fatal */ }

    // 2. Upsert to Qdrant
    const payload: PatternPayload = {
      pattern_id: patternId,
      project: metadata.project,
      pattern_type: metadata.pattern_type,
      severity: metadata.severity,
      score: metadata.score,
      times_triggered: 0,
      times_useful: 0,
      verified: false,
      trigger_context: triggerContext.slice(0, 200),
    };

    await upsertPatternEmbedding(patternId, embedding, payload);

    return true;
  } catch {
    return false;
  }
}

/**
 * Embed a journal entry (recall metadata) and upsert to Qdrant.
 * Called when recall_text is set during captureRecallFlowEntry.
 * Non-throwing.
 */
export async function embedJournalEntry(
  db: import('better-sqlite3').Database,
  journalId: number,
  content: string,
  recallText: string | undefined,
  metadata: {
    project: string;
    session_id: string;
    entry_type: string;
  },
): Promise<boolean> {
  try {
    // Prefer recall_text for embedding (user's voice), fall back to content
    const textToEmbed = recallText || content;
    const embedding = await embedText(textToEmbed);
    if (!embedding) return false;

    // 1. Store BLOB in SQLite
    try {
      const blob = Buffer.from(new Float32Array(embedding).buffer);
      db.prepare('UPDATE session_journal SET embedding = ? WHERE id = ?').run(blob, journalId);
    } catch { /* non-fatal */ }

    // 2. Upsert to Qdrant
    await upsertJournalEmbedding(journalId, embedding, {
      ...metadata,
      content: content.slice(0, 300),
      recall_text: recallText?.slice(0, 200),
      timestamp_epoch: Math.floor(Date.now() / 1000),
    });

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Embed a query string for search. Returns null if embeddings unavailable.
 * Used by hybrid-retrieval to get the query vector for Qdrant search.
 * Non-throwing.
 */
export async function embedQuery(query: string): Promise<number[] | null> {
  return embedText(query);
}

/**
 * Check if the full semantic pipeline is available (Ollama + Qdrant).
 * Non-throwing.
 */
export async function isSemanticPipelineAvailable(): Promise<boolean> {
  try {
    const provider = await getEmbeddingProvider();
    return provider !== null && isQdrantAvailable();
  } catch {
    return false;
  }
}
