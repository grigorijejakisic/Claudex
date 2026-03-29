/**
 * CARA Reasoning Layer — Hindsight-inspired opinion network for Angel.
 *
 * Angel forms opinions about tools, approaches, patterns, and architectural
 * choices. Each opinion has a confidence that evolves based on evidence:
 *
 *   reinforce(subject) — evidence supports the opinion → confidence increases
 *   weaken(subject)    — evidence against → confidence decreases
 *   contradict(subject, newOpinion) — strong counter-evidence → opinion flips
 *
 * Confidence dynamics use Bayesian update:
 *   reinforced: confidence = confidence + (1 - confidence) * learning_rate
 *   weakened:   confidence = confidence * (1 - learning_rate)
 *   contradicted: opinion replaced, confidence reset to 0.5
 *
 * Opinions surface in assembly when relevant to the current context.
 *
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

const LEARNING_RATE = 0.1;
const MIN_CONFIDENCE = 0.05;
const MAX_CONFIDENCE = 0.99;

export type OpinionSource = 'inferred' | 'user_stated' | 'pattern_derived' | 'observation_derived';

export interface Opinion {
  id: number;
  project: string;
  subject: string;
  opinion: string;
  confidence: number;
  evidence_count: number;
  source_type: OpinionSource;
  created_at_epoch: number;
  updated_at_epoch: number;
}

/**
 * Form or update an opinion about a subject.
 * If the subject already has an opinion, reinforce or update it.
 */
export function formOpinion(
  db: Database,
  project: string,
  subject: string,
  opinion: string,
  sourceType: OpinionSource = 'inferred',
): number {
  try {
    const existing = cachedPrepare(db,
      `SELECT id, opinion, confidence FROM angel_opinions WHERE project = ? AND subject = ?`
    ).get(project, subject) as { id: number; opinion: string; confidence: number } | undefined;

    if (existing) {
      // Same opinion → reinforce
      if (existing.opinion === opinion) {
        reinforceOpinion(db, existing.id);
        return existing.id;
      }
      // Different opinion → contradict and replace
      contradictOpinion(db, existing.id, opinion);
      return existing.id;
    }

    // New opinion
    const result = cachedPrepare(db,
      `INSERT INTO angel_opinions (project, subject, opinion, source_type)
       VALUES (?, ?, ?, ?)`
    ).run(project, subject, opinion, sourceType);
    return Number(result.lastInsertRowid);
  } catch {
    return 0;
  }
}

/**
 * Reinforce an opinion — evidence supports it. Confidence increases.
 */
export function reinforceOpinion(db: Database, opinionId: number): void {
  try {
    const row = cachedPrepare(db,
      `SELECT confidence FROM angel_opinions WHERE id = ?`
    ).get(opinionId) as { confidence: number } | undefined;
    if (!row) return;

    const newConfidence = Math.min(MAX_CONFIDENCE, row.confidence + (1 - row.confidence) * LEARNING_RATE);
    cachedPrepare(db,
      `UPDATE angel_opinions
       SET confidence = ?, reinforced_count = reinforced_count + 1,
           evidence_count = evidence_count + 1, updated_at_epoch = unixepoch()
       WHERE id = ?`
    ).run(newConfidence, opinionId);
  } catch { /* non-throwing */ }
}

/**
 * Weaken an opinion — evidence against it. Confidence decreases.
 */
export function weakenOpinion(db: Database, opinionId: number): void {
  try {
    const row = cachedPrepare(db,
      `SELECT confidence FROM angel_opinions WHERE id = ?`
    ).get(opinionId) as { confidence: number } | undefined;
    if (!row) return;

    const newConfidence = Math.max(MIN_CONFIDENCE, row.confidence * (1 - LEARNING_RATE));
    cachedPrepare(db,
      `UPDATE angel_opinions
       SET confidence = ?, weakened_count = weakened_count + 1,
           evidence_count = evidence_count + 1, updated_at_epoch = unixepoch()
       WHERE id = ?`
    ).run(newConfidence, opinionId);
  } catch { /* non-throwing */ }
}

/**
 * Contradict an opinion — strong evidence flips it. Opinion replaced, confidence reset.
 */
export function contradictOpinion(db: Database, opinionId: number, newOpinion: string): void {
  try {
    cachedPrepare(db,
      `UPDATE angel_opinions
       SET opinion = ?, confidence = 0.5, contradicted_count = contradicted_count + 1,
           evidence_count = evidence_count + 1, updated_at_epoch = unixepoch()
       WHERE id = ?`
    ).run(newOpinion, opinionId);
  } catch { /* non-throwing */ }
}

/**
 * Get high-confidence opinions for a project. Used by assembly to inject
 * Angel's understanding of the project into context.
 */
export function getStrongOpinions(
  db: Database,
  project: string,
  minConfidence: number = 0.7,
  limit: number = 10,
): Opinion[] {
  try {
    return cachedPrepare(db,
      `SELECT * FROM angel_opinions
       WHERE project IN (?, '__global__') AND confidence >= ?
       ORDER BY confidence DESC, evidence_count DESC
       LIMIT ?`
    ).all(project, minConfidence, limit) as Opinion[];
  } catch {
    return [];
  }
}

/**
 * Get opinions relevant to a specific subject/topic.
 * Uses LIKE matching for fuzzy subject search.
 */
export function getRelevantOpinions(
  db: Database,
  project: string,
  topic: string,
  limit: number = 5,
): Opinion[] {
  try {
    if (!topic || topic.length < 3) return [];
    const keywords = topic.toLowerCase().split(/\s+/).filter(w => w.length >= 3).slice(0, 3);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => 'LOWER(subject) LIKE ?').join(' OR ');
    const params = keywords.map(k => `%${k}%`);

    return cachedPrepare(db,
      `SELECT * FROM angel_opinions
       WHERE (project = ? OR project = '__global__')
         AND confidence >= 0.3
         AND (${conditions})
       ORDER BY confidence DESC
       LIMIT ?`
    ).all(project, ...params, limit) as Opinion[];
  } catch {
    return [];
  }
}

/**
 * Format opinions for assembly injection.
 */
export function formatOpinionsForInjection(opinions: Opinion[]): string {
  if (opinions.length === 0) return '';

  const lines = opinions.map(o => {
    const conf = Math.round(o.confidence * 100);
    const evidence = o.evidence_count > 1 ? ` (${o.evidence_count} observations)` : '';
    return `- **${o.subject}**: ${o.opinion} [${conf}% confidence${evidence}]`;
  });

  return `## Angel Insights\n${lines.join('\n')}`;
}

/**
 * Derive opinions from proven experience patterns.
 * Called by Angel heartbeat to build the opinion network from existing knowledge.
 */
export function deriveOpinionsFromPatterns(db: Database, project: string): number {
  try {
    const patterns = cachedPrepare(db,
      `SELECT id, trigger_context, lesson, pattern_type, score, helpful_count
       FROM experience_patterns
       WHERE maturity = 'proven' AND score >= 20
         AND source_project IN (?, '__global__')
       ORDER BY score DESC LIMIT 20`
    ).all(project) as Array<{
      id: string; trigger_context: string; lesson: string;
      pattern_type: string; score: number; helpful_count: number;
    }>;

    let derived = 0;
    for (const p of patterns) {
      // Extract subject from trigger_context (first meaningful phrase)
      const subject = p.trigger_context.slice(0, 80).replace(/\s+/g, ' ').trim();
      if (subject.length < 5) continue;

      const id = formOpinion(db, project, subject, p.lesson, 'pattern_derived');
      if (id > 0) derived++;
    }

    return derived;
  } catch {
    return 0;
  }
}
