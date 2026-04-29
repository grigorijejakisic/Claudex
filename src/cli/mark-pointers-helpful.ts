/**
 * Phase 5.5 — mark a subset of pointers retrieved this session as helpful.
 *
 * Usage:
 *   node dist/cli/mark-pointers-helpful.cjs <session_id> <input>
 *
 * <input> is one of:
 *   ""              — empty: no-op, "No pointers marked.", exit 0
 *   "none"          — same as empty
 *   "all"           — mark every pointer retrieved this session
 *   "1,3,5"         — comma-separated 1-based indices into list-session-pointers' output
 *
 * Index ordering MUST match list-session-pointers exactly (both call
 * listSessionPointers, which is deterministic by first_retrieved_at_epoch_ms ASC).
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import { listSessionPointers, markPointersHelpful } from '../angel/pointer-recall.js';

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: mark-pointers-helpful <session_id> [input]');
    process.exit(1);
  }
  const sessionId = args[0];
  const input = (args[1] ?? '').trim();

  if (input === '' || input.toLowerCase() === 'none') {
    console.log('No pointers marked.');
    process.exit(0);
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    const rows = listSessionPointers(db, sessionId);

    let pointerIds: number[];
    if (input.toLowerCase() === 'all') {
      pointerIds = rows.map(r => r.pointer_id);
    } else {
      const indices = input.split(',').map(s => s.trim()).filter(Boolean);
      const parsed: number[] = [];
      for (const tok of indices) {
        const n = Number(tok);
        if (!Number.isInteger(n) || n < 1 || n > rows.length) {
          console.error(`Invalid index: '${tok}' (must be 1..${rows.length})`);
          db.close();
          process.exit(1);
        }
        parsed.push(n);
      }
      const dedup = Array.from(new Set(parsed));
      pointerIds = dedup.map(i => rows[i - 1].pointer_id);
    }

    const updated = markPointersHelpful(db, sessionId, pointerIds);
    db.close();
    console.log(`Marked ${updated} pointer(s) helpful for session ${sessionId}`);
    process.exit(0);
  } catch (err) {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    console.error('Failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
