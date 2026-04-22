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
import { cachedPrepare } from '../core/stmt-cache.js';
import { resolveProjectPath } from '../shared/scope-detector.js';

/** Hard ceiling for Angel-owned content portion of MEMORY.md. */
export const MAX_BYTES = 25_000;
export const MAX_LINES = 200;

/** Max preamble lines rendered above `## Entities`. */
const MAX_PREAMBLE_LINES = 5;

/** Max bytes to sniff per user-memory sibling file (frontmatter only). */
const MAX_FRONTMATTER_SNIFF_BYTES = 1024;

/** Section caps. */
const MAX_ENTITIES = 15;
const MAX_ACTIVE_PROJECTS = 5;
const MAX_RECENT_THREADS = 5;
const RECENT_SESSIONS_WINDOW = 10;

/** Active-projects activity window: 7 days in seconds. */
const ACTIVE_WINDOW_SECONDS = 7 * 86_400;

/** Max distilled lines in the `## Handoff` section body (excludes header + `See:`). */
const MAX_HANDOFF_LINES = 10;

/** Static footer body — this block is byte-stable and drives idempotency. */
export const HOW_TO_QUERY_STATIC = `## How to Query

- claudex_search("topic") — decisions, learnings, prior sessions
- claudex_events — latest session history
- claudex_recall(id|path) — fetch a specific artifact

See ~/.claude/CLAUDE.md for Claudex tool reference.
`;

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
 * Render the `## Entities` section — top-N entity summaries for the project,
 * ranked by `importance DESC, timestamp_epoch DESC, id ASC`.
 *
 * Reads the legacy `artifacts` table (`artifact_type='entity_summary'`).
 * Per RESEARCH §2: `entity_summary` rows have NOT migrated to V17, so the
 * `importance` column still lives on `artifacts`, not on `artifact`. The
 * `id ASC` final tiebreaker guarantees deterministic ordering when two
 * entities share the same importance + timestamp.
 *
 * Cold-start (no matching rows) → header + blank line, for shape stability.
 */
export function renderEntities(db: Database, project: string): string {
  let rows: Array<{ artifact_ref: string | null; summary: string }> = [];
  try {
    rows = cachedPrepare(
      db,
      `SELECT artifact_ref, summary
       FROM artifacts
       WHERE artifact_type = 'entity_summary'
         AND project = ?
         AND state IN ('packed','fresh','materialized')
       ORDER BY importance DESC, timestamp_epoch DESC, id ASC
       LIMIT ${MAX_ENTITIES}`,
    ).all(project) as typeof rows;
  } catch {
    rows = [];
  }

  const lines = ['## Entities'];
  if (rows.length === 0) {
    lines.push('');
  } else {
    for (const row of rows) {
      const ref = (row.artifact_ref ?? 'entity').toString();
      const summary = (row.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      lines.push(`- ${ref} — ${summary}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the `## Active Projects` section — up to 5 projects with activity
 * in the last 7 days, ranked by activity count DESC.
 *
 * Reads the V17 `artifact` table. Dashboard style: the section is
 * cross-project by design — MEMORY.md is per-project but this list shows
 * what's hot everywhere. Ties broken by most-recent touch, then project_id
 * ASC for determinism.
 */
export function renderActiveProjects(db: Database): string {
  const cutoff = Math.floor(Date.now() / 1000) - ACTIVE_WINDOW_SECONDS;

  let rows: Array<{ project_id: string; activity_cnt: number; last_touched: number }> = [];
  try {
    rows = cachedPrepare(
      db,
      `SELECT project_id,
              COUNT(*) AS activity_cnt,
              MAX(updated_at_epoch) AS last_touched
       FROM artifact
       WHERE updated_at_epoch >= ?
         AND project_id IS NOT NULL
         AND project_id != ''
       GROUP BY project_id
       ORDER BY activity_cnt DESC, last_touched DESC, project_id ASC
       LIMIT ${MAX_ACTIVE_PROJECTS}`,
    ).all(cutoff) as typeof rows;
  } catch {
    rows = [];
  }

  const lines = ['## Active Projects'];
  if (rows.length === 0) {
    lines.push('');
  } else {
    for (const row of rows) {
      lines.push(`- ${row.project_id} — ${row.activity_cnt} edits in last 7d`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the `## Recent Threads` section — up to 5 deduplicated topic_labels
 * from the most recent 10 sessions' `transcript_chunk` artifacts.
 *
 * Two-step resolution (avoids relying on SQLite window-function edge cases):
 *   1. Find the 10 most-recent sessions by MAX(created_at_epoch) of their
 *      transcript_chunk rows for this project.
 *   2. Within that set, group by topic_label → latest chunk time, order
 *      DESC, break ties by session_id ASC then topic_label ASC, take 5.
 *
 * Cold-start (no transcript_chunk rows yet) → header + blank line.
 */
export function renderRecentThreads(db: Database, project: string): string {
  const lines = ['## Recent Threads'];
  let candidates: Array<{ topic_label: string; latest: number; session_id: string }> = [];

  try {
    const sessionRows = cachedPrepare(
      db,
      `SELECT session_id
       FROM artifact
       WHERE kind = 'transcript_chunk'
         AND project_id = ?
         AND session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY MAX(created_at_epoch) DESC
       LIMIT ${RECENT_SESSIONS_WINDOW}`,
    ).all(project) as Array<{ session_id: string }>;

    if (sessionRows.length === 0) {
      lines.push('');
      return lines.join('\n') + '\n';
    }

    const placeholders = sessionRows.map(() => '?').join(',');
    const params = [project, ...sessionRows.map((r) => r.session_id)];

    candidates = cachedPrepare(
      db,
      `SELECT json_extract(data, '$.topic_label') AS topic_label,
              MAX(created_at_epoch) AS latest,
              MAX(session_id) AS session_id
       FROM artifact
       WHERE kind = 'transcript_chunk'
         AND project_id = ?
         AND session_id IN (${placeholders})
         AND json_extract(data, '$.topic_label') IS NOT NULL
       GROUP BY json_extract(data, '$.topic_label')
       ORDER BY latest DESC, session_id ASC, topic_label ASC
       LIMIT ${MAX_RECENT_THREADS}`,
    ).all(...params) as typeof candidates;
  } catch {
    candidates = [];
  }

  if (candidates.length === 0) {
    lines.push('');
    return lines.join('\n') + '\n';
  }

  for (const row of candidates) {
    const label = (row.topic_label ?? '').toString().trim() || 'untitled';
    const sidShort = (row.session_id ?? '').toString().slice(0, 8);
    lines.push(`- ${label} — session ${sidShort}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Distill an ACTIVE.md body into up to 10 lines drawn from the
 * `## Commander's Intent` and `## What's Left To Do` blocks.
 *
 * Extraction: after splitting on `^## ` headers, take the body between
 * `## Commander's Intent` and the next `## ` header, then the body under
 * `## What's Left To Do`. Concatenate, drop empty lines, cap at 10 total
 * lines (never mid-line).
 */
function distillHandoffBody(raw: string): string[] {
  // Normalize CRLF first — some editors on Windows save CRLF and we want
  // deterministic line splitting here, independent of the top-level normalize.
  const text = raw.replace(/\r\n/g, '\n');
  const sections = new Map<string, string[]>();
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  for (const line of text.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headerMatch) {
      if (currentHeader) sections.set(currentHeader.toLowerCase(), currentLines);
      currentHeader = headerMatch[1];
      currentLines = [];
      continue;
    }
    if (currentHeader) currentLines.push(line);
  }
  if (currentHeader) sections.set(currentHeader.toLowerCase(), currentLines);

  const out: string[] = [];
  const pushBlock = (key: string) => {
    const block = sections.get(key);
    if (!block) return;
    for (const line of block) {
      if (out.length >= MAX_HANDOFF_LINES) break;
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed.length === 0) continue;
      out.push(trimmed);
    }
  };

  // Find Commander's Intent variants (typographic apostrophes included).
  for (const key of sections.keys()) {
    if (/^commander.?s?\s+intent$/i.test(key.replace(/’/g, "'"))) {
      pushBlock(key);
      break;
    }
  }
  for (const key of sections.keys()) {
    if (/^what.?s?\s+left\s+to\s+do$/i.test(key.replace(/’/g, "'"))) {
      pushBlock(key);
      break;
    }
  }

  return out;
}

/**
 * Render the `## Handoff` section from `context/handoffs/ACTIVE.md`.
 *
 * Missing file → single-line `No active handoff.` under the header — keeps
 * file shape stable so idempotency tests don't flake on a missing handoff.
 */
export function renderHandoff(project: string): string {
  const header = '## Handoff\n\n';
  try {
    const projectPath = resolveProjectPath(project);
    if (!projectPath) return header + 'No active handoff.\n';

    const handoffPath = path.join(projectPath, 'context', 'handoffs', 'ACTIVE.md');
    if (!fs.existsSync(handoffPath)) return header + 'No active handoff.\n';

    let raw: string;
    try {
      raw = fs.readFileSync(handoffPath, 'utf8');
    } catch {
      return header + 'No active handoff.\n';
    }

    const distilled = distillHandoffBody(raw);
    if (distilled.length === 0) return header + 'No active handoff.\n';

    return header + distilled.join('\n') + '\nSee: context/handoffs/ACTIVE.md\n';
  } catch {
    return header + 'No active handoff.\n';
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
