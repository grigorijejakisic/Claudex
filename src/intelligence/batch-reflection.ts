/**
 * Cross-session batch reflection (4.4 — Generative Agents pattern).
 *
 * Every N sessions, synthesizes high-level insights from accumulated memories.
 * Heuristic-only path: clusters learnings by keyword overlap, extracts the
 * largest clusters as themes, and stores results as high-importance learning artifacts.
 *
 * All public functions are non-throwing.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { createArtifact } from '../core/artifacts.js';
import { getLearningsByProject, type LearningRow } from '../core/learnings.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum sessions between reflections. */
const REFLECTION_INTERVAL = 10;

/** Key used to store the last reflection timestamp in checkpoint_tracking. */
const REFLECTION_GUARD_KEY = '__reflection_guard__';

// ---------------------------------------------------------------------------
// Stop words for keyword extraction (reused from thread-tracker pattern)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'these',
  'those', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'my', 'your',
  'let', 'just', 'now', 'so', 'if', 'but', 'or', 'and', 'not', 'no',
  'its', 'what', 'when', 'which', 'who', 'how', 'all', 'each', 'every',
  'both', 'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too',
  'very', 'only', 'also', 'then', 'as', 'about', 'up', 'out', 'into',
  'through', 'after', 'before', 'between', 'under', 'again', 'there',
  'here', 'where', 'why', 'any', 'own', 'same', 'get', 'got', 'use',
  'used', 'using', 'new', 'one', 'two', 'first', 'last', 'make', 'made',
]);

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/**
 * Extract meaningful keywords from text. Filters stop words, short tokens,
 * and numbers. Returns unique lowercase keywords.
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
    .filter((w, i, arr) => arr.indexOf(w) === i); // unique
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/** A cluster of related learnings. */
export interface LearningCluster {
  /** Common keywords that define this cluster. */
  keywords: string[];
  /** Learning items in this cluster. */
  items: Array<{ id: number; content: string }>;
  /** Theme summary derived from the cluster. */
  theme: string;
}

/**
 * Cluster learnings by keyword overlap.
 * Greedy single-pass: for each learning, compute keyword overlap with existing clusters.
 * If overlap > 40%, merge into best cluster. Otherwise, start a new cluster.
 */
export function clusterLearnings(learnings: LearningRow[]): LearningCluster[] {
  if (learnings.length === 0) return [];

  const clusters: Array<{
    keywords: Set<string>;
    items: Array<{ id: number; content: string }>;
  }> = [];

  for (const learning of learnings) {
    const keywords = extractKeywords(learning.content);
    if (keywords.length === 0) continue;

    const keywordSet = new Set(keywords);

    // Find best matching cluster
    let bestCluster: typeof clusters[number] | null = null;
    let bestOverlap = 0;

    for (const cluster of clusters) {
      let overlap = 0;
      for (const kw of keywordSet) {
        if (cluster.keywords.has(kw)) overlap++;
      }
      const overlapRatio = overlap / Math.min(keywordSet.size, cluster.keywords.size);
      if (overlapRatio > 0.4 && overlapRatio > bestOverlap) {
        bestOverlap = overlapRatio;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      // Merge into existing cluster
      for (const kw of keywordSet) bestCluster.keywords.add(kw);
      bestCluster.items.push({ id: learning.id, content: learning.content });
    } else {
      // New cluster
      clusters.push({
        keywords: keywordSet,
        items: [{ id: learning.id, content: learning.content }],
      });
    }
  }

  // Sort clusters by size (largest first) and build themes
  return clusters
    .filter(c => c.items.length >= 2) // Only clusters with 2+ items are themes
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, 5) // Top 5 clusters
    .map(c => {
      // Build theme from top keywords (most common in the cluster items)
      const kwFreq = new Map<string, number>();
      for (const item of c.items) {
        const itemKw = extractKeywords(item.content);
        for (const kw of itemKw) {
          kwFreq.set(kw, (kwFreq.get(kw) ?? 0) + 1);
        }
      }
      // Sort by frequency, take top 5
      const topKeywords = [...kwFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([kw]) => kw);

      const theme = `Theme: ${topKeywords.join(', ')} (${c.items.length} learnings)`;

      return {
        keywords: topKeywords,
        items: c.items,
        theme,
      };
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if batch reflection should run for this project.
 * Returns true if sessions_since_last_reflection >= REFLECTION_INTERVAL.
 * Non-throwing — returns false on any error.
 */
export function shouldRunReflection(db: Database, project: string): boolean {
  try {
    // Get last reflection epoch from checkpoint_tracking
    const guardKey = `${REFLECTION_GUARD_KEY}${project}`;
    const guard = cachedPrepare(db,
      'SELECT last_checkpoint_epoch_ms FROM checkpoint_tracking WHERE session_id = ?'
    ).get(guardKey) as { last_checkpoint_epoch_ms: number | null } | undefined;

    const lastReflectionEpochMs = guard?.last_checkpoint_epoch_ms ?? 0;

    // Count sessions for this project since last reflection (ms precision).
    const MAX_SANE_EPOCH_MS = 4_102_444_800_000; // 2100-01-01 in ms
    const countResult = cachedPrepare(db,
      `SELECT COUNT(*) as cnt FROM sessions
       WHERE project = ? AND created_at_epoch_ms > ? AND created_at_epoch_ms < ?`
    ).get(project, lastReflectionEpochMs, MAX_SANE_EPOCH_MS) as { cnt: number };

    return countResult.cnt >= REFLECTION_INTERVAL;
  } catch {
    return false;
  }
}

/**
 * Run batch reflection: cluster learnings, extract themes, store as artifacts.
 * Non-throwing — returns the number of reflection artifacts created.
 *
 * @param db - SQLite database
 * @param project - project scope
 * @param sessionId - current session ID (for artifact creation)
 * @returns number of reflection artifacts created
 */
export function runBatchReflection(
  db: Database,
  project: string,
  sessionId: string,
): number {
  try {
    // 1. Gather top-20 learnings
    const learnings = getLearningsByProject(db, project, { limit: 20 });
    if (learnings.length < 3) return 0; // Not enough learnings to reflect on

    // 2. Gather recent thread summaries for additional context
    let threadSummaries: string[] = [];
    try {
      const threads = cachedPrepare(db,
        `SELECT t.summary FROM thread_state t
         JOIN sessions s ON s.session_id = t.session_id
         WHERE s.project = ? AND t.summary IS NOT NULL
         ORDER BY t.updated_at_epoch_ms DESC
         LIMIT 10`
      ).all(project) as Array<{ summary: string }>;
      threadSummaries = threads.map(t => t.summary);
    } catch { /* non-fatal */ }

    // 3. Gather top-10 experience patterns
    let patternLessons: string[] = [];
    try {
      const patterns = cachedPrepare(db,
        `SELECT lesson FROM experience_patterns
         WHERE source_project = ? AND score > 0
         ORDER BY score DESC, times_triggered DESC
         LIMIT 10`
      ).all(project) as Array<{ lesson: string }>;
      patternLessons = patterns.map(p => p.lesson);
    } catch { /* non-fatal — table may not exist */ }

    // 4. Cluster learnings by keyword overlap
    const clusters = clusterLearnings(learnings);
    if (clusters.length === 0) return 0;

    // 5. Create reflection artifacts for each theme
    let artifactsCreated = 0;
    for (const cluster of clusters) {
      // Build a synthesis content from the cluster
      const contentParts: string[] = [
        `[Reflection] ${cluster.theme}`,
        '',
        'Synthesized from:',
      ];
      for (const item of cluster.items.slice(0, 5)) {
        contentParts.push(`- ${item.content.slice(0, 120)}`);
      }

      // Add relevant thread summaries that share keywords
      const relatedSummaries = threadSummaries.filter(s => {
        const sKeywords = extractKeywords(s);
        return cluster.keywords.some(kw => sKeywords.includes(kw));
      });
      if (relatedSummaries.length > 0) {
        contentParts.push('');
        contentParts.push('Related session context:');
        for (const s of relatedSummaries.slice(0, 2)) {
          contentParts.push(`- ${s.slice(0, 120)}`);
        }
      }

      // Add relevant pattern lessons
      const relatedPatterns = patternLessons.filter(p => {
        const pKeywords = extractKeywords(p);
        return cluster.keywords.some(kw => pKeywords.includes(kw));
      });
      if (relatedPatterns.length > 0) {
        contentParts.push('');
        contentParts.push('Related patterns:');
        for (const p of relatedPatterns.slice(0, 2)) {
          contentParts.push(`- ${p.slice(0, 120)}`);
        }
      }

      const content = contentParts.join('\n');
      const summary = `[Reflection] ${cluster.keywords.slice(0, 3).join(', ')} — ${cluster.items.length} learnings`;

      // 14-07b: migrated from legacy artifacts — dedup against V17 artifact table
      // V17 field mapping: summary → title
      try {
        const existing = cachedPrepare(db,
          `SELECT id FROM artifact WHERE project = ? AND title = ? LIMIT 1`
        ).get(project, summary) as { id: string } | undefined;
        if (existing) continue; // Already have this reflection
      } catch { /* non-fatal — proceed with creation */ }

      try {
        createArtifact(db, sessionId, project, 'learning', `reflection:${cluster.keywords[0]}`, summary, content, 5);
        artifactsCreated++;
      } catch {
        // Non-throwing per artifact
      }
    }

    // 6. Mark reflection timestamp
    try {
      const guardKey = `${REFLECTION_GUARD_KEY}${project}`;
      cachedPrepare(db,
        `INSERT INTO checkpoint_tracking (session_id, last_checkpoint_epoch, updated_at_epoch)
         VALUES (?, unixepoch(), unixepoch())
         ON CONFLICT(session_id) DO UPDATE SET
           last_checkpoint_epoch = unixepoch(),
           updated_at_epoch = unixepoch()`
      ).run(guardKey);
    } catch {
      // Non-fatal — reflection still created artifacts
    }

    return artifactsCreated;
  } catch (e) {
    try { emitErrorTelemetry(db, sessionId, 'batch_reflection', e); } catch { /* swallow */ }
    return 0;
  }
}
