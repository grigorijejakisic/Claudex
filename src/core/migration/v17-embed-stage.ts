/**
 * V17 Phase A — pre-embed staging.
 *
 * Reads every row from the 6 legacy tables, composes `{title, body, data, ...}`
 * via the shared `composeBody()` function, then batch-embeds via Ollama
 * arctic-embed2. Result is held in memory as `StagedRow[]`.
 *
 * Assumes ~10^4 rows per table × 6 tables × (kernel fields + 1024 × 4-byte
 * embedding) ≈ 240MB ceiling. If benchmarks show this is too high, switch to
 * a temp staging table per CONTEXT Decision 2's fallback path.
 *
 * Runs OUTSIDE the migration transaction so an Ollama failure costs nothing
 * but a retry. Never mutates the source DB.
 */

import type { Database } from 'better-sqlite3';
import { composeBody, type Composed } from './v17-compose.js';
import { KIND_MAPPING, type ArtifactKind, type LegacyTable } from './kind-mapping.js';

export interface StagedRow {
  legacyTable: LegacyTable;
  legacyId: number | string;           // INTEGER for most; TEXT UUID for experience_patterns
  kind: ArtifactKind;
  composed: Composed;
  /** 1024 × 4 = 4096 bytes of little-endian float32 — vec0 arctic-embed2 shape. */
  embedding: Buffer | null;
  /** The raw legacy row for downstream audit / id-map synthesis. */
  legacyRow: Record<string, unknown>;
}

export interface EmbedderLike {
  embedBatch(texts: string[]): Promise<(number[] | null)[]>;
}

export interface StageOpts {
  /** Override batch size for testing; default 32. */
  batchSize?: number;
  /** Abort staging early if embedder returns null for any row. Default true. */
  abortOnEmbedFailure?: boolean;
}

export class EmbeddingError extends Error {
  constructor(msg: string) { super(msg); this.name = 'EmbeddingError'; }
}

/**
 * Iterate each of the 6 legacy tables and stage {composed, embedding}.
 * Rows come out in table-then-id order for deterministic downstream sequencing.
 */
export async function stageEmbeddings(
  db: Database,
  embedder: EmbedderLike,
  opts: StageOpts = {},
): Promise<StagedRow[]> {
  const batchSize = opts.batchSize ?? 32;
  const abortOnFail = opts.abortOnEmbedFailure !== false;

  const allStaged: StagedRow[] = [];

  for (const table of Object.keys(KIND_MAPPING) as LegacyTable[]) {
    const m = KIND_MAPPING[table];

    // Skip missing tables (legitimate on partial dev DBs)
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table);
    if (!exists) continue;

    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${m.legacyIdCol} ASC`).all() as Record<string, unknown>[];
    if (rows.length === 0) continue;

    // Compose + embed in batches.
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const composed: Composed[] = chunk.map((row) => composeBody(m.kind, row));
      const texts: string[] = composed.map((c) => {
        // Keep title + body separated by a space to align with FTS5/cross-encoder
        // query construction. Null title collapses to body only.
        return c.title ? `${c.title} ${c.body}` : c.body;
      });

      const embeddings = await embedder.embedBatch(texts);

      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j];
        const emb = embeddings[j];
        if (emb === null) {
          if (abortOnFail) {
            throw new EmbeddingError(
              `Ollama arctic-embed2 returned null for ${table}.${m.legacyIdCol}=${String(row[m.legacyIdCol])}. Aborting before DB mutation.`,
            );
          }
        }
        const legacyId = row[m.legacyIdCol] as number | string;
        allStaged.push({
          legacyTable: table,
          legacyId,
          kind: m.kind,
          composed: composed[j],
          embedding: emb ? floatsToBuffer(emb) : null,
          legacyRow: row,
        });
      }
    }
  }

  return allStaged;
}

/**
 * Pack a float[] into a little-endian float32 Buffer suitable for vec0.
 */
export function floatsToBuffer(v: number[]): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf;
}
