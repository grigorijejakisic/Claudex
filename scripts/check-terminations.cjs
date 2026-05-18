const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath, { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%session%' OR name LIKE '%termination%' OR name LIKE '%heartbeat%' OR name LIKE '%highlight%') ORDER BY name").all();
console.log('relevant tables:');
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get();
    console.log('  ', t.name, '->', c.c, 'rows');
  } catch (e) {
    console.log('  ', t.name, '-> err', e.message);
  }
}

console.log('\n--- Recent sessions in claudex-v3 ---');
try {
  const cols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
  console.log('sessions cols:', cols.join(','));
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE project = 'claudex-v3'
    ORDER BY rowid DESC LIMIT 8
  `).all();
  for (const r of rows) console.log(JSON.stringify(r).slice(0, 500));
} catch (e) {
  console.log('sessions err:', e.message);
}
