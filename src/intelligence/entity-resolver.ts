/**
 * Entity Resolver — canonicalize entity names across sessions.
 *
 * Multi-signal resolution:
 *   1. Exact match (case-insensitive)
 *   2. Levenshtein distance (typos, variations)
 *   3. Co-occurrence (entities appearing in same sessions are likely aliases)
 *
 * Stores canonical → alias mappings in a lightweight table.
 * Inspired by Hindsight's entity resolution pipeline.
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

/**
 * Levenshtein distance between two strings (edit distance).
 * Used for fuzzy entity matching.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Normalize an entity name for comparison.
 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

/**
 * Resolve an entity name to its canonical form.
 * Checks existing canonical mappings first, then fuzzy matches.
 */
export function resolveEntity(
  db: Database,
  entityName: string,
): string {
  try {
    if (!entityName || entityName.length < 2) return entityName;

    const normalized = normalize(entityName);
    if (!normalized) return entityName;

    // 1. Exact canonical match
    const exact = cachedPrepare(db,
      `SELECT canonical FROM entity_aliases WHERE LOWER(alias) = ? LIMIT 1`
    ).get(normalized) as { canonical: string } | undefined;
    if (exact) return exact.canonical;

    // 2. Fuzzy match against known canonicals
    const canonicals = cachedPrepare(db,
      `SELECT DISTINCT canonical FROM entity_aliases LIMIT 100`
    ).all() as Array<{ canonical: string }>;

    for (const c of canonicals) {
      const dist = levenshtein(normalized, normalize(c.canonical));
      const maxLen = Math.max(normalized.length, c.canonical.length);
      // Accept if edit distance < 20% of the longer string
      if (maxLen > 4 && dist / maxLen < 0.2) {
        // Register as alias for future exact matching
        registerAlias(db, entityName, c.canonical);
        return c.canonical;
      }
    }

    return entityName; // No match — return as-is
  } catch {
    return entityName;
  }
}

/**
 * Register an entity alias → canonical mapping.
 */
export function registerAlias(
  db: Database,
  alias: string,
  canonical: string,
): void {
  try {
    cachedPrepare(db,
      `INSERT OR IGNORE INTO entity_aliases (alias, canonical) VALUES (?, ?)`
    ).run(normalize(alias), canonical);
  } catch { /* non-throwing */ }
}

/**
 * Register a new canonical entity with optional aliases.
 */
export function registerCanonical(
  db: Database,
  canonical: string,
  aliases?: string[],
): void {
  try {
    // Self-reference ensures the canonical is findable
    registerAlias(db, canonical, canonical);
    for (const alias of aliases ?? []) {
      registerAlias(db, alias, canonical);
    }
  } catch { /* non-throwing */ }
}

/**
 * Batch-resolve entities from session_events, registering discovered aliases.
 * Called by Angel during entity summary generation.
 * Groups similar entity names by Levenshtein distance and registers the
 * most-frequent variant as the canonical.
 */
export function resolveEntitiesInBatch(
  db: Database,
  limit: number = 50,
): number {
  try {
    // Get all distinct entity names with their frequency
    const entities = cachedPrepare(db,
      `SELECT entity, COUNT(*) as freq
       FROM session_events
       WHERE entity != '' AND entity IS NOT NULL
       GROUP BY entity
       ORDER BY COUNT(*) DESC
       LIMIT ?`
    ).all(limit) as Array<{ entity: string; freq: number }>;

    let resolved = 0;
    const canonicals = new Map<string, string>(); // normalized → canonical

    for (const e of entities) {
      const norm = normalize(e.entity);
      if (!norm || norm.length < 3) continue;

      // Check if already resolved
      if (canonicals.has(norm)) continue;

      // Find fuzzy matches among remaining entities
      let bestMatch: string | null = null;
      for (const [existingNorm, existingCanonical] of canonicals) {
        const dist = levenshtein(norm, existingNorm);
        const maxLen = Math.max(norm.length, existingNorm.length);
        if (maxLen > 4 && dist / maxLen < 0.2) {
          bestMatch = existingCanonical;
          break;
        }
      }

      if (bestMatch) {
        registerAlias(db, e.entity, bestMatch);
        canonicals.set(norm, bestMatch);
        resolved++;
      } else {
        // New canonical
        canonicals.set(norm, e.entity);
        registerAlias(db, e.entity, e.entity);
      }
    }

    return resolved;
  } catch {
    return 0;
  }
}
