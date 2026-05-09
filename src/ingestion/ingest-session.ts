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
 * Sentinel returned by parseSessionJsonl when the JSONL file does not exist on
 * disk (ENOENT). Distinguished from a present-but-empty file so the caller
 * can surface the missing-file path operator-visibly per POLISH-03 / Gemini
 * Ingestion Finding #4. Other I/O errors fall through with `turns: []` +
 * `malformed: 0` and are counted as a generic failure (not missing-file).
 */
type ParseOutcome =
  | { kind: 'ok'; turns: JsonlTurn[]; malformed: number }
  | { kind: 'missing_file' }
  | { kind: 'io_error' };

/**
 * Read a Claude Code session JSONL file into JsonlTurn[]. Each line is one
 * JSON record. Tolerates malformed lines (skipped + counted in caller).
 * parseWrappers redaction does NOT fire here — chunkTranscript owns that.
 *
 * POLISH-03 — Gemini Ingestion Finding #4: missing-file (ENOENT) returns the
 * `missing_file` outcome so the caller writes a `transcript_ingest_missing_file`
 * telemetry row and returns the `errors=-1` sentinel. A present-but-empty file
 * returns `kind=ok` with `turns=[]` (the existing semantic).
 */
function parseSessionJsonl(jsonlPath: string, sessionId: string, project: string): ParseOutcome {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { kind: 'missing_file' };
    return { kind: 'io_error' };
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

  return { kind: 'ok', turns, malformed };
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
 *
 * POLISH-03 sentinel: when the JSONL path does not exist on disk
 * (ENOENT), the function writes a `transcript_ingest_missing_file`
 * telemetry row and returns `{ chunksWritten: 0, embeddingsWritten: 0, errors: -1 }`.
 * Callers detect missing-file via `result.errors === -1` and surface
 * operator-visible warnings (vs. the generic per-chunk-failure positive
 * `result.errors >= 1` semantic).
 */
export async function ingestSession(
  db: Database,
  sessionId: string,
  project: string,
  jsonlPath: string,
  embeddingProvider?: EmbeddingProvider,
): Promise<IngestionResult> {
  const result: IngestionResult = { chunksWritten: 0, embeddingsWritten: 0, errors: 0 };

  const parsed = parseSessionJsonl(jsonlPath, sessionId, project);
  if (parsed.kind === 'missing_file') {
    // POLISH-03 — Gemini Ingestion Finding #4: missing JSONL is operator-visible.
    // Telemetry row + errors=-1 sentinel distinguishes "file did not exist" from
    // "file existed but had zero usable turns" (the existing positive `errors=0`
    // semantic for empty/all-malformed files).
    try {
      writeIngestMissingFileTelemetry(db, sessionId, project, jsonlPath);
    } catch {
      // Telemetry table absent on a degraded DB shape — sentinel still
      // returned to caller; visibility downgraded to caller-side.
    }
    return { ...result, errors: -1 };
  }
  if (parsed.kind === 'io_error') {
    // Generic I/O error (permissions, partial read, etc.) — preserve the
    // existing positive-counter semantic so callers that grep `result.errors > 0`
    // still surface a failure, distinct from the missing-file sentinel.
    result.errors += 1;
    return result;
  }

  const { turns, malformed } = parsed;
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

  // POLISH-03 — Gemini Ingestion Finding #2: session-scoped DELETE before re-ingest
  // so trailing chunks from a prior pass (with more sub-chunks) don't survive as
  // ghost rows. vec0 cleanup precedes metadata cleanup because vec0 has no FK
  // cascade — explicit DELETE on vec_transcript_chunks_v6 keyed off the metadata
  // ids we're about to drop. Wrapped in best-effort try/catch — DELETE failures
  // (vec0 absent, table absent) must not block ingestion.
  try {
    if (hasVecTable) {
      cachedPrepare(db,
        `DELETE FROM vec_transcript_chunks_v6 WHERE rowid IN (
           SELECT id FROM transcript_chunk_v6 WHERE session_id = ?
         )`,
      ).run(sessionId);
    }
    cachedPrepare(db,
      `DELETE FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).run(sessionId);
  } catch {
    // Either vec0 or transcript_chunk_v6 missing — ingest continues; ghosts
    // (if any) get caught on the next clean ingest. Counted via heartbeat.
    result.errors += 1;
  }

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

      // POLISH-03 — Gemini Ingestion Finding #3: ALWAYS DELETE the vec0 row
      // for this rowid before deciding empty-skip. If a re-ingest produces an
      // empty body for a chunk that previously had content, the stale vector
      // would otherwise survive and pollute top-K retrieval against an empty
      // metadata body. The DELETE is BigInt-rowid-safe (vec0 contract).
      const rowid = BigInt(idRow.id);
      try {
        cachedPrepare(db,
          `DELETE FROM vec_transcript_chunks_v6 WHERE rowid = ?`,
        ).run(rowid);
      } catch {
        // vec0 DELETE failure is best-effort — falls into vec INSERT catch
        // below if we proceed, or if empty-body skip we just log and move on.
      }

      const empty = chunk.body.trim().length === 0;
      if (empty) {
        // No semantic content to embed — DELETE above ensured vec0 is consistent.
        continue;
      }

      // POLISH-03 — Gemini Ingestion Finding #6: hard-cap chunk body before
      // embed() so an unbounded chunk (single sentence > embedder context limit)
      // does not silently fail. Force-split on a character boundary (~95% of
      // 4-chars-per-token × 512 = ~1944 chars). Each split gets its own vec0
      // row keyed off (rowid, sub_index_offset) — but since metadata is keyed
      // by sub_index from the chunker, we serialize the splits as a single
      // joined embedding by averaging vectors in-place. The simpler safe-bound
      // is to truncate to the embedder limit and emit telemetry so the operator
      // sees the force-truncation — that's what we do; the chunker's own
      // sub-chunking handles the structural fix in transcript-chunker-v6.ts.
      const EMBED_CHAR_HARD_CAP = 1900;
      let bodyForEmbed = chunk.body;
      let forceTruncated = false;
      if (bodyForEmbed.length > EMBED_CHAR_HARD_CAP) {
        bodyForEmbed = bodyForEmbed.slice(0, EMBED_CHAR_HARD_CAP);
        forceTruncated = true;
      }

      const vector = await provider.embed(bodyForEmbed);
      if (vector === null) {
        // POLISH-03 — Gemini Ingestion Finding #7: degraded-path visibility.
        // Embedding provider unavailable / returned null — write telemetry so
        // the operator can grep `transcript_ingest_embed_unavailable` and see
        // which sessions degraded to metadata-only.
        result.errors += 1;
        try {
          writeIngestEmbedUnavailableTelemetry(db, sessionId, project, chunk);
        } catch {
          // Telemetry absent — counter still incremented; visibility downgraded.
        }
        continue;
      }

      if (forceTruncated) {
        try {
          writeIngestForceTruncatedTelemetry(db, sessionId, project, chunk, EMBED_CHAR_HARD_CAP);
        } catch {
          // Telemetry absent — chunk still embedded against the truncated body.
        }
      }

      try {
        const vec = encodeVector(vector);
        // vec0 specifics (matched against src/embeddings/sqlite-vec-backend.ts:188):
        //   1. Rowid binding requires BigInt — better-sqlite3 returns plain JS
        //      numbers from SELECT, which vec0 rejects with "Only integers are
        //      allowed for primary key values".
        //   2. vec0 does NOT honor INSERT OR REPLACE semantics for rowid
        //      conflicts — DELETE moved upstream of the empty-skip per Finding
        //      #3, so the INSERT here is always against a clean rowid slot.
        cachedPrepare(db,
          `INSERT INTO vec_transcript_chunks_v6 (rowid, embedding) VALUES (?, ?)`,
        ).run(rowid, vec);
        result.embeddingsWritten += 1;
      } catch {
        // vec0 insert failure (extension load issue, dimension mismatch, etc.)
        // — count as error + emit telemetry per Finding #7.
        result.errors += 1;
        try {
          writeIngestVecInsertFailureTelemetry(db, sessionId, project, chunk);
        } catch {
          // Telemetry absent — counter still incremented.
        }
      }
    } catch {
      result.errors += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// POLISH-03 — telemetry helpers (Gemini Ingestion Finding #4 + #7 visibility)
// ---------------------------------------------------------------------------

function writeIngestMissingFileTelemetry(
  db: Database,
  sessionId: string,
  project: string,
  jsonlPath: string,
): void {
  recordEvent(
    db,
    sessionId,
    project,
    'transcript_ingest_missing_file',
    'angel',
    'ingest',
    JSON.stringify({ session_id: sessionId, project, jsonl_path: jsonlPath, reason: 'ENOENT' }),
  );
}

function writeIngestEmbedUnavailableTelemetry(
  db: Database,
  sessionId: string,
  project: string,
  chunk: { turn_index: number; sub_index: number; role: string },
): void {
  recordEvent(
    db,
    sessionId,
    project,
    'transcript_ingest_embed_unavailable',
    'angel',
    'ingest',
    JSON.stringify({
      session_id: sessionId,
      project,
      turn_index: chunk.turn_index,
      sub_index: chunk.sub_index,
      role: chunk.role,
    }),
  );
}

function writeIngestForceTruncatedTelemetry(
  db: Database,
  sessionId: string,
  project: string,
  chunk: { turn_index: number; sub_index: number; role: string; body: string },
  capChars: number,
): void {
  recordEvent(
    db,
    sessionId,
    project,
    'transcript_ingest_force_truncated',
    'angel',
    'ingest',
    JSON.stringify({
      session_id: sessionId,
      project,
      turn_index: chunk.turn_index,
      sub_index: chunk.sub_index,
      role: chunk.role,
      original_chars: chunk.body.length,
      cap_chars: capChars,
    }),
  );
}

function writeIngestVecInsertFailureTelemetry(
  db: Database,
  sessionId: string,
  project: string,
  chunk: { turn_index: number; sub_index: number; role: string },
): void {
  recordEvent(
    db,
    sessionId,
    project,
    'transcript_ingest_vec_insert_failure',
    'angel',
    'ingest',
    JSON.stringify({
      session_id: sessionId,
      project,
      turn_index: chunk.turn_index,
      sub_index: chunk.sub_index,
      role: chunk.role,
    }),
  );
}
