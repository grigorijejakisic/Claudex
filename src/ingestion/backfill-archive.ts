/**
 * Phase 8 plan 04 — full-archive transcript backfill.
 *
 * Walks ~/.claude/projects/**\/{session_id}.jsonl, enumerates every session
 * across every project, and floods Angel's heartbeat queue via
 * enqueueSessionIngestion. The actual chunking + embedding runs from
 * Angel's heartbeat at LIMIT 5 sessions per tick over a multi-hour drain.
 *
 * Resumable: re-running is a no-op for already-ingested sessions because
 * `transcript_chunk_v6` already has at least one row for that session_id.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Database } from 'better-sqlite3';
import { enqueueSessionIngestion } from './ingest-session.js';
import { cachedPrepare } from '../core/stmt-cache.js';

export interface SessionRef {
  session_id: string;
  project: string;
  jsonl_path: string;
  size_bytes: number;
  mtime_ms: number;
}

export interface BackfillProgress {
  total: number;
  enqueued: number;
  skipped: number;
  errors: number;
}

export interface BackfillOptions {
  onProgress?: (p: BackfillProgress) => void;
  progressEvery?: number;
}

/**
 * Enumerate every {project}/{session_id}.jsonl pair under the projects root.
 * Sorted by mtime ascending so the operator can monitor early progress
 * (oldest sessions are usually the ones the user has the most context on
 * already, but the deterministic ordering makes "I see N sessions ingested"
 * progress-tracking simple).
 *
 * Mirrors the path shape `parseSessionIdFromPath` in jsonl-watcher.ts
 * understands. Non-throwing — returns empty array on any enumeration error.
 */
export function enumerateArchiveSessions(rootDir?: string): SessionRef[] {
  const root = rootDir ?? path.join(os.homedir(), '.claude', 'projects');
  let projectDirs: string[];
  try {
    if (!fs.existsSync(root)) return [];
    projectDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  const refs: SessionRef[] = [];
  for (const project of projectDirs) {
    const projectPath = path.join(root, project);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      if (!sessionId) continue;
      const jsonlPath = path.join(projectPath, entry.name);
      try {
        const stat = fs.statSync(jsonlPath);
        refs.push({
          session_id: sessionId,
          project,
          jsonl_path: jsonlPath,
          size_bytes: stat.size,
          mtime_ms: stat.mtimeMs,
        });
      } catch {
        // file vanished mid-walk — skip.
      }
    }
  }

  refs.sort((a, b) => a.mtime_ms - b.mtime_ms);
  return refs;
}

/**
 * Iterate refs and enqueue each via enqueueSessionIngestion. Cheap — pure
 * DB INSERTs, no I/O beyond the fs.statSync above. The actual chunking +
 * embedding runs from Angel's heartbeat over the subsequent multi-hour
 * drain.
 *
 * Skips sessions that already have at least one transcript_chunk_v6 row
 * (idempotent across re-runs).
 */
export function runBackfill(
  db: Database,
  refs: SessionRef[],
  opts: BackfillOptions = {},
): BackfillProgress {
  const progress: BackfillProgress = {
    total: refs.length,
    enqueued: 0,
    skipped: 0,
    errors: 0,
  };
  const progressEvery = opts.progressEvery ?? 25;

  const skipQuery = cachedPrepare(db,
    `SELECT 1 FROM transcript_chunk_v6 WHERE session_id = ? LIMIT 1`,
  );

  for (const ref of refs) {
    try {
      const exists = skipQuery.get(ref.session_id) as { 1: number } | undefined;
      if (exists) {
        progress.skipped += 1;
      } else {
        enqueueSessionIngestion(db, ref.session_id, ref.project, ref.jsonl_path);
        progress.enqueued += 1;
      }
    } catch {
      progress.errors += 1;
    }
    if (opts.onProgress &&
        (progress.enqueued + progress.skipped + progress.errors) % progressEvery === 0) {
      opts.onProgress({ ...progress });
    }
  }

  if (opts.onProgress) opts.onProgress({ ...progress });
  return progress;
}
