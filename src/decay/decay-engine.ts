/**
 * EI computation, observation pruning, and retention policy.
 * Non-throwing public API.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { getPolicy } from '../intelligence/policy-registry.js';

import type { StabilityClass } from '../core/observations.js';

/** Base weights by importance level. */
export const BASE_WEIGHTS: Record<number, number> = { 1: 0.2, 2: 0.4, 3: 0.6, 4: 0.8, 5: 1.0 };

/** Half-lives in days by importance level (flat — legacy, used as fallback for 'standard'). */
export const HALF_LIVES: Record<number, number> = { 1: 7, 2: 14, 3: 60, 4: 90, 5: 365 };

/**
 * Stability-aware half-lives in days, keyed by stability class and importance level.
 * Infinity means the observation never auto-decays.
 */
export const STABILITY_HALF_LIVES: Record<string, Record<number, number>> = {
  transient:  { 1: 3,        2: 7,        3: 14,       4: 30,       5: 90 },
  standard:   { 1: 7,        2: 14,       3: 30,       4: 60,       5: 365 },
  stable:     { 1: 14,       2: 30,       3: 90,       4: 180,      5: Infinity },
  permanent:  { 1: Infinity, 2: Infinity, 3: Infinity, 4: Infinity, 5: Infinity },
};

/** Minimum access count for immunity. */
export const IMMUNITY_ACCESS_COUNT = 3;

/** Maximum age in days for access-based immunity. */
export const IMMUNITY_ACCESS_DAYS = 180;

/**
 * Computes the Effective Importance (EI) score for an observation.
 * Pure function, no DB access.
 * EI = baseWeight * accessFactor * decayFactor * connectivityBonus
 *
 * When stabilityClass is provided, uses stability-aware half-lives.
 * When omitted or null, falls back to 'standard' (backward compatible).
 */
export function computeEI(obs: {
  importance: number;
  accessCount: number;
  lastAccessedAtEpoch: number | null;
  timestampEpoch: number;
  coOccurrences: number;
  stabilityClass?: StabilityClass | string | null;
}): number {
  const baseWeight = BASE_WEIGHTS[obs.importance] ?? 0.2;
  const accessFactor = 1 + Math.log2(1 + obs.accessCount);
  const ageDays = Math.max(0, (Date.now() / 1000 - obs.timestampEpoch) / 86400);

  // Resolve stability class with backward-compatible fallback
  // Delegate to memory policy for half-life lookup
  const stability = obs.stabilityClass ?? 'standard';
  const halfLife = getPolicy().getHalfLife('', obs.importance, String(stability));

  // Permanent/stable importance-5: Infinity half-life → no decay
  if (!isFinite(halfLife)) {
    const connectivityBonus = 1.0 + 0.1 * Math.min(obs.coOccurrences, 5);
    return baseWeight * accessFactor * connectivityBonus;
  }

  const effectiveHL = halfLife * (1 + 0.15 * obs.accessCount);
  const decayFactor = Math.pow(2, -ageDays / effectiveHL);
  const connectivityBonus = 1.0 + 0.1 * Math.min(obs.coOccurrences, 5);

  return baseWeight * accessFactor * decayFactor * connectivityBonus;
}

/**
 * Counts co-occurring observations (sharing files_modified values).
 * Capped at 5. 100ms timeout guard.
 * Non-throwing (returns 0 on error).
 */
export function getCoOccurrences(
  db: Database,
  observationId: number,
  filesModified: string,
  project?: string
): number {
  try {
    let files: string[];
    try {
      files = JSON.parse(filesModified);
    } catch {
      return 0;
    }
    if (!Array.isArray(files) || files.length === 0) return 0;

    // Cap file list to bound execution time
    files = files.slice(0, 10);

    const start = Date.now();
    const cap = 5;

    // Use a Set to track distinct observation IDs across all files,
    // preventing double-counting when an observation shares multiple files with the target.
    const seen = new Set<number>();

    const stmt = project != null
      ? cachedPrepare(db,
          `SELECT id FROM observations
           WHERE id != ? AND deleted_at_epoch IS NULL AND project = ? AND files_modified LIKE ? ESCAPE '\\'
           LIMIT 6`
        )
      : cachedPrepare(db,
          `SELECT id FROM observations
           WHERE id != ? AND deleted_at_epoch IS NULL AND files_modified LIKE ? ESCAPE '\\'
           LIMIT 6`
        );

    for (const file of files) {
      if (Date.now() - start > 100) return Math.min(seen.size, cap);
      // Escape LIKE wildcards in file names
      const escapedFile = file.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%"${escapedFile}"%`;
      const rows = project != null
        ? stmt.all(observationId, project, pattern) as Array<{ id: number }>
        : stmt.all(observationId, pattern) as Array<{ id: number }>;
      for (const row of rows) {
        seen.add(row.id);
      }
      // Early exit: if already at cap, no need to check more files
      if (seen.size >= cap) return cap;
    }

    return Math.min(seen.size, cap);
  } catch {
    return 0;
  }
}

/**
 * Prunes lowest-EI observations when count exceeds threshold.
 * Immune observations are never pruned: importance >= 5, or access_count >= 3 within 180 days.
 * Non-throwing (returns 0 on error).
 */
export function pruneObservations(
  db: Database,
  project: string,
  opts?: { pruneThreshold?: number; pruneCount?: number }
): number {
  try {
    const pruneThreshold = opts?.pruneThreshold ?? 1000;
    const pruneCount = opts?.pruneCount ?? 50;

    const countRow = cachedPrepare(db, 'SELECT COUNT(*) as cnt FROM observations WHERE project = ? AND deleted_at_epoch IS NULL')
      .get(project) as { cnt: number };

    if (countRow.cnt <= pruneThreshold) return 0;

    const immunityEpoch = Math.floor(Date.now() / 1000) - IMMUNITY_ACCESS_DAYS * 86400;

    const candidates = cachedPrepare(db,
        `SELECT id, importance, access_count, last_accessed_at_epoch, timestamp_epoch, files_modified, stability_class
         FROM observations
         WHERE project = ? AND deleted_at_epoch IS NULL
           AND importance < 5
           AND NOT (access_count >= ? AND last_accessed_at_epoch IS NOT NULL AND last_accessed_at_epoch > ?)`
      )
      .all(project, IMMUNITY_ACCESS_COUNT, immunityEpoch) as Array<{
        id: number;
        importance: number;
        access_count: number;
        last_accessed_at_epoch: number | null;
        timestamp_epoch: number;
        files_modified: string;
        stability_class: string | null;
      }>;

    // Cap candidates to avoid N+1 query explosion
    const MAX_PRUNE_CANDIDATES = 200;
    const cappedCandidates = candidates.length > MAX_PRUNE_CANDIDATES
      ? candidates.slice(0, MAX_PRUNE_CANDIDATES)
      : candidates;

    // Compute EI for each candidate (stability-aware)
    const scored = cappedCandidates.map((c) => ({
      id: c.id,
      ei: computeEI({
        importance: c.importance,
        accessCount: c.access_count,
        lastAccessedAtEpoch: c.last_accessed_at_epoch,
        timestampEpoch: c.timestamp_epoch,
        coOccurrences: getCoOccurrences(db, c.id, c.files_modified, project),
        stabilityClass: c.stability_class ?? 'standard',
      }),
    }));

    // Sort by EI ascending (lowest first)
    scored.sort((a, b) => a.ei - b.ei);

    // Soft-delete the lowest pruneCount
    const toPrune = scored.slice(0, pruneCount);
    const softDelete = cachedPrepare(db,
      'UPDATE observations SET deleted_at_epoch = unixepoch() WHERE id = ?'
    );

    const doDelete = db.transaction(() => {
      for (const item of toPrune) {
        softDelete.run(item.id);
      }
    });
    doDelete();

    return toPrune.length;
  } catch {
    return 0;
  }
}

/**
 * Hard-deletes old observations per retention policy.
 * 1. Soft-deleted observations older than retention_days
 * 2. Non-deleted observations older than retention_days with importance < 5
 * Non-throwing (returns 0 on error).
 */
export function applyRetentionPolicy(
  db: Database,
  project: string,
  retentionDays?: number
): number {
  try {
    const days = retentionDays ?? 90;
    const threshold = days * 86400;

    const r1 = cachedPrepare(db,
        `DELETE FROM observations
         WHERE project = ? AND deleted_at_epoch IS NOT NULL
           AND deleted_at_epoch < unixepoch() - ?`
      )
      .run(project, threshold);

    const r2 = cachedPrepare(db,
        `DELETE FROM observations
         WHERE project = ? AND deleted_at_epoch IS NULL
           AND timestamp_epoch < unixepoch() - ?
           AND importance < 5`
      )
      .run(project, threshold);

    return r1.changes + r2.changes;
  } catch {
    return 0;
  }
}
