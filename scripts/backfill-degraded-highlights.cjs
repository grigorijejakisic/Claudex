// One-shot: re-extract degraded session_highlights rows via the Claude
// subprocess (default generation backend post-Phase-14-08). Closes the
// "Mechanism unblocked, backfill pending" item from session d2237451 turn 213.

const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const tmpOut = path.join(__dirname, '..', '.tmp-backfill-highlights.cjs');

// Build a tiny CJS bundle that exposes extractHighlightsForSession +
// initializeSchema/runMigrations.
const entrySource = `
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from './src/core/migrations.js';
import { extractHighlightsForSession } from './src/angel/highlights-extractor.js';
export { Database, initializeSchema, runMigrations, extractHighlightsForSession };
`;
const entryPath = path.join(__dirname, '..', '.tmp-backfill-entry.mjs');
fs.writeFileSync(entryPath, entrySource);

execSync(
  `npx esbuild ${entryPath} --bundle --platform=node --format=cjs --outfile=${tmpOut} --external:better-sqlite3`,
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
);

const mod = require(tmpOut);
const { extractHighlightsForSession, runMigrations } = mod;

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath);
runMigrations(db);

console.log('=== Backfill degraded session_highlights ===');

const degraded = db.prepare(`
  SELECT session_id, project, degraded_reason, created_at_epoch_ms
  FROM session_highlights
  WHERE degraded = 1
  ORDER BY created_at_epoch_ms DESC
`).all();

console.log(`degraded rows: ${degraded.length}`);

const projectsReg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claudex', 'projects.json'), 'utf8'));

const config = {
  localModel: 'sonnet',
  // Other AngelConfig fields aren't used by extractHighlightsForSession.
};

(async () => {
  let ok = 0, skipped = 0, failed = 0;
  for (const r of degraded) {
    const projEntry = projectsReg.projects[r.project];
    if (!projEntry || !projEntry.path) {
      console.log(`[skip] ${r.session_id} — project ${r.project} not in registry`);
      skipped++;
      continue;
    }
    const sessionsDir = path.join(projEntry.path, 'Sessions');
    if (!fs.existsSync(sessionsDir)) {
      console.log(`[skip] ${r.session_id} — no Sessions/ dir at ${sessionsDir}`);
      skipped++;
      continue;
    }
    const files = fs.readdirSync(sessionsDir);
    const found = files.find(f => f.endsWith(`_${r.session_id}.md`));
    if (!found) {
      console.log(`[skip] ${r.session_id} — no Sessions/ markdown file (likely tiny test session)`);
      skipped++;
      continue;
    }

    const before = Date.now();
    process.stdout.write(`[run]  ${r.session_id} (${r.project}) ... `);
    try {
      await extractHighlightsForSession({
        db,
        sessionId: r.session_id,
        project: r.project,
        projectDir: projEntry.path,
        config,
      });
      // Check result
      const after = db.prepare(
        `SELECT degraded, degraded_reason FROM session_highlights WHERE session_id = ?`,
      ).get(r.session_id);
      const elapsed = ((Date.now() - before) / 1000).toFixed(1);
      if (after && after.degraded === 0) {
        console.log(`OK (${elapsed}s) — degraded=0`);
        ok++;
      } else {
        console.log(`STILL DEGRADED (${elapsed}s) reason=${after?.degraded_reason}`);
        failed++;
      }
    } catch (e) {
      const elapsed = ((Date.now() - before) / 1000).toFixed(1);
      console.log(`THREW (${elapsed}s) ${e.message}`);
      failed++;
    }
  }
  console.log('');
  console.log(`Backfill done: ok=${ok}, skipped=${skipped}, failed=${failed}`);
  db.close();
})();
