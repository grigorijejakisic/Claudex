/**
 * Phase 5.5 — list pointers retrieved during a session.
 *
 * Usage:
 *   node dist/cli/list-session-pointers.cjs <session_id>
 *
 * Output: one line per pointer, indexed (1-based), in first-retrieved-at order:
 *   1. [lesson] foo-proj/feedback_check-deps.md (3x)
 *   2. [lesson] foo-proj/process_audit.md (1x)
 *
 * No header, no trailing summary. Empty session prints nothing and exits 0.
 *
 * Used by the /endsession skill (Step 1d) to render the helpful_yn prompt.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import { listSessionPointers } from '../angel/pointer-recall.js';

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: list-session-pointers <session_id>');
    process.exit(1);
  }
  const sessionId = args[0];

  try {
    const db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    const rows = listSessionPointers(db, sessionId);
    db.close();

    rows.forEach((row, idx) => {
      const i = idx + 1;
      const helpfulMark = row.helpful_yn === 1 ? ' ✓' : '';
      console.log(`${i}. [${row.source}] ${row.project}/${row.filename} (${row.recall_count}x)${helpfulMark}`);
    });
    process.exit(0);
  } catch (err) {
    console.error('Failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
