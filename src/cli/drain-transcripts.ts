#!/usr/bin/env node
/**
 * Operator-invoked one-shot transcript drain CLI (v6 P9 unblock).
 *
 * Bypasses Angel's heartbeat drain. Reads pending `transcript_ingestion_pending`
 * rows from session_events, calls `ingestSession` directly (same code path
 * Angel runs at heartbeat.ts:1175-1230), marks `detail.processed = true`,
 * logs each row observably.
 *
 * Why this exists: Angel's heartbeat-internal drain block is wrapped in an
 * outer try/catch that silently swallows every drain error. When the drain
 * fails inside Angel, no telemetry
 * row is written and no log line is emitted, making it impossible to
 * diagnose without instrumentation. This CLI runs the same logic
 * synchronously with explicit per-row logging so failures are visible.
 *
 * Usage:
 *   bun run drain:transcripts                   — drain all pending
 *   bun run drain:transcripts --limit=10        — drain N (testing/sampling)
 *   bun run drain:transcripts --batch-size=5    — process in batches of N (default 5)
 *
 * Operator-only. Never wired into hooks or Angel auto-runs.
 */

import { openDatabase, closeDatabase } from '../core/storage.js';
import { getDbPath } from '../shared/paths.js';
import { ingestSession } from '../ingestion/ingest-session.js';
import { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { encodeVector } from '../core/sqlite-vec-loader.js';
import { chunkTranscript } from '../ingestion/transcript-chunker-v6.js';
import * as fs from 'node:fs';

export interface DrainCliArgs {
  limit: number | null;
  batchSize: number;
}

export function parseArgs(argv: string[]): DrainCliArgs {
  const args: DrainCliArgs = { limit: null, batchSize: 5 };
  for (const a of argv) {
    if (a.startsWith('--limit=')) args.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--batch-size=')) args.batchSize = Number(a.slice('--batch-size='.length));
  }
  return args;
}

async function probeEmbedding(db: any): Promise<void> {
  // Diagnostic: prove that EmbeddingProvider + encodeVector + vec0 INSERT
  // all work on this connection before we trust the per-chunk error counts.
  process.stdout.write('--- EmbeddingProvider self-test ---\n');
  const provider = new EmbeddingProvider();
  const t0 = Date.now();
  const ok = await provider.isAvailable();
  process.stdout.write(`  isAvailable=${ok} (${Date.now() - t0}ms)\n`);
  const t1 = Date.now();
  const vec = await provider.embed('drain self-test payload');
  process.stdout.write(`  embed: ${vec === null ? 'NULL' : `dim=${vec.length}`} (${Date.now() - t1}ms)\n`);
  if (!vec) return;

  // Test vec0 INSERT path
  try {
    const encoded = encodeVector(vec);
    process.stdout.write(`  encodeVector: bytes=${encoded.length}\n`);

    // Use a synthetic rowid that won't collide with real rows.
    // vec0 requires BigInt for primary key values.
    const testRowid = -999999n;
    db.prepare(`INSERT OR REPLACE INTO vec_transcript_chunks_v6 (rowid, embedding) VALUES (?, ?)`).run(testRowid, encoded);
    process.stdout.write(`  vec0 INSERT (BigInt literal): OK\n`);
    db.prepare(`DELETE FROM vec_transcript_chunks_v6 WHERE rowid = ?`).run(testRowid);

    // Now mimic ingest-session.ts EXACTLY: read an id from transcript_chunk_v6,
    // call BigInt() on it, INSERT.
    const realIdRow = db.prepare(`SELECT id FROM transcript_chunk_v6 LIMIT 1`).get() as { id: number } | undefined;
    if (realIdRow) {
      try {
        process.stdout.write(`  realIdRow.id type=${typeof realIdRow.id} value=${realIdRow.id}\n`);
        const coerced = BigInt(realIdRow.id);
        process.stdout.write(`  BigInt(realIdRow.id) type=${typeof coerced} value=${coerced}\n`);
        db.prepare(`INSERT OR REPLACE INTO vec_transcript_chunks_v6 (rowid, embedding) VALUES (?, ?)`).run(coerced, encoded);
        process.stdout.write(`  vec0 INSERT (BigInt(realIdRow.id)): OK\n`);
      } catch (e) {
        process.stdout.write(`  vec0 INSERT (BigInt(realIdRow.id)): FAIL ${(e as Error).message}\n`);
      }
    }
  } catch (e) {
    process.stdout.write(`  vec0 INSERT: FAIL ${(e as Error).message}\n`);
  }
  process.stdout.write('---\n\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = getDbPath();
  const db = openDatabase(dbPath);

  await probeEmbedding(db);

  const start = Date.now();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let totalChunks = 0;
  let totalEmbeddings = 0;

  process.stdout.write(`drain:transcripts starting db=${dbPath}\n`);

  while (true) {
    const remaining = args.limit !== null ? Math.max(0, args.limit - processed) : Infinity;
    const batch = Math.min(args.batchSize, remaining);
    if (batch <= 0) break;

    const rows = db.prepare(
      `SELECT id, session_id, project, detail
         FROM session_events
        WHERE event_type = 'transcript_ingestion_pending'
          AND (json_extract(detail, '$.processed') IS NULL
               OR json_extract(detail, '$.processed') = 0)
        ORDER BY id ASC
        LIMIT ?`
    ).all(batch) as Array<{ id: number; session_id: string; project: string; detail: string }>;

    if (rows.length === 0) break;

    for (const row of rows) {
      const t0 = Date.now();
      let parsed: { jsonl_path?: string | null } = {};
      try { parsed = JSON.parse(row.detail ?? '{}') as { jsonl_path?: string | null }; } catch { /* keep empty */ }
      const jsonlPath = parsed.jsonl_path ?? null;

      if (!jsonlPath) {
        db.prepare(
          `UPDATE session_events
              SET detail = json_set(COALESCE(detail, '{}'), '$.processed', json('true'),
                                    '$.skip_reason', 'no_jsonl_path')
            WHERE id = ?`
        ).run(row.id);
        process.stdout.write(`  [${row.id}] SKIP no_jsonl_path session=${row.session_id.slice(0,8)}\n`);
        processed += 1;
        continue;
      }

      try {
        const ir = await ingestSession(db, row.session_id, row.project, jsonlPath);
        db.prepare(
          `UPDATE session_events
              SET detail = json_set(COALESCE(detail, '{}'), '$.processed', json('true'),
                                    '$.chunks_written', ?,
                                    '$.embeddings_written', ?,
                                    '$.errors', ?)
            WHERE id = ?`
        ).run(ir.chunksWritten, ir.embeddingsWritten, ir.errors, row.id);
        succeeded += 1;
        totalChunks += ir.chunksWritten;
        totalEmbeddings += ir.embeddingsWritten;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(
          `  [${row.id}] OK session=${row.session_id.slice(0,8)} chunks=${ir.chunksWritten} embeds=${ir.embeddingsWritten} errs=${ir.errors} ${elapsed}s\n`
        );
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(
          `  [${row.id}] FAIL session=${row.session_id.slice(0,8)} error=${message.slice(0, 200)} ${elapsed}s\n`
        );
      }

      processed += 1;
    }
  }

  const total = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(`\ndrain:transcripts complete\n`);
  process.stdout.write(`  processed:  ${processed}\n`);
  process.stdout.write(`  succeeded:  ${succeeded}\n`);
  process.stdout.write(`  failed:     ${failed}\n`);
  process.stdout.write(`  chunks:     ${totalChunks}\n`);
  process.stdout.write(`  embeddings: ${totalEmbeddings}\n`);
  process.stdout.write(`  wall-time:  ${total}s\n`);

  closeDatabase(db);

  process.exit(failed > 0 && succeeded === 0 ? 1 : 0);
}

if (require.main === module) {
  void main();
}
