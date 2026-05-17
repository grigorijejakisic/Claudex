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
  DEFAULT_TOP_K,
} from '../../intelligence/lesson-relevance.js';

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
