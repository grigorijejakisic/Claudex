/**
 * Phase 4.1 lesson file writer.
 *
 * Writes lesson markdown files atomically (tmp + rename) under
 * ~/.claude/projects/<cc-slug>/memory/{feedback,project,process}_<slug>.md.
 *
 * Validates input strictly:
 *   - Telemetry handles required (CONTEXT.md lock — abstaining on telemetry
 *     is NOT allowed; abstaining is only permitted on shape).
 *   - Body must be non-empty after trim.
 *   - Slug must match SLUG_RE.
 *   - created_at_epoch_ms must be ms-precision (>= 1e12).
 *
 * Idempotent on byte-identical content (skips rewrite if existing matches).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { pathToCcSlug } from '../shared/cc-slug.js';
import { resolveProjectPath } from '../shared/scope-detector.js';
import { parseLessonFile } from './lesson-reader.js';
import { ensurePointerId } from './pointer-recall.js';
import { classifyTaskPattern, writeTaskPattern } from './task-pattern-classifier.js';
import type { LessonWriteParams, LessonType, LessonFrontmatter } from './lesson-types.js';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

/**
 * Compute absolute path for a lesson file:
 *   ~/.claude/projects/<slug>/memory/<type>_<slug>.md
 *
 * Mirrors computeMemoryMdPath from memory-md-writer.ts (resolveProjectPath
 * fallback chain), but lands at a per-lesson file rather than MEMORY.md.
 */
export function computeLessonFilePath(project: string, type: LessonType, slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid lesson slug: ${slug} — must match ${SLUG_RE}`);
  }
  const projectPath = resolveProjectPath(project);
  const ccSlug = projectPath
    ? pathToCcSlug(projectPath)
    : (/[\\/:]/.test(project) ? pathToCcSlug(project) : project);
  return path.join(os.homedir(), '.claude', 'projects', ccSlug, 'memory', `${type}_${slug}.md`);
}

/**
 * Render lesson frontmatter as YAML. Bounded vocabulary shape fields are
 * emitted only when populated (abstain-allowed per CONTEXT.md).
 *
 * Preserves the readable formatting from the CONTEXT.md schema example:
 *   - top-level `type:` and `created_at_epoch_ms:` fields
 *   - nested `telemetry:` block with explicit array notation
 *   - optional `shape:` block (omitted entirely if absent or all undefined)
 *
 * Confidence comments are NOT auto-rendered; they're metadata that the
 * proposer/curator may add manually.
 */
export function renderLessonFrontmatter(
  type: LessonType,
  frontmatter: Omit<LessonFrontmatter, 'type'>,
): string {
  const lines: string[] = ['---'];
  lines.push(`type: ${type}`);
  lines.push(`created_at_epoch_ms: ${frontmatter.created_at_epoch_ms}`);

  // telemetry block (always present)
  const t = frontmatter.telemetry;
  lines.push('telemetry:');
  lines.push(`  tools_used: [${t.tools_used.map(quoteIfNeeded).join(', ')}]`);
  lines.push(`  files_touched: [${t.files_touched.map(quoteIfNeeded).join(', ')}]`);
  lines.push(`  errors_encountered: [${t.errors_encountered.map(quoteIfNeeded).join(', ')}]`);
  lines.push(`  user_framing_tokens: [${t.user_framing_tokens.map(quoteIfNeeded).join(', ')}]`);
  lines.push(`  session_arc: [${t.session_arc.map(quoteIfNeeded).join(', ')}]`);
  lines.push(`  duration_min: ${t.duration_min}`);
  lines.push(`  correction_count: ${t.correction_count}`);
  if (t.triggered_by && t.triggered_by.length > 0) {
    lines.push(`  triggered_by: [${t.triggered_by.map(quoteIfNeeded).join(', ')}]`);
  }

  // shape block (optional; emitted only if any field set)
  if (frontmatter.shape) {
    const s = frontmatter.shape;
    const present = [s.task_shape, s.failure_mode, s.solution_pattern].some(v => v != null);
    if (present) {
      lines.push('shape:');
      if (s.task_shape) lines.push(`  task_shape: ${s.task_shape}`);
      if (s.failure_mode) lines.push(`  failure_mode: ${s.failure_mode}`);
      if (s.solution_pattern) lines.push(`  solution_pattern: ${s.solution_pattern}`);
    }
  }

  // tier tracking (optional but recorded if set)
  if (frontmatter.tier) lines.push(`tier: ${frontmatter.tier}`);
  if (frontmatter.last_fired_at_epoch != null) {
    lines.push(`last_fired_at_epoch: ${frontmatter.last_fired_at_epoch}`);
  }

  lines.push('---');
  return lines.join('\n') + '\n';
}

function quoteIfNeeded(s: string): string {
  // YAML inline list: quote if value contains commas, brackets, colons, or
  // starts with a special character. Keep simple values bare.
  if (/^[a-zA-Z0-9_./*-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Write a lesson file atomically (tmp → rename). Idempotent on identical
 * content (no rewrite if existing matches).
 *
 * Returns absolute path. Throws on validation failure or IO error.
 */
export function writeLesson(params: LessonWriteParams): string {
  if (params.body.trim().length === 0) {
    throw new Error('Lesson body cannot be empty');
  }
  const t = params.frontmatter.telemetry;
  if (
    !Array.isArray(t.tools_used)
    || !Array.isArray(t.files_touched)
    || !Array.isArray(t.errors_encountered)
    || !Array.isArray(t.user_framing_tokens)
    || !Array.isArray(t.session_arc)
  ) {
    throw new Error('Telemetry handles incomplete — all five array fields required');
  }
  if (typeof t.duration_min !== 'number' || typeof t.correction_count !== 'number') {
    throw new Error('Telemetry duration_min and correction_count must be numbers');
  }
  if (
    typeof params.frontmatter.created_at_epoch_ms !== 'number'
    || params.frontmatter.created_at_epoch_ms < 1e12
  ) {
    throw new Error('created_at_epoch_ms must be ms-precision (>= 1e12)');
  }

  const filePath = computeLessonFilePath(params.project, params.type, params.slug);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const frontmatter = renderLessonFrontmatter(params.type, params.frontmatter);
  const content = `${frontmatter}\n${params.body.trim()}\n`;

  // Idempotent: skip rewrite if content matches existing file byte-for-byte.
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing === content) return filePath;
  }

  // Atomic write (tmp + rename, with one Windows-lock retry — same pattern
  // as memory-md-writer.ts:609-628).
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    const start = Date.now();
    while (Date.now() - start < 50) { /* busy-wait for Windows AV/editor unlock */ }
    fs.renameSync(tmp, filePath);
  }
  return filePath;
}

/**
 * Phase 6.5 — write a lesson AND populate its task_pattern fingerprint.
 *
 * Lessons are filesystem-keyed (not direct artifact rows), so the
 * artifact_task_pattern row is keyed by the V19 lesson_pointer.id. Plan 02
 * candidate queries will JOIN through both artifacts and lesson_pointer.
 *
 * Failures in pointer registration or classifier writes are swallowed —
 * lesson write itself is higher priority than fingerprint coverage.
 */
export function writeLessonWithTaskPattern(
  db: Database,
  params: LessonWriteParams,
): string {
  const filePath = writeLesson(params);

  // Phase 6.5: classify and persist task_pattern fingerprint.
  try {
    const filename = path.basename(filePath);
    const pointerId = ensurePointerId(db, params.project, filename, 'lesson');
    const result = classifyTaskPattern(
      db,
      params.frontmatter.telemetry,
      params.frontmatter.shape,
      'write_time',
    );
    if (result.task_pattern) {
      writeTaskPattern(db, pointerId, result);
    }
  } catch { /* non-fatal — lesson is the source of truth, fingerprint is metadata */ }

  return filePath;
}

/**
 * Phase 5.5 — Update only the frontmatter of an existing lesson file. Body
 * is preserved BYTE-FOR-BYTE (we re-emit the exact bytes parseLessonFile
 * recovers, which retains the post-`---` body verbatim).
 *
 * Atomic via tmp + rename, same pattern as writeLesson.
 *
 * `partial` is shallow-merged into the parsed frontmatter. Nested objects
 * (telemetry, shape) require the caller to pass a complete replacement
 * sub-object — partial nested merge is intentionally out of scope.
 *
 * Idempotent: if the merged frontmatter is byte-identical to the existing
 * frontmatter, no write happens (no mtime churn).
 *
 * Throws if the file doesn't exist or fails to parse as a valid lesson.
 */
export function updateLessonFrontmatter(
  filePath: string,
  partial: Partial<LessonFrontmatter>,
): void {
  const parsed = parseLessonFile(filePath);
  if (!parsed) {
    throw new Error(`updateLessonFrontmatter: failed to parse lesson at ${filePath}`);
  }
  const merged: LessonFrontmatter = { ...parsed.frontmatter, ...partial };

  // renderLessonFrontmatter emits its own `---` delimiters (open and close).
  // The body parsed by lesson-reader has the leading `\n` stripped (^\n+),
  // so we restore exactly one separator newline before re-attaching it.
  const newFrontmatter = renderLessonFrontmatter(merged.type, merged);
  const newContent = `${newFrontmatter}\n${parsed.body}`;

  // Idempotency: skip write if no-op.
  let existing: string | null = null;
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch { /* fall through */ }
  if (existing === newContent) return;

  // Atomic tmp + rename (mirror writeLesson, including the Windows-lock retry).
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, newContent, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    const start = Date.now();
    while (Date.now() - start < 50) { /* busy-wait for Windows AV/editor unlock */ }
    fs.renameSync(tmp, filePath);
  }
}
