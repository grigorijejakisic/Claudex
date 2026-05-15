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
 *   ## Handoff          (one-line status summary + pointer to ACTIVE.md)
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
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { pathToCcSlug } from '../shared/cc-slug.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { resolveProjectPath } from '../shared/scope-detector.js';
import { recordEvent } from '../core/session-events.js';
import { listLessonsForProject } from './lesson-reader.js';
import { parseHandoffHeader } from './handoff-writer.js';

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

/** Phase 4.1 lesson section caps (CUR-09 / CUR-10). */
const MAX_LESSONS_FOREGROUND = 20;
const POINTER_LINE_MAX_CHARS = 140;

/** Active-projects activity window: 7 days in seconds. */
const ACTIVE_WINDOW_SECONDS = 7 * 86_400;

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
 *
 * Resolution chain:
 *   1. Try `resolveProjectPath(project)` — looks up the Claudex project
 *      registry (`~/.claudex/projects.json`) and, if necessary, scans the
 *      configured projects directory (CLAUDEX_PROJECTS_DIR, default
 *      `~/Projects/`) for a directory whose derived ID matches.
 *      If a filesystem path is returned, convert it to a CC slug via
 *      `pathToCcSlug` and build the `~/.claude/projects/<slug>/memory/MEMORY.md`
 *      path. This is the normal production path for Claudex project IDs like
 *      `claudex-v3` or `soak-test-p4b-1df6c0f2`.
 *   2. Fallback: if `resolveProjectPath` returns null (unregistered project or
 *      test fixture), apply the legacy heuristic — use `pathToCcSlug` only when
 *      `project` contains path separators or drive colons, otherwise use it
 *      verbatim. This preserves behaviour for path-shaped inputs (e.g. some
 *      older callers that pass a resolved FS path directly) and for test
 *      fixtures that deliberately do not register a project.
 */
export function computeMemoryMdPath(project: string): string {
  // First try to resolve as a Claudex project ID → filesystem path → CC slug
  const projectPath = resolveProjectPath(project);
  if (projectPath) {
    return path.join(os.homedir(), '.claude', 'projects', pathToCcSlug(projectPath), 'memory', 'MEMORY.md');
  }
  // Fallback: input might already be a path (e.g., test fixtures, edge cases)
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
       ORDER BY importance DESC, timestamp_epoch_ms DESC, id ASC
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
 * what's hot everywhere. Ties broken by most-recent touch, then project
 * ASC for determinism.
 */
export function renderActiveProjects(db: Database): string {
  const cutoffMs = Date.now() - ACTIVE_WINDOW_SECONDS * 1000;

  let rows: Array<{ project: string; activity_cnt: number; last_touched: number }> = [];
  try {
    rows = cachedPrepare(
      db,
      `SELECT project,
              COUNT(*) AS activity_cnt,
              MAX(updated_at_epoch_ms) AS last_touched
       FROM artifact
       WHERE updated_at_epoch_ms >= ?
         AND project IS NOT NULL
         AND project != ''
       GROUP BY project
       ORDER BY activity_cnt DESC, last_touched DESC, project ASC
       LIMIT ${MAX_ACTIVE_PROJECTS}`,
    ).all(cutoffMs) as typeof rows;
  } catch {
    rows = [];
  }

  const lines = ['## Active Projects'];
  if (rows.length === 0) {
    lines.push('');
  } else {
    for (const row of rows) {
      lines.push(`- ${row.project} — ${row.activity_cnt} edits in last 7d`);
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
         AND project = ?
         AND session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY MAX(created_at_epoch_ms) DESC
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
              MAX(created_at_epoch_ms) AS latest,
              MAX(session_id) AS session_id
       FROM artifact
       WHERE kind = 'transcript_chunk'
         AND project = ?
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
 * Render the `## Handoff` section from `context/handoffs/ACTIVE.md`.
 *
 * Phase 7.5: emits a one-line status summary derived from the YAML header,
 * never the body. Body lives in ACTIVE.md only — MEMORY.md is an index. If
 * ACTIVE.md is missing, malformed, or `status: archived`, the section is
 * `No active handoff.` Active and paused statuses each render one prose line
 * plus a `See:` pointer.
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

    const parsed = parseHandoffHeader(raw);
    if (!parsed) return header + 'No active handoff.\n';

    const phase = parsed.phase;
    const topic = parsed.topic ?? parsed.summary ?? 'unspecified';
    switch (parsed.status) {
      case 'active':
        return (
          header +
          `Active handoff at phase ${phase}: ${topic}.\nSee: context/handoffs/ACTIVE.md\n`
        );
      case 'paused':
        return (
          header +
          `Handoff paused at phase ${phase}.\nSee: context/handoffs/ACTIVE.md\n`
        );
      case 'archived':
      default:
        return header + 'No active handoff.\n';
    }
  } catch {
    return header + 'No active handoff.\n';
  }
}

/**
 * Phase 4.1 — Render the `## Lessons` section.
 *
 * Sources lesson files via lesson-reader.ts (filesystem-backed). Filters to
 * foreground-tier lessons (tier === 'foreground' OR tier undefined; default-
 * foreground for newly-written files without the field).
 *
 * Pointer line format (CUR-10):
 *   - [<salience>](filename) — task-pattern: <task_shape>
 *
 * Where:
 *   - <salience> = first non-blank body line, trimmed, with markdown
 *     heading/list markers stripped. Truncated to fit ≤ POINTER_LINE_MAX_CHARS
 *     total line length.
 *   - <filename> = lesson basename (e.g., feedback_check_deps.md).
 *   - <task_shape> = frontmatter.shape.task_shape, or 'unclassified' if
 *     shape was abstained (per CONTEXT.md abstain-allowed rule).
 *
 * Sort: foreground entries by `last_fired_at_epoch` DESC nulls last,
 * then `created_at_epoch_ms` DESC, then filename ASC.
 *
 * Cap: top 20 foreground entries (MAX_LESSONS_FOREGROUND). The heartbeat-
 * driven demotion (Plan 07) handles persistent demotion; this only
 * constrains the visible window.
 *
 * Empty state: header + 'No lessons captured yet.' line.
 */
export function renderLessons(project: string): string {
  const lessons = listLessonsForProject(project);
  const foreground = lessons.filter(l => (l.frontmatter.tier ?? 'foreground') === 'foreground');

  foreground.sort((a, b) => {
    const fa = a.frontmatter.last_fired_at_epoch ?? 0;
    const fb = b.frontmatter.last_fired_at_epoch ?? 0;
    if (fa !== fb) return fb - fa;
    const ca = a.frontmatter.created_at_epoch_ms;
    const cb = b.frontmatter.created_at_epoch_ms;
    if (ca !== cb) return cb - ca;
    return a.filename.localeCompare(b.filename);
  });

  const top = foreground.slice(0, MAX_LESSONS_FOREGROUND);

  const lines = ['## Lessons'];
  if (top.length === 0) {
    lines.push('');
    lines.push('No lessons captured yet.');
    return lines.join('\n') + '\n';
  }

  for (const lesson of top) {
    const taskShape = lesson.frontmatter.shape?.task_shape ?? 'unclassified';
    const salience = extractLessonSalience(lesson.body);
    const tail = `](${lesson.filename}) — task-pattern: ${taskShape}`;
    const head = '- [';
    const availableSalienceChars = Math.max(10, POINTER_LINE_MAX_CHARS - head.length - tail.length);
    const truncatedSalience = salience.length > availableSalienceChars
      ? salience.slice(0, availableSalienceChars - 1) + '…'
      : salience;
    lines.push(`${head}${truncatedSalience}${tail}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Extract a one-line salience headline from a lesson body.
 *
 * Rule: first non-blank line, with markdown heading/list markers stripped,
 * collapsed whitespace. If body starts with a `# Heading` line, prefer it
 * over a subsequent prose line — headings are typically the salience the
 * author intended.
 */
function extractLessonSalience(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const cleaned = trimmed.replace(/^#+\s+|^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0) return cleaned;
  }
  return '(no salience extracted)';
}

/**
 * Normalize a body string to make sentinel hashing stable across platforms
 * and editors. Contract:
 *   - CRLF → LF
 *   - strip trailing whitespace per line
 *   - collapse runs of ≥2 blank lines to a single blank line
 *   - ensure exactly one trailing `\n`
 */
export function normalize(text: string): string {
  let out = text.replace(/\r\n/g, '\n');
  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.replace(/\n+$/, '') + '\n';
  return out;
}

/**
 * Build the top sentinel line. `normalizedBody` must be the post-normalize
 * Angel-owned block (between sentinel line and `<!-- USER EDITABLE -->`).
 */
export function sentinelLine(normalizedBody: string): string {
  const hash = createHash('sha256').update(normalizedBody, 'utf8').digest('hex');
  return `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${hash} -->`;
}

/**
 * Parse a sentinel line and return the embedded sha256 hex hash, or null
 * if the line is missing, malformed, or carries a non-64-hex-char hash.
 */
export function parseSentinelHash(firstLine: string): string | null {
  const m = firstLine.match(/^<!-- CLAUDEX-MANAGED: .*? hash=([0-9a-f]{64}) -->$/);
  return m ? m[1] : null;
}

/**
 * Build a user-tail block wrapping legacy user-authored MEMORY.md content.
 *
 * Used at first-run migration when a project has hand-curated MEMORY.md
 * (e.g., Lacuna-Betting / Oracle / Nexus) WITHOUT the Angel sentinel. The
 * full file body becomes the body of `## User Notes`, prefixed by a fresh
 * `<!-- USER EDITABLE -->` marker. Subsequent writes go through the normal
 * sentinel-checked path because the marker is now present.
 *
 * Detection rule (caller's responsibility): pass a non-empty `existing`
 * string that has NEITHER the top sentinel NOR the `<!-- USER EDITABLE -->`
 * marker on its own line.
 *
 * Returns:
 *   - The wrapped string ready to be used as `userTail` in curateMemoryMd.
 *   - null if `existing` is whitespace-only (cold-start; caller should fall
 *     back to USER_TAIL_DEFAULT instead).
 *
 * Preservation contract: legacy content is preserved BYTE-FOR-BYTE inside
 * `## User Notes`. We do NOT rewrite list items, headings, or whitespace.
 * Idempotent re-runs (after migration) skip this branch entirely because
 * the marker now exists.
 */
export function wrapLegacyUserContent(existing: string): string | null {
  const normalized = existing.replace(/\r\n/g, '\n');
  if (normalized.replace(/\s/g, '').length === 0) return null;

  // Don't double-wrap if existing content already starts with (or contains
  // a top-level) `## User Notes` header — avoid creating nested User Notes.
  // We use a line-anchored regex (^|\n).
  const hasUserNotesHeader = /(^|\n)## User Notes\b/.test(normalized);
  const body = hasUserNotesHeader ? normalized : `## User Notes\n\n${normalized}`;
  // Ensure the wrapped body ends with a single newline.
  const normalizedBody = body.replace(/\n+$/, '') + '\n';
  return `<!-- USER EDITABLE -->\n\n${normalizedBody}`;
}

/**
 * Find the byte offset where the user tail begins, identified by a
 * `<!-- USER EDITABLE -->` line that occupies its OWN line (no surrounding
 * content on the same line).
 *
 * NOT `indexOf` — that matches the marker as substring inside body content
 * that happens to mention it (e.g., a User Notes block describing the marker
 * for documentation purposes). The substring match caused the duplicate-marker
 * regression at MEMORY.md line 38 (Phase 4.1 CUR-13 / Plan 03).
 *
 * Returns -1 if no line-anchored marker exists. The matcher is strict: trailing
 * whitespace on the marker line is rejected (lines must equal the marker
 * exactly, post-CRLF normalization).
 */
export function findUserTailStart(content: string): number {
  const marker = '<!-- USER EDITABLE -->';
  const normalized = content.replace(/\r\n/g, '\n');
  let offset = 0;
  for (const line of normalized.split('\n')) {
    if (line === marker) return offset;
    offset += line.length + 1; // +1 for the consumed \n
  }
  return -1;
}

/**
 * Record a refusal event in `session_events` so observers see when and why
 * Angel declined to write. Sessionless — uses a synthetic session_id.
 */
function recordRefusal(db: Database, project: string, filePath: string, reason: string): void {
  recordEvent(db, 'angel-memory-writer', project, 'memory_curation_refused', filePath, 'refuse', reason);
}

/**
 * Trim the Angel-owned body until it fits in maxBytes AND maxLines.
 *
 * Trim order: Recent Threads tail → Active Projects tail → Entities tail →
 * Handoff tail. Preamble and How-to-Query are never trimmed. If still over
 * after all three lists are emptied, truncate Entities to 3 entries as a
 * hard last resort (planner pragma in PLAN §Tasks/04-01-06).
 */
function enforceSizeCap(
  body: string,
  sections: { preamble: string; projects: string; lessons: string; handoff: string; howTo: string },
): string {
  const fits = (s: string): boolean =>
    Buffer.byteLength(s, 'utf8') <= MAX_BYTES && s.split('\n').length <= MAX_LINES;

  const rebuild = (): string =>
    normalize(
      [sections.preamble, sections.projects, sections.lessons, sections.handoff, sections.howTo]
        .filter(Boolean)
        .join('\n'),
    );

  if (fits(body)) return body;

  const trimTail = (section: string): string => {
    const lines = section.split('\n');
    // Keep header (first line) and drop the last `- ` line we find.
    for (let i = lines.length - 1; i > 0; i--) {
      if (lines[i].startsWith('- ')) {
        lines.splice(i, 1);
        return lines.join('\n');
      }
    }
    return section; // no `- ` rows left to trim
  };

  // Trim order (Phase 4.1 CUR-09 / CUR-10): lessons first (they grow most,
  // and demotion is a stronger signal than active-projects truncation),
  // then projects, then handoff.
  while (!fits(body) && /^- /m.test(sections.lessons)) {
    sections.lessons = trimTail(sections.lessons);
    body = rebuild();
  }
  while (!fits(body) && /^- /m.test(sections.projects)) {
    sections.projects = trimTail(sections.projects);
    body = rebuild();
  }
  while (!fits(body) && /^- /m.test(sections.handoff)) {
    sections.handoff = trimTail(sections.handoff);
    body = rebuild();
  }

  // No "last resort" entities truncation — entities removed in 4.1.

  return body;
}

/**
 * Orchestrates curation — gathers inputs, renders body, checks sentinel,
 * writes atomically. Always non-throwing; returns a structured result so
 * the Angel heartbeat can record metrics without needing exception-safety.
 */
export function curateMemoryMd(db: Database, project: string): CurationResult {
  let memoryMdPath = '';
  try {
    memoryMdPath = computeMemoryMdPath(project);
    if (!fs.existsSync(path.dirname(memoryMdPath))) {
      return { path: memoryMdPath, written: false, reason: 'no_project_dir' };
    }

    // Assemble Angel-owned sections (Phase 4.1 CUR-09 / CUR-10).
    // Drop ## Entities (frequency-extraction noise: entity:-, entity:--2--1)
    // and ## Recent Threads (50% session-IDs masquerading as topics) — these
    // were in pre-4.1 layout. Add ## Lessons (pointer-line index sourced
    // from lesson files in the project's memory directory).
    const sections = {
      preamble: renderPreamble(toSlug(project)),
      projects: renderActiveProjects(db),
      lessons: renderLessons(project),
      handoff: renderHandoff(project),
      howTo: HOW_TO_QUERY_STATIC,
    };

    let body = normalize(
      [sections.preamble, sections.projects, sections.lessons, sections.handoff, sections.howTo]
        .filter(Boolean)
        .join('\n'),
    );
    body = enforceSizeCap(body, sections);

    const sentinel = sentinelLine(body);

    // Read existing file (if any) to preserve user tail and detect refuse condition.
    const existing = fs.existsSync(memoryMdPath) ? fs.readFileSync(memoryMdPath, 'utf8') : '';

    let userTail = USER_TAIL_DEFAULT;
    // Line-anchored match: the marker must occupy its own line, NOT appear
    // as substring inside body content. See findUserTailStart docs and CUR-13
    // in the Phase 4.1 RESEARCH.md.
    //
    // `existing` may include a CRLF-mismatched copy from older writes; we
    // normalize to LF for offset arithmetic and for fast-path comparison
    // against `fullNew` (which is generated LF-only).
    const normalizedExisting = existing.replace(/\r\n/g, '\n');
    const markerIdx = findUserTailStart(normalizedExisting);

    if (markerIdx >= 0) {
      // Existing file already has the marker. Standard sentinel-checked path.
      userTail = normalizedExisting.slice(markerIdx);
      if (!userTail.endsWith('\n')) userTail += '\n';

      // Refuse if there's a user block but no valid sentinel on line 1.
      const firstLine = normalizedExisting.split('\n', 1)[0];
      if (!parseSentinelHash(firstLine)) {
        recordRefusal(db, project, memoryMdPath, 'sentinel_missing');
        return { path: memoryMdPath, written: false, reason: 'sentinel_missing' };
      }
    } else if (normalizedExisting.length > 0) {
      // Existing file has content but NO line-anchored marker — first-run
      // migration path (Lacuna/Oracle/Nexus pattern). Preserve content
      // verbatim under ## User Notes per CONTEXT.md migration policy
      // ("Never overwrite. Append above hash marker.").
      const firstLine = normalizedExisting.split('\n', 1)[0];
      if (parseSentinelHash(firstLine)) {
        // Top sentinel present but no marker — corrupt or partial-write
        // mid-state. Refuse rather than guess.
        recordRefusal(db, project, memoryMdPath, 'sentinel_invalid');
        return { path: memoryMdPath, written: false, reason: 'sentinel_invalid' };
      }
      const wrapped = wrapLegacyUserContent(normalizedExisting);
      if (wrapped) userTail = wrapped;
      // (else: file was effectively whitespace; fall back to USER_TAIL_DEFAULT.)
    }
    // Else: file is empty / does not exist; userTail stays at USER_TAIL_DEFAULT.

    const fullNew = `${sentinel}\n${body}\n${userTail}`;

    // Idempotency fast-path: bytes already match (LF-normalized for comparison
    // since fullNew is generated LF-only; user tails may carry CRLF from
    // Windows editors).
    if (normalizedExisting === fullNew) {
      const firstLine = normalizedExisting.split('\n', 1)[0];
      return {
        path: memoryMdPath,
        written: false,
        reason: 'idempotent_noop',
        bytes: Buffer.byteLength(existing, 'utf8'),
        lines: existing.split('\n').length,
        hash: parseSentinelHash(firstLine) ?? undefined,
      };
    }

    // Atomic write: tmp → rename, with one Windows-lock retry.
    const tmp = memoryMdPath + '.tmp';
    try {
      fs.writeFileSync(tmp, fullNew, 'utf8');
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { path: memoryMdPath, written: false, reason: 'write_io_error' };
    }
    try {
      fs.renameSync(tmp, memoryMdPath);
    } catch {
      // Windows: rename can race a file lock (AV scan, editor watch). Retry once.
      const start = Date.now();
      while (Date.now() - start < 50) { /* busy-wait 50ms, no async here */ }
      try {
        fs.renameSync(tmp, memoryMdPath);
      } catch {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return { path: memoryMdPath, written: false, reason: 'write_io_error' };
      }
    }

    return {
      path: memoryMdPath,
      written: true,
      reason: 'wrote',
      bytes: Buffer.byteLength(fullNew, 'utf8'),
      lines: fullNew.split('\n').length,
      hash: parseSentinelHash(sentinel) ?? undefined,
    };
  } catch {
    return { path: memoryMdPath, written: false, reason: 'write_io_error' };
  }
}
