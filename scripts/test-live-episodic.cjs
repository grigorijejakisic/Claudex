// Live-DB test: run the same query shapes the fresh-agent gate failed on
// this morning against the real claudex-v3 database. Validates that today's
// fixes (V43 column rename, episodic channel, multiplier, materialized
// session_summary) surface real data correctly.

const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const entryPath = path.join(__dirname, '..', '.tmp-live-test-entry.mjs');
const outPath = path.join(__dirname, '..', '.tmp-live-test.cjs');
fs.writeFileSync(entryPath, `
import { hybridSearchSync, isEpisodicQuery } from './src/core/hybrid-retrieval.js';
import { runMigrations } from './src/core/migrations.js';
import { getRecentTerminations } from './src/core/session-termination.js';
export { hybridSearchSync, isEpisodicQuery, runMigrations, getRecentTerminations };
`);
execSync(
  `npx esbuild ${entryPath} --bundle --platform=node --format=cjs --outfile=${outPath} --external:better-sqlite3`,
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
);

const mod = require(outPath);
const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath);
mod.runMigrations(db);

const project = 'claudex-v3';
const queries = [
  'why did the last session stop',
  'why did production stop the last 2 times we were making V7',
  'where did we get cut off mid-pivot',
  'what was the last thing I told you to do',
  'remember where we stopped',
];

console.log('=== Layer 2: live-DB structural test ===\n');

console.log('--- claudex_recent_sessions equivalent ---');
const recent = mod.getRecentTerminations(db, { limit: 5, project });
console.log(`returned ${recent.length} sessions:`);
for (const r of recent) {
  const dur = r.last_user_directive ? r.last_user_directive.slice(0, 60).replace(/\\s+/g, ' ') : '(null)';
  console.log(`  ${r.session_id.slice(0,8)} | ${r.end_reason} | ${new Date(r.ended_at_epoch_ms).toISOString().slice(0,16)} | "${dur}..."`);
  if (r.open_blockers) {
    try {
      const blockers = JSON.parse(r.open_blockers);
      console.log(`    open_blockers: ${blockers.length} ${blockers.map(b => b.signal_type + ':' + b.target).join(', ')}`);
    } catch {}
  }
}
console.log();

for (const q of queries) {
  const isEp = mod.isEpisodicQuery(q);
  console.log(`--- "${q}" ---`);
  console.log(`isEpisodicQuery: ${isEp}`);

  const results = mod.hybridSearchSync(db, q, project, { limit: 3 });
  console.log(`top-${Math.min(3, results.length)} results:`);
  for (const [i, r] of results.entries()) {
    const score = r.hybrid_score.toFixed(4);
    const kind = r.artifact_type || 'unknown';
    const matchKind = r.match_kind || '-';
    const title = (r.summary || '').slice(0, 80).replace(/\\s+/g, ' ');
    console.log(`  ${i+1}. score=${score} kind=${kind} match=${matchKind}`);
    console.log(`     ${title}`);
    if (r.match_kind === 'episodic') {
      const body = String(r.content || '').slice(0, 100).replace(/\\s+/g, ' ');
      console.log(`     [episodic content]: ${body}`);
    }
  }
  console.log();
}

// Also check the session_summary materialization landed naturally
console.log('--- session_summary V17 artifacts ---');
const sumArtifacts = db.prepare(
  `SELECT id, length(body) AS blen, created_at_epoch_ms FROM artifact WHERE kind = 'session_summary' AND project = ? ORDER BY created_at_epoch_ms DESC LIMIT 5`,
).all(project);
console.log(`${sumArtifacts.length} session_summary artifacts found:`);
for (const a of sumArtifacts) {
  console.log(`  ${a.id} | body=${a.blen}b | ${new Date(a.created_at_epoch_ms).toISOString().slice(0,16)}`);
}

db.close();
