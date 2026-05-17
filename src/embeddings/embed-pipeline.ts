/**
 * Unified embedding pipeline — embed-at-write for all artifact types.
 *
 * Orchestrates: Ollama embedding generation → vec_artifact_v17 (V17 path) + SQLite BLOB fallback.
 * Graceful degradation chain:
 *   Ollama + vec_artifact_v17 → full semantic search on V17 artifacts
 *   Ollama + legacy artifacts.embedding BLOB → legacy path (pre-14-07b callers)
 *   Neither → FTS5-only (current behavior, always works)
 *
 * All public functions are non-throwing. Embedding failures must never
 * block the primary write path (SQLite observation/artifact creation).
 *
 * 14-07b: Added embedArtifactV17() for writing embeddings to vec_artifact_v17
 * (the V17 unified vector store). Legacy embedArtifact() retained for backward
 * compatibility with callers that have not yet migrated.
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
let _providerCheckTime = 0;
const PROVIDER_RECHECK_MS = 60_000; // Re-check availability every 60s if unavailable

/**
 * Get the shared EmbeddingProvider instance. Returns null if embeddings
 * are unavailable (Ollama not running). Caches result with TTL re-check
 * so that a temporarily-down Ollama doesn't permanently disable embeddings
 * in long-lived processes (Angel).
 * Non-throwing.
 */
export async function getEmbeddingProvider(config?: {
  baseUrl?: string;
  model?: string;
}): Promise<EmbeddingProvider | null> {
  try {
    // If previously unavailable, re-check after TTL expires
    if (_providerChecked && _provider === null) {
      if (Date.now() - _providerCheckTime < PROVIDER_RECHECK_MS) return null;
      _providerChecked = false; // TTL expired — re-check
    }

    if (!_provider) {
      _provider = new EmbeddingProvider({
        baseUrl: config?.baseUrl ?? 'http://localhost:11434',
        model: config?.model ?? 'snowflake-arctic-embed2',
      });
    }

    if (!_providerChecked) {
      const ok = await _provider.isAvailable();
      _providerChecked = true;
      _providerCheckTime = Date.now();
      if (!ok) {
        _provider = null;
        return null;
      }
    }

    return _provider;
  } catch {
    _providerChecked = true;
    _providerCheckTime = Date.now();
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
// Embedding constants
// ---------------------------------------------------------------------------

/** Native output dimension of snowflake-arctic-embed2. No truncation needed. */
export const EMBED_DIM = 1024;

/** Max input chars — snowflake-arctic-embed2 has 8K token context (~32K chars). */
const MAX_INPUT_CHARS = 8000;

// ---------------------------------------------------------------------------
// Embed text
// ---------------------------------------------------------------------------

/**
 * Embed a text string. Returns the 1024-dim vector or null if unavailable.
 * Uses snowflake-arctic-embed2 (568M params, 8K context, native 1024-dim).
 * Non-throwing.
 */
export async function embedText(
  text: string,
  config?: { baseUrl?: string; model?: string },
): Promise<number[] | null> {
  try {
    const provider = await getEmbeddingProvider(config);
    if (!provider) return null;

    const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
    const raw = await provider.embed(truncated);
    if (!raw) return null;
    return raw; // snowflake-arctic-embed2 outputs native 1024-dim, no truncation needed
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
 * Embed a V17 artifact and write vector to vec_artifact_v17.
 *
 * This is the V17 migration path for artifact embeddings. Unlike embedArtifact()
 * which writes to legacy artifacts.embedding BLOB, this function writes to
 * vec_artifact_v17 (the vec0 virtual table created by migrateV36toV37).
 *
 * 14-07b: migrated from legacy artifacts — embedding write path for V17 unified schema.
 *
 * @param db - SQLite database
 * @param artifactId - V17 TEXT artifact ID (from artifact.id)
 * @param artifactRowid - artifact.rowid (INTEGER, used as vec0 rowid key)
 * @param content - text content to embed (title + '\n' + body)
 * @param metadata - artifact metadata for payload context
 * @returns true if embedding was written to vec_artifact_v17, false if unavailable
 */
export async function embedArtifactV17(
  db: import('better-sqlite3').Database,
  artifactId: string,
  artifactRowid: number,
  content: string,
  metadata: {
    project: string;
    kind: string;
    confidence: number;
    session_id: string;
    title: string;
  },
): Promise<boolean> {
  try {
    const embedding = await embedText(content);
    if (!embedding) return false;

    // Write to vec_artifact_v17 using artifact.rowid as the vec0 rowid.
    // Use DELETE + INSERT (vec0 doesn't support UPDATE on embedding column).
    // This mirrors the pattern used by reVectorizeArtifact in re-vectorize.ts.
    try {
      const { loadSqliteVec, encodeVector } = await import('../core/sqlite-vec-loader.js');
      loadSqliteVec(db);
      const vecBlob = encodeVector(new Float32Array(embedding));
      const vecRowid = BigInt(artifactRowid);
      db.prepare(`DELETE FROM vec_artifact_v17 WHERE rowid = ?`).run(vecRowid);
      db.prepare(`INSERT INTO vec_artifact_v17(rowid, embedding) VALUES (?, ?)`).run(vecRowid, vecBlob);
    } catch {
      // vec_artifact_v17 write failure is non-fatal — FTS5 still works.
      // Log is skipped here (non-throwing by design); caller tracks via result.
      return false;
    }

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
    // reads pre-Phase-4 experience_patterns table — write surface deleted, no
    // new INSERTs (V28 trigger blocks them). Rows persist for as long as their
    // content is useful. See .planning/reframes/2026-05-05-multi-handle-kill.md.
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

// ---------------------------------------------------------------------------
// Backfill: embed records that were created before the pipeline was active
// ---------------------------------------------------------------------------

export interface BackfillResult {
  artifacts: number;
  journal: number;
  threads: number;
  errors: number;
}

/** Max total chars to embed per backfill batch — bounds Ollama pressure by content volume, not just count. */
const BACKFILL_CHAR_BUDGET = 50_000;

/**
 * Process unembedded records in batches. Content-length-aware: stops when either
 * the record count OR the total character budget is exhausted.
 * Called by Angel heartbeat when idle. Non-throwing.
 *
 * Prioritizes: artifacts (highest retrieval impact) > journal > threads.
 */
export async function backfillEmbeddings(
  db: import('better-sqlite3').Database,
  batchSize: number = 10,
): Promise<BackfillResult> {
  const result: BackfillResult = { artifacts: 0, journal: 0, threads: 0, errors: 0 };

  try {
    const provider = await getEmbeddingProvider();
    if (!provider) return result;

    let remaining = batchSize;
    let charBudget = BACKFILL_CHAR_BUDGET;

    // 1. Artifacts without embeddings (highest priority)
    if (remaining > 0 && charBudget > 0) {
      const unembedded = db.prepare(
        `SELECT id, content, summary, project, artifact_type, importance, session_id, timestamp_epoch_ms
         FROM artifacts
         WHERE embedding IS NULL AND state != 'packed' AND content IS NOT NULL
         LIMIT ?`
      ).all(remaining) as Array<{
        id: number; content: string; summary: string; project: string;
        artifact_type: string; importance: number; session_id: string; timestamp_epoch_ms: number;
      }>;

      for (const art of unembedded) {
        if (charBudget <= 0) break;
        try {
          const text = art.summary || art.content;
          if (!text || text.length < 10) continue;
          charBudget -= text.length;
          const ok = await embedArtifact(db, art.id, text, {
            project: art.project,
            artifact_type: art.artifact_type,
            importance: art.importance,
            session_id: art.session_id,
            summary: (art.summary || '').slice(0, 500),
            timestamp_epoch: art.timestamp_epoch_ms,
          });
          if (ok) { result.artifacts++; remaining--; }
        } catch { result.errors++; }
      }
    }

    // 2. Journal entries without embeddings
    if (remaining > 0 && charBudget > 0) {
      const unembedded = db.prepare(
        `SELECT id, content, project, session_id, timestamp_epoch_ms
         FROM session_journal
         WHERE embedding IS NULL AND content IS NOT NULL
         LIMIT ?`
      ).all(remaining) as Array<{
        id: number; content: string; project: string; session_id: string; timestamp_epoch_ms: number;
      }>;

      for (const entry of unembedded) {
        if (charBudget <= 0) break;
        try {
          if (!entry.content || entry.content.length < 10) continue;
          charBudget -= entry.content.length;
          const ok = await embedJournalEntry(db, entry.id, entry.content, undefined, {
            project: entry.project,
            session_id: entry.session_id,
            entry_type: 'journal',
          });
          if (ok) { result.journal++; remaining--; }
        } catch { result.errors++; }
      }
    }

    // 3. Thread summaries with SQLite BLOB but missing from Qdrant
    // (detect by checking summary_embedding IS NOT NULL — they have BLOBs but were never pushed)
    if (remaining > 0) {
      try {
        const { upsertThreadEmbedding } = await import('./qdrant-client.js');
        const threads = db.prepare(
          `SELECT ts.session_id, ts.topic, ts.summary, ts.summary_embedding, s.project
           FROM thread_state ts
           JOIN sessions s ON s.session_id = ts.session_id
           WHERE ts.summary_embedding IS NOT NULL AND ts.summary IS NOT NULL
             AND ts.qdrant_synced = 0
           LIMIT ?`
        ).all(remaining) as Array<{
          session_id: string; topic: string | null; summary: string;
          summary_embedding: Buffer; project: string;
        }>;

        for (const t of threads) {
          try {
            const buf = t.summary_embedding;
            const embedding = Array.from(
              new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
            );
            if (embedding.length === 0) continue;

            const ok = await upsertThreadEmbedding(t.session_id, embedding, {
              project: t.project,
              topic: t.topic ?? '',
              summary: t.summary.slice(0, 500),
              timestamp_epoch: Math.floor(Date.now() / 1000),
            });
            if (ok) {
              db.prepare('UPDATE thread_state SET qdrant_synced = 1 WHERE session_id = ?').run(t.session_id);
              result.threads++; remaining--;
            }
          } catch { result.errors++; }
        }
      } catch { /* qdrant import failure — non-fatal */ }
    }
  } catch {
    // Non-throwing
  }

  return result;
}
