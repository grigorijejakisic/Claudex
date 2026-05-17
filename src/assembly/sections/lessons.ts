/**
 * Lesson-related section formatters for the assembly pipeline.
 *
 * Owns: formatProvenPrinciplesSection, formatLearningsSection.
 *
 * Wave 3 (14-07h, 14-07j) adds to this file:
 *   - 14-07h rewrites formatProvenPrinciplesSection to use trigger-style frontmatter.
 *   - 14-07j extends the lessons section with link-aware inline-expansion.
 *
 * All functions are pure, non-throwing (return null on error), and
 * take pre-fetched data.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import type { ExperiencePattern } from '../../intelligence/experience-patterns.js';
import type { LearningRow } from '../../core/learnings.js';
import { estimateTokens } from '../../shared/text-utils.js';
import {
  selectTopKLessons,
  readLessonTrigger,
  DEFAULT_TOP_K as LESSON_RELEVANCE_DEFAULT_TOP_K,
} from '../../intelligence/lesson-relevance.js';

// Re-export for documentation purposes only (actual default handling is in lesson-relevance.ts).
const _DEFAULT_TOP_K_DOC = LESSON_RELEVANCE_DEFAULT_TOP_K; void _DEFAULT_TOP_K_DOC;

/**
 * Priority 4.1: Proven principles — proactive injection of established learnings.
 * Unlike experience warnings (keyword-matched per turn), these are injected
 * unconditionally at session start. They represent the accumulated wisdom that
 * every agent should know, regardless of what the current prompt is about.
 */
export function formatProvenPrinciplesSection(patterns: ExperiencePattern[]): string | null {
  if (!patterns || patterns.length === 0) return null;

  let inner = '## Proven Principles\nThe following are patterns extracted from prior sessions across this project. Each entry pairs a recurring context with the lesson that emerged.\n\n';

  for (const p of patterns) {
    inner += `- **${p.trigger_context}**: ${p.lesson}\n`;
  }

  return inner.trimEnd();
}

/**
 * Cross-session learnings — knowledge distilled from past sessions.
 * Ordered by promotion count (most reinforced first). Max 5.
 */
export function formatLearningsSection(learnings: LearningRow[]): string | null {
  try {
    if (!learnings || learnings.length === 0) return null;

    const lines: string[] = [
      '## Learnings',
      '[Cross-session knowledge — distilled from past experience]',
      '',
    ];

    for (const l of learnings.slice(0, 5)) {
      const promoted = l.promotion_count > 1 ? ` (×${l.promotion_count})` : '';
      lines.push(`- ${l.content}${promoted}`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

// ─── 14-07h: lessons section formatter (J extends post-merge for inline-expansion) ──────────

/** Lesson filename pattern (mirrors lesson-reader.ts, includes reference/user files). */
const LESSON_FILENAME_RE = /^(feedback|project|process|reference|user)_([a-z0-9][a-z0-9_-]{0,59})\.md$/;

/** Max chars for trigger display before truncation (14-07h). */
const TRIGGER_MAX_CHARS = 120;

/** Max chars for truncated-body fallback display (14-07h). */
const BODY_FALLBACK_MAX_CHARS = 60;

/**
 * Phase 14-07h — lessons section formatter from memory_dir scan.
 *
 * Renders the lessons pointer list at session-start. For each lesson
 * file, reads the `trigger:` frontmatter if present and uses it as
 * the display title. Falls back to truncated-body for lessons without trigger.
 *
 * Sort: mtime DESC, tiebreak by filename ASC.
 * Budget cap: cuts list when budget reached; appends "... and N more lessons available".
 * Returns null when no lesson files found in memory_dir.
 *
 * 14-07j extends this via formatLessonsWithInlineExpansion (post-merge).
 * H ships this function first; J adds inline-expansion as additional behavior.
 * // 14-07h: lessons section formatter (J extends post-merge for inline-expansion)
 */
export function formatLessonsSectionFromDir(params: {
  db: Database;
  project: string;
  memory_dir: string;
  budget_tokens: number;
}): string | null {
  try {
    if (!fs.existsSync(params.memory_dir)) return null;

    const entries = fs.readdirSync(params.memory_dir);
    const lessonFiles = entries.filter(name => LESSON_FILENAME_RE.test(name));

    if (lessonFiles.length === 0) return null;

    // Sort by mtime DESC, tiebreak filename ASC.
    const withMtime = lessonFiles.map(name => {
      const filePath = path.join(params.memory_dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
      return { name, filePath, mtime };
    });
    withMtime.sort((a, b) => {
      if (b.mtime !== a.mtime) return b.mtime - a.mtime;
      return a.name.localeCompare(b.name);
    });

    const lines: string[] = ['## Lessons'];
    const TOKEN_ESTIMATE_PER_LINE = 20;
    let tokenBudgetUsed = TOKEN_ESTIMATE_PER_LINE; // header line budget
    let skipped = 0;

    for (const { name, filePath } of withMtime) {
      const trigger = readLessonTrigger(filePath);

      let display: string;
      if (trigger && trigger.length > 0) {
        display = trigger.length > TRIGGER_MAX_CHARS
          ? trigger.slice(0, TRIGGER_MAX_CHARS - 1) + '…'
          : trigger;
      } else {
        // Fallback: read body and extract first meaningful line.
        let bodyText = '';
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const normalized = raw.replace(/\r\n/g, '\n');
          const endFm = normalized.indexOf('\n---\n', 4);
          if (endFm >= 0) {
            bodyText = normalized.slice(endFm + 5).replace(/^\n+/, '');
          }
        } catch { /* ignore */ }

        let firstLine = '(no content)';
        for (const line of bodyText.split('\n')) {
          const trimmed = line.trim().replace(/^#+\s+|^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
          if (trimmed.length > 0) { firstLine = trimmed; break; }
        }
        display = firstLine.length > BODY_FALLBACK_MAX_CHARS
          ? firstLine.slice(0, BODY_FALLBACK_MAX_CHARS - 1) + '…'
          : firstLine;
      }

      const lineStr = `- [${display}](${name})`;
      const lineTokens = Math.ceil(lineStr.length / 4) + 2;

      if (tokenBudgetUsed + lineTokens > params.budget_tokens) {
        skipped++;
        continue;
      }

      lines.push(lineStr);
      tokenBudgetUsed += lineTokens;
    }

    if (skipped > 0) {
      lines.push(`... and ${skipped} more lessons available`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

// ─── 14-07j: Link-aware inline-expansion of top-K lessons ─────────────────────

/**
 * Token budget (total) across all inline-expanded lessons in the section.
 * Locked per 14-07-CONTEXT: 400 tokens total, ~130 per lesson.
 */
export const INLINE_EXPANSION_BUDGET_TOKENS = 400;

/** Per-lesson body token cap before truncation with ellipsis. */
export const PER_LESSON_BODY_TOKEN_CAP = 130;

/**
 * Parameters for the inline-expansion-aware lessons section.
 *
 * Extends H's formatProvenPrinciplesSection with the fields needed for
 * link-aware inline-expansion. All new fields are optional — absent params
 * degrade gracefully to H's baseline pointer-list rendering.
 */
export interface LessonsSectionParams {
  db: Database;
  project: string;
  memory_dir: string;
  budget_tokens: number;
  // 14-07j: inline-expansion fields
  pivot_text?: string;
  pivot_artifact_ids?: string[];
  /** Number of top lessons to inline. Default DEFAULT_TOP_K (3), capped at MAX_TOP_K (5). */
  inline_top_k?: number;
}

/**
 * Read the body of a lesson file (post-frontmatter content).
 * Returns null if unreadable or empty.
 */
function readLessonBodyLocal(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n')) return null;
    const endIdx = normalized.indexOf('\n---\n', 4);
    if (endIdx < 0) return null;
    const body = normalized.slice(endIdx + 5).replace(/^\n+/, '');
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

/**
 * Truncate a string to approximately `max_tokens` tokens (chars/4),
 * appending `…` if truncated. Tries to break at a sentence boundary
 * (period + space) if one exists within the last 20% of the budget.
 */
function truncateToTokenBudget(text: string, max_tokens: number): string {
  const maxChars = max_tokens * 4;
  if (text.length <= maxChars) return text;

  // Try to find a sentence boundary in the last 20% of the budget
  const searchFrom = Math.floor(maxChars * 0.8);
  const periodIdx = text.indexOf('. ', searchFrom);
  if (periodIdx !== -1 && periodIdx < maxChars) {
    return text.slice(0, periodIdx + 1) + '…';
  }

  // Fall back to hard truncation at word boundary
  const hardSlice = text.slice(0, maxChars);
  const lastSpace = hardSlice.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.6) {
    return hardSlice.slice(0, lastSpace) + '…';
  }
  return hardSlice + '…';
}

/**
 * Format a single inline-expanded lesson block.
 *
 * Format:
 *   ### [<trigger>]
 *   <truncated lesson body, ~130 tokens>
 *   *Source: <filename>*
 *
 * The trigger is the `trigger:` frontmatter field; falls back to the filename
 * basename (sans extension) when no trigger is present.
 */
export function inlineExpandLesson(filePath: string, body_token_cap: number = PER_LESSON_BODY_TOKEN_CAP): string | null {
  try {
    const trigger = readLessonTrigger(filePath) ?? path.basename(filePath, '.md');
    const body = readLessonBodyLocal(filePath);
    if (!body) return null;

    const truncatedBody = truncateToTokenBudget(body, body_token_cap);
    const filename = path.basename(filePath);

    return `### [${trigger}]\n${truncatedBody}\n*Source: ${filename}*`;
  } catch {
    return null;
  }
}

/**
 * Scan memory_dir for all lesson files (feedback_*, project_*, process_* .md files).
 * Returns an array of { file_path, artifact_id? } entries.
 *
 * Used by formatLessonsWithInlineExpansion to build the candidate set.
 */
function scanLessonFiles(memory_dir: string): Array<{ file_path: string }> {
  try {
    if (!fs.existsSync(memory_dir)) return [];
    const LESSON_RE = /^(feedback|project|process)_[a-z0-9][a-z0-9_-]{0,59}\.md$/;
    return fs
      .readdirSync(memory_dir)
      .filter(name => LESSON_RE.test(name))
      .map(name => ({ file_path: path.join(memory_dir, name) }));
  } catch {
    return [];
  }
}

/**
 * Phase 14-07j: Lessons section formatter with link-aware inline-expansion.
 *
 * Behavior:
 * - When pivot_text and pivot_artifact_ids are absent (or empty), degrades
 *   gracefully: returns null (no lessons to show from memory_dir perspective).
 *   This lets the existing formatProvenPrinciplesSection (H's baseline) continue
 *   to be called with ExperiencePattern[] for the pointer-list rendering.
 *
 * - When pivot_text is present: scans memory_dir for lesson files, scores all
 *   lessons by relevance (trigger match + link distance), inline-expands the
 *   top-K by relevance at the TOP of the section, and renders the remaining
 *   lessons as pointer lines.
 *
 * - Inline-expansion budget: 400 tokens TOTAL across all K lessons.
 * - Per-lesson body cap: ~130 tokens (truncated with ellipsis).
 * - K=0 explicitly: no inline-expansion; all lessons as pointer lines.
 *
 * Non-throwing — returns null on any error.
 *
 * NOTE: 14-07j adds inline-expansion as additional behavior. This function
 * is separate from (and does not rewrite) formatProvenPrinciplesSection (H's
 * ExperiencePattern-based renderer). The assembler wires this when it has
 * lesson file metadata available.
 *
 * // 14-07j: inline-expansion of top-K lessons
 */
export function formatLessonsWithInlineExpansion(p: LessonsSectionParams): string | null {
  try {
    const {
      db,
      memory_dir,
      pivot_text,
      pivot_artifact_ids = [],
      inline_top_k,
      budget_tokens,
    } = p;

    // Graceful fallback: if no pivot context, skip inline-expansion entirely
    if (!pivot_text || pivot_text.trim() === '') return null;
    if (inline_top_k === 0) return null;

    // Scan lesson files
    const lessonFiles = scanLessonFiles(memory_dir);
    if (lessonFiles.length === 0) return null;

    // Select top-K by relevance
    // 14-07j: inline-expansion of top-K lessons
    // Pass inline_top_k directly (undefined when not set) so selectTopKLessons
    // can apply the CLAUDEX_LESSON_INLINE_K env var override when no explicit K.
    const topKResults = selectTopKLessons({
      lessons: lessonFiles,
      pivot_text,
      pivot_artifact_ids,
      db,
      k: inline_top_k,
    });

    // Track which file paths are being inline-expanded
    const inlinedPaths = new Set(topKResults.map(r => r.lesson_file_path));

    // Build the inline-expansion block (top of section)
    const inlineBlocks: string[] = [];
    let inlineTokensUsed = 0;

    for (const result of topKResults) {
      // Per-lesson token cap: distribute equally, but hard-cap at PER_LESSON_BODY_TOKEN_CAP
      const remainingBudget = INLINE_EXPANSION_BUDGET_TOKENS - inlineTokensUsed;
      if (remainingBudget < 20) break; // Not enough budget for another lesson

      const perLessonCap = Math.min(PER_LESSON_BODY_TOKEN_CAP, remainingBudget);
      const expanded = inlineExpandLesson(result.lesson_file_path, perLessonCap);
      if (!expanded) continue;

      const blockCost = estimateTokens(expanded);
      if (inlineTokensUsed + blockCost > INLINE_EXPANSION_BUDGET_TOKENS) break;

      inlineBlocks.push(expanded);
      inlineTokensUsed += blockCost;
    }

    // Build the pointer list for remaining lessons (not inline-expanded)
    const pointerLines: string[] = [];
    for (const lessonFile of lessonFiles) {
      if (inlinedPaths.has(lessonFile.file_path)) continue;
      const trigger = readLessonTrigger(lessonFile.file_path);
      const filename = path.basename(lessonFile.file_path);
      const label = trigger ?? filename.replace(/\.md$/, '');
      pointerLines.push(`- [${label}](${filename})`);
    }

    // Compose the section
    const parts: string[] = [];

    if (inlineBlocks.length > 0 || pointerLines.length > 0) {
      parts.push('## Lessons');
    }

    if (inlineBlocks.length > 0) {
      parts.push('[Inline-expanded by relevance to current pivot]\n');
      parts.push(...inlineBlocks);
    }

    if (pointerLines.length > 0) {
      if (inlineBlocks.length > 0) {
        parts.push('\n**Other lessons** (pointer list):');
      }
      parts.push(...pointerLines);
    }

    const result = parts.join('\n').trimEnd();
    if (!result || result === '## Lessons') return null;

    // Budget gate: if total output exceeds budget, return null (let baseline handle it)
    if (estimateTokens(result) > budget_tokens) return null;

    return result;
  } catch {
    return null;
  }
}
