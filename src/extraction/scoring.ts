/**
 * Importance scoring (1-5) and category auto-classification.
 * Pure functions. Non-throwing.
 * @see Architecture Section 5.3 — importance scoring
 */

import type { ObservationCategory } from '../core/observations.js';
import { FILE_TOOL_NAMES } from '../shared/tool-catalog.js';

// --- Category Classification ---

/** Keyword-first-match mapping. Order matters: first match wins. */
const CATEGORY_KEYWORDS: Array<[RegExp, ObservationCategory]> = [
  [/error|exception|fail|crash|bug/i, 'error'],
  [/test|spec|assert|expect/i, 'test'],
  [/config|env|setting|option/i, 'config'],
  [/package|dependency|npm|install/i, 'dependency'],
  [/doc|readme|comment|jsdoc/i, 'documentation'],
  [/perf|latency|slow|optimize/i, 'performance'],
  [/auth|secret|token|credential|vulnerability/i, 'security'],
  [/architect|design|pattern|interface/i, 'architecture'],
  [/decide|chose|agreed|confirmed/i, 'decision'],
];

/**
 * Classifies an observation into a category using keyword-first-match.
 * Scans title + content (case-insensitive) against keyword map in order.
 * Default: 'code' for file-related tools, 'other' otherwise.
 */
export function classifyCategory(
  toolName: string,
  title: string,
  content: string
): ObservationCategory {
  try {
    const combined = `${title} ${content}`.replace(/\[REDACTED_\w+\]/g, '');
    for (const [pattern, category] of CATEGORY_KEYWORDS) {
      if (pattern.test(combined)) {
        return category;
      }
    }
    return FILE_TOOL_NAMES.has(toolName) ? 'code' : 'other';
  } catch {
    return 'other';
  }
}

// --- Importance Scoring ---

/** Breaking change signal patterns. */
const BREAKING_SIGNALS = /breaking|BREAKING|deprecated/;

/** Test failure signal patterns. */
const TEST_FAILURE_SIGNALS = /FAIL|failed|error/;

/**
 * Scores observation importance from 1-5.
 * Returns highest matching score (checks 5 first, then 4, etc.).
 * @see Architecture Section 5.3
 */
export function scoreImportance(
  toolName: string,
  category: ObservationCategory,
  content: string
): number {
  try {
    // Score 5: security, architecture, or breaking change signals
    if (category === 'security' || category === 'architecture') return 5;
    if (BREAKING_SIGNALS.test(content)) return 5;

    // Score 4: config, dependency, or test failure signals
    if (category === 'config' || category === 'dependency') return 4;
    if (TEST_FAILURE_SIGNALS.test(content) && /test/i.test(content)) return 4;

    // Score 3: Edit/Write (significant code changes), or error category
    if (toolName === 'Edit' || toolName === 'Write') return 3;
    if (category === 'error') return 3;

    // Score 2: Read with structural content, or Grep/Glob search results
    if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') return 2;

    // Score 1: everything else
    return 1;
  } catch {
    return 1;
  }
}
