/**
 * POLISH-05 — Fresh-schema snapshot loader.
 *
 * Imports the production migrations module and writes a minimal fresh-V32 DB
 * to the path passed as argv[2]. Called from build-production-shape-snapshot.cjs
 * via tsx so we don't need a separate dist/ build for the snapshot script.
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../src/core/migrations.js';

const dest = process.argv[2];
if (!dest) {
  console.error('snapshot-fresh-schema: missing destination path argv[2]');
  process.exit(1);
}

const db = new Database(dest);
initializeSchema(db);

const seedTs = 1_700_000_000_000;
const seedChunk = db.prepare(`
  INSERT INTO transcript_chunk_v6 (
    session_id, project_id, turn_index, sub_index, role, provenance,
    body, created_at_epoch_ms, wrapper_redacted
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (let i = 0; i < 25; i++) {
  seedChunk.run(
    'wir-fixture-session',
    'wir-fixture-project',
    i,
    0,
    i % 2 === 0 ? 'user' : 'assistant',
    'organic',
    `redacted-fixture-${i}`,
    seedTs + i * 60_000,
    0,
  );
}

db.close();
console.log(`[snapshot-fresh] wrote ${dest}`);
