/**
 * Contradiction Detector — flags when new observations contradict stored knowledge.
 *
 * Checks new observations against existing decisions and proven patterns.
 * When a contradiction is detected, creates a 'danger' signal visible to all sessions.
 *
 * Inspired by Memelord's explicit contradiction tool.
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { createSignal } from '../core/session-signals.js';

/**
 * Check if a new observation contradicts any existing decisions or proven patterns.
 * Returns the contradicting knowledge if found.
 */
export function detectContradiction(
  db: Database,
  newContent: string,
  project: string,
  sessionId: string,
): { type: 'decision' | 'pattern'; id: number | string; content: string } | null {
  try {
    if (!newContent || newContent.length < 20) return null;

    // Tokenize the new content
    const words = newContent.toLowerCase()
      .split(/[\s_\-/.,;:!?()[\]{}]+/)
      .filter(w => w.length >= 4);
    if (words.length < 3) return null;

    const wordSet = new Set(words);

    // Check against recent decisions in the same project
    const decisions = cachedPrepare(db,
      `SELECT id, content FROM decisions
       WHERE project IN (?, '__global__')
       ORDER BY updated_at_epoch DESC LIMIT 20`
    ).all(project) as Array<{ id: number; content: string }>;

    for (const dec of decisions) {
      const decWords = dec.content.toLowerCase()
        .split(/[\s_\-/.,;:!?()[\]{}]+/)
        .filter(w => w.length >= 4);
      if (decWords.length < 3) continue;

      // Check for negation patterns: new content says "don't X" while decision says "do X"
      // or new content says "use Y" while decision says "don't use Y"
      const negationWords = ['not', 'never', 'dont', 'avoid', 'stop', 'remove', 'delete', 'wrong'];
      const newHasNegation = words.some(w => negationWords.includes(w));
      const decHasNegation = decWords.some(w => negationWords.includes(w));

      // Topic overlap: >40% of decision words appear in new content
      const overlap = decWords.filter(w => wordSet.has(w)).length;
      const overlapRatio = overlap / decWords.length;

      // Contradiction = high topic overlap + opposite polarity (one negated, other not)
      if (overlapRatio > 0.4 && newHasNegation !== decHasNegation) {
        // Signal the contradiction
        createSignal(db, sessionId, project, 'danger',
          `Potential contradiction with decision #${dec.id}`,
          `New: "${newContent.slice(0, 100)}" vs Existing: "${dec.content.slice(0, 100)}"`);
        return { type: 'decision', id: dec.id, content: dec.content };
      }
    }

    // Check against proven patterns
    const patterns = cachedPrepare(db,
      `SELECT id, lesson, anti_pattern FROM experience_patterns
       WHERE maturity = 'proven' AND source_project IN (?, '__global__')
       AND score >= 20 LIMIT 20`
    ).all(project) as Array<{ id: string; lesson: string; anti_pattern: string | null }>;

    for (const pat of patterns) {
      const lessonWords = pat.lesson.toLowerCase()
        .split(/[\s_\-/.,;:!?()[\]{}]+/)
        .filter(w => w.length >= 4);

      const overlap = lessonWords.filter(w => wordSet.has(w)).length;
      const overlapRatio = lessonWords.length > 0 ? overlap / lessonWords.length : 0;

      // Check if new content matches the anti-pattern
      if (pat.anti_pattern && overlapRatio > 0.3) {
        const antiWords = pat.anti_pattern.toLowerCase()
          .split(/[\s_\-/.,;:!?()[\]{}]+/)
          .filter(w => w.length >= 4);
        const antiOverlap = antiWords.filter(w => wordSet.has(w)).length;
        if (antiWords.length > 0 && antiOverlap / antiWords.length > 0.4) {
          createSignal(db, sessionId, project, 'danger',
            `Contradicts proven pattern ${pat.id.slice(0, 8)}`,
            `Approach matches anti-pattern: "${pat.anti_pattern.slice(0, 100)}"`);
          return { type: 'pattern', id: pat.id, content: pat.lesson };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
