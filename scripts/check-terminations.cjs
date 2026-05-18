const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath, { readonly: true });

const cols = db.prepare("PRAGMA table_info(session_termination)").all().map(c => c.name);
console.log('columns:', cols.join(','));

const rows = db.prepare(`
  SELECT *
  FROM session_termination
  WHERE project = 'claudex-v3'
  ORDER BY ended_at_epoch_ms DESC
  LIMIT 8
`).all();

for (const r of rows) {
  const when = new Date(r.ended_at_epoch_ms).toISOString();
  console.log('---');
  console.log('session_id:', r.session_id);
  console.log('end:', when, '|', r.end_reason);
  console.log('last_user_directive:', (r.last_user_directive || '').slice(0, 240));
  if (r.detail) console.log('detail:', String(r.detail).slice(0, 240));
}
