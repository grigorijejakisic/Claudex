/**
 * Capability Boundary Tracking (EvoCUA) — 3.6
 *
 * Tracks correction rate by topic/domain using the capability_boundaries table.
 * Surfaces known-weak areas in assembly when correction_rate > 0.3.
 *
 * Domain extraction is heuristic: takes the primary topic from thread state
 * and normalizes it to a domain key.
 *
 * All public functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityBoundary {
  id: number;
  project: string;
  domain: string;
  total_interactions: number;
  corrections: number;
  correction_rate: number;
  last_updated_epoch: number;
}

// ---------------------------------------------------------------------------
// Domain extraction
// ---------------------------------------------------------------------------

/** Common domain keywords mapped to normalized domain names. */
const DOMAIN_MAP: Record<string, string> = {
  auth: 'auth',
  oauth: 'auth',
  login: 'auth',
  authentication: 'auth',
  authorization: 'auth',
  test: 'testing',
  testing: 'testing',
  vitest: 'testing',
  jest: 'testing',
  spec: 'testing',
  migration: 'migrations',
  migrations: 'migrations',
  schema: 'migrations',
  deploy: 'deployment',
  deployment: 'deployment',
  docker: 'deployment',
  ci: 'deployment',
  css: 'styling',
  style: 'styling',
  styling: 'styling',
  tailwind: 'styling',
  database: 'database',
  sqlite: 'database',
  sql: 'database',
  query: 'database',
  api: 'api',
  endpoint: 'api',
  route: 'api',
  rest: 'api',
  config: 'config',
  configuration: 'config',
  settings: 'config',
  env: 'config',
  build: 'build',
  compile: 'build',
  esbuild: 'build',
  webpack: 'build',
  git: 'git',
  commit: 'git',
  branch: 'git',
  merge: 'git',
  performance: 'performance',
  optimization: 'performance',
  latency: 'performance',
  security: 'security',
  vulnerability: 'security',
  xss: 'security',
  injection: 'security',
};

/**
 * Extracts a normalized domain from topic text.
 * Returns null if no recognizable domain is found.
 * Non-throwing.
 */
export function extractDomain(topicText: string): string | null {
  if (!topicText || topicText.length < 2) return null;

  try {
    const words = topicText.toLowerCase().split(/[\s_\-/.,;:]+/);

    for (const word of words) {
      const domain = DOMAIN_MAP[word];
      if (domain) return domain;
    }

    // Fallback: use first significant word (length >= 3) as domain
    const significant = words.find(w => w.length >= 3 && !/^(?:the|and|for|with|from|this|that|have|been|will|were)$/.test(w));
    return significant ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Domain interaction tracking
// ---------------------------------------------------------------------------

/**
 * Records an interaction in a domain. Increments total_interactions.
 * If correctionDetected is true, also increments corrections.
 * Uses UPSERT for atomic insert-or-update.
 * Non-throwing.
 */
export function recordDomainInteraction(
  db: Database,
  project: string,
  domain: string,
  correctionDetected: boolean,
): void {
  try {
    const now = Math.floor(Date.now() / 1000);

    if (correctionDetected) {
      cachedPrepare(db,
        `INSERT INTO capability_boundaries (project, domain, total_interactions, corrections, last_updated_epoch)
         VALUES (?, ?, 1, 1, ?)
         ON CONFLICT(project, domain) DO UPDATE SET
           total_interactions = total_interactions + 1,
           corrections = corrections + 1,
           last_updated_epoch = ?`
      ).run(project, domain, now, now);
    } else {
      cachedPrepare(db,
        `INSERT INTO capability_boundaries (project, domain, total_interactions, corrections, last_updated_epoch)
         VALUES (?, ?, 1, 0, ?)
         ON CONFLICT(project, domain) DO UPDATE SET
           total_interactions = total_interactions + 1,
           last_updated_epoch = ?`
      ).run(project, domain, now, now);
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Advisory generation
// ---------------------------------------------------------------------------

/**
 * Gets the capability boundary for a domain. Returns null if not tracked.
 * Non-throwing.
 */
export function getDomainBoundary(
  db: Database,
  project: string,
  domain: string,
): CapabilityBoundary | null {
  try {
    const row = cachedPrepare(db,
      `SELECT id, project, domain, total_interactions, corrections, last_updated_epoch,
              CASE WHEN total_interactions > 0
                THEN CAST(corrections AS REAL) / total_interactions
                ELSE 0.0
              END as correction_rate
       FROM capability_boundaries
       WHERE project = ? AND domain = ?`
    ).get(project, domain) as CapabilityBoundary | undefined;

    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Gets all domains with high correction rates (> threshold) for a project.
 * Used in assembly to inject advisories for weak areas.
 * Non-throwing.
 */
export function getWeakDomains(
  db: Database,
  project: string,
  threshold: number = 0.3,
  minInteractions: number = 3,
): CapabilityBoundary[] {
  try {
    return cachedPrepare(db,
      `SELECT id, project, domain, total_interactions, corrections, last_updated_epoch,
              CAST(corrections AS REAL) / total_interactions as correction_rate
       FROM capability_boundaries
       WHERE project = ?
         AND total_interactions >= ?
         AND CAST(corrections AS REAL) / total_interactions > ?
       ORDER BY CAST(corrections AS REAL) / total_interactions DESC`
    ).all(project, minInteractions, threshold) as CapabilityBoundary[];
  } catch {
    return [];
  }
}

/**
 * Generates an advisory string for a domain with high correction rate.
 * Returns null if the domain is not weak or not tracked.
 * Non-throwing.
 */
export function generateDomainAdvisory(
  db: Database,
  project: string,
  domain: string,
  threshold: number = 0.3,
  minInteractions: number = 3,
): string | null {
  try {
    const boundary = getDomainBoundary(db, project, domain);
    if (!boundary) return null;
    if (boundary.total_interactions < minInteractions) return null;
    if (boundary.correction_rate <= threshold) return null;

    const pct = Math.round(boundary.correction_rate * 100);
    return `This topic area ("${domain}") has a ${pct}% correction rate (${boundary.corrections}/${boundary.total_interactions}) — extra care advised.`;
  } catch {
    return null;
  }
}
