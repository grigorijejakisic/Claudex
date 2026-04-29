/**
 * Phase 4.1 feedback → critical_rules promotion bridge.
 *
 * Architecture B (CONTEXT.md lock): when 3 instances of equivalent feedback_*
 * lessons accumulate in a project, INSERT a row into critical_rules with
 * source='system-promoted'. The existing Critical Reminders Tier scorer
 * (assembleCriticalReminders) consumes the new row automatically — no scorer
 * changes for the basic path.
 *
 * Equivalence (4.1 lock): simple normalized text equality — lowercase, strip
 * punctuation, trim whitespace. Embedding-based similarity is deferred to 6.5.
 *
 * Scope: project-scoped only. Cross-project escalation deferred to 6.5.
 *
 * Density threshold: 3 (Claude's discretion to tune; documented in CONTEXT.md).
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { listLessonsForProject } from './lesson-reader.js';

const PROMOTION_DENSITY = 3;

// Drift-risk inference — same regex set as critical-reminders.ts pattern.
// Reused via duplication (not import) to avoid circular module graph between
// angel/feedback-promoter and intelligence/critical-reminders.
const SAFETY_KEYWORDS = /\b(never|deadlock|scope|verify|safety)\b/i;

/**
 * Normalize lesson body for equivalence comparison.
 *
 * Rule (CONTEXT.md): lowercase, strip punctuation, trim whitespace. Conservative
 * punctuation strip preserves alphanumerics, spaces, hyphens, underscores
 * (content-bearing) but removes commas, periods, exclamation marks, question
 * marks, brackets, parens, and quotes.
 */
export function normalizeRuleText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"\[\]\{\}\(\)]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferDriftRisk(text: string): 'safety' | 'working-method' | 'style' {
  if (SAFETY_KEYWORDS.test(text)) return 'safety';
  // CONTEXT.md default: working-method
  return 'working-method';
}

/**
 * Run promotion for one project. Returns the number of rules promoted.
 *
 * Idempotent: if a system-promoted critical_rule already matches the
 * normalized text for a candidate, the insert is skipped.
 */
export function promoteFeedbackToCriticalRules(db: Database, project: string): number {
  const lessons = listLessonsForProject(project).filter(l => l.frontmatter.type === 'feedback');
  if (lessons.length < PROMOTION_DENSITY) return 0;

  // Group by normalized first-non-blank-line ('salience headline').
  const groups = new Map<string, string[]>(); // norm_text → [filename]
  for (const lesson of lessons) {
    const firstLine = lesson.body.split('\n').map(l => l.trim()).find(l => l.length > 0);
    if (!firstLine) continue;
    const cleaned = firstLine.replace(/^#+\s+/, '').replace(/^[-*]\s+/, '');
    const norm = normalizeRuleText(cleaned);
    if (norm.length === 0) continue;
    const arr = groups.get(norm) ?? [];
    arr.push(lesson.filename);
    groups.set(norm, arr);
  }

  let promoted = 0;
  for (const [normText, files] of groups.entries()) {
    if (files.length < PROMOTION_DENSITY) continue;

    // Skip if a system-promoted critical_rule with this normalized text exists.
    const existing = cachedPrepare(db,
      `SELECT rule_text FROM critical_rules
       WHERE project = ?
         AND source = 'system-promoted'`,
    ).all(project) as Array<{ rule_text: string }>;
    if (existing.some(r => normalizeRuleText(r.rule_text) === normText)) continue;

    // Reconstruct presentable rule text from the latest lesson (by filename
    // sort order — slugs typically include time-ordered prefixes).
    const repFile = files.sort().slice(-1)[0];
    const repLesson = lessons.find(l => l.filename === repFile)!;
    const repFirstLine = repLesson.body.split('\n').map(l => l.trim()).find(l => l.length > 0)!;
    const presentable = repFirstLine.replace(/^#+\s+/, '').replace(/^[-*]\s+/, '');

    const driftRisk = inferDriftRisk(presentable);

    try {
      cachedPrepare(db,
        `INSERT INTO critical_rules (project, rule_text, source, drift_risk, domain_tags, base_ttl)
         VALUES (?, ?, 'system-promoted', ?, NULL, 8)`,
      ).run(project, presentable, driftRisk);
      promoted++;
    } catch {
      // Existing unique-index conflict on (project, rule_text) — non-fatal.
    }
  }

  return promoted;
}
