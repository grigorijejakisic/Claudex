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
import { emitErrorTelemetry } from '../observability/error-telemetry.js';

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
  if (ttlSeconds < 1) return [];

  const uniqueIds = [...new Set(artifactIds)];

  try {
    const now = Math.floor(Date.now() / 1000);
    const claimed: string[] = [];

    const doClaim = db.transaction((): void => {
      for (const artifactId of uniqueIds) {
        // Check for an existing claim (single-owner PK: one row per artifact_id).
        const existing = cachedPrepare(db,
          `SELECT worker_id, claimed_at_epoch, ttl_seconds
           FROM artifact_claims
           WHERE artifact_id = ?`
        ).get(artifactId) as
          | { worker_id: string; claimed_at_epoch: number; ttl_seconds: number }
          | undefined;

        if (existing) {
          const expiresAt = existing.claimed_at_epoch + existing.ttl_seconds;
          if (expiresAt >= now && existing.worker_id !== workerId) {
            // Another worker holds an active claim — skip this artifact.
            continue;
          }
          if (expiresAt < now) {
            // Expired claim — delete it so we can insert fresh.
            cachedPrepare(db,
              `DELETE FROM artifact_claims WHERE artifact_id = ?`
            ).run(artifactId);
          }
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
  } catch (e) {
    emitErrorTelemetry(db, '', 'artifact-claims/claimArtifacts', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// getUnclaimedArtifactIds
// ---------------------------------------------------------------------------

/**
 * Returns artifact IDs (not full Artifact objects) that are not currently claimed.
 *
 * NOTE: Spec defines getUnclaimedArtifacts(db, query, project, excludeWorker?) → Artifact[].
 * This implementation intentionally returns string[] of IDs without query filtering:
 * - The PM/orchestrator handles query-based selection via searchArtifacts
 * - This function provides the unclaimed filter layer only
 * - Returning IDs (not objects) avoids loading full artifact content just for claim checking
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
      `SELECT a.id AS artifact_id
       FROM artifacts a
       WHERE a.project = ?
         AND NOT EXISTS (
           SELECT 1 FROM artifact_claims ac
           WHERE ac.artifact_id = a.id
             AND ac.claimed_at_epoch + ac.ttl_seconds >= ?
         )
       ORDER BY a.importance DESC, a.timestamp_epoch DESC`
    ).all(project, now) as Array<{ artifact_id: number }>;

    return rows.map(r => String(r.artifact_id));
  } catch (e) {
    emitErrorTelemetry(db, '', 'artifact-claims/getUnclaimedArtifactIds', e);
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
  } catch (e) {
    emitErrorTelemetry(db, '', 'artifact-claims/releaseAllClaims', e);
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
  } catch (e) {
    emitErrorTelemetry(db, '', 'artifact-claims/expireStaleClaims', e);
    return 0;
  }
}
