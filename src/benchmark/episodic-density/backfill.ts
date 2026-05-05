/**
 * Phase 2 IDX-01 — explicit one-time backfill (re-runnable, idempotent).
 *
 * Walks two sources and populates the V26 sidecar
 * `episodic_index_error_fingerprint` plus, for organic rows, the per-row
 * `episodic_events.metadata_json.error_fingerprint` payload:
 *
 *   1. Phase 1 organic — `episodic_events` rows where `provenance='tool_result'`
 *      AND `ts_epoch >= PHASE1_SHIP_TS_EPOCH` (commit 9434ab9, 2026-05-04).
 *      Sidecar tagged `corpus_origin='phase1_organic'`. The episodic_events
 *      row is byte-identical post-backfill except for its `metadata_json`
 *      (which gains the `error_fingerprint` key).
 *
 *   2. v4 artifact observations — rows in the legacy `artifacts` table where
 *      `artifact_type='observation'` whose content matches stack-trace shape.
 *      A SHADOW `episodic_events` row is written with
 *      `provenance='environmental'` and `source='backfill/v4-artifact'` so
 *      the sidecar's FK to `episodic_events(id)` is stable. v4 artifacts
 *      themselves are NOT mutated. Sidecar tagged `corpus_origin='v4_backfill'`.
 *
 * Idempotency: re-running produces the same final state. Sidecar inserts use
 * `INSERT OR IGNORE` (and a UNIQUE-by-tuple guard via INSERT-then-check is
 * unnecessary here: the harness reads aggregate counts, and at re-run we
 * simply re-attempt insertion of identical (shingle_hash, episode_event_id)
 * tuples; without a UNIQUE constraint, dupes can pile up — so the function
 * deletes any prior sidecar rows tagged with the corresponding origin AND
 * episode_event_id BEFORE reinsertion. Shadow row creation is guarded by a
 * `json_extract(metadata_json, '$.source_row_id')` lookup.
 *
 * **CONTEXT.md compliance:**
 *   - `conversation_turns` is NEVER read from this module.
 *   - episodic_events row content/provenance/ts_epoch are NEVER mutated for
 *     organic rows (only metadata_json).
 *   - v4 artifact rows are NEVER mutated.
 *
 * Single-threaded; deterministic order (`ORDER BY id ASC`).
 */

import type { Database } from 'better-sqlite3';
import {
  computeErrorFingerprint,
  looksLikeStackTrace,
  type ErrorFingerprint,
} from '../../core/error-fingerprint.js';
import { writeEnvironmentalEvent } from '../../core/episodic-events.js';
import {
  PHASE1_SHIP_TS_EPOCH,
  PHASE2_CLOSE_TS_EPOCH,
  FLOOR_FINGERPRINTED,
  FLOOR_PROJECTS,
  type BackfillSummary,
  type CorpusOrigin,
  type PerSourceCounters,
} from './types.js';

/**
 * Three-tier corpus_origin classifier (CONTEXT.md decision 1c).
 *
 * Pure: no DB, no clock. Tested directly in
 * `src/tests/benchmark/episodic-density/backfill-corpus-origin.test.ts`.
 *
 *   - provenance !== 'organic'  → 'v4_backfill'
 *   - provenance === 'organic' AND ts_epoch <= PHASE2_CLOSE_TS_EPOCH
 *       → 'phase1_organic_pre_phase2_close'
 *   - provenance === 'organic' AND ts_epoch >  PHASE2_CLOSE_TS_EPOCH
 *       → 'phase1_organic_post_phase2_close'
 *
 * Boundary inclusivity is documented on PHASE2_CLOSE_TS_EPOCH.
 */
export function classifyCorpusOrigin(provenance: string, ts_epoch: number): CorpusOrigin {
  if (provenance !== 'organic') return 'v4_backfill';
  return ts_epoch <= PHASE2_CLOSE_TS_EPOCH
    ? 'phase1_organic_pre_phase2_close'
    : 'phase1_organic_post_phase2_close';
}

interface OrganicRow {
  id: number;
  project: string;
  ts_epoch: number;
  content: string;
  metadata_json: string | null;
}

interface V4ArtifactRow {
  id: number;
  project: string;
  timestamp_epoch: number;
  content: string;
}

const ORGANIC_SELECT = `
  SELECT id, project, ts_epoch, content, metadata_json
    FROM episodic_events
   WHERE provenance = 'tool_result'
     AND ts_epoch >= ?
   ORDER BY id ASC
`;

const V4_SELECT = `
  SELECT id, project, timestamp_epoch, content
    FROM artifacts
   WHERE artifact_type = 'observation'
     AND content IS NOT NULL
   ORDER BY id ASC
`;

const SIDECAR_DELETE_BY_EVENT = `
  DELETE FROM episodic_index_error_fingerprint
   WHERE episode_event_id = ?
     AND corpus_origin = ?
`;

const SIDECAR_INSERT = `
  INSERT INTO episodic_index_error_fingerprint
    (shingle_hash, episode_event_id, ts_epoch, project, corpus_origin)
  VALUES (?, ?, ?, ?, ?)
`;

const ORGANIC_UPDATE_METADATA = `
  UPDATE episodic_events
     SET metadata_json = ?
   WHERE id = ?
`;

const SHADOW_LOOKUP = `
  SELECT id
    FROM episodic_events
   WHERE source = 'backfill/v4-artifact'
     AND json_extract(metadata_json, '$.source_row_id') = ?
   LIMIT 1
`;

function emptyCounters(): PerSourceCounters {
  return { rows_scanned: 0, fingerprinted: 0, sidecar_writes: 0, projects: [] };
}

function rememberProject(counters: PerSourceCounters, project: string): void {
  if (!counters.projects.includes(project)) counters.projects.push(project);
}

function tableExists(db: Database, name: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ?`,
  ).get(name) as { one: number } | undefined;
  return row != null;
}

function mergeFingerprint(metadataJson: string | null, fp: ErrorFingerprint): string {
  let parsed: Record<string, unknown> = {};
  if (metadataJson) {
    try {
      const candidate = JSON.parse(metadataJson);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON — replace with a fresh object that has only the fingerprint.
      parsed = {};
    }
  }
  parsed.error_fingerprint = fp;
  return JSON.stringify(parsed);
}

/**
 * Backfill Phase 1 organic tool_result rows. Mutates `metadata_json` to
 * splice in `error_fingerprint`; writes one sidecar row per shingle.
 *
 * Idempotent — re-runs delete prior sidecar rows for the same (event_id,
 * 'phase1_organic') tuple before reinserting.
 */
export function backfillPhase1Organic(
  db: Database,
  opts: { dryRun: boolean },
): PerSourceCounters {
  const counters = emptyCounters();
  const rows = db.prepare(ORGANIC_SELECT).all(PHASE1_SHIP_TS_EPOCH) as OrganicRow[];
  counters.rows_scanned = rows.length;

  for (const row of rows) {
    const fp = computeErrorFingerprint(row.content);
    if (!fp) continue;
    counters.fingerprinted++;
    rememberProject(counters, row.project);

    if (opts.dryRun) {
      counters.sidecar_writes += fp.shingles.length;
      continue;
    }

    // Phase 2.1: classify each organic row by ts_epoch into the pre- or
    // post-phase-2-close tier (CONTEXT.md decision 1c). The legacy single
    // 'phase1_organic' tag is gone — rows on either side of
    // PHASE2_CLOSE_TS_EPOCH carry distinct sidecar origins now.
    const origin = classifyCorpusOrigin('organic', row.ts_epoch);
    const tx = db.transaction(() => {
      db.prepare(ORGANIC_UPDATE_METADATA).run(
        mergeFingerprint(row.metadata_json, fp),
        row.id,
      );
      db.prepare(SIDECAR_DELETE_BY_EVENT).run(row.id, origin);
      const insert = db.prepare(SIDECAR_INSERT);
      for (const shingle of fp.shingles) {
        insert.run(shingle, row.id, row.ts_epoch, row.project, origin);
        counters.sidecar_writes++;
      }
    });
    try {
      tx();
    } catch {
      // Skip on per-row error — never let a single bad row sink the run.
    }
  }
  return counters;
}

/**
 * Backfill v4 artifact observations. For each row whose content matches
 * stack-trace shape, ensure a shadow `episodic_events` row exists
 * (provenance='environmental', source='backfill/v4-artifact', metadata
 * carries the fingerprint + source_table + source_row_id), then insert
 * sidecar rows tagged 'v4_backfill' against the shadow row.
 *
 * Idempotent — shadow row lookup uses
 * `json_extract(metadata_json, '$.source_row_id') = <artifact.id>`, so a
 * second run reuses the same shadow row id and reinserts the sidecar
 * tuples after deletion of the prior set.
 *
 * If the `artifacts` table doesn't exist (fresh installs), this is a no-op.
 */
export function backfillV4Artifacts(
  db: Database,
  opts: { dryRun: boolean },
): PerSourceCounters {
  const counters = emptyCounters();
  if (!tableExists(db, 'artifacts')) return counters;

  const rows = db.prepare(V4_SELECT).all() as V4ArtifactRow[];
  counters.rows_scanned = rows.length;

  for (const row of rows) {
    if (!looksLikeStackTrace(row.content)) continue;
    const fp = computeErrorFingerprint(row.content);
    if (!fp) continue;
    counters.fingerprinted++;
    rememberProject(counters, row.project);

    if (opts.dryRun) {
      counters.sidecar_writes += fp.shingles.length;
      continue;
    }

    try {
      // Shadow row: lookup by source_row_id; create if absent.
      const existing = db.prepare(SHADOW_LOOKUP).get(row.id) as
        | { id: number }
        | undefined;
      let shadowId: number;
      if (existing) {
        shadowId = existing.id;
        // Refresh metadata so re-runs converge on the latest fingerprint.
        db.prepare(ORGANIC_UPDATE_METADATA).run(
          JSON.stringify({
            error_fingerprint: fp,
            source_table: 'artifacts',
            source_row_id: row.id,
            corpus_origin: 'v4_backfill',
          }),
          shadowId,
        );
      } else {
        // Create the shadow row via the canonical writer.
        const result = writeEnvironmentalEvent({
          db,
          sessionId: `backfill/v4-artifact/${row.id}`,
          project: row.project,
          type: 'environmental_event',
          source: 'backfill/v4-artifact',
          content: row.content,
          metadata: {
            error_fingerprint: fp,
            source_table: 'artifacts',
            source_row_id: row.id,
            corpus_origin: 'v4_backfill',
          },
        });
        if (result.episodicId == null) continue;
        shadowId = result.episodicId;
      }

      // v4 artifacts are always classified as 'v4_backfill' regardless
      // of timestamp (CONTEXT.md decision 1c — phase-anchoring applies to
      // organic rows only; v4 is its own tier).
      const v4Origin = classifyCorpusOrigin('environmental', row.timestamp_epoch ?? 0);
      const tx = db.transaction(() => {
        db.prepare(SIDECAR_DELETE_BY_EVENT).run(shadowId, v4Origin);
        const insert = db.prepare(SIDECAR_INSERT);
        for (const shingle of fp.shingles) {
          insert.run(shingle, shadowId, row.timestamp_epoch ?? 0, row.project, v4Origin);
          counters.sidecar_writes++;
        }
      });
      tx();
    } catch {
      // Skip on per-row error.
    }
  }
  return counters;
}

/**
 * Top-level backfill orchestrator. Runs the two sources serially (organic
 * first, then v4) and assembles a BackfillSummary suitable for the CLI
 * output and the corpus-audit document.
 */
export async function runBackfill(
  db: Database,
  opts?: { dryRun?: boolean },
): Promise<BackfillSummary> {
  const dryRun = opts?.dryRun ?? false;
  const phase1 = backfillPhase1Organic(db, { dryRun });
  // eslint-disable-next-line no-console
  console.error(`backfill: scanned ${phase1.rows_scanned} organic rows, ${phase1.fingerprinted} fingerprinted`);
  const v4 = backfillV4Artifacts(db, { dryRun });
  // eslint-disable-next-line no-console
  console.error(`backfill: scanned ${v4.rows_scanned} v4 artifact rows, ${v4.fingerprinted} fingerprinted`);

  const projectSet = new Set<string>([...phase1.projects, ...v4.projects]);
  const totalFingerprinted = phase1.fingerprinted + v4.fingerprinted;
  const totalProjects = projectSet.size;

  // CONTEXT.md decision 1c: surface the three-tier sidecar distribution
  // so the operator can eyeball pre-vs-post-Phase-2-close drift before
  // running the harness. Descriptive log line; not gating.
  if (!opts?.dryRun) {
    try {
      const counts = db.prepare(`
        SELECT corpus_origin, COUNT(*) as n
          FROM episodic_index_error_fingerprint
         GROUP BY corpus_origin
         ORDER BY corpus_origin
      `).all() as Array<{ corpus_origin: string; n: number }>;
      // eslint-disable-next-line no-console
      console.error(`[backfill] per-tier sidecar counts: ${JSON.stringify(counts)}`);
    } catch {
      // Sidecar table unavailable — skip the log; not load-bearing.
    }
  }

  return {
    phase1_organic: phase1,
    v4_backfill: v4,
    total_fingerprinted: totalFingerprinted,
    total_projects: totalProjects,
    floor_met: totalFingerprinted >= FLOOR_FINGERPRINTED && totalProjects >= FLOOR_PROJECTS,
    ts_epoch: Math.floor(Date.now() / 1000),
  };
}
