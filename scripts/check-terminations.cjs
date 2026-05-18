const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath, { readonly: true });

const ftsCols = db.prepare("PRAGMA table_info(session_journal_fts)").all().map(c => c.name);
console.log('fts cols:', ftsCols.join(','));

const queries = [
  'cutover AND refused',
  'cutover AND halt',
  'cutover AND failed',
  'gate AND failed',
  '"first attempt"',
  'rolled AND back',
  'binding AND only',
];

for (const q of queries) {
  console.log('\n--- query:', q);
  try {
    const rows = db.prepare(`
      SELECT j.session_id, j.timestamp_epoch, j.entry_type,
             substr(j.content, 1, 300) AS snip
      FROM session_journal_fts f
      JOIN session_journal j ON j.id = f.rowid
      WHERE session_journal_fts MATCH ?
      ORDER BY j.timestamp_epoch DESC
      LIMIT 6
    `).all(q);
    for (const r of rows) {
      const t = r.timestamp_epoch < 2e10 ? r.timestamp_epoch * 1000 : r.timestamp_epoch;
      console.log('  ', new Date(t).toISOString(), '|', r.session_id.slice(0, 8), '|', r.entry_type);
      console.log('    ', (r.snip || '').replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log('  err:', e.message);
  }
}
