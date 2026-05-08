#!/usr/bin/env node
/**
 * Operator-invoked transcript backfill CLI.
 *
 * Usage:
 *   bun run backfill:transcripts             — enqueue full archive
 *   bun run backfill:transcripts --dry-run   — print summary, no DB writes
 *
 * After enqueue completes, Angel's heartbeat drains the queue at 5
 * sessions per tick. Monitor progress via:
 *
 *   sqlite3 ~/.claudex/db/claudex.db "SELECT COUNT(*) FROM session_events
 *     WHERE event_type='transcript_ingestion_pending'
 *       AND json_extract(detail, '$.processed') IS NULL"
 *
 * Operator-only — never wired into hooks or Angel auto-runs.
 */

import { openDatabase, closeDatabase } from '../core/storage.js';
import { getDbPath } from '../shared/paths.js';
import {
  enumerateArchiveSessions,
  runBackfill,
  type SessionRef,
} from '../ingestion/backfill-archive.js';

export interface CliArgs {
  dryRun: boolean;
  rootDir?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') {
      args.dryRun = true;
    } else if (a === '--root' && i + 1 < argv.length) {
      args.rootDir = argv[++i];
    }
  }
  return args;
}

function printRefSummary(refs: SessionRef[]): void {
  const byProject = new Map<string, number>();
  let totalBytes = 0;
  for (const r of refs) {
    byProject.set(r.project, (byProject.get(r.project) ?? 0) + 1);
    totalBytes += r.size_bytes;
  }
  const projects = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Found ${refs.length} session JSONL file${refs.length === 1 ? '' : 's'} across ${projects.length} project${projects.length === 1 ? '' : 's'}.`);
  console.log(`Total size: ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log('');
  console.log('Top projects by session count:');
  for (const [project, count] of projects.slice(0, 10)) {
    console.log(`  ${count.toString().padStart(5)}  ${project}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const refs = enumerateArchiveSessions(args.rootDir);

  if (refs.length === 0) {
    console.log('No session JSONL files found under ~/.claude/projects.');
    console.log('Nothing to backfill.');
    process.exit(0);
  }

  printRefSummary(refs);

  if (args.dryRun) {
    console.log('');
    console.log('--dry-run: not writing to DB. Re-run without --dry-run to enqueue.');
    process.exit(0);
  }

  const db = openDatabase(getDbPath());
  try {
    console.log('');
    console.log('Enqueueing... (Angel heartbeat will drain at 5 sessions per tick)');
    const startEpoch = Date.now();
    const progress = runBackfill(db, refs, {
      progressEvery: 100,
      onProgress: (p) => {
        const processed = p.enqueued + p.skipped + p.errors;
        const pct = p.total > 0 ? ((processed / p.total) * 100).toFixed(1) : '0.0';
        process.stderr.write(`  [${pct}%] enqueued=${p.enqueued} skipped=${p.skipped} errors=${p.errors}\r`);
      },
    });
    const elapsed = Math.max(1, Math.floor((Date.now() - startEpoch) / 1000));
    process.stderr.write('\n');
    console.log('');
    console.log(`Done in ${elapsed}s.`);
    console.log(`  enqueued: ${progress.enqueued}`);
    console.log(`  skipped (already ingested): ${progress.skipped}`);
    console.log(`  errors: ${progress.errors}`);
    console.log('');
    console.log('Monitor heartbeat drain via:');
    console.log("  sqlite3 ~/.claudex/db/claudex.db \"SELECT COUNT(*) FROM session_events WHERE event_type='transcript_ingestion_pending' AND json_extract(detail,'$.processed') IS NULL\"");
  } finally {
    closeDatabase(db);
  }
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    return argv1.endsWith('backfill-transcripts.ts') ||
           argv1.endsWith('backfill-transcripts.cjs') ||
           argv1.endsWith('backfill-transcripts.js');
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('backfill-transcripts failed:', err);
    process.exit(1);
  });
}
