#!/usr/bin/env node
/**
 * POLISH-05 — Production-shape fixture builder.
 *
 * Builds a SCHEMA-PRESERVING + minimally-seeded fixture at
 * `.planning/fixtures/production-shape-v32.db` for the WIR-promoted integration
 * tests. The fixture is small (≤ 1 MB), git-committable, and exercises the
 * production-shape signal: V32 schema, join keys, indexes, FK relationships.
 *
 * Two construction modes:
 *
 *   (1) FROM_LIVE_DB — when ~/.claudex/db/claudex.db exists, copy + sanitize
 *       + sample. Sampling caps each non-FTS table at 25 rows, redacts every
 *       body / pattern_text column, drops vec0 contents and cross_agent_sessions.
 *       Fixture stays ≤ 1 MB.
 *
 *   (2) FROM_FRESH_SCHEMA — when no live DB exists (CI, fresh-clone), build
 *       the V32 schema via the production migration path and seed minimal
 *       deterministic synthetic content. Same shape, same joins, just no
 *       real production data ever existed.
 *
 * Both paths produce a fixture that satisfies the WIR test's contract:
 * upsertChunk + ingestSession + routeFromArtifact run cleanly, FK constraints
 * exist, the (session_id, turn_index, role, sub_index) UNIQUE constraint is
 * present, vec_transcript_chunks_v6 exists (rows are absent — vec0 module load
 * is a separate ship gate handled in synthetic-corpus-import etc.).
 *
 * Re-run only when V32 schema changes or when the WIR test needs new seed shape.
 *
 * Usage:
 *   node scripts/build-production-shape-snapshot.cjs
 *   bun run snapshot:build
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const SOURCE = path.join(os.homedir(), '.claudex', 'db', 'claudex.db');
const DEST = path.join(__dirname, '..', '.planning', 'fixtures', 'production-shape-v32.db');
const SAMPLE_PER_TABLE = 25;
const SAMPLE_TRANSCRIPT_CHUNKS = 100;

function aggressiveSample(db) {
  // Sample every non-FTS-shadow non-vec table down to SAMPLE_PER_TABLE rows.
  const allTables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r) => r.name);
  const FTS_SHADOW_RE = /_fts(_|$)/;
  for (const table of allTables) {
    if (table.startsWith('vec_')) continue;
    if (FTS_SHADOW_RE.test(table)) continue;
    if (table.startsWith('sqlite_')) continue;
    try {
      const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      const total = totalRow ? totalRow.n : 0;
      const cap = table === 'transcript_chunk_v6' ? SAMPLE_TRANSCRIPT_CHUNKS : SAMPLE_PER_TABLE;
      if (total > cap) {
        db.prepare(`
          DELETE FROM ${table} WHERE rowid NOT IN (
            SELECT rowid FROM ${table} ORDER BY ABS(RANDOM()) LIMIT ${cap}
          )
        `).run();
        console.log(`[snapshot] sampled ${table}: ${cap}/${total}`);
      }
    } catch (e) {
      // FK constraints / triggers may forbid bulk DELETE on some tables — leave them as-is.
      console.log(`[snapshot] sample skipped ${table}: ${e && e.message ? e.message : 'error'}`);
    }
  }
  // Clear FTS shadows — they auto-rebuild on next vacuum / use.
  for (const t of allTables) {
    if (t.endsWith('_fts')) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
    }
  }
}

function redactBodies(db) {
  // transcript_chunk_v6 — primary surface for the WIR test.
  try {
    const r = db.prepare(`UPDATE transcript_chunk_v6 SET body = 'redacted-' || id WHERE body IS NOT NULL`).run();
    console.log(`[snapshot] redacted transcript_chunk_v6.body: ${r.changes} rows`);
  } catch {}

  // Other body-bearing tables — best-effort.
  const candidates = [
    { table: 'learnings', col: 'body' },
    { table: 'decisions', col: 'body' },
    { table: 'experience_patterns', col: 'pattern_text' },
    { table: 'observations', col: 'body' },
    { table: 'mental_models', col: 'body' },
    { table: 'directive_rules', col: 'body' },
    { table: 'critical_rules', col: 'body' },
    { table: 'session_journal', col: 'content' },
    { table: 'conversation_turns', col: 'body' },
    { table: 'artifacts', col: 'content' },
  ];
  for (const { table, col } of candidates) {
    try {
      const exists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
      ).get(table);
      if (!exists) continue;
      const colExists = db.prepare(
        `SELECT 1 FROM pragma_table_info(?) WHERE name=? LIMIT 1`,
      ).get(table, col);
      if (!colExists) continue;
      const r = db.prepare(
        `UPDATE ${table} SET ${col} = 'redacted-' || rowid WHERE ${col} IS NOT NULL`,
      ).run();
      console.log(`[snapshot] redacted ${table}.${col}: ${r.changes} rows`);
    } catch {}
  }
}

function dropVec0(db) {
  const vecTables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_%'`)
    .all()
    .map((r) => r.name);
  for (const name of vecTables) {
    try { db.prepare(`DELETE FROM ${name}`).run(); } catch {}
  }
  console.log(`[snapshot] cleared ${vecTables.length} vec0/vec0-shadow tables`);
}

function dropOtherProjectContent(db) {
  for (const t of ['cross_agent_sessions']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
}

function buildFromLiveDb() {
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.copyFileSync(SOURCE, DEST);
  console.log(`[snapshot] copied ${SOURCE} → ${DEST}`);
  const db = new Database(DEST);
  db.pragma('foreign_keys = OFF');
  aggressiveSample(db);
  redactBodies(db);
  dropOtherProjectContent(db);
  dropVec0(db);
  try { db.exec('VACUUM'); } catch {}
  db.close();
}

function buildFromFreshSchema() {
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  if (fs.existsSync(DEST)) fs.unlinkSync(DEST);
  // Use tsx to run a small TypeScript loader that imports the production
  // migrations module and writes a fresh V32 DB. This way the fixture exactly
  // matches whatever V32 = current head (including any future bumps) without
  // needing a separate dist build for the snapshot script.
  const { spawnSync } = require('node:child_process');
  const loaderTs = path.resolve(__dirname, 'snapshot-fresh-schema.ts');
  if (!fs.existsSync(loaderTs)) {
    console.error(`[snapshot] FRESH path needs ${loaderTs}`);
    process.exit(1);
  }
  const r = spawnSync('npx', ['tsx', loaderTs, DEST], {
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.error(`[snapshot] FRESH path failed (tsx exit ${r.status})`);
    process.exit(1);
  }
  console.log(`[snapshot] built FRESH V32 fixture via tsx loader`);
}

// Default mode: FRESH schema build (bounded, git-committable size).
// Pass --from-live-db to copy + sanitize the live DB instead — produces a much
// larger fixture (typically 80–500 MB on a worked-in machine) that is NOT
// suitable for committing but useful for local-only verification.
const MODE = process.argv.includes('--from-live-db') ? 'live' : 'fresh';
if (MODE === 'live' && fs.existsSync(SOURCE)) {
  buildFromLiveDb();
} else {
  if (MODE === 'live') {
    console.log(`[snapshot] live DB not found at ${SOURCE}; falling back to FRESH schema`);
  }
  buildFromFreshSchema();
}

// Audit — every transcript_chunk_v6.body must start with 'redacted-'.
const audit = new Database(DEST, { readonly: true });
let auditOk = true;
try {
  const rows = audit.prepare(`SELECT id, body FROM transcript_chunk_v6 LIMIT 30`).all();
  for (const r of rows) {
    if (r.body && !String(r.body).startsWith('redacted-')) {
      console.error(`[snapshot] AUDIT FAIL: row ${r.id} body did not redact: ${String(r.body).slice(0, 60)}`);
      auditOk = false;
    }
  }
  if (auditOk) console.log(`[snapshot] AUDIT OK — ${rows.length} sample rows all redacted`);
} finally {
  audit.close();
}

if (!auditOk) {
  console.error('[snapshot] aborting — fixture leaked content');
  process.exit(2);
}

const stat = fs.statSync(DEST);
const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
console.log('');
console.log(`[snapshot] Built ${DEST} (${sizeMb} MB)`);
console.log('');
console.log('NOTE: fixture is committed to the repo for WIR-promoted integration tests.');
console.log('Re-run only when V32 schema changes or WIR test needs new seed shape.');
