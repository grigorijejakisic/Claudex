/**
 * Phase 2 IDX-01 — shared types for the episodic-density measurement harness.
 *
 * Benchmark-scoped on purpose (CONTEXT.md): keeps measurement vocabulary out
 * of production code paths. Production code only sees `error_fingerprint` in
 * `episodic_events.metadata_json` and the `episodic_index_error_fingerprint`
 * sidecar table — not these types.
 */

/**
 * Closed enum tagging where a sidecar row's source data came from.
 * Mandatory for every sidecar insert (CONTEXT item 2 known-limitation
 * visibility) — Plan 02-04 splits metrics by this dimension.
 *
 *   - 'phase1_organic' : `episodic_events` rows written post-Phase-1 ship
 *     (commit 9434ab9, 2026-05-04). Provenance-clean tool_result rows.
 *   - 'v4_backfill'    : v4 `artifacts` rows (artifact_type='observation')
 *     whose content matched stack-trace shape. No Phase 1 provenance tags;
 *     mixed quality. Tagged so post-hoc analysis can split clean from dirty.
 */
export type CorpusOrigin = 'phase1_organic' | 'v4_backfill';

export type BackfillSource = CorpusOrigin;

/**
 * In-memory representation of a fingerprinted episode plus the metadata
 * the measurement harness needs (raw_content for ground-truth labeling,
 * source_table+source_row_id for the corpus audit, session_id so the
 * pair-labeler can enforce the "different session_id" rule from CONTEXT
 * item 2).
 */
export interface IndexedEvent {
  /** FK into `episodic_events`. For v4 backfill rows, this is the shadow row id. */
  episode_event_id: number;
  project: string;
  ts_epoch: number;
  session_id: string;
  corpus_origin: CorpusOrigin;
  outer_exception: string | null;
  /** Sorted unique 16-hex-char shingle hashes; deterministic. */
  shingles: string[];
  /** Original error/trace string — Plan 02-04 reads this for frame-overlap labeling. */
  raw_content: string;
  /** Origin row's home table (for the audit doc). */
  source_table: 'episodic_events' | 'artifacts';
  /** Origin row id in `source_table`. */
  source_row_id: number;
}

/**
 * Per-source backfill counters; assembled into the runner's CLI output and
 * the corpus-audit document at .planning/.../02-03-corpus-audit.md.
 */
export interface PerSourceCounters {
  rows_scanned: number;
  fingerprinted: number;
  sidecar_writes: number;
  projects: string[];
}

export interface BackfillSummary {
  phase1_organic: PerSourceCounters;
  v4_backfill: PerSourceCounters;
  total_fingerprinted: number;
  total_projects: number;
  /** True iff total_fingerprinted >= FLOOR_FINGERPRINTED && total_projects >= FLOOR_PROJECTS. */
  floor_met: boolean;
  ts_epoch: number;
}

/**
 * Phase 1 ship boundary — `git show -s --format=%ct 9434ab9` resolved to
 * 1777929975 (epoch seconds). The backfill's organic source filter is
 * `WHERE provenance='tool_result' AND ts_epoch >= PHASE1_SHIP_TS_EPOCH`.
 *
 * Bound at execution time (Plan 02-03 Task 1 verification) per the spec.
 */
export const PHASE1_SHIP_TS_EPOCH = 1777929975 as const;

/** Floor: ≥50 fingerprinted episodes AND ≥3 projects (CONTEXT item 2). */
export const FLOOR_FINGERPRINTED = 50 as const;
export const FLOOR_PROJECTS = 3 as const;
