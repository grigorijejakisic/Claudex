// One-shot: run the V43 migration on the live DB to unblock the read-only
// trigger interaction. Logs before/after state.
//
// Built from src/core/migrations.ts via esbuild bundle below.

const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// Bundle the migrations entry point on the fly so we use the same TS code path
// (including my fix) without needing a permanent dist export.
// Output inside project so the bundled CJS can resolve `better-sqlite3` via
// the project's node_modules.
const tmpOut = path.join(__dirname, '..', '.tmp-v43-runner.cjs');
execSync(
  `npx esbuild src/core/migrations.ts --bundle --platform=node --format=cjs --outfile=${tmpOut} --external:better-sqlite3`,
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
);

const { runMigrations } = require(tmpOut);

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath);

console.log('=== Live DB V43 migration ===');
console.log('db path:', dbPath);
console.log('before user_version:', db.pragma('user_version', { simple: true }));

const triggersBefore = db
  .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'prevent_legacy_%'")
  .all();
console.log('read-only triggers before:', triggersBefore.map(t => t.name).join(','));

const flippedBefore = db
  .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE read_only = 1")
  .get();
console.log('read_only=1 rows before:', flippedBefore.n);

try {
  runMigrations(db);
  console.log('runMigrations: OK');
} catch (e) {
  console.error('runMigrations FAILED:', e.message);
  process.exit(1);
}

console.log('after user_version:', db.pragma('user_version', { simple: true }));

const triggersAfter = db
  .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'prevent_legacy_%'")
  .all();
console.log('read-only triggers after:', triggersAfter.map(t => t.name).join(','));

const cols = db.prepare('PRAGMA table_info(session_events)').all();
console.log('session_events cols:', cols.map(c => c.name).join(','));

const flippedAfter = db
  .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE read_only = 1")
  .get();
console.log('read_only=1 rows after:', flippedAfter.n);

db.close();
console.log('done.');
