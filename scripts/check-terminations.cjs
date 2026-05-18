const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== claudex-v3 sessions since 2026-05-18 04:00 UTC+2 (i.e. 02:00 UTC) ===');
const cutoff = new Date('2026-05-18T02:00:00Z').getTime();
const rows = db.prepare(`
  SELECT session_id, name, status,
         created_at_epoch_ms, ended_at_epoch_ms,
         (COALESCE(ended_at_epoch_ms, strftime('%s', 'now') * 1000) - created_at_epoch_ms) / 60000.0 AS dur_min,
         observation_count, session_summary
  FROM sessions
  WHERE project = 'claudex-v3'
    AND created_at_epoch_ms >= ?
  ORDER BY created_at_epoch_ms DESC
  LIMIT 25
`).all(cutoff);

for (const s of rows) {
  console.log('---');
  console.log('  ', s.session_id.slice(0, 8), '|', s.name, '|', s.status, '|', s.dur_min.toFixed(1) + 'min', '| obs=' + s.observation_count);
  console.log('   start:', new Date(s.created_at_epoch_ms).toISOString());
  console.log('   end:  ', s.ended_at_epoch_ms ? new Date(s.ended_at_epoch_ms).toISOString() : 'NULL (active)');
  if (s.session_summary) console.log('   sum: ', s.session_summary.slice(0, 200).replace(/\s+/g, ' '));
}
console.log('total since:', rows.length);

console.log('\n=== Active signals on claudex-v3 ===');
try {
  const sigCols = db.prepare("PRAGMA table_info(session_signals)").all().map(c => c.name);
  console.log('  cols:', sigCols.join(','));
  const sigs = db.prepare(`
    SELECT * FROM session_signals
    WHERE project = 'claudex-v3'
    ORDER BY rowid DESC LIMIT 8
  `).all();
  for (const s of sigs) {
    console.log(JSON.stringify(s).slice(0, 500));
  }
} catch (e) { console.log('  err:', e.message); }

console.log('\n=== Recent session_messages mentioning this session or the proposal ===');
try {
  const msgs = db.prepare(`
    SELECT * FROM session_messages
    ORDER BY rowid DESC LIMIT 8
  `).all();
  for (const m of msgs) console.log(JSON.stringify(m).slice(0, 400));
} catch (e) { console.log('  err:', e.message); }
