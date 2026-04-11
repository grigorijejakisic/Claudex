/**
 * Project Curated Context CRUD.
 *
 * Privileged always-on injection slot per project (and globally). Written
 * authoritatively by the agent at /endsession with Angel fallback for
 * crashed sessions. Bypasses RRF ranking — not competing for slots in
 * hybrid retrieval.
 *
 * See context/specs/CURATED_CONTEXT.md for the full design.
 *
 * All functions are plain, non-throwing where safe (writes throw on invalid
 * input so the caller knows the write was rejected; reads return [] on error).
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { GLOBAL_PROJECT_SCOPE } from '../shared/constants.js';

export type CuratedType =
  | 'mental_model'
  | 'workspace_map'
  | 'shipped'
  | 'reframe'
  | 'constraint'
  | 'preference';

export type CuratedCurator = 'agent' | 'angel';

export type CuratedStatus = 'active' | 'superseded' | 'proposed' | 'archived';

export interface CuratedEntry {
  id: number;
  project: string;
  type: CuratedType;
  content: string;
  tags: string | null;
  supersedes_id: number | null;
  curator: CuratedCurator;
  trust_tier: number;
  status: CuratedStatus;
  source_session_id: string | null;
  created_at_epoch: number;
  updated_at_epoch: number;
}

/**
 * Types that are only valid at project scope (never __global__).
 * Enforced in writeEntry, not the DB CHECK, so we can evolve this without a
 * migration.
 */
const PROJECT_ONLY_TYPES: ReadonlySet<CuratedType> = new Set<CuratedType>([
  'workspace_map',
  'shipped',
]);

/** Default soft cap on the rendered curated-context block. */
export const CURATED_CONTEXT_TOKEN_CAP = 1500;

export interface WriteEntryParams {
  project: string;
  type: CuratedType;
  content: string;
  curator: CuratedCurator;
  tags?: string[];
  supersedes_id?: number;
  trust_tier?: number;
  status?: CuratedStatus;
  source_session_id?: string;
}

/**
 * Writes a new curated entry. Returns the inserted row id.
 *
 * Throws on invalid input so the caller knows the write was rejected:
 *   - Empty content
 *   - workspace_map / shipped at __global__ scope
 *
 * Defaults:
 *   - curator='agent'   → trust_tier=2, status='active'
 *   - curator='angel'   → trust_tier=1, status='proposed'
 *
 * If `supersedes_id` is provided, the referenced entry is automatically
 * marked status='superseded' in the same transaction.
 */
export function writeEntry(db: Database, params: WriteEntryParams): number {
  if (!params.content || params.content.trim().length === 0) {
    throw new Error('curated-context: content must be non-empty');
  }
  if (
    PROJECT_ONLY_TYPES.has(params.type) &&
    params.project === GLOBAL_PROJECT_SCOPE
  ) {
    throw new Error(
      `curated-context: type '${params.type}' is not valid at __global__ scope`,
    );
  }

  const curator = params.curator;
  const trustTier =
    params.trust_tier ?? (curator === 'angel' ? 1 : 2);
  const status =
    params.status ?? (curator === 'angel' ? 'proposed' : 'active');
  const tagsJson = params.tags ? JSON.stringify(params.tags) : null;

  const txn = db.transaction(() => {
    const result = cachedPrepare(
      db,
      `INSERT INTO project_curated_context
         (project, type, content, tags, supersedes_id, curator,
          trust_tier, status, source_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.project,
      params.type,
      params.content.trim(),
      tagsJson,
      params.supersedes_id ?? null,
      curator,
      trustTier,
      status,
      params.source_session_id ?? null,
    );

    const newId = Number(result.lastInsertRowid);

    // Automatic supersession: if this entry replaces another, mark the old
    // one as superseded in the same transaction. Only if the referenced
    // entry is currently active (don't re-supersede an already-superseded row).
    if (params.supersedes_id != null) {
      cachedPrepare(
        db,
        `UPDATE project_curated_context
            SET status = 'superseded', updated_at_epoch = unixepoch()
          WHERE id = ? AND status = 'active'`,
      ).run(params.supersedes_id);
    }

    return newId;
  });

  return txn();
}

/**
 * Lists active entries for a project. Includes global entries when
 * `includeGlobal` is true (default). Ordering: global first, then project,
 * then by type group, then newest first within each group.
 *
 * `status` filter defaults to 'active' but can be relaxed to fetch proposed
 * entries for review at /endsession.
 */
export function listEntries(
  db: Database,
  project: string,
  opts: {
    includeGlobal?: boolean;
    statuses?: readonly CuratedStatus[];
    types?: readonly CuratedType[];
  } = {},
): CuratedEntry[] {
  try {
    const includeGlobal = opts.includeGlobal ?? true;
    const statuses: readonly CuratedStatus[] =
      opts.statuses ?? (['active'] as const);

    const projects =
      includeGlobal && project !== GLOBAL_PROJECT_SCOPE
        ? [GLOBAL_PROJECT_SCOPE, project]
        : [project];

    const statusPlaceholders = statuses.map(() => '?').join(',');
    const projectPlaceholders = projects.map(() => '?').join(',');

    let typeClause = '';
    const typeArgs: string[] = [];
    if (opts.types && opts.types.length > 0) {
      typeClause = `AND type IN (${opts.types.map(() => '?').join(',')})`;
      typeArgs.push(...opts.types);
    }

    const sql = `
      SELECT * FROM project_curated_context
       WHERE project IN (${projectPlaceholders})
         AND status IN (${statusPlaceholders})
         ${typeClause}
       ORDER BY
         CASE project WHEN '${GLOBAL_PROJECT_SCOPE}' THEN 0 ELSE 1 END,
         CASE type
           WHEN 'mental_model' THEN 1
           WHEN 'reframe'      THEN 2
           WHEN 'preference'   THEN 3
           WHEN 'constraint'   THEN 4
           WHEN 'workspace_map' THEN 5
           WHEN 'shipped'      THEN 6
           ELSE 7
         END,
         created_at_epoch DESC`;

    return cachedPrepare(db, sql).all(
      ...projects,
      ...statuses,
      ...typeArgs,
    ) as CuratedEntry[];
  } catch {
    return [];
  }
}

/**
 * Marks an Angel-proposed entry as confirmed (tier 1 → 2, status → active).
 * No-op if the entry is not currently in the 'proposed' state.
 */
export function confirmEntry(db: Database, id: number): boolean {
  try {
    const result = cachedPrepare(
      db,
      `UPDATE project_curated_context
          SET trust_tier = 2, status = 'active', updated_at_epoch = unixepoch()
        WHERE id = ? AND status = 'proposed'`,
    ).run(id);
    return result.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Archives an entry (status → 'archived'). Used for both rejected
 * Angel-proposed entries and retiring stale agent-written entries.
 */
export function archiveEntry(db: Database, id: number): boolean {
  try {
    const result = cachedPrepare(
      db,
      `UPDATE project_curated_context
          SET status = 'archived', updated_at_epoch = unixepoch()
        WHERE id = ?`,
    ).run(id);
    return result.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Promotes an entry to tier 3 — user-marked permanent, immune to auto-
 * eviction. Only valid on active entries.
 */
export function promoteEntry(db: Database, id: number): boolean {
  try {
    const result = cachedPrepare(
      db,
      `UPDATE project_curated_context
          SET trust_tier = 3, updated_at_epoch = unixepoch()
        WHERE id = ? AND status = 'active'`,
    ).run(id);
    return result.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Convenience: supersede an existing entry by writing a new one that
 * replaces it. Returns the new entry's id. Wraps writeEntry to enforce
 * the two-step (insert new + mark old superseded) atomically.
 */
export function supersedeEntry(
  db: Database,
  oldId: number,
  newParams: Omit<WriteEntryParams, 'supersedes_id'>,
): number {
  return writeEntry(db, { ...newParams, supersedes_id: oldId });
}
