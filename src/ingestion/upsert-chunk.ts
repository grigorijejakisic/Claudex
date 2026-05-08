/**
 * v6 transcript-chunk write surface.
 *
 * Phase 8 plan 08-03 calls this from the ingestion hook; plan 08-05's
 * WIR-01 live-wiring tests exercise this exact exported function against
 * V17-collapsed + base-table fresh-DB fixtures. NEVER mock — the v5.0.1
 * silent-fail lesson promoted live-wiring to ship-gate severity.
 *
 * Idempotent on the V32 UNIQUE(session_id, turn_index, role, sub_index)
 * constraint via ON CONFLICT DO NOTHING.
 *
 * The closed-enum CHECK constraints on `role` and `provenance` are
 * structural (V32 schema). Bad values throw — caller treats throws as
 * bugs, do not swallow.
 *
 * Embedding is NOT computed here — vec_transcript_chunks_v6 is populated
 * by plan 08-04's backfill sweep. Mirrors Phase 4.1's transcript-chunker
 * pattern where embedding_ref is left null.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { ChunkV6 } from './transcript-chunker-v6.js';

const UPSERT_SQL = `
INSERT INTO transcript_chunk_v6 (
  session_id, project_id, turn_index, sub_index, role, provenance,
  body, created_at_epoch_ms, wrapper_redacted
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, turn_index, role, sub_index) DO NOTHING
`;

export function upsertChunk(db: Database, chunk: ChunkV6): void {
  cachedPrepare(db, UPSERT_SQL).run(
    chunk.session_id,
    chunk.project_id,
    chunk.turn_index,
    chunk.sub_index,
    chunk.role,
    chunk.provenance,
    chunk.body,
    chunk.created_at_epoch_ms,
    chunk.wrapper_redacted ? 1 : 0,
  );
}
