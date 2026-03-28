/**
 * Angel User Profile Sync — cross-project identity reconciliation.
 *
 * CC's auto-memory system stores per-project memory files at
 * ~/.claude/projects/<slug>/memory/*.md with YAML frontmatter.
 * Files with `type: user` contain identity facts (hardware, preferences,
 * role) that should be globally visible — not siloed per project.
 *
 * This module periodically:
 * 1. Scans all CC project memory dirs for `type: user` files
 * 2. Groups by filename (e.g., user_pc_specs.md in 3 projects)
 * 3. Resolves conflicts: newest mtime wins (canonical version)
 * 4. Upserts canonical version as __global__ artifact (importance 5)
 * 5. Embeds for vector search
 *
 * Runs in the Angel heartbeat (~5 min cycle). Lightweight — stat-first,
 * only reads files when mtime has changed.
 *
 * Non-throwing — safe for heartbeat integration.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CC_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const GLOBAL_PROJECT = '__global__';

/** Max file size for user memory files (64 KB — these are small text files). */
const MAX_FILE_SIZE = 64 * 1024;

/** Rate limit: at most once per 5 minutes. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Max project directories to scan (avoid unbounded I/O). */
const MAX_PROJECTS_TO_SCAN = 30;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

let _lastSyncEpoch = 0;

/** Reset rate limit (for testing). */
export function resetSyncRateLimit(): void {
  _lastSyncEpoch = 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserMemoryFile {
  /** Full file path. */
  filePath: string;
  /** Filename only (e.g., user_pc_specs.md). */
  filename: string;
  /** CC project slug this file belongs to. */
  projectSlug: string;
  /** File mtime in ms. */
  mtimeMs: number;
  /** Content after stripping YAML frontmatter. */
  content: string;
  /** Summary (first 200 chars of content). */
  summary: string;
  /** Original YAML frontmatter name field, if present. */
  name?: string;
}

export interface SyncResult {
  files_scanned: number;
  profiles_synced: number;
  conflicts_resolved: number;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Scans all CC project memory directories for type: user files,
 * resolves conflicts by newest mtime, and upserts canonical versions
 * as __global__ artifacts.
 *
 * Non-throwing. Rate-limited to once per SYNC_INTERVAL_MS.
 */
export async function syncUserProfiles(db: Database): Promise<SyncResult> {
  const result: SyncResult = {
    files_scanned: 0,
    profiles_synced: 0,
    conflicts_resolved: 0,
  };

  try {
    // Rate limit
    const now = Date.now();
    if (now - _lastSyncEpoch < SYNC_INTERVAL_MS) return result;
    _lastSyncEpoch = now;

    // 1. Scan all project memory dirs for type: user files
    const userFiles = await scanAllProjectsForUserMemories();
    result.files_scanned = userFiles.length;
    if (userFiles.length === 0) return result;

    // 2. Group by filename — same filename across projects = same user fact
    const grouped = new Map<string, UserMemoryFile[]>();
    for (const file of userFiles) {
      const existing = grouped.get(file.filename) ?? [];
      existing.push(file);
      grouped.set(file.filename, existing);
    }

    // 3. For each group, pick the canonical version (newest mtime wins)
    for (const [filename, versions] of grouped) {
      try {
        // Sort by mtime descending — newest first
        versions.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const canonical = versions[0];

        if (versions.length > 1) {
          result.conflicts_resolved++;
        }

        // 4. Upsert as __global__ artifact
        const synced = upsertGlobalUserArtifact(db, canonical);
        if (synced) result.profiles_synced++;
      } catch {
        // Individual file group failure — continue with others
      }
    }

    // 5. Embed any newly upserted user profile artifacts
    try {
      await embedUnembeddedUserProfiles(db);
    } catch {
      // Embedding is supplementary — never blocks sync
    }
  } catch {
    // Non-throwing
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Scans all CC project memory directories for type: user files.
 * Uses stat-first approach — only reads files that exist and are small enough.
 * Non-throwing.
 */
async function scanAllProjectsForUserMemories(): Promise<UserMemoryFile[]> {
  const files: UserMemoryFile[] = [];

  try {
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = await fsp.readdir(CC_PROJECTS_DIR, { withFileTypes: true });
    } catch { return files; }

    const dirs = projectDirs
      .filter(d => d.isDirectory())
      .slice(0, MAX_PROJECTS_TO_SCAN);

    // Scan all project memory dirs concurrently
    const scanPromises = dirs.map(async (projDir) => {
      const results: UserMemoryFile[] = [];
      try {
        const memDir = path.join(CC_PROJECTS_DIR, projDir.name, 'memory');
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(memDir, { withFileTypes: true });
        } catch { return results; }

        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (path.extname(entry.name).toLowerCase() !== '.md') continue;
          if (entry.name === 'MEMORY.md') continue;

          const filePath = path.join(memDir, entry.name);
          try {
            const stat = await fsp.stat(filePath);
            if (stat.size > MAX_FILE_SIZE || stat.size < 20) continue;

            const raw = await fsp.readFile(filePath, 'utf-8');
            if (!raw.startsWith('---')) continue;

            const endIdx = raw.indexOf('---', 3);
            if (endIdx < 0) continue;

            const frontmatter = raw.slice(3, endIdx);

            // Only process type: user files
            if (!/\btype:\s*user\b/i.test(frontmatter)) continue;

            const content = raw.slice(endIdx + 3).trim();
            if (content.length < 20) continue;

            // Extract name from frontmatter
            const nameMatch = frontmatter.match(/\bname:\s*(.+)/i);
            const name = nameMatch?.[1]?.trim();

            results.push({
              filePath,
              filename: entry.name,
              projectSlug: projDir.name,
              mtimeMs: stat.mtimeMs,
              content,
              summary: content.replace(/\n/g, ' ').slice(0, 200).trim(),
              name,
            });
          } catch { /* skip individual file */ }
        }
      } catch { /* skip individual project */ }
      return results;
    });

    const allResults = await Promise.allSettled(scanPromises);
    for (const result of allResults) {
      if (result.status === 'fulfilled') {
        files.push(...result.value);
      }
    }
  } catch { /* non-throwing */ }

  return files;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

/**
 * Upserts a user memory file as a __global__ artifact.
 * Returns true if a new artifact was created or an existing one was updated.
 *
 * Uses artifact_ref as the dedup key (full file path of the CANONICAL version).
 * The ref key is the FILENAME (not full path) so that the same user fact
 * from different projects resolves to the same artifact.
 */
function upsertGlobalUserArtifact(db: Database, file: UserMemoryFile): boolean {
  try {
    // Use filename as the stable ref key — independent of which project dir it came from
    const refKey = `user_memory:${file.filename}`;
    const nowEpoch = Math.floor(Date.now() / 1000);
    const fileMtimeEpoch = Math.floor(file.mtimeMs / 1000);

    const existing = cachedPrepare(db,
      `SELECT id, timestamp_epoch FROM artifacts
       WHERE project = ? AND artifact_type = 'memory_file' AND artifact_ref = ?
       LIMIT 1`
    ).get(GLOBAL_PROJECT, refKey) as { id: number; timestamp_epoch: number } | undefined;

    if (existing) {
      // Only update if the file is newer than what we have
      if (fileMtimeEpoch <= existing.timestamp_epoch) return false;

      cachedPrepare(db,
        `UPDATE artifacts SET summary = ?, content = ?, timestamp_epoch = ?, importance = 5
         WHERE id = ?`
      ).run(file.summary, file.content, fileMtimeEpoch, existing.id);
      return true;
    }

    // Insert new global user artifact
    cachedPrepare(db,
      `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance, timestamp_epoch)
       VALUES ('angel', ?, 'memory_file', ?, ?, ?, 'packed', 0, 5, ?)`
    ).run(GLOBAL_PROJECT, refKey, file.summary, file.content, fileMtimeEpoch);

    return true;
  } catch {
    return false;
  }
}

/**
 * Embeds any __global__ user memory artifacts that lack embeddings.
 * Non-throwing.
 */
async function embedUnembeddedUserProfiles(db: Database): Promise<void> {
  try {
    const unembedded = cachedPrepare(db,
      `SELECT id, summary, content, artifact_type, importance, session_id
       FROM artifacts
       WHERE project = ? AND embedding IS NULL AND artifact_type = 'memory_file'
       ORDER BY importance DESC
       LIMIT 10`
    ).all(GLOBAL_PROJECT) as Array<{
      id: number; summary: string; content: string;
      artifact_type: string; importance: number; session_id: string;
    }>;

    if (unembedded.length === 0) return;

    const { embedArtifact } = await import('../embeddings/embed-pipeline.js');
    await Promise.allSettled(unembedded.map(a =>
      embedArtifact(db, a.id, [a.summary, a.content].filter(Boolean).join(' '), {
        project: GLOBAL_PROJECT,
        artifact_type: a.artifact_type,
        importance: a.importance,
        session_id: a.session_id,
        summary: a.summary,
      })
    ));
  } catch {
    // Non-throwing
  }
}
