/**
 * Phase 14-07d — site helpers for autonomous soft-link emission.
 *
 * Each helper wraps writeSoftLink with site-specific defaults and
 * the standardized try/catch + telemetry pattern. Per the Good
 * Child policy, soft links commit at write-time; failures are
 * logged but do not block the primary write path.
 *
 * All helpers:
 *   - return the soft_link row id on success
 *   - emit `soft_link_skipped` telemetry and return null when preconditions fail
 *   - emit `soft_link_write_failed` telemetry and return null on DB error
 *   - NEVER throw; NEVER roll back the primary write
 *
 * Callers must never call writeSoftLink directly from write sites;
 * always go through these helpers for consistency and error handling.
 */

import type { Database } from 'better-sqlite3';
import { writeSoftLink } from '../core/link-writer.js';

// ─── Internal telemetry helper ────────────────────────────────────────────────

/**
 * Emit a soft-link telemetry event. Bypasses the typed emitTelemetry because
 * `soft_link_skipped` and `soft_link_write_failed` are new event kinds not yet
 * in the EventKindDetailMap (same pattern as `frame_extraction_fallback` and
 * `handoff_parse_failed` — direct INSERT with try/catch).
 *
 * Non-throwing by construction.
 */
function emitSoftLinkTelemetry(
  db: Database,
  eventKind: 'soft_link_skipped' | 'soft_link_write_failed',
  sessionId: string,
  detail: Record<string, unknown>,
): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, ?, ?, ?)`,
    ).run(sessionId, eventKind, JSON.stringify(detail), '14-07d-soft-link-writers');
  } catch {
    // Telemetry write failure is non-fatal: log to console in debug mode only.
    if (process.env.CLAUDEX_DEBUG === '1') {
      console.error(`[soft-link-writers] telemetry write failed for ${eventKind}:`, detail);
    }
  }
}

// ─── Shared context ───────────────────────────────────────────────────────────

export interface SoftLinkContext {
  db: Database;
  session_id: string;
}

// ─── recordSupersedes ─────────────────────────────────────────────────────────

export interface RecordSupersedesParams extends SoftLinkContext {
  /** V17 ID of the just-written handoff. */
  new_handoff_artifact_id: string;
  /** V17 ID of the prior handoff; null = first handoff for project (skip). */
  prior_handoff_artifact_id: string | null;
}

/**
 * Record a supersedes link from new handoff → prior handoff.
 *
 * If prior is null (first handoff for the project), emits
 * `soft_link_skipped` telemetry and returns null — not an error condition.
 *
 * Returns the soft_link row id on success; null on skip or failure.
 */
export function recordSupersedes(p: RecordSupersedesParams): number | null {
  if (!p.prior_handoff_artifact_id) {
    emitSoftLinkTelemetry(p.db, 'soft_link_skipped', p.session_id, {
      reason: 'no_prior',
      site: 'recordSupersedes',
      new_id: p.new_handoff_artifact_id,
    });
    return null;
  }
  try {
    return writeSoftLink(p.db, {
      src_artifact_id: p.new_handoff_artifact_id,
      dst_artifact_id: p.prior_handoff_artifact_id,
      type: 'supersedes',
      created_by_session: p.session_id,
    });
  } catch (err) {
    emitSoftLinkTelemetry(p.db, 'soft_link_write_failed', p.session_id, {
      site: 'recordSupersedes',
      error: String(err),
    });
    return null;
  }
}

// ─── recordPromotedTo ─────────────────────────────────────────────────────────

export interface RecordPromotedToParams extends SoftLinkContext {
  /** V17 ID of the originating observation. */
  observation_artifact_id: string;
  /** V17 ID of the resulting lesson. */
  lesson_artifact_id: string;
  /** Confidence of the promotion link. Default 1.0. */
  promotion_confidence?: number;
}

/**
 * Record a promoted_to link from observation → lesson.
 *
 * Returns the soft_link row id on success; null on failure.
 */
export function recordPromotedTo(p: RecordPromotedToParams): number | null {
  try {
    return writeSoftLink(p.db, {
      src_artifact_id: p.observation_artifact_id,
      dst_artifact_id: p.lesson_artifact_id,
      type: 'promoted_to',
      confidence: p.promotion_confidence ?? 1.0,
      created_by_session: p.session_id,
    });
  } catch (err) {
    emitSoftLinkTelemetry(p.db, 'soft_link_write_failed', p.session_id, {
      site: 'recordPromotedTo',
      error: String(err),
    });
    return null;
  }
}

// ─── recordExtractedFrom ──────────────────────────────────────────────────────

export interface RecordExtractedFromParams extends SoftLinkContext {
  /** V17 ID of the extracted highlight artifact. */
  highlight_artifact_id: string;
  /** V17 ID of the session frame (the session row in V17 form). */
  session_frame_artifact_id: string;
}

/**
 * Record an extracted_from link from highlight → session frame.
 *
 * Returns the soft_link row id on success; null on failure.
 */
export function recordExtractedFrom(p: RecordExtractedFromParams): number | null {
  try {
    return writeSoftLink(p.db, {
      src_artifact_id: p.highlight_artifact_id,
      dst_artifact_id: p.session_frame_artifact_id,
      type: 'extracted_from',
      created_by_session: p.session_id,
    });
  } catch (err) {
    emitSoftLinkTelemetry(p.db, 'soft_link_write_failed', p.session_id, {
      site: 'recordExtractedFrom',
      error: String(err),
    });
    return null;
  }
}

// ─── recordReferences ─────────────────────────────────────────────────────────

export interface RecordReferencesParams extends SoftLinkContext {
  /** V17 ID of the source artifact (e.g. a retrieval log entry). */
  src_artifact_id: string;
  /** V17 IDs of each artifact referenced by the source. Emits N links. */
  referenced_artifact_ids: string[];
}

/**
 * Record N references links from src → each referenced artifact.
 *
 * The UNIQUE constraint on (src, dst, type) in soft_link handles duplicates
 * idempotently via writeSoftLink's INSERT OR IGNORE semantics — so re-running
 * on the same log entry does not produce duplicate rows or errors.
 *
 * Returns the count of links successfully written (new inserts + existing id
 * returns both count; only failures reduce the count). If an individual
 * reference fails, it is skipped with telemetry and processing continues.
 */
export function recordReferences(p: RecordReferencesParams): number {
  if (p.referenced_artifact_ids.length === 0) return 0;

  let written = 0;
  for (const dst of p.referenced_artifact_ids) {
    try {
      writeSoftLink(p.db, {
        src_artifact_id: p.src_artifact_id,
        dst_artifact_id: dst,
        type: 'references',
        created_by_session: p.session_id,
      });
      written++;
    } catch (err) {
      emitSoftLinkTelemetry(p.db, 'soft_link_write_failed', p.session_id, {
        site: 'recordReferences',
        src: p.src_artifact_id,
        dst,
        error: String(err),
      });
    }
  }
  return written;
}
