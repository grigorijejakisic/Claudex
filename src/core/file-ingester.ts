/**
 * File-to-artifact ingester for Claudex Recall.
 *
 * Scans file-based context sources (memory files, session logs, handoffs)
 * and upserts them as artifacts. This widens the existing artifact search
 * pipeline to include file-based knowledge — no new search infrastructure.
 *
 * Runs at session-start and compaction boundaries (500ms-3000ms budget),
 * never per-turn. Uses mtime + content hash for incremental updates.
 * All file I/O is async (fs.promises) to avoid blocking the event loop
 * at production scale (hundreds of files).
 *
 * All functions are non-throwing with safe defaults.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
// crypto removed — contentHash was computed but never stored/used
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import type { ArtifactType } from './artifacts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size to ingest (512 KB). Larger files are skipped. */
const MAX_FILE_SIZE = 512 * 1024;

/** Minimum file content length after frontmatter stripping. */
const MIN_CONTENT_LENGTH = 20;

/** Allowed file extensions for ingestion. */
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);

/** Files to skip (index files, not content). */
const SKIP_FILES = new Set(['MEMORY.md']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileSource {
  path: string;
  type: ArtifactType;
  summary: string;
  content: string;
  mtimeMs: number;
}

export interface IngestResult {
  ingested: number;
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

/**
 * Derives the Claude Code project key from a directory path.
 * Claude Code stores project-scoped data at ~/.claude/projects/<key>/
 * where key = absolute path with ':' removed and separators replaced by '-'.
 */
function deriveClaudeProjectKey(dir: string): string {
  return path.resolve(dir)
    .replace(/:/g, '')
    .replace(/[/\\]/g, '-');
}

// ---------------------------------------------------------------------------
// File scanning (async)
// ---------------------------------------------------------------------------

/**
 * Scans all file-based context sources for a project.
 * Uses mtime comparison against existing artifact timestamps to skip
 * unmodified files (avoids reading + hashing unchanged content).
 * All file I/O is async. Non-throwing — skips unreadable files.
 */
async function scanSources(
  db: Database,
  projectDir: string,
  project: string,
): Promise<FileSource[]> {
  const home = os.homedir();

  // Load existing artifact timestamps for mtime comparison (DB query — sync, fast)
  const existingTimestamps = loadExistingTimestamps(db, project);

  // 1. Memory files from Claude auto-memory
  const projectKey = deriveClaudeProjectKey(projectDir);
  const memoryDir = path.join(home, '.claude', 'projects', projectKey, 'memory');

  // 2. Session logs
  const sessionsDir = path.join(projectDir, 'context', 'sessions');

  // 3. Handoffs (top-level only)
  const handoffsDir = path.join(projectDir, 'context', 'handoffs');

  // Scan all three directories concurrently
  const [memorySources, sessionSources, handoffSources] = await Promise.all([
    scanDirectory(memoryDir, 'memory_file', existingTimestamps),
    scanDirectory(sessionsDir, 'session_log', existingTimestamps),
    scanDirectory(handoffsDir, 'handoff', existingTimestamps),
  ]);

  return [...memorySources, ...sessionSources, ...handoffSources];
}

/**
 * Loads existing file artifact timestamps for mtime comparison.
 * Returns a map of artifact_ref → timestamp_epoch (in ms).
 */
function loadExistingTimestamps(db: Database, project: string): Map<string, number> {
  try {
    const rows = cachedPrepare(db,
      `SELECT artifact_ref, timestamp_epoch FROM artifacts
       WHERE project = ? AND artifact_type IN ('memory_file', 'session_log', 'handoff')
         AND artifact_ref IS NOT NULL`
    ).all(project) as Array<{ artifact_ref: string; timestamp_epoch: number }>;

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.artifact_ref, row.timestamp_epoch * 1000); // epoch seconds → ms
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Scans a directory for text files. Checks mtime before reading.
 * Returns FileSource entries. All file I/O is async.
 * Non-throwing.
 */
async function scanDirectory(
  dir: string,
  type: ArtifactType,
  existingTimestamps: Map<string, number>,
): Promise<FileSource[]> {
  const sources: FileSource[] = [];
  try {
    // Check directory exists
    try {
      await fsp.access(dir);
    } catch {
      return sources;
    }

    const entries = await fsp.readdir(dir, { withFileTypes: true });

    // Process files concurrently with Promise.allSettled
    const filePromises = entries
      .filter(entry => {
        if (!entry.isFile()) return false;
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) return false;
        if (SKIP_FILES.has(entry.name)) return false;
        return true;
      })
      .map(entry => processFile(path.join(dir, entry.name), type, existingTimestamps));

    const results = await Promise.allSettled(filePromises);
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        sources.push(result.value);
      }
    }
  } catch { /* non-throwing */ }
  return sources;
}

/**
 * Processes a single file: stat → mtime check → read → parse.
 * Returns null if file should be skipped. Async.
 */
async function processFile(
  filePath: string,
  type: ArtifactType,
  existingTimestamps: Map<string, number>,
): Promise<FileSource | null> {
  const stat = await fsp.stat(filePath);

  // Size cap
  if (stat.size > MAX_FILE_SIZE) return null;
  if (stat.size < MIN_CONTENT_LENGTH) return null;

  // Mtime check — skip if file hasn't changed since last ingestion.
  // timestamp_epoch stores floor(file_mtime_ms / 1000) — second precision.
  // existingTs = timestamp_epoch * 1000 — back to ms but truncated to second boundary.
  // File mtimeMs has full ms precision, so we compare with +1000 to cover the
  // truncation gap (same second = unchanged).
  const existingTs = existingTimestamps.get(filePath);
  if (existingTs !== undefined && stat.mtimeMs < existingTs + 1000) return null;

  const raw = await fsp.readFile(filePath, 'utf-8');

  // Binary detection — skip files with NUL bytes
  if (raw.includes('\0')) return null;

  // Strip YAML frontmatter
  let content = raw;
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx > 0) content = content.slice(endIdx + 3).trim();
  }

  if (content.length < MIN_CONTENT_LENGTH) return null;

  const summary = content.replace(/\n/g, ' ').slice(0, 200).trim();

  return {
    path: filePath,
    type,
    summary,
    content,
    mtimeMs: stat.mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Schema setup
// ---------------------------------------------------------------------------

/**
 * Ensures the unique index for file artifact dedup exists.
 * Idempotent. Non-throwing.
 */
function ensureFileArtifactIndex(db: Database): void {
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_file_ref
       ON artifacts(project, artifact_type, artifact_ref)
       WHERE artifact_ref IS NOT NULL
         AND artifact_type IN ('memory_file', 'session_log', 'handoff')`
    );
  } catch { /* non-throwing — index may already exist or partial index not supported */ }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingests file-based context sources as artifacts.
 *
 * File scanning is async (non-blocking). DB writes are sync (better-sqlite3).
 * Content stored directly (no inline hash encoding).
 * Ingested artifacts: state='packed', importance=3, ttl=0.
 *
 * Non-throwing. Returns counts of ingested/skipped/errors.
 */
export async function ingestFileArtifacts(
  db: Database,
  sessionId: string,
  project: string,
  projectDir: string,
): Promise<IngestResult> {
  const result: IngestResult = { ingested: 0, skipped: 0, errors: 0 };

  try {
    // Index creation moved to migrateV3toV4 — no runtime DDL on hot path
    const sources = await scanSources(db, projectDir, project);
    if (sources.length === 0) return result;

    const ingestTx = db.transaction(() => {
      for (const src of sources) {
        try {
          // Store file's actual mtime as timestamp_epoch (not Date.now()).
          // This makes the mtime comparison in scanDirectory accurate:
          // file.mtimeMs vs artifact.timestamp_epoch*1000 is apples-to-apples.
          const fileMtimeEpoch = Math.floor(src.mtimeMs / 1000);

          const existing = cachedPrepare(db,
            `SELECT id, summary FROM artifacts
             WHERE project = ? AND artifact_type = ? AND artifact_ref = ?
             LIMIT 1`
          ).get(project, src.type, src.path) as { id: number; summary: string } | undefined;

          if (existing) {
            cachedPrepare(db,
              `UPDATE artifacts SET summary = ?, content = ?, timestamp_epoch = ?
               WHERE id = ?`
            ).run(src.summary, src.content, fileMtimeEpoch, existing.id);
          } else {
            cachedPrepare(db,
              `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance, timestamp_epoch)
               VALUES (?, ?, ?, ?, ?, ?, 'packed', 0, 3, ?)`
            ).run(sessionId, project, src.type, src.path, src.summary, src.content, fileMtimeEpoch);
          }
          result.ingested++;
        } catch {
          result.errors++;
        }
      }
    });

    ingestTx();
  } catch {
    // Non-throwing
  }

  return result;
}

/**
 * Removes artifacts for files that no longer exist on disk.
 * Uses async file existence checks. Non-throwing.
 */
export async function pruneStaleFileArtifacts(db: Database, project: string): Promise<number> {
  try {
    const fileTypes = ['memory_file', 'session_log', 'handoff'];
    const placeholders = fileTypes.map(() => '?').join(',');
    const rows = cachedPrepare(db,
      `SELECT id, artifact_ref FROM artifacts
       WHERE project = ? AND artifact_type IN (${placeholders})
         AND artifact_ref IS NOT NULL`
    ).all(project, ...fileTypes) as Array<{ id: number; artifact_ref: string }>;

    let pruned = 0;
    const checks = await Promise.allSettled(
      rows.map(async row => {
        try {
          await fsp.access(row.artifact_ref);
          return { id: row.id, exists: true };
        } catch {
          return { id: row.id, exists: false };
        }
      })
    );

    for (const check of checks) {
      if (check.status === 'fulfilled' && !check.value.exists) {
        try {
          cachedPrepare(db, `DELETE FROM artifacts WHERE id = ?`).run(check.value.id);
          pruned++;
        } catch { /* skip */ }
      }
    }
    return pruned;
  } catch {
    return 0;
  }
}
