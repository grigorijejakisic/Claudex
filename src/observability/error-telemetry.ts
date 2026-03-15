/**
 * Non-throwing error telemetry helper.
 * Replaces the `try { emitTelemetry(..., 'error', { subsystem, error: sanitize(e) }) } catch {}` pattern.
 * Lives in observability/ (not shared/) to avoid upward dependency.
 */

import type { Database } from 'better-sqlite3';
import { emitTelemetry, sanitizeErrorForTelemetry } from './telemetry.js';

/**
 * Emits an error telemetry event. Never throws.
 * Sanitizes the error automatically — callers pass the raw caught value.
 */
export function emitErrorTelemetry(
  db: Database,
  sessionId: string,
  subsystem: string,
  err: unknown,
): void {
  try {
    emitTelemetry(db, sessionId, 'error', {
      subsystem,
      error: sanitizeErrorForTelemetry(err),
    });
  } catch {
    // Double-fault: telemetry itself failed — nothing we can do
  }
}
