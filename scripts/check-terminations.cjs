const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath, { readonly: true });

const total = db.prepare("SELECT COUNT(*) AS c FROM session_termination").get();
console.log('total rows:', total.c);

const projects = db.prepare("SELECT project, COUNT(*) AS c FROM session_termination GROUP BY project ORDER BY c DESC").all();
console.log('by project:', projects);

const rows = db.prepare(`
  SELECT session_id, project, ended_at_epoch_ms, end_reason, last_user_directive
  FROM session_termination
  ORDER BY ended_at_epoch_ms DESC
  LIMIT 10
`).all();

for (const r of rows) {
  const when = new Date(r.ended_at_epoch_ms).toISOString();
  console.log('---');
  console.log('session_id:', r.session_id, '| project:', r.project);
  console.log('end:', when, '|', r.end_reason);
  console.log('last_user_directive:', (r.last_user_directive || '').slice(0, 300).replace(/\s+/g, ' '));
}
