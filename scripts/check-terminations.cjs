const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== session_journal FTS search: cutover refused/halt/stop/blocked ===');
const cols = db.prepare("PRAGMA table_info(session_journal)").all().map(c => c.name);
console.log('session_journal cols:', cols.join(','));

const queries = [
  'cutover AND (refused OR halt OR halted OR stop OR stopped OR blocked OR aborted)',
  'gate AND (failed OR refused OR halt)',
  '"cutover refused"',
  'v7 AND (refused OR aborted OR rolled back)'
];

for (const q of queries) {
  console.log('\n--- query:', q);
  try {
    const rows = db.prepare(`
      SELECT j.session_id, j.recorded_at_epoch_ms,
             substr(j.body, 1, 240) AS snip
      FROM session_journal_fts f
      JOIN session_journal j ON j.rowid = f.rowid
      WHERE session_journal_fts MATCH ?
      ORDER BY j.recorded_at_epoch_ms DESC
      LIMIT 5
    `).all(q);
    for (const r of rows) {
      console.log('  ', new Date(r.recorded_at_epoch_ms).toISOString(), '|', r.session_id.slice(0, 8));
      console.log('    ', (r.snip || '').replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log('  err:', e.message);
  }
}
