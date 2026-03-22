/**
 * claudex update-recall CLI — sets recall aliases on journal entries for a session.
 *
 * Usage:
 *   node dist/cli/update-recall.cjs <session_id> <recall_text>
 *
 * Updates all journal entries for the given session with the provided recall_text.
 * Called by /endsession skill after LLM generates recall aliases.
 *
 * Exit 0 on success, 1 on error.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import { cachedPrepare } from '../core/stmt-cache.js';

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: update-recall <session_id> <recall_text>');
    process.exit(1);
  }

  const sessionId = args[0];
  const recallText = args.slice(1).join(' ');

  try {
    const dbPath = getDbPath();
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Update all journal entries for this session that don't already have recall_text
    const result = cachedPrepare(db,
      `UPDATE session_journal SET recall_text = ? WHERE session_id = ? AND recall_text IS NULL`
    ).run(recallText, sessionId);

    console.log(`Updated ${result.changes} journal entries for session ${sessionId}`);
    db.close();
  } catch (err) {
    console.error('Failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
