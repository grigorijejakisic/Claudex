/**
 * Worker observation write-back — allows worker discoveries to persist in the
 * shared DB so parallel and future agents benefit from team work.
 *
 * Option A implementation (Anthropic recommended): Workers include observations
 * in their final report to the PM/main agent, which calls ingestWorkerObservation()
 * or ingestWorkerReport() for each. No staging tables, no polling.
 */

import type { Database } from 'better-sqlite3';
import { createHash } from 'crypto';
import { insertObservation } from '../core/observations.js';
import { createArtifact } from '../core/artifacts.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { redactContent } from '../extraction/redaction.js';

/** Maximum characters for a stored observation. Longer text is truncated. */
const OBS_MAX_CHARS = 2000;

/** Minimum importance threshold — low-signal observations are rejected. */
const MIN_IMPORTANCE = 3;

export interface WorkerObservation {
  worker_id: string;
  task_description: string;
  observation: string;
  files_involved: string[];
  importance: number;   // 1-5
  session_id: string;
}

/**
 * Computes a stable dedup hash from (worker_id + observation text + session_id).
 * Includes session_id so that cross-session re-observation of the same fact is
 * not silently dropped — legitimate in a new session context.
 */
function observationHash(workerId: string, observation: string, sessionId: string): string {
  return createHash('sha256')
    .update(`${workerId}\x00${observation}\x00${sessionId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Checks whether an observation with this exact (worker_id + text) combo
 * already exists in the DB (stored as obs_type = 'worker:<hash>').
 */
function isDuplicate(db: Database, hash: string): boolean {
  try {
    const row = cachedPrepare(db,
      `SELECT 1 FROM observations WHERE obs_type = ? LIMIT 1`
    ).get(`worker:${hash}`);
    return row != null;
  } catch {
    return false;
  }
}

/**
 * Ingests a single worker observation into the shared observations table.
 *
 * Quality gates (applied in order):
 * 1. Importance threshold: importance >= 3 — rejects low-signal observations.
 * 2. Dedup: hash of (worker_id + observation text) — skips duplicate writes.
 * 3. Redaction: applies redactContent() to strip secrets/PII before storage.
 * 4. Length cap: truncates observation to 2000 chars.
 *
 * Storage mapping:
 * - tool_name  → 'worker_report'
 * - category   → 'other' (CHECK constraint only allows known categories; team_discovery
 *                         is preserved in obs_type as 'worker:<hash>')
 * - title      → first 100 chars of (redacted) observation
 * - content    → full redacted observation (truncated to 2000 chars)
 * - obs_type   → 'worker:<hash>' — encodes dedup key + source identity
 * - files_modified → files_involved array
 *
 * Returns observation ID on success, '' if rejected.
 * Non-throwing.
 */
export function ingestWorkerObservation(
  db: Database,
  obs: WorkerObservation,
  project: string
): string {
  try {
    // Gate 1: importance threshold
    if (obs.importance < MIN_IMPORTANCE) {
      return '';
    }

    // Gate 2: dedup check (includes session_id so cross-session re-observation is allowed)
    const hash = observationHash(obs.worker_id, obs.observation, obs.session_id);
    if (isDuplicate(db, hash)) {
      return '';
    }

    // Gate 3: redaction
    const redacted = redactContent(obs.observation);

    // Gate 4: length cap
    const truncated = redacted.length > OBS_MAX_CHARS
      ? redacted.slice(0, OBS_MAX_CHARS)
      : redacted;

    const title = truncated.slice(0, 100);

    let id: number;
    try {
      id = insertObservation(db, {
        session_id: obs.session_id,
        project,
        tool_name: 'worker_report',
        category: 'other',
        title,
        content: truncated,
        importance: obs.importance,
        files_modified: obs.files_involved,
        obs_type: `worker:${hash}`,
      });
    } catch (e: any) {
      // Handle race condition: concurrent insert with same obs_type (UNIQUE constraint)
      if (e?.code === 'SQLITE_CONSTRAINT') return '';
      throw e; // Re-throw unexpected errors to outer catch
    }

    // C8: Promote high-importance worker observations to artifacts so they
    // surface via searchArtifacts in assembleWorkerContext.
    if (obs.importance >= 4) {
      try {
        createArtifact(
          db,
          obs.session_id,
          project,
          'observation',      // artifact_type
          String(id),         // artifact_ref — links back to observation
          title,              // summary
          truncated,          // content (already redacted and truncated)
          obs.importance,     // importance
        );
      } catch {
        // Non-throwing — artifact promotion is best-effort
      }
    }

    return String(id);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Heuristic importance scoring for batch ingestion
// ---------------------------------------------------------------------------

/**
 * Heuristically scores the importance of an observation extracted from a
 * worker's free-text report. Returns 1-5.
 *
 * Scoring rationale (matches existing Claudex gate patterns):
 * - 5: Critical/blocking/fatal keywords → important architectural signals
 * - 4: Error/warning/found/discovered → meaningful findings
 * - 3: Default for anything that looks like a real observation
 * - 2: Very short fragments (< 20 chars) → likely noise
 * - 1: Single-word or whitespace-only fragments → definitely noise
 */
function scoreObservationImportance(text: string): number {
  const t = text.trim();
  if (!t || t.length < 5) return 1;
  if (t.length < 20) return 2;

  const lower = t.toLowerCase();

  // High-signal keywords → 5
  if (/\b(critical|blocking|fatal|must|required|breaking|regression)\b/.test(lower)) {
    return 5;
  }

  // Medium-high signal → 4
  if (/\b(error|warning|bug|issue|found|discovered|note|important|unexpected)\b/.test(lower)) {
    return 4;
  }

  // Default for substantive text
  return 3;
}

/**
 * Splits a worker's free-text report into individual observations.
 * Recognises:
 * - Bullet points: lines starting with -, *, •, –
 * - Numbered items: lines starting with 1. / 1) / (1)
 * - Paragraph breaks (double newline) when no list markers found
 *
 * Returns non-empty strings only.
 */
function splitReportIntoObservations(reportText: string): string[] {
  if (!reportText || !reportText.trim()) return [];

  // Try bullet/numbered split first
  const lines = reportText.split('\n');
  const listItems: string[] = [];

  for (const line of lines) {
    const stripped = line.replace(/^[\s]*[-*•–]\s+/, '').replace(/^[\s]*\d+[.)]\s+/, '').replace(/^[\s]*\(\d+\)\s+/, '').trim();
    // Only keep lines that had a list marker
    if (
      stripped &&
      stripped !== line.trim() &&
      stripped.length > 0
    ) {
      listItems.push(stripped);
    }
  }

  if (listItems.length > 0) {
    // Also preserve substantive non-list paragraphs (context, analysis, etc.)
    const paragraphs = reportText
      .split(/\n{2,}/)
      .map(p => p.replace(/\n/g, ' ').trim())
      .filter(p => p.length > 20 && !listItems.some(li => p.includes(li)));
    return [...listItems, ...paragraphs];
  }

  // Fall back to paragraph splitting
  return reportText
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(p => p.length > 0);
}

/**
 * Parses a worker's final report text, extracts individual observations,
 * scores each heuristically, and calls ingestWorkerObservation for each
 * that passes the quality gate.
 *
 * Returns count of observations successfully ingested.
 * Non-throwing.
 */
export function ingestWorkerReport(
  db: Database,
  workerId: string,
  reportText: string,
  taskDescription: string,
  project: string,
  sessionId: string
): number {
  try {
    const observations = splitReportIntoObservations(reportText);
    let count = 0;

    for (const observation of observations) {
      if (!observation.trim()) continue;

      const importance = scoreObservationImportance(observation);
      const result = ingestWorkerObservation(
        db,
        {
          worker_id: workerId,
          task_description: taskDescription,
          observation,
          files_involved: [],
          importance,
          session_id: sessionId,
        },
        project
      );

      if (result !== '') {
        count++;
      }
    }

    return count;
  } catch {
    return 0;
  }
}
