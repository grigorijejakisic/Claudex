/**
 * Angel Memory Monitor — watches CC's auto-memory (MEMORY.md) across all projects.
 *
 * CC's auto-memory system adds entries to ~/.claude/projects/<slug>/memory/MEMORY.md.
 * When Claudex is the primary memory system, these bloat context — every entry is loaded
 * unconditionally every session regardless of relevance.
 *
 * The monitor migrates excess entries to Claudex DB where hybrid retrieval surfaces
 * them only when relevant. Entries under "## Universal" headers are pinned (never migrated).
 *
 * Non-throwing — safe for heartbeat integration.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

/** Max MEMORY.md entries before migration triggers. */
const MAX_ENTRIES = 5;

const CC_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDEX_PROJECTS_JSON = path.join(os.homedir(), '.claudex', 'projects.json');

/** Pinned section headers — entries under these are never migrated. */
const PINNED_HEADERS = ['universal', 'pinned', 'keep'];

export interface MemoryMonitorResult {
  projects_scanned: number;
  entries_migrated: number;
  projects_with_migrations: string[];
}

interface ParsedEntry {
  filename: string;
  description: string;
  line: string;
  pinned: boolean;
}

// ---------------------------------------------------------------------------
// Project name resolution
// ---------------------------------------------------------------------------

/**
 * Compute CC project directory slug from a filesystem path.
 * Matches CC's encoding: replace special chars with dashes.
 */
function pathToSlug(projectPath: string): string {
  return projectPath.replace(/[:\\/. ]/g, '-');
}

/**
 * Build a lookup map: CC directory slug → Claudex project name.
 * Uses ~/.claudex/projects.json as the registry.
 */
function buildSlugToProjectMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    if (!fs.existsSync(CLAUDEX_PROJECTS_JSON)) return map;
    const raw = JSON.parse(fs.readFileSync(CLAUDEX_PROJECTS_JSON, 'utf-8'));
    const projects = raw.projects ?? {};
    for (const [name, info] of Object.entries(projects)) {
      const slug = pathToSlug((info as { path: string }).path);
      map.set(slug, name);
    }
  } catch {
    // Non-throwing
  }
  return map;
}

// ---------------------------------------------------------------------------
// MEMORY.md parsing
// ---------------------------------------------------------------------------

/**
 * Parse MEMORY.md into structured entries with pinned status.
 * Entries under headers matching PINNED_HEADERS are marked as pinned.
 */
function parseMemoryMd(content: string): { entries: ParsedEntry[]; headerLines: string[] } {
  const entries: ParsedEntry[] = [];
  const headerLines: string[] = [];
  let currentPinned = false;

  for (const line of content.split('\n')) {
    // Track section headers
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      const headerText = headerMatch[1].toLowerCase().trim();
      currentPinned = PINNED_HEADERS.some(h => headerText.includes(h));
      headerLines.push(line);
      continue;
    }

    // Parse entry lines: - [filename.md](filename.md) — description
    const entryMatch = line.match(/^- \[([^\]]+)\]\([^)]+\)\s*[—–-]\s*(.+)$/);
    if (entryMatch) {
      entries.push({
        filename: entryMatch[1],
        description: entryMatch[2].trim(),
        line,
        pinned: currentPinned,
      });
    }
  }

  return { entries, headerLines };
}

// ---------------------------------------------------------------------------
// Memory file reading
// ---------------------------------------------------------------------------

/**
 * Read a memory file, parse frontmatter, return type + body content.
 */
function readMemoryFile(filePath: string): { type: string; content: string } | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');

    // Strip system-reminder tags
    const cleaned = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

    // Parse frontmatter
    const fmMatch = cleaned.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return { type: 'learning', content: cleaned };

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();
    if (!body) return null;

    // Extract type from frontmatter
    const typeMatch = frontmatter.match(/type:\s*(\w+)/);
    const memType = typeMatch?.[1] ?? 'feedback';

    // Map CC memory types to Claudex observation types
    const typeMap: Record<string, string> = {
      feedback: 'learning',
      project: 'decision',
      reference: 'decision',
      user: 'decision',
    };

    return { type: typeMap[memType] ?? 'learning', content: body };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claudex DB storage
// ---------------------------------------------------------------------------

/**
 * Store migrated memory content in Claudex observations table.
 */
function storeInClaudex(
  db: Database,
  project: string,
  content: string,
  type: string,
): boolean {
  try {
    const now = Math.floor(Date.now() / 1000);
    // category CHECK constraint: code|architecture|decision|error|test|config|dependency|documentation|performance|security|other
    const category = type === 'decision' ? 'decision' : 'other';
    const title = content.slice(0, 100).replace(/\n/g, ' ');
    cachedPrepare(db,
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, timestamp_epoch, obs_type)
       VALUES ('angel-memory-monitor', ?, 'angel-memory-monitor', ?, ?, ?, 4, ?, 'routine')`
    ).run(project, category, title, content, now);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MEMORY.md rewriting
// ---------------------------------------------------------------------------

/**
 * Rebuild MEMORY.md with only pinned and kept entries.
 */
function rewriteMemoryMd(
  memoryMdPath: string,
  originalContent: string,
  removedFilenames: Set<string>,
): void {
  try {
    const lines = originalContent.split('\n');
    const kept: string[] = [];

    for (const line of lines) {
      // Check if this line is an entry that should be removed
      const entryMatch = line.match(/^- \[([^\]]+)\]/);
      if (entryMatch && removedFilenames.has(entryMatch[1])) {
        continue; // Skip removed entries
      }
      kept.push(line);
    }

    // Clean up consecutive blank lines
    const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    fs.writeFileSync(memoryMdPath, cleaned);
  } catch {
    // Non-fatal — worst case MEMORY.md has stale entries pointing to deleted files
  }
}

// ---------------------------------------------------------------------------
// Main monitor function
// ---------------------------------------------------------------------------

/**
 * Scan all CC project MEMORY.md files, migrate excess entries to Claudex DB.
 * Called from the Angel heartbeat tick.
 */
export function monitorMemoryFiles(db: Database): MemoryMonitorResult {
  const result: MemoryMonitorResult = {
    projects_scanned: 0,
    entries_migrated: 0,
    projects_with_migrations: [],
  };

  try {
    if (!fs.existsSync(CC_PROJECTS_DIR)) return result;

    const slugToProject = buildSlugToProjectMap();
    let dirs: string[];
    try {
      dirs = fs.readdirSync(CC_PROJECTS_DIR);
    } catch {
      return result;
    }

    for (const slug of dirs) {
      const memoryDir = path.join(CC_PROJECTS_DIR, slug, 'memory');
      const memoryMdPath = path.join(memoryDir, 'MEMORY.md');

      if (!fs.existsSync(memoryMdPath)) continue;
      result.projects_scanned++;

      let content: string;
      try {
        content = fs.readFileSync(memoryMdPath, 'utf-8');
      } catch {
        continue;
      }

      const { entries } = parseMemoryMd(content);
      const unpinnedEntries = entries.filter(e => !e.pinned);

      // Only trigger if total unpinned entries exceed threshold
      if (unpinnedEntries.length <= MAX_ENTRIES) continue;

      // Resolve project name for DB storage
      const projectName = slugToProject.get(slug) ?? 'unknown';

      // Migrate excess unpinned entries (keep first MAX_ENTRIES unpinned)
      const toMigrate = unpinnedEntries.slice(MAX_ENTRIES);
      const removedFilenames = new Set<string>();

      for (const entry of toMigrate) {
        const filePath = path.join(memoryDir, entry.filename);
        const fileContent = readMemoryFile(filePath);

        if (!fileContent) {
          // File doesn't exist or is empty — just remove the index entry
          removedFilenames.add(entry.filename);
          continue;
        }

        // Store in Claudex DB
        if (storeInClaudex(db, projectName, fileContent.content, fileContent.type)) {
          removedFilenames.add(entry.filename);
          result.entries_migrated++;

          // Delete the source file
          try { fs.unlinkSync(filePath); } catch { /* non-fatal */ }
        }
      }

      // Rewrite MEMORY.md without migrated entries
      if (removedFilenames.size > 0) {
        rewriteMemoryMd(memoryMdPath, content, removedFilenames);
        result.projects_with_migrations.push(projectName);
      }
    }
  } catch {
    // Non-throwing — monitoring failure should never break the heartbeat
  }

  return result;
}
