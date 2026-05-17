/**
 * Phase 14-07b W5 — V7 unified schema test helpers.
 *
 * Provides fixture builders and assertion helpers for the V17 unified artifact
 * schema. Designed for the cutover transition window:
 *
 *   - `createV17Artifact`   — seeds a V17 `artifact` row; returns its TEXT id.
 *   - `createLegacyArtifact` — seeds a legacy `artifacts` row (transitional
 *                              bridge for tests that haven't been swept yet);
 *                              returns INTEGER rowid.
 *   - `assertV17Shape`      — asserts a raw DB row matches the V17 kernel shape.
 *   - `migrateFixtureToV17` — converts a legacy-shaped fixture object to
 *                              V17ArtifactFixture (does NOT write to DB).
 *
 * Dual-mode: createLegacyArtifact is intentionally preserved for the transition
 * window. Once 14-07c's cutover script runs and the legacy table becomes
 * read-only, tests using createLegacyArtifact will surface as failures —
 * that's the intended signal to complete their migration.
 *
 * W5 owns this file. W1-W4 consume it via import. Do NOT modify it from
 * outside W5 — changes go through the W5 branch.
 *
 * 14-07b: v7-unified-schema helper (new file)
 */

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { generateV17IdFromLegacy, populateAllMappings, type LegacyIdInput } from '../../core/artifact-id-map.js';
import { migrateV36toV37 } from '../../core/migration-steps.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Fields for seeding a V17 unified artifact row.
 * Mirrors the V17 `artifact` kernel table (v17-ddl.ts ARTIFACT_KERNEL_DDL).
 */
export interface V17ArtifactFixture {
  /** V17 TEXT id. If omitted, derived via hash from title + body + project. */
  id?: string;
  /** kind column — e.g. 'observation', 'learning', 'entity_summary'. */
  kind: string;
  /** Project scope. */
  project: string;
  /** Title (maps from legacy `summary`). Nullable in schema; required here. */
  title: string;
  /** Body (maps from legacy `content`). */
  body: string;
  /** Status enum: 'active' | 'stale' | 'superseded'. Default: 'active'. */
  status?: 'active' | 'stale' | 'superseded';
  /** Confidence [0, 1]. Maps from legacy `importance` / 5.0. Default: 0.6. */
  confidence?: number;
  /** created_at_epoch_ms (milliseconds). Default: Date.now(). */
  created_at_epoch_ms?: number;
  /** session_id for the owning session. Default: 'test-session'. */
  session_id?: string;
  /** Additional JSON data sidecar fields (ttl, activation_score, etc.). */
  data?: Record<string, unknown>;
}

/**
 * Legacy-shaped artifact fixture. Matches the columns of the legacy `artifacts`
 * table. Used by createLegacyArtifact for the transitional period.
 */
export interface LegacyArtifactFixture {
  session_id?: string;
  project?: string;
  artifact_type?: string;
  artifact_ref?: string | null;
  summary: string;
  content?: string | null;
  state?: 'fresh' | 'packed' | 'materialized';
  ttl?: number;
  importance?: number;
  timestamp_epoch_ms?: number;
  activation_score?: number;
  novelty_score?: number;
  confidence?: number;
  superseded_by?: number | null;
  valid_until?: number | null;
}

// ─── ID derivation ────────────────────────────────────────────────────────────

/**
 * Derive a stable V17 TEXT id from fixture content (for tests that don't
 * provide an explicit id). Not the same formula as generateV17IdFromLegacy —
 * this is a test-side deterministic hash.
 *
 * Formula: sha256(kind + ':' + project + ':' + title + ':' + body).slice(0, 32)
 */
function deriveTestV17Id(
  kind: string,
  project: string,
  title: string,
  body: string,
): string {
  return createHash('sha256')
    .update(`${kind}:${project}:${title}:${body}`)
    .digest('hex')
    .slice(0, 32);
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Seed a V17 `artifact` row directly. Returns the V17 TEXT id.
 *
 * Does NOT insert into legacy `artifacts` — writes go DIRECTLY to V17.
 * Suitable for tests that exercise code paths already migrated to V17.
 *
 * Idempotent: INSERT OR IGNORE — if a row with this id already exists,
 * the function returns the id without error.
 *
 * 14-07b: migrated write path — V17 artifact direct insert
 */
export function createV17Artifact(
  db: Database,
  fixture: Partial<V17ArtifactFixture> & { kind: string; project: string; title: string },
): string {
  const now = Date.now();
  const body = fixture.body ?? '';
  const id =
    fixture.id ??
    deriveTestV17Id(fixture.kind, fixture.project, fixture.title, body);
  const status = fixture.status ?? 'active';
  const confidence = fixture.confidence ?? 0.6;
  const created_at = fixture.created_at_epoch_ms ?? now;
  const session_id = fixture.session_id ?? 'test-session';
  const data = JSON.stringify(fixture.data ?? {});

  db.prepare(`
    INSERT OR IGNORE INTO artifact(
      id, kind, title, body, scope, status, confidence,
      created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fixture.kind,
    fixture.title,
    body,
    'project',
    status,
    confidence,
    created_at,
    created_at,
    session_id,
    fixture.project,
    data,
  );

  return id;
}

/**
 * Seed a legacy `artifacts` row (transitional bridge).
 *
 * Returns the INTEGER rowid. Use this ONLY for tests that are testing
 * code paths that still read from the legacy `artifacts` table during
 * the transition window. Migrate callers to createV17Artifact as
 * W1-W4 workers land their production-code migrations.
 *
 * 14-07b: transitional helper — remove after 14-07c cutover
 */
export function createLegacyArtifact(
  db: Database,
  fixture: LegacyArtifactFixture,
): number {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO artifacts(
      session_id, project, artifact_type, artifact_ref,
      summary, content, state, ttl, importance,
      timestamp_epoch_ms, activation_score, novelty_score, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fixture.session_id ?? 'test-session',
    fixture.project ?? 'test-project',
    fixture.artifact_type ?? 'observation',
    fixture.artifact_ref ?? null,
    fixture.summary,
    fixture.content ?? null,
    fixture.state ?? 'fresh',
    fixture.ttl ?? 3,
    fixture.importance ?? 3,
    fixture.timestamp_epoch_ms ?? now,
    fixture.activation_score ?? 0.0,
    fixture.novelty_score ?? 0.0,
    fixture.confidence ?? 0.6,
  );

  return Number(result.lastInsertRowid);
}

/**
 * Convert a legacy-shaped fixture object to a V17ArtifactFixture.
 * Does NOT write to DB — pure field-mapping transformation.
 *
 * Field mapping per RCA-3 loss-map:
 *   summary          → title
 *   content          → body
 *   artifact_type    → kind
 *   importance (1-5) → confidence (0-1, formula: importance / 5.0)
 *   state            → status (enum shift)
 *   timestamp_epoch_ms → created_at_epoch_ms (same unit)
 *   ttl, activation_score, novelty_score, etc. → data sidecar
 *
 * 14-07b: field-mapping helper per RCA-3 loss-map
 */
export function migrateFixtureToV17(
  legacy: LegacyArtifactFixture & { id?: number },
): V17ArtifactFixture {
  const importance = legacy.importance ?? 3;
  const state = legacy.state ?? 'fresh';
  const statusMap: Record<string, 'active' | 'stale' | 'superseded'> = {
    fresh: 'active',
    packed: 'stale',
    materialized: 'superseded',
  };

  const data: Record<string, unknown> = {};
  if (legacy.ttl !== undefined) data['ttl'] = legacy.ttl;
  if (legacy.id !== undefined) data['migrated_from_legacy_id'] = legacy.id;

  // V17 TEXT id: if no legacy numeric id to derive from, use content hash
  let id: string | undefined;
  if (legacy.id !== undefined) {
    const input: LegacyIdInput = {
      legacy_id: legacy.id,
      project: legacy.project ?? 'test-project',
      timestamp_epoch_ms: legacy.timestamp_epoch_ms ?? Date.now(),
      summary: legacy.summary,
      body: legacy.content ?? '',
    };
    id = generateV17IdFromLegacy(input);
  }

  return {
    id,
    kind: legacy.artifact_type ?? 'observation',
    project: legacy.project ?? 'test-project',
    title: legacy.summary,
    body: legacy.content ?? '',
    status: statusMap[state] ?? 'active',
    confidence: importance / 5.0,
    created_at_epoch_ms: legacy.timestamp_epoch_ms ?? Date.now(),
    session_id: legacy.session_id ?? 'test-session',
    data: Object.keys(data).length > 0 ? data : undefined,
  };
}

/**
 * Assert that a raw DB row matches the V17 artifact kernel shape.
 * Throws `AssertionError` (via standard Node.js `assert`) if the shape
 * is wrong; does not use vitest so it remains usable in non-test contexts.
 *
 * Checked fields: id (TEXT non-empty), kind (TEXT non-empty), body (TEXT),
 * status (one of 'active'|'stale'|'superseded'), confidence (0-1 range),
 * created_at_epoch_ms (positive integer), project (TEXT non-empty).
 *
 * 14-07b: shape assertion for post-migration V17 rows
 */
export function assertV17Shape(row: unknown): asserts row is V17ArtifactRow {
  if (row === null || typeof row !== 'object') {
    throw new Error(`assertV17Shape: expected an object, got ${JSON.stringify(row)}`);
  }

  const r = row as Record<string, unknown>;

  if (typeof r['id'] !== 'string' || r['id'].length === 0) {
    throw new Error(`assertV17Shape: id must be a non-empty string, got ${JSON.stringify(r['id'])}`);
  }
  if (r['id'].length > 64) {
    throw new Error(`assertV17Shape: id length ${r['id'].length} exceeds 64 chars (V17 TEXT hash convention)`);
  }
  if (typeof r['kind'] !== 'string' || r['kind'].length === 0) {
    throw new Error(`assertV17Shape: kind must be a non-empty string`);
  }
  if (typeof r['body'] !== 'string') {
    throw new Error(`assertV17Shape: body must be a string`);
  }
  const validStatuses = new Set(['active', 'stale', 'superseded']);
  if (!validStatuses.has(r['status'] as string)) {
    throw new Error(`assertV17Shape: status must be one of active|stale|superseded, got ${JSON.stringify(r['status'])}`);
  }
  if (typeof r['confidence'] !== 'number' || r['confidence'] < 0 || r['confidence'] > 1) {
    throw new Error(`assertV17Shape: confidence must be a number in [0,1], got ${JSON.stringify(r['confidence'])}`);
  }
  if (typeof r['created_at_epoch_ms'] !== 'number' || r['created_at_epoch_ms'] <= 0) {
    throw new Error(`assertV17Shape: created_at_epoch_ms must be a positive number`);
  }
  if (typeof r['project'] !== 'string' || r['project'].length === 0) {
    throw new Error(`assertV17Shape: project must be a non-empty string`);
  }
}

/**
 * Type representing a V17 artifact row as returned by a SELECT * FROM artifact
 * query (minimum required fields). Used as the assertion target type.
 */
export interface V17ArtifactRow {
  id: string;
  kind: string;
  title: string | null;
  body: string;
  scope: string | null;
  status: 'active' | 'stale' | 'superseded';
  confidence: number;
  created_at_epoch_ms: number;
  updated_at_epoch_ms: number;
  session_id: string | null;
  project: string;
  data: string;
}

// ─── Migration helper ─────────────────────────────────────────────────────────

/**
 * Run the V36→V37 migration on a test DB and synchronize all existing legacy
 * `artifacts` rows into the V17 `artifact` table.
 *
 * Used by tests that start from a legacy-shaped fixture DB (V36 schema) and
 * need to exercise the V37 migration path. After this call, `artifact_id_map`,
 * `vec_artifact_v17`, and V17 `artifact` rows are all present.
 *
 * Unlike the raw `migrateV36toV37` call (which is idempotency-guarded and
 * skips population if `artifact_id_map` already exists), this helper always
 * re-runs `populateAllMappings` to sync any legacy rows that were inserted
 * AFTER the initial migration ran. This makes it useful for test setup that
 * seeds legacy rows and then calls this function to materialize them into V17.
 *
 * Idempotent — safe to call multiple times. Existing V17 rows are skipped
 * via INSERT OR IGNORE.
 *
 * 14-07b: test-side migration runner for fixture DBs
 */
export function runMigrateFixtureToV37(db: Database): void {
  // Ensure the schema (tables, indexes, artifact_id_map) exists.
  migrateV36toV37(db);
  // Sync any legacy artifacts rows → V17 artifact + artifact_id_map entries.
  // This is idempotent (INSERT OR IGNORE) and handles rows added after the
  // initial migration ran.
  populateAllMappings(db);
}
