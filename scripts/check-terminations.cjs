const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== Long-running interactive sessions in claudex-v3 (>5min duration) ===');
const longSessions = db.prepare(`
  SELECT session_id, name, status,
         created_at_epoch_ms, ended_at_epoch_ms,
         (ended_at_epoch_ms - created_at_epoch_ms) AS duration_ms,
         observation_count, session_summary
  FROM sessions
  WHERE project = 'claudex-v3'
    AND (ended_at_epoch_ms - created_at_epoch_ms) > 300000
  ORDER BY created_at_epoch_ms DESC
  LIMIT 10
`).all();

for (const s of longSessions) {
  const created = new Date(s.created_at_epoch_ms).toISOString();
  const ended = s.ended_at_epoch_ms ? new Date(s.ended_at_epoch_ms).toISOString() : 'NULL';
  const durMin = (s.duration_ms / 60000).toFixed(1);
  console.log('---');
  console.log('id:', s.session_id, '| name:', s.name);
  console.log('status:', s.status, '| dur:', durMin, 'min');
  console.log('start:', created);
  console.log('end:  ', ended);
  console.log('observations:', s.observation_count);
  console.log('summary:', (s.session_summary || '').slice(0, 240).replace(/\s+/g, ' '));
}

console.log('\n=== Sessions with status != completed (active/crashed/etc) ===');
const oddStatus = db.prepare(`
  SELECT session_id, name, status, created_at_epoch_ms, ended_at_epoch_ms,
         observation_count, session_summary
  FROM sessions
  WHERE project = 'claudex-v3' AND status != 'completed'
  ORDER BY created_at_epoch_ms DESC LIMIT 10
`).all();
for (const s of oddStatus) {
  console.log('---');
  console.log('id:', s.session_id, '| name:', s.name, '| status:', s.status);
  console.log('start:', new Date(s.created_at_epoch_ms).toISOString());
  console.log('end:  ', s.ended_at_epoch_ms ? new Date(s.ended_at_epoch_ms).toISOString() : 'NULL');
  console.log('summary:', (s.session_summary || '').slice(0, 240).replace(/\s+/g, ' '));
}
