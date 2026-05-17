/**
 * claudex recall CLI — unified search across all Claudex data sources.
 *
 * Usage:
 *   node dist/cli/recall.cjs "search query" [--project <name>] [--limit 10]
 *
 * Searches artifacts (including ingested memory files, session logs, handoffs),
 * observations, and learnings. Returns ranked results with source provenance.
 *
 * Exit 0 on success, 1 on error.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { getDbPath } from '../shared/paths.js';
import { getProjectId } from '../shared/scope-detector.js';
import { searchArtifactsGlobal } from '../core/artifacts.js';
import type { ArtifactRow } from '../core/artifacts.js';

interface RecallResult {
  type: string;
  summary: string;
  provenance: string;
  importance: number;
  age_seconds: number;
}

function formatResults(artifacts: ArtifactRow[]): RecallResult[] {
  const nowMs = Date.now();
  return artifacts.map(a => {
    const isFile = a.artifact_type === 'memory_file' || a.artifact_type === 'session_log' || a.artifact_type === 'handoff';
    return {
      type: a.artifact_type,
      summary: a.summary,
      provenance: isFile && a.artifact_ref ? path.basename(a.artifact_ref) : `artifact #${a.id}`,
      importance: a.importance,
      age_seconds: a.timestamp_epoch_ms ? Math.floor((nowMs - a.timestamp_epoch_ms) / 1000) : -1,
    };
  });
}

// ── Entry point ──────────────────────────────────────────────────────

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].includes('recall') || process.argv[1].endsWith('recall.cjs'));

if (isDirectExecution) {
  try {
    const args = process.argv.slice(2);
    let query = '';
    let project: string | null = null;
    let limit = 10;

    // Parse args
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project' && i + 1 < args.length) {
        project = args[++i];
      } else if (args[i] === '--limit' && i + 1 < args.length) {
        const v = parseInt(args[++i], 10);
        if (!isNaN(v) && v > 0) limit = v;
      } else if (!args[i].startsWith('--')) {
        query = args[i];
      }
    }

    if (!query) {
      process.stderr.write('Usage: node dist/cli/recall.cjs "search query" [--project <name>] [--limit 10]\n');
      process.exit(1);
    }

    const dbPath = getDbPath();
    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 5000');

    try {
      const resolvedProject = project ?? getProjectId(process.cwd());
      const artifacts = searchArtifactsGlobal(db, resolvedProject, query, limit);
      const results = formatResults(artifacts);

      process.stdout.write(JSON.stringify({ query, project: resolvedProject, results }, null, 2) + '\n');
      process.exit(0);
    } finally {
      try { db.close(); } catch { /* non-throwing */ }
    }
  } catch (err) {
    process.stderr.write(
      `recall error: ${err instanceof Error ? err.message : 'Unknown error'}\n`
    );
    process.exit(1);
  }
}
