/**
 * Phase 2 IDX-02 — automated pair-labeling (CONTEXT.md item 2 verbatim).
 *
 * Two error events form a "should-match" pair when ALL hold:
 *   1. Same outermost exception type
 *   2. ≥`frame_overlap_min` frames of stack trace overlap (frame = `<file>:<line>:<func>`)
 *   3. Different `session_id`
 *
 * Phase 2 used `frame_overlap_min=3` (the strict labeler). Phase 2.1
 * (CONTEXT.md decision 2a) runs the labeler twice in parallel — once
 * with `frame_overlap_min=3` (strict) and once with `frame_overlap_min=2`
 * (relaxed) — producing two parallel bound experiences. The two pair
 * sets are independent inputs to the verdict module; each tier ships
 * its own verdict under its own conditions, with NO combination logic
 * (CONTEXT.md decision 2a verbatim: "Not a fallback. Two bound
 * experiences > one").
 *
 * **CONTEXT.md decision 2b binding:** values below 2 are rejected
 * (≥2 hard floor; ≥1 is too noisy a signal — same exception type +
 * one shared frame is a coincidence rate the auto-labeler can't
 * reliably distinguish from genuine match).
 *
 * Yields hundreds of pairs without human labeling. Manual spot-check 20
 * random pairs validates the auto-labeler isn't producing garbage (audit
 * before measurement runs — see Plan 02.1-03's audit MDs).
 *
 * 80/20 train/test split: fixed-seed deterministic. Seed default 42; the
 * test set is held out from threshold tuning per the empirical-phase
 * discipline.
 *
 * Pure module — no DB, no I/O, no clock.
 */

import { extractFrames } from '../../core/error-fingerprint.js';
import {
  LABELER_TIER_FRAME_MIN,
  type CorpusOrigin,
  type IndexedEvent,
  type LabelerTier,
} from './types.js';

export interface LabeledPair {
  /** episode_event_id of the smaller-id event in the pair. */
  a: number;
  /** episode_event_id of the larger-id event in the pair. */
  b: number;
  /** Shared outer exception class (non-null by construction). */
  outer_exception: string;
  /** Frames intersection cardinality (>=3 by construction). */
  overlap_frame_count: number;
  /** Both events from same project (used by density.ts intra-project share). */
  same_project: boolean;
  origin_a: CorpusOrigin;
  origin_b: CorpusOrigin;
}

export interface Split {
  train: LabeledPair[];
  test: LabeledPair[];
  seed: number;
}

/** Deterministic, side-effect-free PRNG (Mulberry32). */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frame key for the overlap test: `<file>:<line>:<func>`. */
function frameKey(file: string, line: string, func: string): string {
  return `${file}:${line}:${func}`;
}

function frameSet(content: string): Set<string> {
  const frames = extractFrames(content);
  const set = new Set<string>();
  for (const f of frames) set.add(frameKey(f.file, f.line, f.func));
  return set;
}

function frameOverlap(setA: Set<string>, setB: Set<string>): number {
  let n = 0;
  for (const k of setA) if (setB.has(k)) n++;
  return n;
}

export interface LabelPairsOpts {
  /**
   * Minimum frame overlap to qualify a pair. Default 3 (Phase 2's
   * strict labeler verbatim — preserves zero-arg call semantics).
   * Phase 2.1 runs the labeler twice — once with 3 and once with 2 —
   * to produce two parallel bound experiences (CONTEXT.md decision 2a).
   * Values below 2 are rejected per CONTEXT.md decision 2b.
   */
  frame_overlap_min?: number;
}

/**
 * Implement CONTEXT item 2's auto-labeler. O(n^2) over events; at
 * n ~ 50-200 the cost is trivial.
 *
 * The zero-arg call signature `labelPairs(events)` is preserved as a
 * thin wrapper that defaults `frame_overlap_min=3`, so Phase 2's
 * existing tests and call sites still produce byte-equal results.
 */
export function labelPairs(events: IndexedEvent[], opts?: LabelPairsOpts): LabeledPair[] {
  const minOverlap = opts?.frame_overlap_min ?? 3;
  if (minOverlap < 2) {
    throw new Error(
      `labelPairs: frame_overlap_min ${minOverlap} below CONTEXT.md decision 2b hard floor of 2 (≥1 is too noisy — same exception type + one shared frame is a coincidence rate the auto-labeler can't reliably distinguish from genuine match)`,
    );
  }
  const sorted = [...events].sort((a, b) => a.episode_event_id - b.episode_event_id);
  // Cache frame sets to avoid recomputing for every (i, j) pair.
  const frames = sorted.map(e => frameSet(e.raw_content));
  const out: LabeledPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.outer_exception == null) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.outer_exception == null) continue;
      if (a.outer_exception !== b.outer_exception) continue;
      if (a.session_id === b.session_id) continue;
      const overlap = frameOverlap(frames[i], frames[j]);
      if (overlap < minOverlap) continue;
      out.push({
        a: a.episode_event_id,
        b: b.episode_event_id,
        outer_exception: a.outer_exception,
        overlap_frame_count: overlap,
        same_project: a.project === b.project,
        origin_a: a.corpus_origin,
        origin_b: b.corpus_origin,
      });
    }
  }
  return out;
}

/**
 * Convenience: label pairs at a given tier's frame-overlap floor.
 * Equivalent to `labelPairs(events, { frame_overlap_min: LABELER_TIER_FRAME_MIN[tier] })`.
 *
 * The relaxed tier's pair set is a strict superset of the strict
 * tier's by construction (frame_overlap >= 2 is implied by >= 3).
 */
export function labelPairsByTier(events: IndexedEvent[], tier: LabelerTier): LabeledPair[] {
  return labelPairs(events, { frame_overlap_min: LABELER_TIER_FRAME_MIN[tier] });
}

/**
 * Fixed-seed deterministic 80/20 train/test split. Pairs are first sorted
 * by (a, b) so the input order to the PRNG is reproducible across
 * machines, then shuffled by the seeded PRNG.
 */
export function splitTrainTest(
  pairs: LabeledPair[],
  opts?: { seed?: number; testFraction?: number },
): Split {
  const seed = opts?.seed ?? 42;
  const testFrac = opts?.testFraction ?? 0.2;
  const ordered = [...pairs].sort((x, y) => (x.a - y.a) || (x.b - y.b));
  const rand = mulberry32(seed);
  // Fisher–Yates shuffle with the seeded PRNG.
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = ordered[i];
    ordered[i] = ordered[j];
    ordered[j] = tmp;
  }
  const trainCount = Math.floor(ordered.length * (1 - testFrac));
  return {
    train: ordered.slice(0, trainCount),
    test: ordered.slice(trainCount),
    seed,
  };
}
