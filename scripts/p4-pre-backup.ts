#!/usr/bin/env node
/**
 * Phase 5 (P4) pre-flight DB backup.
 *
 * Creates a timestamped readonly snapshot of the production Claudex DB
 * BEFORE any assembler.ts deletion lands. Smoke-queries the copy to
 * confirm restorability. Exit 0 on success, 1 on suspicious copy.
 *
 * Usage: node dist/scripts/p4-pre-backup.cjs
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

interface BackupReport {
  src: string;
  dst: string;
  schema_version: number;
  artifacts_count: number;
  sessions_count: number;
  learnings_count: number;
  ok: boolean;
}

function main(): void {
  const TS = Math.floor(Date.now() / 1000);
  const homedir = os.homedir();
  const src = path.join(homedir, '.claudex', 'db', 'claudex.db');
  const backupsDir = path.join(homedir, '.claudex', 'backups');
  const dst = path.join(backupsDir, `pre-v4-P4-${TS}.db`);

  if (!fs.existsSync(src)) {
    console.error(JSON.stringify({ error: 'src DB not found', src }));
    process.exit(1);
  }

  fs.mkdirSync(backupsDir, { recursive: true });
  fs.copyFileSync(src, dst);

  let db: Database.Database | null = null;
  try {
    db = new Database(dst, { readonly: true });
    const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const artifactsRow = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number };
    const sessionsRow = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    let learningsCount = 0;
    try {
      learningsCount = (db.prepare('SELECT COUNT(*) AS n FROM learnings').get() as { n: number }).n;
    } catch {
      learningsCount = 0;
    }

    const report: BackupReport = {
      src,
      dst,
      schema_version: userVersion,
      artifacts_count: artifactsRow.n,
      sessions_count: sessionsRow.n,
      learnings_count: learningsCount,
      ok: false,
    };

    if (artifactsRow.n === 0 && sessionsRow.n === 0) {
      report.ok = false;
      console.error(JSON.stringify({ ...report, error: 'DB suspicious — zero rows in core tables' }));
      try { db.close(); } catch { /* */ }
      try { fs.unlinkSync(dst); } catch { /* */ }
      process.exit(1);
    }

    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
    db.close();
    process.exit(0);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ error: 'smoke query failed', detail: msg, dst }));
    if (db) { try { db.close(); } catch { /* */ } }
    try { fs.unlinkSync(dst); } catch { /* */ }
    process.exit(1);
  }
}

main();

export { main };
