/**
 * Contrastive Pattern Extraction (ExpeL) — 3.5
 *
 * At session-end, compares successful vs. failed sessions of the same type
 * to extract WHY one worked and the other didn't. Produces contrastive rules.
 *
 * Frequency: every 10 sessions per project (not every session).
 * Requires 5+ sessions to have enough data for meaningful comparison.
 *
 * All public functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { createPattern, type ExtractionInput } from './experience-patterns.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionSummary {
  session_id: string;
  project: string;
  session_summary: string | null;
  correction_count: number;
  created_at_epoch: number;
}

export interface ContrastiveRule {
  successful_session_id: string;
  failed_session_id: string;
  rule: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cosine similarity between two sets of words (bag-of-words). */
function wordOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  return intersection / Math.sqrt(wordsA.size * wordsB.size);
}

/**
 * Extracts a contrastive rule by diffing decisions/approaches between
 * a successful and a failed session.
 */
function extractContrastiveRule(
  db: Database,
  successful: SessionSummary,
  failed: SessionSummary,
): string | null {
  try {
    // Get decisions from both sessions
    const getDecisions = (sessionId: string): string[] => {
      const rows = cachedPrepare(db,
        `SELECT detail FROM session_events
         WHERE session_id = ? AND event_type = 'decision' AND detail IS NOT NULL
         ORDER BY timestamp_epoch`
      ).all(sessionId) as Array<{ detail: string }>;
      return rows.map(r => r.detail);
    };

    const successDecisions = getDecisions(successful.session_id);
    const failedDecisions = getDecisions(failed.session_id);

    if (successDecisions.length === 0 && failedDecisions.length === 0) return null;

    // Build the contrastive rule from decision differences
    const parts: string[] = [];

    if (successDecisions.length > 0) {
      parts.push(`In successful session: ${successDecisions.slice(0, 3).join('; ')}`);
    }
    if (failedDecisions.length > 0) {
      parts.push(`In failed session: ${failedDecisions.slice(0, 3).join('; ')}`);
    }

    // Use session summaries for additional context
    if (successful.session_summary && failed.session_summary) {
      parts.push(
        `Success approach: ${successful.session_summary.slice(0, 120)}; ` +
        `Failed approach: ${failed.session_summary.slice(0, 120)}`
      );
    }

    if (parts.length === 0) return null;
    return parts.join('. ').slice(0, 500);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether contrastive extraction should run for this project.
 * Triggers every 10 sessions, requires at least 5 sessions total.
 * Non-throwing.
 */
export function shouldRunContrastiveExtraction(
  db: Database,
  project: string,
): boolean {
  try {
    const row = cachedPrepare(db,
      `SELECT COUNT(*) as cnt FROM sessions WHERE project = ?`
    ).get(project) as { cnt: number } | undefined;

    const sessionCount = row?.cnt ?? 0;
    return sessionCount >= 5 && sessionCount % 10 === 0;
  } catch {
    return false;
  }
}

/**
 * Runs contrastive extraction: pairs successful and failed sessions by topic
 * similarity, diffs their approaches, and creates discovery patterns.
 *
 * Returns the number of contrastive rules created.
 * Non-throwing.
 */
export function runContrastiveExtraction(
  db: Database,
  project: string,
  sessionId: string,
): number {
  try {
    // Get sessions with correction counts
    const sessions = cachedPrepare(db,
      `SELECT s.session_id, s.project, s.session_summary, s.created_at_epoch,
              COALESCE((
                SELECT COUNT(*) FROM experience_patterns ep
                WHERE ep.source_session = s.session_id AND ep.pattern_type = 'correction'
              ), 0) as correction_count
       FROM sessions s
       WHERE s.project = ?
       ORDER BY s.created_at_epoch DESC
       LIMIT 20`
    ).all(project) as SessionSummary[];

    if (sessions.length < 5) return 0;

    // Separate into successful (0 corrections) and failed (1+ corrections)
    const successful = sessions.filter(s => s.correction_count === 0 && s.session_summary);
    const failed = sessions.filter(s => s.correction_count > 0 && s.session_summary);

    if (successful.length === 0 || failed.length === 0) return 0;

    // Pair by topic similarity (word overlap on session summaries)
    const pairs: Array<{ success: SessionSummary; failure: SessionSummary; similarity: number }> = [];

    for (const f of failed) {
      let bestMatch: SessionSummary | null = null;
      let bestSimilarity = 0;

      for (const s of successful) {
        const sim = wordOverlap(s.session_summary ?? '', f.session_summary ?? '');
        if (sim > bestSimilarity) {
          bestSimilarity = sim;
          bestMatch = s;
        }
      }

      // Minimum similarity threshold for pairing
      if (bestMatch && bestSimilarity > 0.15) {
        pairs.push({ success: bestMatch, failure: f, similarity: bestSimilarity });
      }
    }

    // Cap at 3 pairs per extraction run
    const topPairs = pairs
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3);

    let created = 0;

    for (const pair of topPairs) {
      const rule = extractContrastiveRule(db, pair.success, pair.failure);
      if (!rule) continue;

      const input: ExtractionInput = {
        pattern_type: 'discovery',
        trigger_context: `Contrastive: ${(pair.failure.session_summary ?? '').slice(0, 100)}`,
        lesson: rule,
        severity: 'minor',
      };

      const id = createPattern(db, input, sessionId, project);
      if (id) created++;
    }

    return created;
  } catch (e) {
    emitErrorTelemetry(db, sessionId, 'contrastive_extraction', e);
    return 0;
  }
}
