/**
 * File Leases — advisory file locks for parallel workers.
 *
 * Implements the MCP Agent Mail pattern: TTL-based advisory leases stored in
 * SQLite. Workers request leases before editing files; the PM/orchestrator
 * checks for conflicts when designing wave structure.
 *
 * Leases are ADVISORY — workers can proceed without one, but risk conflicts.
 * The system records intent, not enforcement.
 *
 * All public functions are non-throwing — defensive with safe defaults on error.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';

// ---------------------------------------------------------------------------
// requestLease
// ---------------------------------------------------------------------------

/**
 * Requests a file lease for the given worker.
 *
 * Grant rules:
 * - If no active lease exists for the file: INSERT and return true.
 * - If the existing lease has expired (granted_at + ttl < now): replace and return true.
 * - If the same worker already holds an active lease: refresh TTL and return true.
 * - If another worker holds an active lease: return false.
 *
 * Uses a transaction for atomicity: check-then-insert cannot race in SQLite
 * WAL mode (single writer).
 *
 * Returns false on any error (safe default for conflict prevention).
 */
export function requestLease(
  db: Database,
  filePath: string,
  workerId: string,
  ttlSeconds: number = 600,
): boolean {
  if (ttlSeconds < 1) return false;

  try {
    const now = Math.floor(Date.now() / 1000);

    const doRequest = db.transaction((): boolean => {
      // Check for an existing lease on this file.
      const existing = cachedPrepare(db,
        `SELECT worker_id, granted_at_epoch, ttl_seconds FROM file_leases WHERE file_path = ?`
      ).get(filePath) as { worker_id: string; granted_at_epoch: number; ttl_seconds: number } | undefined;

      if (existing) {
        const expiresAt = existing.granted_at_epoch + existing.ttl_seconds;
        const isExpired = expiresAt < now;
        const isSameWorker = existing.worker_id === workerId;

        if (!isExpired && !isSameWorker) {
          // Another worker holds an active lease — deny.
          return false;
        }

        // Expired or same worker — replace/refresh.
        cachedPrepare(db,
          `UPDATE file_leases SET worker_id = ?, granted_at_epoch = ?, ttl_seconds = ? WHERE file_path = ?`
        ).run(workerId, now, ttlSeconds, filePath);
        return true;
      }

      // No existing lease — insert fresh.
      cachedPrepare(db,
        `INSERT INTO file_leases (file_path, worker_id, granted_at_epoch, ttl_seconds) VALUES (?, ?, ?, ?)`
      ).run(filePath, workerId, now, ttlSeconds);
      return true;
    });

    return doRequest();
  } catch (e) {
    emitErrorTelemetry(db, '', 'file-leases/requestLease', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// releaseLease
// ---------------------------------------------------------------------------

/**
 * Releases the lease a specific worker holds on a file.
 * No-op if the worker doesn't hold the lease (e.g., another worker owns it
 * or the lease already expired and was cleaned up).
 * Non-throwing.
 */
export function releaseLease(db: Database, filePath: string, workerId: string): void {
  try {
    cachedPrepare(db,
      `DELETE FROM file_leases WHERE file_path = ? AND worker_id = ?`
    ).run(filePath, workerId);
  } catch (e) {
    emitErrorTelemetry(db, '', 'file-leases/releaseLease', e);
  }
}

// ---------------------------------------------------------------------------
// releaseAllLeases
// ---------------------------------------------------------------------------

/**
 * Releases all leases held by a worker.
 * Call when a worker finishes its task to clean up all held leases.
 * Non-throwing.
 */
export function releaseAllLeases(db: Database, workerId: string): void {
  try {
    cachedPrepare(db,
      `DELETE FROM file_leases WHERE worker_id = ?`
    ).run(workerId);
  } catch (e) {
    emitErrorTelemetry(db, '', 'file-leases/releaseAllLeases', e);
  }
}

// ---------------------------------------------------------------------------
// getLeaseHolder
// ---------------------------------------------------------------------------

/**
 * Returns the worker_id that currently holds an active (non-expired) lease on
 * the given file, or null if no active lease exists.
 * Non-throwing — returns null on error.
 */
export function getLeaseHolder(db: Database, filePath: string): string | null {
  try {
    const now = Math.floor(Date.now() / 1000);
    const row = cachedPrepare(db,
      `SELECT worker_id, granted_at_epoch, ttl_seconds FROM file_leases WHERE file_path = ?`
    ).get(filePath) as { worker_id: string; granted_at_epoch: number; ttl_seconds: number } | undefined;

    if (!row) return null;
    const expiresAt = row.granted_at_epoch + row.ttl_seconds;
    if (expiresAt < now) return null; // Expired — treat as no holder
    return row.worker_id;
  } catch (e) {
    emitErrorTelemetry(db, '', 'file-leases/getLeaseHolder', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// expireStaleLeases
// ---------------------------------------------------------------------------

/**
 * Deletes all leases where granted_at_epoch + ttl_seconds < now (epoch seconds).
 * Returns the number of leases deleted. Returns 0 on error.
 * Call periodically (e.g., at session start or TTL tick) to keep the table clean.
 */
export function expireStaleLeases(db: Database): number {
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = cachedPrepare(db,
      `DELETE FROM file_leases WHERE granted_at_epoch + ttl_seconds < ?`
    ).run(now);
    return result.changes;
  } catch (e) {
    emitErrorTelemetry(db, '', 'file-leases/expireStaleLeases', e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// getWorkerLeases
// ---------------------------------------------------------------------------

/**
 * Returns the list of file paths with active (non-expired) leases held by the given worker.
 * Non-throwing — returns [] on error.
 */
export function getWorkerLeases(db: Database, workerId: string): string[] {
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = cachedPrepare(db,
      `SELECT file_path FROM file_leases WHERE worker_id = ? AND granted_at_epoch + ttl_seconds >= ?`
    ).all(workerId, now) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  } catch (e) {
    emitErrorTelemetry(db, '', 'file-leases/getWorkerLeases', e);
    return [];
  }
}
