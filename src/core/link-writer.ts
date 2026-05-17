/**
 * Phase 14-07-LINKS-SCHEMA — canonical link-write API.
 *
 * Soft links: writeSoftLink (autonomous, commits immediately).
 * Hard links: proposeHardLink (creates PENDING row) →
 *   confirmHardLink (operator confirms) | rejectHardLink (operator
 *   rejects; increments decay_count) | decayHardLink (proposer
 *   self-decays after threshold).
 *
 * Per memory/project_v7_hard_link_writer_is_good_child.md, the
 * Good Child hybrid policy is the contract this file enforces:
 *   - Soft links commit autonomously at write-time (no inference needed;
 *     the write site already knows the relationship by construction).
 *   - Hard links are *proposed* first; operator must confirm before they
 *     enter the active link graph. Hallucinated certainty compounds —
 *     especially for 'contradicts' links that shape future retrieval.
 *
 * Wave 2 workers (D/E/F/G) consume these helpers; NONE bypass them.
 */

import type { Database } from 'better-sqlite3';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Default rejection count before the proposer stops re-suggesting a
 * (src, dst, type) tuple. Tunable post-ship by changing this export
 * (or a future config surface).
 *
 * Locked at 3 per Phase 14-07-CONTEXT Locked Decision.
 */
export const DECAY_THRESHOLD = 3;

// ─── Soft Link Types ──────────────────────────────────────────────────────────

export type SoftLinkType =
  | 'supersedes'
  | 'promoted_to'
  | 'extracted_from'
  | 'references';

export interface WriteSoftLinkParams {
  src_artifact_id: string;
  dst_artifact_id: string;
  type: SoftLinkType;
  /** Default 1.0 */
  confidence?: number;
  created_by_session: string;
  /** Serialized to JSON text in the `data` column. */
  data?: object;
}

export interface SoftLinkRow {
  id: number;
  src: string;
  dst: string;
  type: SoftLinkType;
  confidence: number;
  created_at_epoch_ms: number;
  data?: object;
}

// ─── Hard Link Types ──────────────────────────────────────────────────────────

export type HardLinkType =
  | 'triggered_by'
  | 'evidence_for'
  | 'contradicts';

export interface ProposeHardLinkParams {
  src_artifact_id: string;
  dst_artifact_id: string;
  type: HardLinkType;
  proposed_confidence: number;
  proposed_by_session: string;
  proposer_rationale: string;
}

export interface PendingHardLinkRow {
  id: number;
  src: string;
  dst: string;
  type: HardLinkType;
  proposed_confidence: number;
  proposer_rationale: string;
  proposed_at_epoch_ms: number;
}

export interface ConfirmedHardLinkRow {
  id: number;
  src: string;
  dst: string;
  type: HardLinkType;
  proposed_confidence: number;
}

// ─── Soft Link Helpers ────────────────────────────────────────────────────────

/**
 * Write a soft link. Commits immediately (autonomous tier).
 *
 * Returns the row's INTEGER id. On duplicate (src, dst, type) — UNIQUE
 * constraint exists — returns the existing row's id without error. This
 * is intentional: idempotent upsert semantics allow callers to call
 * writeSoftLink at the write site unconditionally.
 *
 * Project value is looked up from the src artifact at write time
 * (denormalization per Phase 14-07-CONTEXT Locked Decision).
 *
 * @throws if src or dst artifact IDs do not exist (FK violation).
 * @throws if type is not a valid SoftLinkType (CHECK violation).
 * @throws if confidence is outside [0.0, 1.0] (CHECK violation).
 */
export function writeSoftLink(db: Database, params: WriteSoftLinkParams): number {
  const {
    src_artifact_id,
    dst_artifact_id,
    type,
    confidence = 1.0,
    created_by_session,
    data,
  } = params;

  const now = Date.now();

  // Resolve project from src artifact (denormalization).
  const srcRow = db.prepare(
    `SELECT project FROM artifact WHERE id = ?`
  ).get(src_artifact_id) as { project: string } | undefined;

  if (!srcRow) {
    throw new Error(
      `writeSoftLink: src_artifact_id '${src_artifact_id}' not found in artifact table. ` +
      `Links are only valid between V17 artifact rows.`
    );
  }

  const project = srcRow.project;
  const dataJson = data != null ? JSON.stringify(data) : null;

  // Insert OR IGNORE (UNIQUE on (src, dst, type)). If the row already exists,
  // changes = 0 and we fall through to the SELECT to return the existing id.
  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO soft_link
      (src_artifact_id, dst_artifact_id, type, confidence,
       created_by_session, created_at_epoch_ms, project, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    src_artifact_id, dst_artifact_id, type, confidence,
    created_by_session, now, project, dataJson
  );

  if (insertResult.changes > 0) {
    return Number(insertResult.lastInsertRowid);
  }

  // Duplicate — return existing id.
  const existing = db.prepare(
    `SELECT id FROM soft_link WHERE src_artifact_id = ? AND dst_artifact_id = ? AND type = ?`
  ).get(src_artifact_id, dst_artifact_id, type) as { id: number };

  return existing.id;
}

/**
 * List soft links for an artifact.
 *
 * @param direction — 'outgoing' (artifact is src), 'incoming' (artifact is dst),
 *                    'both' (union of outgoing + incoming). Default: 'both'.
 * @param types — optional filter; returns all types if omitted.
 */
export function listSoftLinks(
  db: Database,
  artifact_id: string,
  direction: 'outgoing' | 'incoming' | 'both' = 'both',
  types?: SoftLinkType[]
): SoftLinkRow[] {
  const buildTypeClause = (paramOffset: number) =>
    types && types.length > 0
      ? `AND type IN (${types.map((_, i) => `?`).join(', ')})`
      : '';

  const typeParams = types && types.length > 0 ? types : [];

  let rows: Array<{
    id: number;
    src_artifact_id: string;
    dst_artifact_id: string;
    type: string;
    confidence: number;
    created_at_epoch_ms: number;
    data: string | null;
  }> = [];

  if (direction === 'outgoing' || direction === 'both') {
    const outgoing = db.prepare(`
      SELECT id, src_artifact_id, dst_artifact_id, type, confidence, created_at_epoch_ms, data
      FROM soft_link
      WHERE src_artifact_id = ? ${buildTypeClause(1)}
      ORDER BY id
    `).all(artifact_id, ...typeParams) as typeof rows;
    rows = rows.concat(outgoing);
  }

  if (direction === 'incoming' || direction === 'both') {
    const incoming = db.prepare(`
      SELECT id, src_artifact_id, dst_artifact_id, type, confidence, created_at_epoch_ms, data
      FROM soft_link
      WHERE dst_artifact_id = ? ${buildTypeClause(1)}
      ORDER BY id
    `).all(artifact_id, ...typeParams) as typeof rows;
    rows = rows.concat(incoming);
  }

  // Deduplicate by id (possible when direction='both' and artifact is both src and dst).
  const seen = new Set<number>();
  const deduplicated = rows.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  return deduplicated.map(r => ({
    id: r.id,
    src: r.src_artifact_id,
    dst: r.dst_artifact_id,
    type: r.type as SoftLinkType,
    confidence: r.confidence,
    created_at_epoch_ms: r.created_at_epoch_ms,
    data: r.data != null ? (JSON.parse(r.data) as object) : undefined,
  }));
}

// ─── Hard Link Helpers ────────────────────────────────────────────────────────

/**
 * Get the current rejection count for a (src, dst, type) tuple.
 *
 * Reads from the hard_link row's decay_count column. Returns 0 if no
 * row exists for the tuple (never proposed or already cleaned up).
 */
export function getDecayCount(
  db: Database,
  src: string,
  dst: string,
  type: HardLinkType
): number {
  const row = db.prepare(`
    SELECT decay_count FROM hard_link
    WHERE src_artifact_id = ? AND dst_artifact_id = ? AND type = ?
  `).get(src, dst, type) as { decay_count: number } | undefined;

  return row?.decay_count ?? 0;
}

/**
 * Propose a hard link (Good Child policy — propose-confirm tier).
 *
 * Inserts a row with confirmed_by_session = NULL (PENDING state).
 * Also inserts a 'proposed' row into hard_link_history.
 *
 * Pre-condition: checks getDecayCount BEFORE inserting. If the tuple
 * has already been rejected >= DECAY_THRESHOLD times, skips the
 * proposal and writes a `proposer_skipped_decayed` telemetry row instead.
 *
 * @returns The new row's INTEGER id, or null if the tuple was decayed.
 *
 * @throws if src or dst artifact IDs do not exist (FK violation).
 * @throws if the tuple already has a UNIQUE conflict (same src/dst/type row
 *         that is neither rejected nor decayed — cannot re-propose a pending
 *         or confirmed link).
 */
export function proposeHardLink(
  db: Database,
  params: ProposeHardLinkParams
): number | null {
  const {
    src_artifact_id,
    dst_artifact_id,
    type,
    proposed_confidence,
    proposed_by_session,
    proposer_rationale,
  } = params;

  // Decay guard: check existing row first.
  const existingRow = db.prepare(`
    SELECT id, decay_count, confirmed_by_session, rejected_by_session
    FROM hard_link
    WHERE src_artifact_id = ? AND dst_artifact_id = ? AND type = ?
  `).get(src_artifact_id, dst_artifact_id, type) as {
    id: number;
    decay_count: number;
    confirmed_by_session: string | null;
    rejected_by_session: string | null;
  } | undefined;

  if (existingRow) {
    if (existingRow.decay_count >= DECAY_THRESHOLD) {
      // Tuple is decayed — skip re-proposal. Write telemetry row.
      _writeTelemetryIfTable(db, proposed_by_session, {
        event: 'proposer_skipped_decayed',
        src: src_artifact_id,
        dst: dst_artifact_id,
        type,
        decay_count: existingRow.decay_count,
      });
      return null;
    }
  }

  // Resolve project from src artifact (denormalization).
  const srcRow = db.prepare(
    `SELECT project FROM artifact WHERE id = ?`
  ).get(src_artifact_id) as { project: string } | undefined;

  if (!srcRow) {
    throw new Error(
      `proposeHardLink: src_artifact_id '${src_artifact_id}' not found in artifact table.`
    );
  }

  const project = srcRow.project;
  const now = Date.now();

  // Insert the pending hard_link row.
  const insertResult = db.prepare(`
    INSERT INTO hard_link
      (src_artifact_id, dst_artifact_id, type, proposed_confidence,
       proposed_by_session, proposed_at_epoch_ms, proposer_rationale, project)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    src_artifact_id, dst_artifact_id, type, proposed_confidence,
    proposed_by_session, now, proposer_rationale, project
  );

  const newId = Number(insertResult.lastInsertRowid);

  // History: 'proposed' event.
  _insertHistory(db, newId, 'proposed', proposed_by_session, now, null);

  return newId;
}

/**
 * Operator action: confirm a pending hard link.
 *
 * Sets confirmed_by_session + confirmed_at_epoch_ms. Inserts a 'confirmed'
 * row into hard_link_history.
 *
 * @throws if the row does not exist.
 * @throws if the row is already confirmed (confirmed_by_session IS NOT NULL).
 * @throws if the row is already rejected (rejected_by_session IS NOT NULL).
 */
export function confirmHardLink(
  db: Database,
  hard_link_id: number,
  confirming_session: string
): void {
  const row = db.prepare(
    `SELECT id, confirmed_by_session, rejected_by_session FROM hard_link WHERE id = ?`
  ).get(hard_link_id) as {
    id: number;
    confirmed_by_session: string | null;
    rejected_by_session: string | null;
  } | undefined;

  if (!row) {
    throw new Error(`confirmHardLink: hard_link id ${hard_link_id} not found.`);
  }
  if (row.confirmed_by_session !== null) {
    throw new Error(
      `confirmHardLink: hard_link id ${hard_link_id} is already confirmed ` +
      `by session '${row.confirmed_by_session}'.`
    );
  }
  if (row.rejected_by_session !== null) {
    throw new Error(
      `confirmHardLink: hard_link id ${hard_link_id} has been rejected ` +
      `by session '${row.rejected_by_session}'. Cannot confirm a rejected link.`
    );
  }

  const now = Date.now();
  db.prepare(`
    UPDATE hard_link
    SET confirmed_by_session = ?, confirmed_at_epoch_ms = ?
    WHERE id = ?
  `).run(confirming_session, now, hard_link_id);

  _insertHistory(db, hard_link_id, 'confirmed', confirming_session, now, null);
}

/**
 * Operator action: reject a pending hard link.
 *
 * Sets rejected_by_session + rejected_at_epoch_ms. Increments decay_count.
 * Inserts a 'rejected' row into hard_link_history.
 *
 * Rejected rows are NOT deleted — they're retained as anti-links so the
 * proposer can check getDecayCount and skip re-suggesting at >= DECAY_THRESHOLD.
 *
 * @throws if the row does not exist.
 * @throws if the row is already confirmed (cannot reject a confirmed link).
 */
export function rejectHardLink(
  db: Database,
  hard_link_id: number,
  rejecting_session: string
): void {
  const row = db.prepare(
    `SELECT id, confirmed_by_session, rejected_by_session, decay_count FROM hard_link WHERE id = ?`
  ).get(hard_link_id) as {
    id: number;
    confirmed_by_session: string | null;
    rejected_by_session: string | null;
    decay_count: number;
  } | undefined;

  if (!row) {
    throw new Error(`rejectHardLink: hard_link id ${hard_link_id} not found.`);
  }
  if (row.confirmed_by_session !== null) {
    throw new Error(
      `rejectHardLink: hard_link id ${hard_link_id} is already confirmed. ` +
      `Cannot reject a confirmed link.`
    );
  }

  const now = Date.now();
  db.prepare(`
    UPDATE hard_link
    SET rejected_by_session = ?, rejected_at_epoch_ms = ?, decay_count = decay_count + 1
    WHERE id = ?
  `).run(rejecting_session, now, hard_link_id);

  _insertHistory(db, hard_link_id, 'rejected', rejecting_session, now, null);
}

/**
 * Proposer self-decay: explicitly mark a hard link as decayed.
 *
 * Called by the proposer when decay_count reaches DECAY_THRESHOLD — marks
 * the row definitively so future proposer runs see it immediately as decayed.
 * Inserts a 'decayed' row into hard_link_history.
 *
 * Unlike rejectHardLink (operator action), this is a proposer-side bookkeeping
 * action. It does NOT increment decay_count further (the threshold was already
 * reached by prior rejectHardLink calls).
 *
 * @throws if the row does not exist.
 */
export function decayHardLink(
  db: Database,
  hard_link_id: number,
  decaying_session: string
): void {
  const row = db.prepare(
    `SELECT id FROM hard_link WHERE id = ?`
  ).get(hard_link_id) as { id: number } | undefined;

  if (!row) {
    throw new Error(`decayHardLink: hard_link id ${hard_link_id} not found.`);
  }

  const now = Date.now();
  // Ensure decay_count reflects at least DECAY_THRESHOLD (belt-and-suspenders;
  // caller should have already incremented via rejectHardLink calls).
  db.prepare(`
    UPDATE hard_link
    SET decay_count = MAX(decay_count, ?)
    WHERE id = ?
  `).run(DECAY_THRESHOLD, hard_link_id);

  _insertHistory(db, hard_link_id, 'decayed', decaying_session, now, null);
}

/**
 * List PENDING hard links for a project.
 *
 * A hard link is PENDING when confirmed_by_session IS NULL AND
 * rejected_by_session IS NULL (operator hasn't acted yet).
 *
 * Used by 14-07f's formatPendingReviewLinksSection to render the
 * "Inferred Links Pending Review" assembly section.
 */
export function listPendingHardLinks(
  db: Database,
  project: string
): PendingHardLinkRow[] {
  const rows = db.prepare(`
    SELECT id, src_artifact_id, dst_artifact_id, type,
           proposed_confidence, proposer_rationale, proposed_at_epoch_ms
    FROM hard_link
    WHERE project = ?
      AND confirmed_by_session IS NULL
      AND rejected_by_session IS NULL
    ORDER BY proposed_at_epoch_ms DESC
  `).all(project) as Array<{
    id: number;
    src_artifact_id: string;
    dst_artifact_id: string;
    type: string;
    proposed_confidence: number;
    proposer_rationale: string;
    proposed_at_epoch_ms: number;
  }>;

  return rows.map(r => ({
    id: r.id,
    src: r.src_artifact_id,
    dst: r.dst_artifact_id,
    type: r.type as HardLinkType,
    proposed_confidence: r.proposed_confidence,
    proposer_rationale: r.proposer_rationale,
    proposed_at_epoch_ms: r.proposed_at_epoch_ms,
  }));
}

/**
 * List CONFIRMED hard links for an artifact.
 *
 * A hard link is CONFIRMED when confirmed_by_session IS NOT NULL.
 *
 * Used by 14-07e's link-distance boost and 14-07g's Provenance walker.
 *
 * @param direction — 'outgoing', 'incoming', or 'both'. Default: 'both'.
 */
export function listConfirmedHardLinks(
  db: Database,
  artifact_id: string,
  direction: 'outgoing' | 'incoming' | 'both' = 'both'
): ConfirmedHardLinkRow[] {
  let rows: Array<{
    id: number;
    src_artifact_id: string;
    dst_artifact_id: string;
    type: string;
    proposed_confidence: number;
  }> = [];

  if (direction === 'outgoing' || direction === 'both') {
    const outgoing = db.prepare(`
      SELECT id, src_artifact_id, dst_artifact_id, type, proposed_confidence
      FROM hard_link
      WHERE src_artifact_id = ? AND confirmed_by_session IS NOT NULL
      ORDER BY id
    `).all(artifact_id) as typeof rows;
    rows = rows.concat(outgoing);
  }

  if (direction === 'incoming' || direction === 'both') {
    const incoming = db.prepare(`
      SELECT id, src_artifact_id, dst_artifact_id, type, proposed_confidence
      FROM hard_link
      WHERE dst_artifact_id = ? AND confirmed_by_session IS NOT NULL
      ORDER BY id
    `).all(artifact_id) as typeof rows;
    rows = rows.concat(incoming);
  }

  // Deduplicate by id.
  const seen = new Set<number>();
  return rows
    .filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .map(r => ({
      id: r.id,
      src: r.src_artifact_id,
      dst: r.dst_artifact_id,
      type: r.type as HardLinkType,
      proposed_confidence: r.proposed_confidence,
    }));
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _insertHistory(
  db: Database,
  hard_link_id: number,
  action: 'proposed' | 'confirmed' | 'rejected' | 'decayed',
  session_id: string,
  action_at_epoch_ms: number,
  details: object | null
): void {
  db.prepare(`
    INSERT INTO hard_link_history
      (hard_link_id, action, session_id, action_at_epoch_ms, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    hard_link_id,
    action,
    session_id,
    action_at_epoch_ms,
    details != null ? JSON.stringify(details) : null
  );
}

/**
 * Write a telemetry row if the telemetry table exists.
 * Non-throwing — telemetry is best-effort.
 */
function _writeTelemetryIfTable(
  db: Database,
  session_id: string,
  detail: Record<string, unknown>
): void {
  try {
    const hasTelemetry = (
      db.prepare(
        `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='telemetry'`
      ).get() as { cnt: number }
    ).cnt > 0;

    if (!hasTelemetry) return;

    db.prepare(`
      INSERT INTO telemetry(session_id, event_kind, detail, timestamp_epoch_ms)
      VALUES (?, 'proposer_skipped_decayed', ?, ?)
    `).run(session_id, JSON.stringify(detail), Date.now());
  } catch {
    // Telemetry write failure is non-fatal — do not propagate.
  }
}
