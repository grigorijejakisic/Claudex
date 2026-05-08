#!/usr/bin/env bun
/**
 * Operator-invoked CLI to ingest the 4 synthetic deliberation transcripts
 * authored in plan 09-01 into transcript_chunk_v6. Run BEFORE
 * `bun run benchmark:deliberation-surfacing`.
 *
 * Idempotent — re-runs absorb duplicates via upsertChunk's
 * ON CONFLICT DO NOTHING on UNIQUE(session_id, turn_index, role, sub_index).
 *
 * Usage: bun run import:synthetic-probes
 */
import { openDatabase, closeDatabase } from '../core/storage.js';
import { getDbPath } from '../shared/paths.js';
import { importSyntheticTranscripts } from '../ingestion/synthetic-corpus-import.js';

async function main(): Promise<number> {
  const db = openDatabase(getDbPath());
  try {
    const report = await importSyntheticTranscripts(db);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.errors.length === 0 ? 0 : 1;
  } finally {
    closeDatabase(db);
  }
}

if (require.main === module) {
  main()
    .then((c) => process.exit(c))
    .catch((e) => {
      process.stderr.write(String(e) + '\n');
      process.exit(1);
    });
}
