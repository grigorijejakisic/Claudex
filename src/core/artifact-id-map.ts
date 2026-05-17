/**
 * Phase 14-07a — legacy↔V17 ID mapping helpers.
 *
 * Single source of truth for ID translation during the V17 unification
 * transition window. The `artifact_id_map` table is populated once at
 * migrateV36toV37 time; subsequent callers (14-07b workers) READ from it
 * but do not modify its rows. 14-07c flips the legacy `artifacts.read_only`
 * flag at cutover. The map table drops one milestone post-cutover.
 *
 * V17 ID derivation formula (deterministic):
 *   content_hash = sha256(summary || COALESCE(content, ''))
 *   v17_id = sha256(legacy_id || ':' || project || ':' || timestamp_epoch_ms || ':' || content_hash).slice(0, 32)
 *
 * 32-char hex prefix matches V17's existing TEXT ID convention (lowercase hex randomblob(16)).
 */

import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';

// ─── ID Derivation ────────────────────────────────────────────────────────

/**
 * Input to the deterministic V17 ID derivation function.
 * All fields are required — the hash is sensitive to every field.
 */
export interface LegacyIdInput {
  legacy_id: number;
  project: string;
  /** timestamp_epoch_ms from the legacy artifacts table (milliseconds, post-V35) */
  timestamp_epoch_ms: number;
  /** summary column from legacy artifacts */
  summary: string;
  /** content column from legacy artifacts (nullable — treat null as '') */
  body: string;
}

/**
 * Derive a V17 TEXT hash ID from legacy artifact fields.
 *
 * Deterministic — same inputs → same V17 ID across runs, processes, and
 * DB connections. Any byte change in ANY input field produces a different ID.
 *
 * Formula:
 *   content_hash = sha256(summary || body)
 *   v17_id = sha256(legacy_id || ':' || project || ':' || timestamp_epoch_ms || ':' || content_hash).slice(0, 32)
 *
 * The 32-char prefix provides ~128 bits of collision resistance. Birthday
 * paradox probability at 1M artifacts: < 1 in 10^23. The `artifact_id_map`
 * UNIQUE constraint on v17_id guarantees uniqueness at insert time.
 */
export function generateV17IdFromLegacy(input: LegacyIdInput): string {
  const contentHash = createHash('sha256')
    .update(input.summary + input.body)
    .digest('hex');

  return createHash('sha256')
    .update(`${input.legacy_id}:${input.project}:${input.timestamp_epoch_ms}:${contentHash}`)
    .digest('hex')
    .slice(0, 32);
}

// ─── Lookup Helpers ───────────────────────────────────────────────────────

/**
 * Look up the V17 TEXT ID for a given legacy INTEGER artifact ID.
 *
 * Returns null if no mapping exists. Callers MUST treat null as an error
 * condition (a missing mapping means either the migration was incomplete or
 * the legacy row was inserted after the migration ran — both are anomalies).
 */
export function lookupV17ByLegacy(db: Database, legacy_id: number): string | null {
  const row = db.prepare(
    `SELECT v17_id FROM artifact_id_map WHERE legacy_id = ?`
  ).get(legacy_id) as { v17_id: string } | undefined;
  return row?.v17_id ?? null;
}

/**
 * Reverse lookup: legacy INTEGER artifact ID for a given V17 TEXT ID.
 *
 * Returns null if no mapping exists. Used by the 14-07c rollback path and
 * diagnostic tooling. The `idx_artifact_id_map_v17` index makes this O(log n).
 */
export function lookupLegacyByV17(db: Database, v17_id: string): number | null {
  const row = db.prepare(
    `SELECT legacy_id FROM artifact_id_map WHERE v17_id = ?`
  ).get(v17_id) as { legacy_id: number } | undefined;
  return row?.legacy_id ?? null;
}

// ─── Bulk Population ──────────────────────────────────────────────────────

/**
 * Populate `artifact_id_map` for every row currently in legacy `artifacts`.
 *
 * Single authorized call site: `migrateV36toV37`. Idempotent — if a mapping
 * already exists for a legacy_id (INSERT OR IGNORE on the UNIQUE constraint),
 * it is skipped silently and counted in `skipped`.
 *
 * Also inserts corresponding rows into the V17 `artifact` table (if not
 * already present) using the RCA-3 field mapping:
 *   summary → title
 *   content → body (null → '')
 *   artifact_type → kind
 *   importance (1-5) → confidence (0.0-1.0, formula: importance / 5.0)
 *   state ('fresh','packed','materialized') → status ('active','stale','superseded')
 *   timestamp_epoch_ms → created_at_epoch_ms (same unit post-V35)
 *   Other fields → data JSON sidecar
 *
 * Embeddings are NOT populated here — that is 14-07c's re-vectorize step.
 *
 * Returns `{ inserted, skipped }` counts.
 */
export function populateAllMappings(
  db: Database
): { inserted: number; skipped: number } {
  if (!tableExists(db, 'artifacts')) return { inserted: 0, skipped: 0 };
  if (!tableExists(db, 'artifact')) return { inserted: 0, skipped: 0 };

  const legacyRows = db.prepare(`
    SELECT id, session_id, project, artifact_type, artifact_ref,
           summary, content, state, ttl, importance,
           retrieval_score, timestamp_epoch_ms, last_materialized_epoch_ms,
           activation_score, superseded_by, valid_until, confidence,
           novelty_score
    FROM artifacts
  `).all() as Array<{
    id: number;
    session_id: string;
    project: string;
    artifact_type: string;
    artifact_ref: string | null;
    summary: string;
    content: string | null;
    state: string;
    ttl: number;
    importance: number;
    retrieval_score: number;
    timestamp_epoch_ms: number;
    last_materialized_epoch_ms: number | null;
    activation_score: number;
    superseded_by: number | null;
    valid_until: number | null;
    confidence: number;
    novelty_score: number;
  }>;

  const insertArtifactStmt = db.prepare(`
    INSERT OR IGNORE INTO artifact(
      id, kind, title, body, scope, status, confidence,
      created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMapStmt = db.prepare(`
    INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
    VALUES (?, ?, ?, ?)
  `);

  const now = Date.now();
  let inserted = 0;
  let skipped = 0;

  const doInsert = db.transaction(() => {
    for (const row of legacyRows) {
      const v17Id = generateV17IdFromLegacy({
        legacy_id: row.id,
        project: row.project,
        timestamp_epoch_ms: row.timestamp_epoch_ms,
        summary: row.summary,
        body: row.content ?? '',
      });

      const v17Confidence = row.importance / 5.0;
      const v17Status = stateToStatus(row.state);

      const dataSidecar: Record<string, unknown> = {
        migrated_from_legacy_id: row.id,
        ttl: row.ttl,
        retrieval_score: row.retrieval_score,
        activation_score: row.activation_score,
        novelty_score: row.novelty_score,
      };
      if (row.artifact_ref !== null) dataSidecar['artifact_ref'] = row.artifact_ref;
      if (row.last_materialized_epoch_ms !== null) {
        dataSidecar['last_materialized_epoch'] = row.last_materialized_epoch_ms;
      }
      if (row.valid_until !== null) dataSidecar['valid_until'] = row.valid_until;

      // Insert V17 artifact row (idempotent — OR IGNORE on PK).
      insertArtifactStmt.run(
        v17Id,
        row.artifact_type,
        row.summary,
        row.content ?? '',
        'project',
        v17Status,
        v17Confidence,
        row.timestamp_epoch_ms,
        row.timestamp_epoch_ms,
        row.session_id,
        row.project,
        JSON.stringify(dataSidecar),
      );

      // Insert mapping row (idempotent — OR IGNORE on UNIQUE v17_id).
      const mapResult = insertMapStmt.run(row.id, v17Id, now, row.project);
      if (mapResult.changes > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }
  });

  doInsert();
  return { inserted, skipped };
}

// ─── Completeness Verification ────────────────────────────────────────────

/**
 * Verify mapping completeness: every legacy `artifacts` row must have a
 * corresponding entry in `artifact_id_map`.
 *
 * Returns `{ total_legacy, mapped, unmapped }`.
 * - `unmapped === 0` → mapping is complete (healthy).
 * - `unmapped > 0` → partial migration (anomaly; 14-07c cutover must refuse).
 *
 * This is the pre-cutover gate called by 14-07c before flipping legacy
 * `artifacts.read_only` to TRUE.
 */
export function verifyMappingComplete(
  db: Database
): { total_legacy: number; mapped: number; unmapped: number } {
  if (!tableExists(db, 'artifacts')) {
    return { total_legacy: 0, mapped: 0, unmapped: 0 };
  }
  if (!tableExists(db, 'artifact_id_map')) {
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number }
    ).n;
    return { total_legacy: total, mapped: 0, unmapped: total };
  }

  const total_legacy = (
    db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number }
  ).n;
  const mapped = (
    db.prepare(`SELECT COUNT(*) AS n FROM artifact_id_map`).get() as { n: number }
  ).n;
  const unmapped = total_legacy - mapped;

  return { total_legacy, mapped, unmapped };
}

// ─── Internal Utilities ───────────────────────────────────────────────────

function tableExists(db: Database, name: string): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name) as { cnt: number };
  return row.cnt > 0;
}

function stateToStatus(state: string): string {
  switch (state) {
    case 'fresh': return 'active';
    case 'packed': return 'stale';
    case 'materialized': return 'superseded';
    default: return 'active';
  }
}
