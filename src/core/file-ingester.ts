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
import { createHash } from 'node:crypto';
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
 * Returns a map of artifact_ref → created_at_epoch_ms (in ms).
 *
 * 14-07b: migrated from legacy artifacts → V17 artifact table.
 * artifact_ref is stored in data JSON as data.artifact_ref.
 */
function loadExistingTimestamps(db: Database, project: string): Map<string, number> {
  try {
    // 14-07b: migrated from legacy artifacts
    const rows = cachedPrepare(db,
      `SELECT json_extract(data, '$.artifact_ref') AS artifact_ref,
              created_at_epoch_ms
       FROM artifact
       WHERE project = ?
         AND kind IN ('memory_file', 'session_log', 'handoff')
         AND json_extract(data, '$.artifact_ref') IS NOT NULL`
    ).all(project) as Array<{ artifact_ref: string; created_at_epoch_ms: number }>;

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.artifact_ref, row.created_at_epoch_ms); // already in ms
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
 * Ensures the unique index for file artifact dedup exists on V17 artifact table.
 * Idempotent. Non-throwing.
 *
 * 14-07b: migrated from legacy artifacts → V17 artifact table.
 * artifact_ref lives in data JSON; index on expression.
 */
function ensureFileArtifactIndex(db: Database): void {
  try {
    // 14-07b: migrated from legacy artifacts — index on V17 artifact
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_file_ref_v17
       ON artifact(project, kind, json_extract(data, '$.artifact_ref'))
       WHERE json_extract(data, '$.artifact_ref') IS NOT NULL
         AND kind IN ('memory_file', 'session_log', 'handoff')`
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
          // Store file's actual mtime as created_at_epoch_ms (ms precision).
          // This makes the mtime comparison in scanDirectory accurate:
          // file.mtimeMs vs artifact.created_at_epoch_ms is apples-to-apples.
          const fileMtimeEpoch = src.mtimeMs;

          // Cross-project user memories use __global__ scope so they're
          // visible from any project's hybrid retrieval.
          const targetProject = src.globalScope ? '__global__' : project;
          // User memories get elevated importance — they're identity facts.
          // V17 confidence is 0-1; legacy importance was 1-5.
          // targetImportance=5 → confidence=1.0; targetImportance=3 → confidence=0.6
          const targetConfidence = src.globalScope ? 1.0 : 0.6;

          // 14-07b: migrated from legacy artifacts — Site 1 (read existing)
          const existing = cachedPrepare(db,
            `SELECT id, title FROM artifact
             WHERE project = ? AND kind = ?
               AND json_extract(data, '$.artifact_ref') = ?
             LIMIT 1`
          ).get(targetProject, src.type, src.path) as { id: string; title: string } | undefined;

          if (existing) {
            // 14-07b: migrated from legacy artifacts — Site 1 (UPDATE existing)
            cachedPrepare(db,
              `UPDATE artifact
               SET title = ?,
                   body = ?,
                   created_at_epoch_ms = ?,
                   updated_at_epoch_ms = ?,
                   confidence = ?,
                   data = json_set(data,
                     '$.artifact_ref', ?,
                     '$.file_mtime_ms', ?
                   )
               WHERE id = ?`
            ).run(
              src.summary,
              src.content,
              fileMtimeEpoch,
              fileMtimeEpoch,
              targetConfidence,
              src.path,
              fileMtimeEpoch,
              existing.id,
            );
          } else {
            // 14-07b: migrated from legacy artifacts — Site 2 (INSERT new)
            // V17 TEXT ID: sha256(file_path + kind + project + mtime).slice(0, 32)
            const v17Id = createHash('sha256')
              .update(`${src.path}:${src.type}:${targetProject}:${fileMtimeEpoch}`)
              .digest('hex')
              .slice(0, 32);

            const now = fileMtimeEpoch;
            const dataSidecar = JSON.stringify({
              artifact_ref: src.path,
              file_mtime_ms: fileMtimeEpoch,
              ttl: 0,
            });

            cachedPrepare(db,
              `INSERT INTO artifact (
                id, kind, title, body, scope, status, confidence,
                created_at_epoch_ms, updated_at_epoch_ms,
                session_id, project, data
               ) VALUES (?, ?, ?, ?, 'project', 'active', ?, ?, ?, ?, ?, ?)`
            ).run(
              v17Id,
              src.type,
              src.summary,
              src.content,
              targetConfidence,
              now,
              now,
              sessionId,
              targetProject,
              dataSidecar,
            );
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
    //
    // 14-07b: migrated from legacy artifacts — embedding query now targets V17 artifact table.
    // Artifacts without a vec_artifact_v17 row need embedding; we detect via LEFT JOIN absence.
    try {
      const unembedded = cachedPrepare(db,
        `SELECT a.id, a.title, a.body, a.kind, a.confidence, a.session_id, a.project,
                a.rowid AS artifact_rowid
         FROM artifact a
         LEFT JOIN vec_artifact_v17 v ON v.rowid = a.rowid
         WHERE a.project IN (?, '__global__')
           AND v.rowid IS NULL
           AND a.kind IN ('session_log', 'decision', 'learning', 'handoff', 'memory_file')
         ORDER BY a.confidence DESC
         LIMIT 20`
      ).all(project) as Array<{
        id: string; title: string | null; body: string;
        kind: string; confidence: number | null; session_id: string | null;
        project: string; artifact_rowid: number;
      }>;

      if (unembedded.length > 0) {
        const { embedArtifactV17 } = await import('../embeddings/embed-pipeline.js');
        // Process in parallel with a concurrency cap
        const batch = unembedded.slice(0, 10);
        await Promise.allSettled(batch.map(a =>
          embedArtifactV17(db, a.id, a.artifact_rowid, [a.title ?? '', a.body].filter(Boolean).join(' '), {
            project: a.project,
            kind: a.kind,
            confidence: a.confidence ?? 0.6,
            session_id: a.session_id ?? '',
            title: a.title ?? '',
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
