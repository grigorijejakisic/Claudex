/**
 * Artifact Claims — retrieved-set coordination for parallel workers.
 *
 * Implements the MetaGPT/LbMAS pattern: when the PM assembles context packages
 * for workers, it claims the artifact IDs matched for each worker. Subsequent
 * workers get DIFFERENT artifacts (claimed ones excluded), increasing coverage
 * and reducing duplicate work across parallel agents.
 *
 * Claims are advisory with TTL (default 300s / 5 minutes). Expired claims are
 * automatically excluded from active-lease checks and cleaned up by
 * expireStaleClaims().
 *
 * All public functions are non-throwing — defensive with safe defaults on error.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// claimArtifacts
// ---------------------------------------------------------------------------

/**
 * Claims the given artifact IDs for a worker.
 *
 * For each artifact ID:
 * - If no active claim exists (or the claim is expired): INSERT and include in result.
 * - If another worker holds an active claim: skip.
 * - If the same worker already holds a claim: refresh TTL and include in result.
 *
 * Returns the IDs that were successfully claimed (new or renewed).
 * Non-throwing — returns [] on error.
 */
export function claimArtifacts(
  db: Database,
  artifactIds: string[],
  workerId: string,
  ttlSeconds: number = 300,
): string[] {
  if (!artifactIds || artifactIds.length === 0) return [];

  try {
    const now = Math.floor(Date.now() / 1000);
    const claimed: string[] = [];

    const doClaim = db.transaction((): void => {
      for (const artifactId of artifactIds) {
        // Check for an existing active claim by another worker.
        const existing = cachedPrepare(db,
          `SELECT worker_id, claimed_at_epoch, ttl_seconds
           FROM artifact_claims
           WHERE artifact_id = ? AND worker_id != ?`
        ).get(artifactId, workerId) as
          | { worker_id: string; claimed_at_epoch: number; ttl_seconds: number }
          | undefined;

        if (existing) {
          const expiresAt = existing.claimed_at_epoch + existing.ttl_seconds;
          if (expiresAt >= now) {
            // Another worker holds an active claim — skip this artifact.
            continue;
          }
          // Existing claim is expired — delete it so we can insert fresh.
          cachedPrepare(db,
            `DELETE FROM artifact_claims WHERE artifact_id = ? AND worker_id = ?`
          ).run(artifactId, existing.worker_id);
        }

        // Upsert: INSERT OR REPLACE handles both new claims and same-worker renewals.
        cachedPrepare(db,
          `INSERT OR REPLACE INTO artifact_claims (artifact_id, worker_id, claimed_at_epoch, ttl_seconds)
           VALUES (?, ?, ?, ?)`
        ).run(artifactId, workerId, now, ttlSeconds);
        claimed.push(artifactId);
      }
    });

    doClaim();
    return claimed;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// getUnclaimedArtifactIds
// ---------------------------------------------------------------------------

/**
 * Returns artifact IDs from the artifacts table (scoped to project) that are
 * NOT currently claimed by any worker with an active TTL.
 *
 * Used by assembleWorkerContext() to find artifacts eligible for the next
 * worker's context package.
 *
 * Non-throwing — returns [] on error.
 */
export function getUnclaimedArtifactIds(db: Database, project: string): string[] {
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = cachedPrepare(db,
      `SELECT CAST(a.id AS TEXT) AS artifact_id
       FROM artifacts a
       WHERE a.project = ?
         AND NOT EXISTS (
           SELECT 1 FROM artifact_claims ac
           WHERE ac.artifact_id = CAST(a.id AS TEXT)
             AND ac.claimed_at_epoch + ac.ttl_seconds >= ?
         )
       ORDER BY a.importance DESC, a.timestamp_epoch DESC`
    ).all(project, now) as Array<{ artifact_id: string }>;

    return rows.map(r => r.artifact_id);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// releaseAllClaims
// ---------------------------------------------------------------------------

/**
 * Releases all artifact claims held by a worker.
 * Call when a worker finishes its task.
 * Non-throwing.
 */
export function releaseAllClaims(db: Database, workerId: string): void {
  try {
    cachedPrepare(db,
      `DELETE FROM artifact_claims WHERE worker_id = ?`
    ).run(workerId);
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// expireStaleClaims
// ---------------------------------------------------------------------------

/**
 * Deletes all claims where claimed_at_epoch + ttl_seconds < now.
 * Returns the number of claims deleted. Returns 0 on error.
 * Call periodically alongside expireStaleLeases().
 */
export function expireStaleClaims(db: Database): number {
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = cachedPrepare(db,
      `DELETE FROM artifact_claims WHERE claimed_at_epoch + ttl_seconds < ?`
    ).run(now);
    return result.changes;
  } catch {
    return 0;
  }
}
