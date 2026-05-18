// Backfill session_termination rows for completed sessions that don't have
// one. The boundary-detector path silently promoted sessions to
// status='completed' without writing a termination row for months — this
// one-shot recovers the missed ones.
//
// Strategy: for each completed session lacking a termination row:
//   - Read last user_framing + last conversation_turn for context
//   - Map to end_reason='unknown' (we don't have signal on how it ended)
//   - Write the row via recordSessionTermination (skips open_blockers
//     because we have no active signals at backfill time)

const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const entryPath = path.join(__dirname, '..', '.tmp-backfill-term-entry.mjs');
const outPath = path.join(__dirname, '..', '.tmp-backfill-term.cjs');
fs.writeFileSync(entryPath, `
import { recordSessionTermination, readLastTurnTexts } from './src/core/session-termination.js';
import { runMigrations } from './src/core/migrations.js';
export { recordSessionTermination, readLastTurnTexts, runMigrations };
`);
execSync(
  `npx esbuild ${entryPath} --bundle --platform=node --format=cjs --outfile=${outPath} --external:better-sqlite3`,
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
);

const mod = require(outPath);
const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath);
mod.runMigrations(db);

console.log('=== Session termination backfill ===');
const before = db.prepare('SELECT COUNT(*) AS n FROM session_termination').get().n;
console.log('session_termination rows before:', before);

// Read user_framing detail for last_user_directive when no conversation_turns exist
const cols = db.prepare('PRAGMA table_info(session_events)').all();
const tsCol = cols.some(c => c.name === 'timestamp_epoch_ms') ? 'timestamp_epoch_ms' : 'timestamp_epoch';
const lastFramingStmt = db.prepare(
  `SELECT detail FROM session_events
     WHERE session_id = ? AND event_type = 'user_framing'
     ORDER BY ${tsCol} DESC LIMIT 1`,
);

const candidates = db.prepare(`
  SELECT s.session_id, s.project, s.ended_at_epoch_ms, s.observation_count
    FROM sessions s
    LEFT JOIN session_termination t ON t.session_id = s.session_id
   WHERE s.status = 'completed'
     AND s.ended_at_epoch_ms IS NOT NULL
     AND s.ended_at_epoch_ms > 0
     AND t.session_id IS NULL
   ORDER BY s.ended_at_epoch_ms DESC
`).all();

console.log('completed sessions missing termination:', candidates.length);

let written = 0;
for (const s of candidates) {
  const turns = mod.readLastTurnTexts(db, s.session_id);
  // Fall back to user_framing if conversation_turns yielded nothing
  let lastUser = turns.last_user_directive;
  if (!lastUser) {
    const f = lastFramingStmt.get(s.session_id);
    lastUser = f?.detail ?? null;
  }
  const ok = mod.recordSessionTermination(db, {
    session_id: s.session_id,
    project: s.project,
    end_reason: 'unknown', // honest — we don't know how the boundary closed
    ended_at_epoch_ms: s.ended_at_epoch_ms,
    last_user_directive: lastUser,
    last_assistant_text: turns.last_assistant_text,
    open_blockers: null, // skip auto-derivation — no fresh signal at backfill time
  });
  if (ok) written++;
}

const after = db.prepare('SELECT COUNT(*) AS n FROM session_termination').get().n;
console.log(`backfill: wrote ${written}, total now ${after} (delta +${after - before})`);

const byReason = db.prepare('SELECT end_reason, COUNT(*) AS n FROM session_termination GROUP BY end_reason ORDER BY n DESC').all();
console.log('by reason:', byReason);

db.close();
