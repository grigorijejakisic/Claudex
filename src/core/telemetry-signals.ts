/**
 * Phase 12 telemetry signal recorders.
 * Four signals measuring real-task retrieval behavior.
 * No verdict structure — signal collection only per 12-CONTEXT.md spec.
 */

import type { Database } from 'better-sqlite3';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ROWS_PER_SIGNAL_KIND = 10_000;

// ── Signal recorders ──────────────────────────────────────────────────────────

/**
 * Record that an agent read a file within N turns of memory surfacing it.
 * Acceptance proxy for retrieval-to-action.
 */
export function recordRerereadAfterSurface(
  db: Database,
  detail: {
    session_id: string;
    file_path: string;
    turns_since_surface: number;
    surfaced_artifact_id?: number;
  },
): void {
  writeTelemetrySignal(db, 'signal_reread_after_surface', detail);
}

/**
 * Record a retrieval fallback event.
 * Generalizes the existing reranker_fallback to cover all fallback paths.
 */
export function recordRetrievalFallback(
  db: Database,
  detail: {
    session_id: string;
    reason: 'vec0_empty' | 'bi_encoder_unavailable' | 'reranker_unavailable' | 'fts_only' | string;
    channel_used: string;
  },
): void {
  writeTelemetrySignal(db, 'signal_retrieval_fallback', detail);
}

/**
 * Record that a transcript-span injection (L2.5 deliberation surface) was accepted.
 * Injection landed AND the agent's next turn references the span.
 */
export function recordTranscriptInjectionAcceptance(
  db: Database,
  detail: {
    session_id: string;
    injected_span_session_id: string;
    injected_span_turn_index: number;
    accepted: boolean;
  },
): void {
  writeTelemetrySignal(db, 'signal_transcript_injection_acceptance', detail);
}

/**
 * Record retrieval-fidelity-vs-behavior decoupling.
 *
 * Fires when: a retrieval result containing domain_token was surfaced in turn N
 * AND the agent's next 3 assistant turns do NOT reference that token.
 * Direct measure of the W1/s42 Big Mozzy V2 failure pattern.
 */
export function recordRetrievedButUnapplied(
  db: Database,
  detail: {
    session_id: string;
    surfaced_turn_index: number;
    domain_token: string;
    turns_checked: number;
    artifact_id?: number;
  },
): void {
  writeTelemetrySignal(db, 'signal_retrieved_but_unapplied', detail);
}

/**
 * Phase 13 Plan 03: record a frame-extraction fallback event.
 * Mirrors the reranker-fallback discipline — every Opus-to-fallback transition
 * writes one row with the structured reason so operators can spot persistent
 * Opus unavailability and the existing health-line surfacing.
 *
 * Phase 14 Plan 14-00 (2026-05-15): added optional `http_status` so the
 * actual HTTP code (e.g. 429 rate limit, 401 auth) is preserved in the
 * detail. RCA-2 found that the OAuth path was getting 429 globally and
 * the original telemetry shape lost that signal — only the bucketed
 * `reason` enum survived. Future debugging should not require manual
 * reproduction.
 */
export function recordFrameExtractionFallback(
  db: Database,
  detail: {
    session_id: string;
    project: string;
    reason: 'opus_timeout' | 'opus_non_2xx' | 'opus_auth_failed' | 'opus_parse_failed' | 'opus_empty_response' | 'local_llm_failed' | string;
    fallback_model: string;
    http_status?: number;
  },
): void {
  writeTelemetrySignal(db, 'frame_extraction_fallback', detail);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function writeTelemetrySignal(
  db: Database,
  eventKind: string,
  detail: Record<string, unknown>,
): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, ?, ?, ?)`,
    ).run(detail.session_id as string ?? '', eventKind, JSON.stringify(detail), 'phase12-signals');

    enforceRowCap(db, eventKind);
  } catch (err) {
    if (process.env.CLAUDEX_DEBUG === '1') {
      console.error(`[telemetry-signals] write failed for ${eventKind}:`, err);
    }
  }
}

function enforceRowCap(db: Database, eventKind: string): void {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) as cnt FROM telemetry WHERE event_kind = ?`)
      .get(eventKind) as { cnt: number };
    if (row.cnt > MAX_ROWS_PER_SIGNAL_KIND) {
      db.prepare(
        `DELETE FROM telemetry WHERE rowid IN (
           SELECT rowid FROM telemetry WHERE event_kind = ?
           ORDER BY timestamp_epoch ASC
           LIMIT ?
         )`,
      ).run(eventKind, row.cnt - MAX_ROWS_PER_SIGNAL_KIND);
    }
  } catch {
    // Row-cap failure is non-fatal — signal was already written
  }
}
