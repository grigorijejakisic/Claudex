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
 * Mandatory for every sidecar insert (Phase 2 CONTEXT item 2 known-
 * limitation visibility); Plan 02-04 splits metrics by this dimension.
 *
 * Phase 2.1 widens this to a phase-anchored three-tier scheme
 * (CONTEXT.md decision 1c): organic events are partitioned by whether
 * their `ts_epoch` precedes or follows Phase 2's measurement timestamp
 * (`PHASE2_CLOSE_TS_EPOCH` below). Date-anchoring was rejected because
 * it would require re-stamping on re-runs; phase-anchoring keeps the
 * partition invariant.
 *
 *   - 'v4_backfill'                     — unchanged from Phase 2; v4
 *     `artifacts` (artifact_type='observation') stack-trace-shaped rows.
 *   - 'phase1_organic_pre_phase2_close' — `episodic_events`
 *     provenance='tool_result' rows whose `ts_epoch <= PHASE2_CLOSE_TS_EPOCH`.
 *     Includes everything that fed Phase 2's measurement.
 *   - 'phase1_organic_post_phase2_close' — `episodic_events`
 *     provenance='tool_result' rows whose `ts_epoch > PHASE2_CLOSE_TS_EPOCH`.
 *     Organic accumulation since Phase 2 closed; expected to be small
 *     (CONTEXT.md decision 1a caveat).
 *
 * BackfillSource keeps the legacy two-tier shape as a forward-compat
 * surface for the Phase 2 backfill summary; production paths that read
 * sidecar rows use CorpusOrigin (three-tier).
 */
export type CorpusOrigin =
  | 'v4_backfill'
  | 'phase1_organic_pre_phase2_close'
  | 'phase1_organic_post_phase2_close';

export type BackfillSource = 'phase1_organic' | 'v4_backfill';

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
 *
 * Phase 2.1: counters keep the legacy two-source split (phase1_organic
 * vs v4_backfill) at the BackfillSummary level — the three-tier
 * sub-partition of organic rows happens at sidecar-insert classification
 * time, not at the source-table walk. Aggregating the two organic tiers
 * in one BackfillSummary entry keeps the existing CLI/test surface
 * intact while the harness reads the three-tier partition off the
 * sidecar.
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

/**
 * Phase 2's measurement was generated at this Unix epoch second. Sourced
 * verbatim from `.planning/phases/02-multi-modal-index-seeds-density-check/02-results.json`
 * `harness.ts_epoch`. The Phase 2.1 corpus_origin scheme partitions
 * organic events at this boundary (CONTEXT.md decision 1c — phase-
 * anchored, not date-anchored, so re-runs preserve the partition
 * meaning).
 *
 * Boundary inclusivity: `ts_epoch <= PHASE2_CLOSE_TS_EPOCH` maps to
 * `phase1_organic_pre_phase2_close`; strictly greater maps to
 * `phase1_organic_post_phase2_close`.
 *
 * **Do not edit this constant unless Phase 2's measurement is re-run.**
 * Editing it post-hoc would silently rewrite which events count as
 * pre-vs-post; that violates the append-only bound-experience invariant
 * (CONTEXT.md decision 4d).
 */
export const PHASE2_CLOSE_TS_EPOCH = 1777940002 as const;

/** Floor: ≥50 fingerprinted episodes AND ≥3 projects (CONTEXT item 2). */
export const FLOOR_FINGERPRINTED = 50 as const;
export const FLOOR_PROJECTS = 3 as const;

/**
 * Phase 2.1 — the two labeler tiers run in parallel per CONTEXT.md
 * decision 2a (two bound experiences > one).
 *
 *   - `strict_3frame`  — Phase 2's labeler verbatim: same outermost
 *     exception type AND ≥3 frames overlap AND different session_id.
 *     Conservative; high per-pair confidence; potentially small n.
 *   - `relaxed_2frame` — same as strict but with the frame overlap
 *     floor lowered from ≥3 to ≥2. Larger pair set (superset of
 *     strict_3frame's by construction). Per-pair confidence is reduced;
 *     the audit (Plan 02.1-03) measures auto-labeler precision per
 *     tier descriptively (CONTEXT.md decision 3b — descriptive, not
 *     gating).
 *
 * **CONTEXT.md decision 2b binding:** ≥2 is the hard floor; never go
 * below. Adding a `relaxed_1frame` tier in a future revision requires
 * CONTEXT.md amendment + user-approval gate.
 */
export type LabelerTier = 'strict_3frame' | 'relaxed_2frame';

export const LABELER_TIER_FRAME_MIN: Record<LabelerTier, number> = {
  strict_3frame: 3,
  relaxed_2frame: 2,
};
