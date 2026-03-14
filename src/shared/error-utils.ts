/**
 * Error handling utilities for non-throwing operations with telemetry.
 * Provides a helper to wrap synchronous operations that should never throw
 * but should emit telemetry on failure.
 */

import type { Database } from 'better-sqlite3';
import { emitTelemetry, sanitizeErrorForTelemetry } from '../observability/telemetry.js';

/**
 * Executes a synchronous function, catching any error and emitting telemetry.
 * The function never throws. If db is null, errors are silently swallowed.
 * Use where manual try/catch + telemetry would add noise without clarity.
 */
export function nonThrowingWithTelemetry(
  fn: () => void,
  db: Database | null,
  sessionId: string,
  subsystem: string
): void {
  try {
    fn();
  } catch (e) {
    if (db) {
      try { emitTelemetry(db, sessionId, 'error', { subsystem, error: sanitizeErrorForTelemetry(e) }); } catch {}
    }
  }
}
