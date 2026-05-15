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
  /** If true, ingest as __global__ scope (cross-project user memories). */
  globalScope?: boolean;
}

export interface IngestResult {
  ingested: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

/**
 * Derives the Claude Code project key from a directory path.
 * Claude Code stores project-scoped data at ~/.claude/projects/<key>/
 * where key = absolute path with ':' replaced by '-' and separators replaced by '-'.
 * Example: C:\Users\Foo\Project → C--Users-Foo-Project
 * (colon becomes '-', then backslash becomes '-', giving double dash after drive letter)
 */
function deriveClaudeProjectKey(dir: string): string {
  return path.resolve(dir)
    .replace(/:/g, '-')
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

  // 4. Cross-project user memories — scan OTHER projects' memory dirs for
  //    type: user files. These are identity facts (hardware, preferences) that
  //    must be visible globally, not siloed per project.
  //    Only runs when the current project has a real memory dir (skip in tests).
  const hasRealMemoryDir = fs.existsSync(memoryDir);
  const globalUserSources = hasRealMemoryDir
    ? scanCrossProjectUserMemories(home, projectKey, existingTimestamps)
    : Promise.resolve([]);

  // Scan all directories concurrently
  const [memorySources, sessionSources, handoffSources, crossProjectSources] = await Promise.all([
    scanDirectory(memoryDir, 'memory_file', existingTimestamps),
    scanDirectory(sessionsDir, 'session_log', existingTimestamps),
    scanDirectory(handoffsDir, 'handoff', existingTimestamps),
    globalUserSources,
  ]);

  return [...memorySources, ...sessionSources, ...handoffSources, ...crossProjectSources];
}

/**
 * Scans all other project memory directories for type: user memory files.
 * These are global identity facts (hardware specs, preferences, role) that
 * should be visible across all projects. Reads YAML frontmatter to check type.
 * Non-throwing, async.
 */
async function scanCrossProjectUserMemories(
  home: string,
  currentProjectKey: string,
  existingTimestamps: Map<string, number>,
): Promise<FileSource[]> {
  const sources: FileSource[] = [];
  try {
    const projectsDir = path.join(home, '.claude', 'projects');
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch { return sources; }

    // Scan up to 20 other projects (avoid unbounded I/O)
    const otherProjects = projectDirs
      .filter(d => d.isDirectory() && d.name !== currentProjectKey)
      .slice(0, 20);

    for (const projDir of otherProjects) {
      try {
        const memDir = path.join(projectsDir, projDir.name, 'memory');
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(memDir, { withFileTypes: true });
        } catch { continue; }

        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (path.extname(entry.name).toLowerCase() !== '.md') continue;
          if (SKIP_FILES.has(entry.name)) continue;

          const filePath = path.join(memDir, entry.name);
          try {
            const stat = await fsp.stat(filePath);
            if (stat.size > MAX_FILE_SIZE || stat.size < MIN_CONTENT_LENGTH) continue;

            // Mtime check
            const existingTs = existingTimestamps.get(filePath);
            if (existingTs !== undefined && stat.mtimeMs < existingTs + 1000) continue;

            const raw = await fsp.readFile(filePath, 'utf-8');
            if (raw.includes('\0')) continue;

            // Check YAML frontmatter for type: user
            if (!raw.startsWith('---')) continue;
            const endIdx = raw.indexOf('---', 3);
            if (endIdx < 0) continue;
            const frontmatter = raw.slice(3, endIdx);
            if (!/\btype:\s*user\b/i.test(frontmatter)) continue;

            // It's a user-type memory — ingest globally
            let content = raw.slice(endIdx + 3).trim();
            if (content.length < MIN_CONTENT_LENGTH) continue;

            sources.push({
              path: filePath,
              type: 'memory_file',
              summary: content.replace(/\n/g, ' ').slice(0, 200).trim(),
              content,
              mtimeMs: stat.mtimeMs,
              globalScope: true,
            });
          } catch { /* skip individual file */ }
        }
      } catch { /* skip individual project */ }
    }
  } catch { /* non-throwing */ }
  return sources;
}

/**
 * Loads existing file artifact timestamps for mtime comparison.
 * Returns a map of artifact_ref → timestamp_epoch_ms (in ms).
 */
function loadExistingTimestamps(db: Database, project: string): Map<string, number> {
  try {
    const rows = cachedPrepare(db,
      `SELECT artifact_ref, timestamp_epoch_ms FROM artifacts
       WHERE project = ? AND artifact_type IN ('memory_file', 'session_log', 'handoff')
         AND artifact_ref IS NOT NULL`
    ).all(project) as Array<{ artifact_ref: string; timestamp_epoch_ms: number }>;

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.artifact_ref, row.timestamp_epoch_ms); // already in ms
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
  // timestamp_epoch_ms stores file mtimeMs directly (ms precision).
  // We compare with +1000 buffer to handle minor filesystem timestamp variation.
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
  const result: IngestResult = { ingested: 0, errors: 0 };

  try {
    // Index creation moved to migrateV3toV4 — no runtime DDL on hot path
    const sources = await scanSources(db, projectDir, project);
    if (sources.length === 0) return result;

    const ingestTx = db.transaction(() => {
      for (const src of sources) {
        try {
          // Store file's actual mtime as timestamp_epoch_ms (ms precision).
          // This makes the mtime comparison in scanDirectory accurate:
          // file.mtimeMs vs artifact.timestamp_epoch_ms is apples-to-apples.
          const fileMtimeEpoch = src.mtimeMs;

          // Cross-project user memories use __global__ scope so they're
          // visible from any project's hybrid retrieval.
          const targetProject = src.globalScope ? '__global__' : project;
          // User memories get elevated importance — they're identity facts
          const targetImportance = src.globalScope ? 5 : 3;

          const existing = cachedPrepare(db,
            `SELECT id, summary FROM artifacts
             WHERE project = ? AND artifact_type = ? AND artifact_ref = ?
             LIMIT 1`
          ).get(targetProject, src.type, src.path) as { id: number; summary: string } | undefined;

          if (existing) {
            cachedPrepare(db,
              `UPDATE artifacts SET summary = ?, content = ?, timestamp_epoch_ms = ?, importance = ?
               WHERE id = ?`
            ).run(src.summary, src.content, fileMtimeEpoch, targetImportance, existing.id);
          } else {
            cachedPrepare(db,
              `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance, timestamp_epoch_ms)
               VALUES (?, ?, ?, ?, ?, ?, 'packed', 0, ?, ?)`
            ).run(sessionId, targetProject, src.type, src.path, src.summary, src.content, targetImportance, fileMtimeEpoch);
          }
          result.ingested++;
        } catch {
          result.errors++;
        }
      }
    });

    ingestTx();

    // Embed newly ingested artifacts (awaited — must complete before session-start returns).
    // Batch-embeds up to 10 artifacts in parallel via Promise.allSettled.
    // Adds ~2-5s on first run, subsequent starts find most artifacts already embedded.
    try {
      const unembedded = cachedPrepare(db,
        `SELECT id, summary, content, artifact_type, importance, session_id, project
         FROM artifacts
         WHERE project IN (?, '__global__') AND embedding IS NULL
           AND artifact_type IN ('session_log', 'decision', 'learning', 'handoff', 'memory_file')
         ORDER BY importance DESC
         LIMIT 20`
      ).all(project) as Array<{
        id: number; summary: string; content: string;
        artifact_type: string; importance: number; session_id: string;
      }>;

      if (unembedded.length > 0) {
        const { embedArtifact } = await import('../embeddings/embed-pipeline.js');
        // Process in parallel with a concurrency cap
        const batch = unembedded.slice(0, 10);
        await Promise.allSettled(batch.map(a =>
          embedArtifact(db, a.id, [a.summary, a.content].filter(Boolean).join(' '), {
            project,
            artifact_type: a.artifact_type,
            importance: a.importance,
            session_id: a.session_id,
            summary: a.summary,
          })
        ));
      }
    } catch {
      // Embedding is supplementary — never blocks ingestion
    }
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
