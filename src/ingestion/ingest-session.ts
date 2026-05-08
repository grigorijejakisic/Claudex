/**
 * v6 transcript ingestion entry points.
 *
 * Two exports:
 *
 *   - enqueueSessionIngestion(db, sessionId, project, jsonlPath?) — cheap
 *     queue-row writer called from CC's SessionEnd hook and Angel's
 *     boundary detector. Synchronous DB INSERT, milliseconds.
 *
 *   - ingestSession(db, sessionId, project, jsonlPath, embeddingProvider?) —
 *     top-level worker called by Angel's heartbeat tick. Reads JSONL → runs
 *     chunkTranscript → embeds via arctic-embed2 → upserts metadata + vec0
 *     rows. Per-chunk try/catch — one bad chunk never aborts a session.
 *
 * Hook safety: enqueueSessionIngestion does not touch any LLM or embedding
 * surface. The CC hook awaits enqueue and returns; the heavy work runs
 * out-of-band from Angel's heartbeat (.claude/rules/hooks-safety.md).
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import { chunkTranscript, type JsonlTurn } from './transcript-chunker-v6.js';
import { upsertChunk } from './upsert-chunk.js';
import { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { recordEvent } from '../core/session-events.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { encodeVector } from '../core/sqlite-vec-loader.js';

export interface IngestionResult {
  chunksWritten: number;
  embeddingsWritten: number;
  errors: number;
}

/**
 * Enqueue a session for transcript ingestion. Cheap — single
 * session_events INSERT, no I/O. Awaitable but completes in milliseconds;
 * never blocks the caller hook on embedding or LLM work.
 *
 * Phase 8 plan 08-03 wires this into both:
 *   - cc-hooks/session-end.ts post-emitCleanEndsessionClose
 *   - angel/boundary/boundary-detector.ts post-clean_endsession promotion
 */
export function enqueueSessionIngestion(
  db: Database,
  sessionId: string,
  project: string,
  jsonlPath?: string,
): void {
  recordEvent(
    db,
    sessionId,
    project,
    'transcript_ingestion_pending',
    'angel',
    'enqueue',
    JSON.stringify({
      session_id: sessionId,
      project,
      jsonl_path: jsonlPath ?? null,
    }),
  );
}

/**
 * Read a Claude Code session JSONL file into JsonlTurn[]. Each line is one
 * JSON record. Tolerates malformed lines (skipped + counted in caller).
 * parseWrappers redaction does NOT fire here — chunkTranscript owns that.
 */
function parseSessionJsonl(jsonlPath: string, sessionId: string, project: string): {
  turns: JsonlTurn[];
  malformed: number;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return { turns: [], malformed: 0 };
  }

  const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
  const turns: JsonlTurn[] = [];
  let malformed = 0;
  let fileMtimeMs = 0;
  try {
    fileMtimeMs = fs.statSync(jsonlPath).mtimeMs;
  } catch {
    fileMtimeMs = Date.now();
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      const role = mapRole(rec);
      if (role === null) {
        // No usable role — skip without counting as malformed (e.g. metadata
        // headers, summary records, or other non-turn JSONL line types).
        continue;
      }

      const body = extractBody(rec);
      if (body === null) {
        continue;
      }

      const created = parseTimestamp(rec) ?? fileMtimeMs;
      const provenance: JsonlTurn['provenance'] =
        role === 'tool' ? 'tool_result' :
        role === 'system' ? 'environmental' :
        'organic';

      turns.push({
        session_id: sessionId,
        project_id: project,
        turn_index: i,
        role,
        body,
        created_at_epoch_ms: created,
        provenance,
      });
    } catch {
      malformed += 1;
    }
  }

  return { turns, malformed };
}

function mapRole(rec: Record<string, unknown>): JsonlTurn['role'] | null {
  const t = String(rec['type'] ?? '');
  if (t === 'user') return 'user';
  if (t === 'assistant') return 'assistant';
  if (t === 'tool_use' || t === 'tool_result') return 'tool';
  if (t === 'system') return 'system';
  // Some records nest the role inside `message.role`.
  const msg = rec['message'] as Record<string, unknown> | undefined;
  if (msg) {
    const r = String(msg['role'] ?? '');
    if (r === 'user') return 'user';
    if (r === 'assistant') return 'assistant';
    if (r === 'tool') return 'tool';
    if (r === 'system') return 'system';
  }
  return null;
}

function extractBody(rec: Record<string, unknown>): string | null {
  const msg = rec['message'] as Record<string, unknown> | undefined;
  const content = msg?.['content'] ?? rec['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj['text'] === 'string') {
          parts.push(obj['text']);
        } else if (typeof obj['content'] === 'string') {
          parts.push(obj['content']);
        }
      }
    }
    if (parts.length === 0) return null;
    return parts.join('\n');
  }
  return null;
}

function parseTimestamp(rec: Record<string, unknown>): number | null {
  const ts = rec['timestamp'];
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) return ms;
  }
  if (typeof ts === 'number') return ts;
  return null;
}

/**
 * Ingest a session's transcript end-to-end. Non-throwing — wraps each
 * chunk in try/catch so one bad embed call never aborts the session.
 *
 * Returns counts for the heartbeat to update the queue row's detail JSON.
 */
export async function ingestSession(
  db: Database,
  sessionId: string,
  project: string,
  jsonlPath: string,
  embeddingProvider?: EmbeddingProvider,
): Promise<IngestionResult> {
  const result: IngestionResult = { chunksWritten: 0, embeddingsWritten: 0, errors: 0 };

  const { turns, malformed } = parseSessionJsonl(jsonlPath, sessionId, project);
  result.errors += malformed;
  if (turns.length === 0) return result;

  const chunks = chunkTranscript(turns);
  if (chunks.length === 0) return result;

  const provider = embeddingProvider ?? new EmbeddingProvider();

  // Detect whether vec_transcript_chunks_v6 is available on this DB
  // connection. If sqlite-vec wasn't loaded (test env, missing extension),
  // skip the vec0 inserts — metadata-only ingestion is still useful.
  const hasVecTable = (cachedPrepare(db,
    `SELECT 1 FROM sqlite_master WHERE name='vec_transcript_chunks_v6' LIMIT 1`,
  ).get() as { 1: number } | undefined) != null;

  for (const chunk of chunks) {
    try {
      upsertChunk(db, chunk);
      result.chunksWritten += 1;

      // Read back the rowid (whether the row was just inserted or already
      // existed via ON CONFLICT). The UNIQUE on (session_id, turn_index,
      // role, sub_index) gives us a deterministic lookup.
      const idRow = cachedPrepare(db,
        `SELECT id FROM transcript_chunk_v6
         WHERE session_id = ? AND turn_index = ? AND role = ? AND sub_index = ?`,
      ).get(chunk.session_id, chunk.turn_index, chunk.role, chunk.sub_index) as
        { id: number } | undefined;
      if (!idRow) {
        // Should never happen — INSERT just succeeded or row pre-existed.
        // If it does, count as error and continue.
        result.errors += 1;
        continue;
      }

      if (!hasVecTable) {
        // No vec table on this connection — metadata is enough. The 08-04
        // backfill sweep can populate vectors later.
        continue;
      }

      const empty = chunk.body.trim().length === 0;
      if (empty) {
        // No semantic content to embed — not an error, just skip the vec0
        // insert. Re-injecting an empty body would just yield a near-zero
        // vector that pollutes top-K.
        continue;
      }

      const vector = await provider.embed(chunk.body);
      if (vector === null) {
        // Embedding service unavailable or failed — degrade to metadata-only.
        result.errors += 1;
        continue;
      }

      try {
        const vec = encodeVector(vector);
        // vec0 specifics (matched against src/embeddings/sqlite-vec-backend.ts:188):
        //   1. Rowid binding requires BigInt — better-sqlite3 returns plain JS
        //      numbers from SELECT, which vec0 rejects with "Only integers are
        //      allowed for primary key values".
        //   2. vec0 does NOT honor INSERT OR REPLACE semantics for rowid
        //      conflicts — it raises UNIQUE constraint failed instead. Upsert
        //      must be DELETE-then-INSERT (the v5 pattern). Discovered live
        //      during v6 P9 backfill drain when re-runs against partially-
        //      ingested sessions silently failed every vec insert.
        const rowid = BigInt(idRow.id);
        cachedPrepare(db,
          `DELETE FROM vec_transcript_chunks_v6 WHERE rowid = ?`,
        ).run(rowid);
        cachedPrepare(db,
          `INSERT INTO vec_transcript_chunks_v6 (rowid, embedding) VALUES (?, ?)`,
        ).run(rowid, vec);
        result.embeddingsWritten += 1;
      } catch {
        // vec0 insert failure (extension load issue, dimension mismatch, etc.)
        // — count as error but keep going.
        result.errors += 1;
      }
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
