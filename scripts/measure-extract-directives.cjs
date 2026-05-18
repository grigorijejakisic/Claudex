// One-shot: measure how long extractDirectivesFromSession takes on a real
// 79-turn claudex-v3 session via the current Claude subprocess backend.
//
// Answers: is the 180s Phase 2 timeout the right size for production?

const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const tmpOut = path.join(__dirname, '..', '.tmp-extract-runner.cjs');
const entryPath = path.join(__dirname, '..', '.tmp-extract-entry.mjs');
fs.writeFileSync(entryPath, `
import { extractDirectivesFromSession } from './src/intelligence/directive-detector.js';
import { runMigrations } from './src/core/migrations.js';
export { extractDirectivesFromSession, runMigrations };
`);

execSync(
  `npx esbuild ${entryPath} --bundle --platform=node --format=cjs --outfile=${tmpOut} --external:better-sqlite3`,
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
);

const mod = require(tmpOut);
const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath);
mod.runMigrations(db);

const sessionId = '523e018e-299a-4be7-acb4-af625e7a9742';
const project = 'claudex-v3';

console.log('=== Measure extractDirectives on real session ===');
console.log('session_id:', sessionId);
console.log('project:', project);

const turnCount = db.prepare(
  `SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = ?`,
).get(sessionId).n;
console.log('turn_count:', turnCount);

const start = Date.now();
mod.extractDirectivesFromSession(db, sessionId, project)
  .then(result => {
    const elapsed = Date.now() - start;
    console.log('');
    console.log('=== Result ===');
    console.log('elapsed_ms:', elapsed, '(' + (elapsed / 1000).toFixed(1) + 's)');
    console.log('candidates:', result.candidates);
    console.log('confirmed:', result.confirmed);
    console.log('inserted:', result.inserted);
    console.log('updated:', result.updated);
    console.log('skipped:', result.skipped);
    console.log('errors:', result.errors);
    console.log('');
    if (elapsed < 60_000) {
      console.log('VERDICT: fits inside the OLD 60s budget — 180s bump is over-provisioned but harmless');
    } else if (elapsed < 180_000) {
      console.log('VERDICT: exceeds 60s but fits in 180s — bump was necessary, sized correctly');
    } else {
      console.log('VERDICT: exceeds 180s — budget needs further bump, or extract logic needs concurrency cap relief');
    }
    db.close();
  })
  .catch(e => {
    const elapsed = Date.now() - start;
    console.log('ERROR after', elapsed, 'ms:', e.message);
    db.close();
    process.exit(1);
  });
