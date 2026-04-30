/**
 * Phase 11 SC#3 mechanical curation kick-off — runs the live MEMORY.md
 * curator against the SC#3 active-projects list when the periodic Angel
 * heartbeat has not yet reached them.
 *
 * Usage: bun run --bun scripts/phase-11-curate-memory-md.ts
 *
 * This is a one-shot Phase 11 helper. It does NOT replace the heartbeat —
 * it just guarantees the SC#3 ship-gate run sees a freshly-curated state.
 */

import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import { curateMemoryMd } from '../src/angel/memory-md-writer.js';

const TARGET_SLUGS = [
  'claudex-v3',
  'lacuna-betting-9f1d552c',
  'oracle-3951898e',
  'big-mozzy-v2',
  'desktop-01dcc792',
  'nexus-e53c6c93',
];

function main() {
  const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
  const db = new Database(dbPath);
  for (const slug of TARGET_SLUGS) {
    try {
      const r = curateMemoryMd(db, slug);
      console.log(`${slug} → ${JSON.stringify(r)}`);
    } catch (err) {
      console.log(`${slug} → ERROR: ${(err as Error).message}`);
    }
  }
  db.close();
}

main();
