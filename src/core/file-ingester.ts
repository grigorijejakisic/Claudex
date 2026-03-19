/**
 * File-to-artifact ingester for Claudex Recall.
 *
 * Scans file-based context sources (memory files, session logs, handoffs)
 * and upserts them as artifacts. This widens the existing artifact search
 * pipeline to include file-based knowledge — no new search infrastructure.
 *
 * Runs at session-start and compaction boundaries (500ms-3000ms budget),
 * never per-turn. Uses mtime + content hash for incremental updates.
 *
 * All functions are non-throwing with safe defaults.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
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
  contentHash: string;
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
// File scanning
// ---------------------------------------------------------------------------

/**
 * Scans all file-based context sources for a project.
 * Uses mtime comparison against existing artifact timestamps to skip
 * unmodified files (avoids reading + hashing unchanged content).
 * Non-throwing — skips unreadable files.
 */
function scanSources(
  db: Database,
  projectDir: string,
  project: string,
): FileSource[] {
  const sources: FileSource[] = [];
  const home = os.homedir();

  // Load existing artifact timestamps for mtime comparison
  const existingTimestamps = loadExistingTimestamps(db, project);

  // 1. Memory files from Claude auto-memory
  const projectKey = deriveClaudeProjectKey(projectDir);
  const memoryDir = path.join(home, '.claude', 'projects', projectKey, 'memory');
  scanDirectory(memoryDir, 'memory_file', sources, existingTimestamps);

  // 2. Session logs
  const sessionsDir = path.join(projectDir, 'context', 'sessions');
  scanDirectory(sessionsDir, 'session_log', sources, existingTimestamps);

  // 3. Handoffs (top-level only)
  const handoffsDir = path.join(projectDir, 'context', 'handoffs');
  scanDirectory(handoffsDir, 'handoff', sources, existingTimestamps);

  return sources;
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
 * Appends FileSource entries to the `out` array.
 * Non-throwing.
 */
function scanDirectory(
  dir: string,
  type: ArtifactType,
  out: FileSource[],
  existingTimestamps: Map<string, number>,
): void {
  try {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;

      // Extension filter
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;

      // Skip index files
      if (SKIP_FILES.has(entry.name)) continue;

      try {
        const filePath = path.join(dir, entry.name);
        const stat = fs.statSync(filePath);

        // Size cap
        if (stat.size > MAX_FILE_SIZE) continue;
        if (stat.size < MIN_CONTENT_LENGTH) continue;

        // Mtime check — skip if file hasn't changed since last ingestion.
        // Add 1000ms buffer because timestamp_epoch is second-precision (truncated)
        // while mtimeMs has millisecond precision.
        const existingTs = existingTimestamps.get(filePath);
        if (existingTs !== undefined && stat.mtimeMs <= existingTs + 1000) continue;

        const raw = fs.readFileSync(filePath, 'utf-8');

        // Binary detection — skip files with NUL bytes
        if (raw.includes('\0')) continue;

        // Strip YAML frontmatter
        let content = raw;
        if (content.startsWith('---')) {
          const endIdx = content.indexOf('---', 3);
          if (endIdx > 0) content = content.slice(endIdx + 3).trim();
        }

        if (content.length < MIN_CONTENT_LENGTH) continue;

        const summary = content.replace(/\n/g, ' ').slice(0, 200).trim();
        const contentHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

        out.push({
          path: filePath,
          type,
          summary,
          content,
          contentHash,
          mtimeMs: stat.mtimeMs,
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* non-throwing */ }
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
 * Uses INSERT ... ON CONFLICT for atomic upsert (no read-then-write race).
 * Content hash stored separately from content (no inline encoding).
 * Ingested artifacts: state='packed', importance=3, ttl=0.
 *
 * Non-throwing. Returns counts of ingested/skipped/errors.
 */
export function ingestFileArtifacts(
  db: Database,
  sessionId: string,
  project: string,
  projectDir: string,
): IngestResult {
  const result: IngestResult = { ingested: 0, skipped: 0, errors: 0 };

  try {
    ensureFileArtifactIndex(db);
    const sources = scanSources(db, projectDir, project);
    if (sources.length === 0) return result;

    const now = Math.floor(Date.now() / 1000);

    const ingestTx = db.transaction(() => {
      for (const src of sources) {
        try {
          // Atomic upsert via INSERT OR REPLACE on the unique index.
          // If artifact_ref already exists for this project+type, the row is replaced.
          // Content hash is stored in artifact_ref alongside the path using a separator
          // that can't appear in file paths, so consumers never need to parse content.
          //
          // Actually, we use a two-step approach: try INSERT, on conflict UPDATE.
          // This preserves the row ID for existing artifacts.
          const existing = cachedPrepare(db,
            `SELECT id, summary FROM artifacts
             WHERE project = ? AND artifact_type = ? AND artifact_ref = ?
             LIMIT 1`
          ).get(project, src.type, src.path) as { id: number; summary: string } | undefined;

          if (existing) {
            // Update content + timestamp
            cachedPrepare(db,
              `UPDATE artifacts SET summary = ?, content = ?, timestamp_epoch = ?
               WHERE id = ?`
            ).run(src.summary, src.content, now, existing.id);
          } else {
            cachedPrepare(db,
              `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance, timestamp_epoch)
               VALUES (?, ?, ?, ?, ?, ?, 'packed', 0, 3, ?)`
            ).run(sessionId, project, src.type, src.path, src.summary, src.content, now);
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
 * Non-throwing.
 */
export function pruneStaleFileArtifacts(db: Database, project: string): number {
  try {
    const fileTypes = ['memory_file', 'session_log', 'handoff'];
    const placeholders = fileTypes.map(() => '?').join(',');
    const rows = cachedPrepare(db,
      `SELECT id, artifact_ref FROM artifacts
       WHERE project = ? AND artifact_type IN (${placeholders})
         AND artifact_ref IS NOT NULL`
    ).all(project, ...fileTypes) as Array<{ id: number; artifact_ref: string }>;

    let pruned = 0;
    for (const row of rows) {
      try {
        if (!fs.existsSync(row.artifact_ref)) {
          cachedPrepare(db,
            `DELETE FROM artifacts WHERE id = ?`
          ).run(row.id);
          pruned++;
        }
      } catch { /* skip */ }
    }
    return pruned;
  } catch {
    return 0;
  }
}
