/**
 * Phase 2 Plan 04 — pair-labeling tests (CONTEXT.md item 2 ground truth).
 */

import { describe, it, expect } from 'vitest';
import {
  labelPairs,
  splitTrainTest,
  type LabeledPair,
} from '../../../benchmark/episodic-density/pair-labeling.js';
import type { IndexedEvent } from '../../../benchmark/episodic-density/types.js';

const STACK_A = `TypeError: x is not a function
    at fn1 (a.js:1:1)
    at fn2 (a.js:2:1)
    at fn3 (a.js:3:1)
    at fn4 (a.js:4:1)`;

const STACK_A_DUPLICATE = STACK_A;
const STACK_A_PARTIAL = `TypeError: x is not a function
    at fn1 (a.js:1:1)
    at different (b.js:9:9)`;
const STACK_B_DIFFERENT_EXCEPTION = `KeyError: missing
    at fn1 (a.js:1:1)
    at fn2 (a.js:2:1)
    at fn3 (a.js:3:1)`;

function makeEvent(
  id: number,
  session_id: string,
  outer: string | null,
  raw: string,
  project = 'p',
): IndexedEvent {
  return {
    episode_event_id: id,
    project,
    ts_epoch: 1700000000 + id,
    session_id,
    corpus_origin: 'phase1_organic',
    outer_exception: outer,
    shingles: [],
    raw_content: raw,
    source_table: 'episodic_events',
    source_row_id: id,
  };
}

describe('labelPairs (CONTEXT item 2)', () => {
  it('does NOT pair two events from the SAME session_id even if everything else matches', () => {
    const events = [
      makeEvent(1, 'sess-A', 'TypeError', STACK_A),
      makeEvent(2, 'sess-A', 'TypeError', STACK_A_DUPLICATE),
    ];
    expect(labelPairs(events)).toHaveLength(0);
  });

  it('PAIRS when outer_exception matches, ≥3 frames overlap, and sessions differ', () => {
    const events = [
      makeEvent(1, 'sess-A', 'TypeError', STACK_A),
      makeEvent(2, 'sess-B', 'TypeError', STACK_A_DUPLICATE),
    ];
    const pairs = labelPairs(events);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].overlap_frame_count).toBeGreaterThanOrEqual(3);
    expect(pairs[0].outer_exception).toBe('TypeError');
  });

  it('does NOT pair when frame overlap < 3', () => {
    const events = [
      makeEvent(1, 'sess-A', 'TypeError', STACK_A),
      makeEvent(2, 'sess-B', 'TypeError', STACK_A_PARTIAL),
    ];
    expect(labelPairs(events)).toHaveLength(0);
  });

  it('does NOT pair when outer_exception differs', () => {
    const events = [
      makeEvent(1, 'sess-A', 'TypeError', STACK_A),
      makeEvent(2, 'sess-B', 'KeyError', STACK_B_DIFFERENT_EXCEPTION),
    ];
    expect(labelPairs(events)).toHaveLength(0);
  });

  it('skips events with null outer_exception', () => {
    const events = [
      makeEvent(1, 'sess-A', null, STACK_A),
      makeEvent(2, 'sess-B', 'TypeError', STACK_A_DUPLICATE),
    ];
    expect(labelPairs(events)).toHaveLength(0);
  });

  it('records same_project flag correctly', () => {
    const sameProj = [
      makeEvent(1, 'sess-A', 'TypeError', STACK_A, 'pX'),
      makeEvent(2, 'sess-B', 'TypeError', STACK_A_DUPLICATE, 'pX'),
    ];
    const diffProj = [
      makeEvent(3, 'sess-C', 'TypeError', STACK_A, 'pY'),
      makeEvent(4, 'sess-D', 'TypeError', STACK_A_DUPLICATE, 'pZ'),
    ];
    expect(labelPairs(sameProj)[0]?.same_project).toBe(true);
    expect(labelPairs(diffProj)[0]?.same_project).toBe(false);
  });
});

describe('splitTrainTest', () => {
  function makePairs(n: number): LabeledPair[] {
    const out: LabeledPair[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        a: i,
        b: i + 1000,
        outer_exception: 'TypeError',
        overlap_frame_count: 3,
        same_project: i % 2 === 0,
        origin_a: 'phase1_organic',
        origin_b: 'phase1_organic',
      });
    }
    return out;
  }

  it('produces an 80/20 split deterministically across two calls (same seed)', () => {
    const pairs = makePairs(100);
    const a = splitTrainTest(pairs, { seed: 42 });
    const b = splitTrainTest(pairs, { seed: 42 });
    expect(JSON.stringify(a.train)).toBe(JSON.stringify(b.train));
    expect(JSON.stringify(a.test)).toBe(JSON.stringify(b.test));
    expect(a.train.length).toBe(80);
    expect(a.test.length).toBe(20);
  });

  it('different seeds produce different shuffles', () => {
    const pairs = makePairs(100);
    const a = splitTrainTest(pairs, { seed: 1 });
    const b = splitTrainTest(pairs, { seed: 2 });
    expect(JSON.stringify(a.train)).not.toBe(JSON.stringify(b.train));
  });

  it('sorting input pairs by (a,b) before shuffle makes input order irrelevant', () => {
    const pairs = makePairs(50);
    const reversed = [...pairs].reverse();
    const a = splitTrainTest(pairs, { seed: 7 });
    const b = splitTrainTest(reversed, { seed: 7 });
    expect(JSON.stringify(a.train)).toBe(JSON.stringify(b.train));
    expect(JSON.stringify(a.test)).toBe(JSON.stringify(b.test));
  });

  it('honors a custom testFraction', () => {
    const pairs = makePairs(100);
    const split = splitTrainTest(pairs, { seed: 0, testFraction: 0.5 });
    expect(split.train.length).toBe(50);
    expect(split.test.length).toBe(50);
  });
});
