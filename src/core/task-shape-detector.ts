/**
 * Phase 6.5 — Task-shape detector for claudex_search query expansion (RETR-06).
 *
 * Regex-first per CONTEXT.md "Claude's Discretion: regex first, LLM if regex
 * misses too many". Detects whether a search query is task-shaped (verb +
 * domain noun) and, if so, picks the closest canonical task_shape from the
 * Phase 4.1 shape_vocabulary table via simple Jaccard.
 *
 * No LLM call here — fast path for the MCP server hot path. The cosine
 * embedder enters only at Stage 2 of the cross-project equivalence function
 * (Plan 02), not at task-shape detection.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export interface TaskShapeResult {
  isTaskShaped: boolean;
  canonicalShapeGuess: string | null;
  matchScore: number; // 0..1
}

// Verb prefixes that suggest task-shape.
const TASK_VERBS = /\b(investigate|debug|fix|implement|design|review|audit|migrate|refactor|test|deploy|integrate|optimize|profile|analyze|explore|understand|figure out|look into|check|inspect|verify|build|setup|configure)\b/i;

// Domain-noun families.
const DOMAIN_NOUNS = /\b(api|backend|endpoint|server|database|schema|migration|table|column|query|auth|authentication|session|token|cookie|request|response|rate.?limit|throttl|crawl|scrape|fetch|user|users|account|payment|webhook|deploy|build|test|integration|frontend|ui|component|hook|cache|index|search|retrieval|embed)\b/i;

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(t => t.length > 1);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenizePattern(value: string): string[] {
  return value.toLowerCase().split(/[-_\s]+/).filter(t => t.length > 0);
}

/**
 * Detect whether the query is task-shaped, and if so, propose the closest
 * canonical shape_vocabulary value via token Jaccard.
 *
 * Returns:
 *   - isTaskShaped: true iff query contains BOTH a verb and a domain noun.
 *   - canonicalShapeGuess: best canonical task_shape value (or null if vocab
 *     empty / no overlap).
 *   - matchScore: best Jaccard score over canonical values (0..1). Used by
 *     the query-expansion gate as a confidence indicator (currently advisory).
 */
export function detectTaskShape(db: Database, query: string): TaskShapeResult {
  const norm = (query ?? '').toLowerCase().trim();
  if (norm.length === 0) {
    return { isTaskShaped: false, canonicalShapeGuess: null, matchScore: 0 };
  }
  const hasVerb = TASK_VERBS.test(norm);
  const hasDomain = DOMAIN_NOUNS.test(norm);
  const isTaskShaped = hasVerb && hasDomain;
  if (!isTaskShaped) {
    return { isTaskShaped: false, canonicalShapeGuess: null, matchScore: 0 };
  }

  // Best canonical match via Jaccard on tokenized query vs tokenized vocab.
  let canonicalShapeGuess: string | null = null;
  let bestScore = 0;
  try {
    const queryTokens = new Set(tokenize(norm));
    const rows = cachedPrepare(db,
      `SELECT value FROM shape_vocabulary WHERE field = 'task_shape'`
    ).all() as Array<{ value: string }>;
    for (const r of rows) {
      const score = jaccard(queryTokens, new Set(tokenizePattern(r.value)));
      if (score > bestScore) {
        bestScore = score;
        canonicalShapeGuess = r.value;
      }
    }
  } catch {
    // Vocab unavailable — task-shape verdict still holds; canonical=null.
  }

  return {
    isTaskShaped: true,
    canonicalShapeGuess,
    matchScore: bestScore,
  };
}
