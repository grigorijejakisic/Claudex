import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'better-sqlite3';
import { chunkTranscript, type JsonlTurn } from './transcript-chunker-v6.js';
import { upsertChunk } from './upsert-chunk.js';
import { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { encodeVector } from '../core/sqlite-vec-loader.js';

export interface IngestReport {
  files_seen: number;
  chunks_inserted: number;
  embeddings_written: number;
  errors: Array<{ file: string; error: string }>;
}

const SYNTHETIC_PROBES_DIR = path.resolve(
  process.cwd(),
  '.planning',
  'phases',
  '09-empirical-measurement',
  'probes',
  'synthetic-transcripts',
);

const SYNTHETIC_PROJECT_ID = 'p9-synthetic';

/**
 * Ingests synthetic deliberation transcripts authored in plan 09-01 into
 * transcript_chunk_v6 + vec_transcript_chunks_v6.
 *
 * Each *.jsonl file uses its filename basename as the deterministic
 * session_id with prefix `synthetic-` (e.g. drift-c-05.jsonl →
 * session_id 'synthetic-drift-c-05'). The fixtures' transcript_anchor.session_id
 * values match this pattern exactly so B-arm retrieval can locate the anchors.
 *
 * Provenance is set to 'environmental' — the closest existing enum value
 * for non-organic, non-tool-result, non-injected content.
 *
 * Idempotent on the V32 UNIQUE(session_id, turn_index, role, sub_index)
 * constraint via upsertChunk's ON CONFLICT DO NOTHING. Embeddings are
 * INSERT OR REPLACE so re-runs refresh stale vectors.
 */
export async function importSyntheticTranscripts(
  db: Database,
  dir: string = SYNTHETIC_PROBES_DIR,
  embeddingProvider?: EmbeddingProvider,
): Promise<IngestReport> {
  const report: IngestReport = { files_seen: 0, chunks_inserted: 0, embeddings_written: 0, errors: [] };
  if (!fs.existsSync(dir)) {
    return report;
  }
  const provider = embeddingProvider ?? new EmbeddingProvider();
  const hasVecTable = (db.prepare(
    `SELECT 1 FROM sqlite_master WHERE name='vec_transcript_chunks_v6' LIMIT 1`,
  ).get() as { 1: number } | undefined) != null;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    report.files_seen++;
    const fullPath = path.join(dir, f);
    const sessionId = `synthetic-${path.basename(f, '.jsonl')}`;
    try {
      const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
      const turns: JsonlTurn[] = lines.map((line, idx) => {
        const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        const role = parsed.message?.role
          ?? (parsed.type === 'user' ? 'user' : parsed.type === 'assistant' ? 'assistant' : 'system');
        const contentRaw = parsed.message?.content;
        const content = typeof contentRaw === 'string'
          ? contentRaw
          : JSON.stringify(contentRaw ?? '');
        return {
          session_id: sessionId,
          project_id: SYNTHETIC_PROJECT_ID,
          turn_index: idx,
          role: (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') ? role : 'system',
          body: content,
          created_at_epoch_ms: 1700000000000 + idx * 1000,
          provenance: 'environmental',
        };
      });
      const chunks = chunkTranscript(turns);
      for (const chunk of chunks) {
        upsertChunk(db, chunk);
        report.chunks_inserted++;

        if (!hasVecTable || chunk.body.trim().length === 0) continue;
        const idRow = db.prepare(
          `SELECT id FROM transcript_chunk_v6 WHERE session_id = ? AND turn_index = ? AND role = ? AND sub_index = ?`,
        ).get(chunk.session_id, chunk.turn_index, chunk.role, chunk.sub_index) as { id: number } | undefined;
        if (!idRow) continue;

        const vector = await provider.embed(chunk.body);
        if (vector === null) continue;
        try {
          const vec = encodeVector(vector);
          db.prepare(
            `INSERT OR REPLACE INTO vec_transcript_chunks_v6 (rowid, embedding) VALUES (?, ?)`,
          ).run(BigInt(idRow.id), vec);
          report.embeddings_written++;
        } catch {
          /* vec0 insert failure — continue */
        }
      }
    } catch (err) {
      report.errors.push({ file: f, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
