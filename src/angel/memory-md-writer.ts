/**
 * Angel MEMORY.md writer — sectioned, sentinel-guarded, idempotent curator.
 *
 * Writes `~/.claude/projects/<slug>/memory/MEMORY.md` as a fixed-shape index
 * of the user's working state:
 *
 *   <sentinel hash>
 *   <preamble: universal user memories, ≤5 lines>
 *
 *   ## Entities         (≤15 from legacy `artifacts.entity_summary`)
 *   ## Active Projects  (≤5 over 7-day V17 activity window)
 *   ## Recent Threads   (≤5 deduped transcript_chunk topic_labels)
 *   ## Handoff          (≤10 distilled lines from ACTIVE.md + pointer)
 *   ## How to Query     (static stock text)
 *
 *   <!-- USER EDITABLE -->
 *
 *   ## User Notes       (preserved byte-for-byte)
 *
 * Refuses to write if the top sentinel was stripped off a previously-curated
 * file (fail-loud at the boundary). Idempotent: given identical inputs the
 * writer produces byte-identical output and short-circuits the write.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { pathToCcSlug } from '../shared/cc-slug.js';

/** Hard ceiling for Angel-owned content portion of MEMORY.md. */
export const MAX_BYTES = 25_000;
export const MAX_LINES = 200;

/** Max preamble lines rendered above `## Entities`. */
const MAX_PREAMBLE_LINES = 5;

/** Max bytes to sniff per user-memory sibling file (frontmatter only). */
const MAX_FRONTMATTER_SNIFF_BYTES = 1024;

/** Cold-start user-tail template. */
export const USER_TAIL_DEFAULT = '<!-- USER EDITABLE -->\n\n## User Notes\n\n';

export interface CurationResult {
  path: string;
  written: boolean;
  reason:
    | 'wrote'
    | 'idempotent_noop'
    | 'sentinel_missing'
    | 'sentinel_invalid'
    | 'write_io_error'
    | 'no_project_dir';
  bytes?: number;
  lines?: number;
  hash?: string;
}

/**
 * Compute the target MEMORY.md path for a given project identifier.
 * `project` may already be a resolved filesystem path (slugged) or a logical
 * project ID — we only translate through `pathToCcSlug` when it looks like a
 * full path (contains separators or drive colons).
 */
export function computeMemoryMdPath(project: string): string {
  const slug = /[\\/:]/.test(project) ? pathToCcSlug(project) : project;
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md');
}

/** Convert a project identifier to its CC slug form. */
export function toSlug(project: string): string {
  return /[\\/:]/.test(project) ? pathToCcSlug(project) : project;
}

/**
 * Render the preamble block: up to 5 lines of universal-user-memory
 * descriptions, drawn from sibling `*.md` files in the same CC memory dir.
 *
 * Scans `~/.claude/projects/<slug>/memory/*.md` (excluding `MEMORY.md`
 * itself), reads the first 1KB of each file, parses YAML frontmatter,
 * keeps only `type: user` files, and renders each as `- <description>`
 * where `<description>` comes from the frontmatter `description:` field or
 * falls back to the filename stem.
 *
 * Returns an empty string if no user-memory files match — in that case
 * `## Entities` starts at the top of the Angel-owned body.
 */
export function renderPreamble(slug: string): string {
  try {
    const memDir = path.join(os.homedir(), '.claude', 'projects', slug, 'memory');
    if (!fs.existsSync(memDir)) return '';

    let entries: string[];
    try {
      entries = fs.readdirSync(memDir);
    } catch {
      return '';
    }

    const candidates = entries
      .filter((name) => name.toLowerCase().endsWith('.md') && name !== 'MEMORY.md')
      .sort(); // filename ASC for deterministic ordering

    const lines: string[] = [];
    for (const name of candidates) {
      if (lines.length >= MAX_PREAMBLE_LINES) break;

      const filePath = path.join(memDir, name);
      let raw: string;
      try {
        // Read up to 1KB — frontmatter is always small, body is irrelevant here.
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(MAX_FRONTMATTER_SNIFF_BYTES);
        const n = fs.readSync(fd, buf, 0, MAX_FRONTMATTER_SNIFF_BYTES, 0);
        fs.closeSync(fd);
        raw = buf.slice(0, n).toString('utf8');
      } catch {
        continue;
      }

      if (!raw.startsWith('---')) continue;
      const endIdx = raw.indexOf('---', 3);
      if (endIdx < 0) continue;
      const frontmatter = raw.slice(3, endIdx);

      // `type: user` filter (word-boundary to avoid matching e.g. "user_x")
      if (!/\btype:\s*user\b/i.test(frontmatter)) continue;

      const descMatch = frontmatter.match(/^\s*description:\s*(.+?)\s*$/im);
      const description = descMatch
        ? descMatch[1].trim().replace(/^["']|["']$/g, '')
        : name.replace(/\.md$/i, '');

      lines.push(`- ${description}`);
    }

    if (lines.length === 0) return '';

    // Trailing blank line separates preamble from `## Entities`.
    return lines.join('\n') + '\n\n';
  } catch {
    return '';
  }
}

/**
 * Orchestrates curation — gathers inputs, renders body, checks sentinel,
 * writes atomically. Always non-throwing; returns a structured result so the
 * Angel heartbeat can record metrics without needing exception-safety.
 *
 * This scaffold implementation lands in 04-01-01. Tasks 04-01-02 through
 * 04-01-06 fill in the renderers, normalization, sentinel logic, refuse
 * path, idempotency fast-path, and atomic write.
 */
export function curateMemoryMd(db: Database, project: string): CurationResult {
  // Reference `db` to prevent a no-unused-vars diagnostic during scaffolding.
  void db;
  try {
    const memoryMdPath = computeMemoryMdPath(project);
    if (!fs.existsSync(path.dirname(memoryMdPath))) {
      return { path: memoryMdPath, written: false, reason: 'no_project_dir' };
    }
    return { path: memoryMdPath, written: false, reason: 'idempotent_noop' };
  } catch {
    return { path: '', written: false, reason: 'write_io_error' };
  }
}
