import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from 'better-sqlite3';
import { chunkTranscript, type JsonlTurn } from './transcript-chunker-v6.js';
import { upsertChunk } from './upsert-chunk.js';

export interface IngestReport {
  files_seen: number;
  chunks_inserted: number;
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
 * transcript_chunk_v6.
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
 * constraint via upsertChunk's ON CONFLICT DO NOTHING.
 */
export async function importSyntheticTranscripts(
  db: Database,
  dir: string = SYNTHETIC_PROBES_DIR,
): Promise<IngestReport> {
  const report: IngestReport = { files_seen: 0, chunks_inserted: 0, errors: [] };
  if (!fs.existsSync(dir)) {
    return report;
  }
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
      }
    } catch (err) {
      report.errors.push({ file: f, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
