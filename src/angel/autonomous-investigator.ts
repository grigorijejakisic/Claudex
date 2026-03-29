/**
 * Autonomous Investigator — Angel reasons about its own memories.
 *
 * CARA-inspired "Reflect" operation: when Angel encounters low-confidence
 * opinions or contradictions, it autonomously investigates by:
 *   1. Picking an uncertain subject
 *   2. Running up to N search iterations against Claudex memory
 *   3. Each iteration: formulate query → search → weigh evidence → refine
 *   4. At the end: update opinion with evidence-backed confidence
 *
 * Uses hybrid retrieval as the search backend. No LLM needed for the
 * investigation loop — evidence weighing is deterministic (token overlap
 * + outcome effectiveness + pattern confidence).
 *
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { hybridSearchSync } from '../core/hybrid-retrieval.js';
import { reinforceOpinion, weakenOpinion, contradictOpinion, type Opinion } from './cara-reasoning.js';

const MAX_ITERATIONS = 5;
const MAX_EVIDENCE_PER_QUERY = 5;
const MIN_EVIDENCE_FOR_CONCLUSION = 3;

interface Evidence {
  content: string;
  supports: boolean;
  strength: number; // 0-1
}

/**
 * Pick opinions that need investigation:
 *   - Low confidence (0.3-0.6) with some evidence
 *   - Recently contradicted
 *   - High evidence count but middling confidence (conflicting signals)
 */
function pickInvestigationTargets(db: Database, limit: number = 3): Opinion[] {
  try {
    return cachedPrepare(db,
      `SELECT * FROM angel_opinions
       WHERE (confidence BETWEEN 0.3 AND 0.6 AND evidence_count >= 2)
          OR (contradicted_count > 0 AND confidence < 0.7)
          OR (evidence_count >= 5 AND confidence BETWEEN 0.4 AND 0.65)
       ORDER BY
         contradicted_count DESC,
         ABS(confidence - 0.5) ASC
       LIMIT ?`
    ).all(limit) as Opinion[];
  } catch {
    return [];
  }
}

/**
 * Search Claudex memory for evidence about a subject.
 * Uses multiple query formulations to find diverse evidence.
 */
function gatherEvidence(
  db: Database,
  subject: string,
  currentOpinion: string,
  project: string,
): Evidence[] {
  const evidence: Evidence[] = [];
  const seen = new Set<number>();

  // Query 1: Direct subject search
  const directResults = hybridSearchSync(db, subject, project, {
    limit: MAX_EVIDENCE_PER_QUERY,
    globalScope: true,
  });

  for (const r of directResults) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const ev = evaluateEvidence(r.content ?? r.summary ?? '', currentOpinion, subject);
    if (ev) evidence.push(ev);
  }

  // Query 2: Opinion-specific search (does evidence support the opinion?)
  const opinionResults = hybridSearchSync(db, currentOpinion, project, {
    limit: MAX_EVIDENCE_PER_QUERY,
    globalScope: true,
  });

  for (const r of opinionResults) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const ev = evaluateEvidence(r.content ?? r.summary ?? '', currentOpinion, subject);
    if (ev) evidence.push(ev);
  }

  // Query 3: Check outcomes for patterns related to this subject
  try {
    const outcomes = cachedPrepare(db,
      `SELECT so.outcome, so.impact, ep.lesson
       FROM solution_outcomes so
       JOIN experience_patterns ep ON ep.id = so.pattern_id
       WHERE (LOWER(ep.lesson) LIKE ? OR LOWER(ep.trigger_context) LIKE ?)
       ORDER BY so.created_at_epoch DESC LIMIT 5`
    ).all(`%${subject.toLowerCase().split(/\s+/)[0]}%`, `%${subject.toLowerCase().split(/\s+/)[0]}%`) as Array<{
      outcome: string; impact: string | null; lesson: string;
    }>;

    for (const o of outcomes) {
      evidence.push({
        content: `Outcome: ${o.outcome} — ${o.impact ?? o.lesson}`,
        supports: o.outcome === 'success',
        strength: o.outcome === 'success' ? 0.8 : o.outcome === 'failure' ? 0.8 : 0.4,
      });
    }
  } catch { /* non-critical */ }

  return evidence;
}

/**
 * Evaluate whether a piece of content supports or contradicts an opinion.
 * Deterministic: uses word overlap + negation detection.
 */
function evaluateEvidence(
  content: string,
  opinion: string,
  subject: string,
): Evidence | null {
  if (!content || content.length < 20) return null;

  const contentLower = content.toLowerCase();
  const opinionWords = opinion.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
  const subjectWords = subject.toLowerCase().split(/\s+/).filter(w => w.length >= 4);

  // Must be relevant (share words with subject)
  const subjectOverlap = subjectWords.filter(w => contentLower.includes(w)).length;
  if (subjectOverlap === 0) return null;

  // Check if content agrees or disagrees with opinion
  const opinionOverlap = opinionWords.filter(w => contentLower.includes(w)).length;
  const overlapRatio = opinionWords.length > 0 ? opinionOverlap / opinionWords.length : 0;

  // Negation detection
  const negationWords = ['not', 'never', 'dont', 'avoid', 'wrong', 'bad', 'failed', 'broken'];
  const contentHasNegation = negationWords.some(w => contentLower.includes(w));
  const opinionHasNegation = negationWords.some(w => opinion.toLowerCase().includes(w));
  const polarityFlip = contentHasNegation !== opinionHasNegation;

  // Determine support/contradiction
  const supports = overlapRatio > 0.3 && !polarityFlip;
  const strength = Math.min(1, overlapRatio * 1.5) * (subjectOverlap / Math.max(1, subjectWords.length));

  return { content: content.slice(0, 200), supports, strength };
}

/**
 * Draw a conclusion from gathered evidence and update the opinion.
 */
function drawConclusion(
  db: Database,
  opinion: Opinion,
  evidence: Evidence[],
): { action: 'reinforce' | 'weaken' | 'contradict' | 'hold'; reason: string } {
  if (evidence.length < MIN_EVIDENCE_FOR_CONCLUSION) {
    return { action: 'hold', reason: `Insufficient evidence (${evidence.length}/${MIN_EVIDENCE_FOR_CONCLUSION})` };
  }

  const supporting = evidence.filter(e => e.supports);
  const opposing = evidence.filter(e => !e.supports);

  const supportWeight = supporting.reduce((s, e) => s + e.strength, 0);
  const opposeWeight = opposing.reduce((s, e) => s + e.strength, 0);
  const totalWeight = supportWeight + opposeWeight;

  if (totalWeight === 0) {
    return { action: 'hold', reason: 'No weighted evidence' };
  }

  const supportRatio = supportWeight / totalWeight;

  if (supportRatio > 0.7) {
    reinforceOpinion(db, opinion.id);
    return {
      action: 'reinforce',
      reason: `${supporting.length} supporting vs ${opposing.length} opposing (${Math.round(supportRatio * 100)}% support weight)`,
    };
  }

  if (supportRatio < 0.3) {
    weakenOpinion(db, opinion.id);
    return {
      action: 'weaken',
      reason: `${opposing.length} opposing vs ${supporting.length} supporting (${Math.round((1 - supportRatio) * 100)}% oppose weight)`,
    };
  }

  // Conflicting evidence — hold but log
  return {
    action: 'hold',
    reason: `Conflicting evidence: ${supporting.length} supporting, ${opposing.length} opposing (${Math.round(supportRatio * 100)}% support)`,
  };
}

export interface InvestigationResult {
  subject: string;
  opinion: string;
  evidenceCount: number;
  action: string;
  reason: string;
  iterations: number;
}

/**
 * Run autonomous investigation on uncertain opinions.
 * Called by Angel heartbeat. Rate-limited externally.
 */
export function runAutonomousInvestigation(
  db: Database,
  project: string,
): InvestigationResult[] {
  const results: InvestigationResult[] = [];

  try {
    const targets = pickInvestigationTargets(db, 3);
    if (targets.length === 0) return results;

    for (const opinion of targets) {
      let allEvidence: Evidence[] = [];

      // Iterative search — each round refines based on what was found
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const newEvidence = gatherEvidence(db, opinion.subject, opinion.opinion, project);

        // Deduplicate against what we already have
        const existingContent = new Set(allEvidence.map(e => e.content));
        const fresh = newEvidence.filter(e => !existingContent.has(e.content));

        allEvidence.push(...fresh);

        // Stop if no new evidence found this iteration
        if (fresh.length === 0) break;
      }

      // Draw conclusion from all gathered evidence
      const conclusion = drawConclusion(db, opinion, allEvidence);

      results.push({
        subject: opinion.subject,
        opinion: opinion.opinion,
        evidenceCount: allEvidence.length,
        action: conclusion.action,
        reason: conclusion.reason,
        iterations: Math.min(MAX_ITERATIONS, allEvidence.length > 0 ? allEvidence.length : 1),
      });
    }
  } catch { /* non-throwing */ }

  return results;
}
