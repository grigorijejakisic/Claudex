// Smarter backfill: promote end_reason='unknown' → 'crash' when the next
// session's first user_framing event contains explicit crash markers.
//
// Rationale: today's earlier backfill defaulted every reconstructed
// termination to 'unknown' because I lacked a deterministic crash signal.
// But the operator's recovery prompt — written at the start of the SESSION
// AFTER a crash — IS a deterministic crash signal pointing at the prior
// session. Six such markers exist in user_framing going back to 2026-04-25;
// none were attributed.
//
// Strategy:
//   1. List sessions where session_termination.end_reason = 'unknown'.
//   2. For each, find the next session in the same project (smallest
//      created_at_epoch_ms > this.ended_at_epoch_ms).
//   3. Read that next session's first user_framing event.
//   4. If the detail matches crash-marker regex, UPDATE the prior session's
//      termination to end_reason='crash'.
//
// Only promotes when the evidence is direct. Sessions without recovery
// markers (most of the 1092) stay 'unknown' — honest about uncertainty.

const path = require('path');
const Database = require('better-sqlite3');
const os = require('os');

const dbPath = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const db = new Database(dbPath);

// Detect timestamp column shape on session_events (V42 had `timestamp_epoch`,
// V43+ renamed to `timestamp_epoch_ms`). Live DB is V44 — but defensive.
const cols = db.prepare('PRAGMA table_info(session_events)').all();
const tsCol = cols.some(c => c.name === 'timestamp_epoch_ms') ? 'timestamp_epoch_ms' : 'timestamp_epoch';

// Crash markers — derived from inspecting the 6 known user_framing rows.
// Conservative: must mention crash/died explicitly, not just any failure.
const CRASH_MARKERS = /\b(pc (cra(s|c)hed|died|crahsed)|pc (died|crashed) (over\s?night|mid|in the middle)|session (died|cra(s|c)hed|abrubptly died)|crashed (in the middle|over\s?night|mid)|killed our|got cut off|our worst fear happened|previous session died|session abrubptly died)\b/i;

console.log('=== Smarter crash-termination backfill ===');

const beforeCounts = db.prepare(
  `SELECT end_reason, COUNT(*) AS n FROM session_termination GROUP BY end_reason ORDER BY n DESC`,
).all();
console.log('before:', beforeCounts);

const unknowns = db.prepare(`
  SELECT session_id, project, ended_at_epoch_ms
    FROM session_termination
    WHERE end_reason = 'unknown'
    ORDER BY ended_at_epoch_ms ASC
`).all();
console.log('unknown rows to scan:', unknowns.length);

const findNextSession = db.prepare(`
  SELECT session_id
    FROM sessions
    WHERE project = ?
      AND created_at_epoch_ms > ?
    ORDER BY created_at_epoch_ms ASC
    LIMIT 1
`);

const findFirstFraming = db.prepare(`
  SELECT detail
    FROM session_events
    WHERE session_id = ?
      AND event_type = 'user_framing'
    ORDER BY ${tsCol} ASC
    LIMIT 1
`);

const promote = db.prepare(`
  UPDATE session_termination
    SET end_reason = 'crash'
    WHERE session_id = ?
      AND end_reason = 'unknown'
`);

let promoted = 0;
let nextSessionMissing = 0;
let nextSessionNoFraming = 0;
let nextSessionNonCrash = 0;
const promotedSamples = [];

for (const u of unknowns) {
  const next = findNextSession.get(u.project, u.ended_at_epoch_ms);
  if (!next) { nextSessionMissing++; continue; }
  const framing = findFirstFraming.get(next.session_id);
  if (!framing || !framing.detail) { nextSessionNoFraming++; continue; }
  if (CRASH_MARKERS.test(framing.detail)) {
    const r = promote.run(u.session_id);
    if (r.changes > 0) {
      promoted++;
      if (promotedSamples.length < 8) {
        promotedSamples.push({
          session: u.session_id.slice(0, 8),
          project: u.project,
          ended: new Date(u.ended_at_epoch_ms).toISOString().slice(0, 16),
          recoveryFraming: framing.detail.slice(0, 100).replace(/\s+/g, ' '),
        });
      }
    }
  } else {
    nextSessionNonCrash++;
  }
}

console.log();
console.log('=== scan complete ===');
console.log('promoted unknown→crash:', promoted);
console.log('skipped — no next session:', nextSessionMissing);
console.log('skipped — next had no user_framing:', nextSessionNoFraming);
console.log('skipped — next framing was not crash-shaped:', nextSessionNonCrash);
console.log();
console.log('sample promotions:');
for (const s of promotedSamples) {
  console.log(' -', s.session, '|', s.project, '|', s.ended);
  console.log('   recovery framing: "' + s.recoveryFraming + '"');
}

const afterCounts = db.prepare(
  `SELECT end_reason, COUNT(*) AS n FROM session_termination GROUP BY end_reason ORDER BY n DESC`,
).all();
console.log();
console.log('after:', afterCounts);

db.close();
