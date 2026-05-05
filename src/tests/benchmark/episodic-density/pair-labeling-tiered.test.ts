/**
 * Phase 2.1 Plan 02.1-02 — threshold-tested labeler + dual-tier harness
 * (CONTEXT.md decisions 2a/2b/2c + 6).
 *
 * Asserts:
 *   - labelPairs honors `frame_overlap_min` parameter; default 3
 *     preserves Phase 2's strict semantics; values < 2 throw.
 *   - relaxed pair set is a strict superset of strict pair set.
 *   - runHarnessTiered returns {ts_epoch, strict_3frame, relaxed_2frame}
 *     with NO combined/winning/primary key (CONTEXT.md decision 2a).
 *   - relaxed_2frame.pairs.total >= strict_3frame.pairs.total.
 *   - n=0 / corpus-too-sparse sentinel: harness does NOT throw when a
 *     tier's labeled pair set is empty; instead returns a zero-n
 *     HarnessRunResult shape.
 *   - runHarness backwards-compat: still returns single strict-tier
 *     HarnessRunResult.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { writeToolResult } from '../../../core/episodic-events.js';
import { runBackfill } from '../../../benchmark/episodic-density/backfill.js';
import {
  labelPairs,
  labelPairsByTier,
  type LabeledPair,
} from '../../../benchmark/episodic-density/pair-labeling.js';
import {
  runHarness,
  runHarnessTiered,
} from '../../../benchmark/episodic-density/harness.js';
import {
  PHASE1_SHIP_TS_EPOCH,
  type IndexedEvent,
} from '../../../benchmark/episodic-density/types.js';

const TRACE = (sessId: number, marker: string) => `TypeError: x is not a function in session ${sessId}
    at fn1 (a.js:1:1)
    at fn2 (a.js:2:1)
    at fn3 (a.js:3:1)
    at fn4 (a.js:4:1)
    at fnExtra-${marker} (e.js:9:9)`;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

async function seedFixtureCorpus(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const project = i < 20 ? 'p-A' : i < 40 ? 'p-B' : 'p-C';
    writeToolResult({
      db,
      sessionId: `sess-${i}`,
      project,
      toolName: 'Bash',
      toolInput: { command: 'fail' },
      toolResult: TRACE(i, `m-${i % 6}`),
      turnNumber: i,
      errorFingerprintEnabled: false,
    });
  }
  db.prepare(`UPDATE episodic_events SET ts_epoch = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
  await runBackfill(db, { dryRun: false });
}

function makeEvent(
  id: number,
  raw: string,
  outer: string | null,
  session_id: string,
): IndexedEvent {
  return {
    episode_event_id: id,
    project: 'p',
    ts_epoch: 1700000000 + id,
    session_id,
    corpus_origin: 'phase1_organic_pre_phase2_close',
    outer_exception: outer,
    shingles: [],
    raw_content: raw,
    source_table: 'episodic_events',
    source_row_id: id,
  };
}

describe('labelPairs — frame_overlap_min parameter (CONTEXT.md decision 2a/2b)', () => {
  // Hand-crafted fixture: 4 events with controlled frame overlaps.
  // STACK_4 / STACK_4_DUP share all 4 frames -> overlap 4
  // STACK_2 shares 2 frames with STACK_4 -> overlap 2
  // STACK_1 shares 1 frame with STACK_4 -> overlap 1
  const STACK_4 = `TypeError: oops
    at f1 (a.js:1:1)
    at f2 (a.js:2:1)
    at f3 (a.js:3:1)
    at f4 (a.js:4:1)`;
  const STACK_4_DUP = STACK_4;
  const STACK_2 = `TypeError: oops
    at f1 (a.js:1:1)
    at f2 (a.js:2:1)
    at fX (b.js:9:9)
    at fY (b.js:8:8)`;
  const STACK_1 = `TypeError: oops
    at f1 (a.js:1:1)
    at fA (z.js:1:1)
    at fB (z.js:2:1)
    at fC (z.js:3:1)`;

  it('default frame_overlap_min=3 (Phase 2 strict semantics) yields only the 4-overlap pair', () => {
    const events = [
      makeEvent(1, STACK_4, 'TypeError', 'A'),
      makeEvent(2, STACK_4_DUP, 'TypeError', 'B'), // overlap 4 with #1
      makeEvent(3, STACK_2, 'TypeError', 'C'),     // overlap 2 with #1, #2
      makeEvent(4, STACK_1, 'TypeError', 'D'),     // overlap 1 with #1, #2; 1 with #3
    ];
    const strict = labelPairs(events);
    expect(strict.length).toBe(1);
    expect(strict[0]).toMatchObject({ a: 1, b: 2 });
    expect(strict[0].overlap_frame_count).toBeGreaterThanOrEqual(3);
  });

  it('frame_overlap_min=2 (relaxed) admits the 2-overlap pairs that strict rejected', () => {
    const events = [
      makeEvent(1, STACK_4, 'TypeError', 'A'),
      makeEvent(2, STACK_4_DUP, 'TypeError', 'B'),
      makeEvent(3, STACK_2, 'TypeError', 'C'),
      makeEvent(4, STACK_1, 'TypeError', 'D'),
    ];
    const relaxed = labelPairs(events, { frame_overlap_min: 2 });
    // Pairs (1,2) overlap=4; (1,3) overlap=2; (2,3) overlap=2
    expect(relaxed.length).toBeGreaterThanOrEqual(3);
    const relaxedKeys = new Set(relaxed.map(p => `${p.a}-${p.b}`));
    expect(relaxedKeys.has('1-2')).toBe(true);
    expect(relaxedKeys.has('1-3')).toBe(true);
    expect(relaxedKeys.has('2-3')).toBe(true);
    // 1-frame pair NOT included
    expect(relaxedKeys.has('1-4')).toBe(false);
  });

  it('frame_overlap_min=1 throws (CONTEXT.md decision 2b hard floor)', () => {
    const events = [
      makeEvent(1, STACK_4, 'TypeError', 'A'),
      makeEvent(2, STACK_4_DUP, 'TypeError', 'B'),
    ];
    expect(() => labelPairs(events, { frame_overlap_min: 1 })).toThrowError(
      /CONTEXT.md decision 2b hard floor/i,
    );
    expect(() => labelPairs(events, { frame_overlap_min: 0 })).toThrowError(
      /CONTEXT.md decision 2b hard floor/i,
    );
  });

  it('labelPairsByTier dispatches strict_3frame -> 3 and relaxed_2frame -> 2', () => {
    const events = [
      makeEvent(1, STACK_4, 'TypeError', 'A'),
      makeEvent(2, STACK_4_DUP, 'TypeError', 'B'),
      makeEvent(3, STACK_2, 'TypeError', 'C'),
    ];
    const strict = labelPairsByTier(events, 'strict_3frame');
    const relaxed = labelPairsByTier(events, 'relaxed_2frame');
    expect(strict.length).toBe(1); // 1-2 only
    expect(relaxed.length).toBeGreaterThanOrEqual(strict.length);
    expect(relaxed.length).toBeGreaterThanOrEqual(3); // 1-2, 1-3, 2-3
  });
});

describe('Relaxed-superset invariant (CONTEXT.md decision 2a — relaxed ⊇ strict by construction)', () => {
  it('every strict pair appears in the relaxed pair set; relaxed is at least as large', async () => {
    await seedFixtureCorpus();
    const corpus: IndexedEvent[] = [];
    for (const row of db.prepare(`
      SELECT e.id, e.project, e.ts_epoch, e.session_id, e.content, e.metadata_json,
             s.corpus_origin
        FROM episodic_events e
        JOIN episodic_index_error_fingerprint s ON s.episode_event_id = e.id
       WHERE e.metadata_json IS NOT NULL
       GROUP BY e.id
       ORDER BY e.id
    `).all() as Array<{
      id: number;
      project: string;
      ts_epoch: number;
      session_id: string;
      content: string;
      metadata_json: string;
      corpus_origin: 'v4_backfill' | 'phase1_organic_pre_phase2_close' | 'phase1_organic_post_phase2_close';
    }>) {
      const md = JSON.parse(row.metadata_json) as { error_fingerprint?: { outer_exception?: string | null; shingles?: string[] } };
      if (!md.error_fingerprint?.shingles) continue;
      corpus.push({
        episode_event_id: row.id,
        project: row.project,
        ts_epoch: row.ts_epoch,
        session_id: row.session_id,
        corpus_origin: row.corpus_origin,
        outer_exception: md.error_fingerprint.outer_exception ?? null,
        shingles: md.error_fingerprint.shingles,
        raw_content: row.content,
        source_table: 'episodic_events',
        source_row_id: row.id,
      });
    }

    const strict = labelPairsByTier(corpus, 'strict_3frame');
    const relaxed = labelPairsByTier(corpus, 'relaxed_2frame');

    expect(relaxed.length).toBeGreaterThanOrEqual(strict.length);
    const relaxedKeys = new Set(relaxed.map(p => `${p.a}-${p.b}`));
    for (const p of strict) {
      expect(relaxedKeys.has(`${p.a}-${p.b}`)).toBe(true);
    }
  });
});

describe('runHarnessTiered shape (CONTEXT.md decision 2a/2c — no combined/winning/primary)', () => {
  it('top-level keys are exactly {ts_epoch, strict_3frame, relaxed_2frame}; no combined/winning/primary', async () => {
    await seedFixtureCorpus();
    const result = await runHarnessTiered(db, { seed: 42 });
    expect(Object.keys(result).sort()).toEqual(
      ['relaxed_2frame', 'strict_3frame', 'ts_epoch'].sort(),
    );
    const r = result as unknown as Record<string, unknown>;
    expect(r.combined).toBeUndefined();
    expect(r.winning).toBeUndefined();
    expect(r.primary).toBeUndefined();
  });

  it('relaxed_2frame.pairs.total >= strict_3frame.pairs.total (relaxed-superset at the harness level)', async () => {
    await seedFixtureCorpus();
    const result = await runHarnessTiered(db, { seed: 42 });
    expect(result.relaxed_2frame.pairs.total).toBeGreaterThanOrEqual(
      result.strict_3frame.pairs.total,
    );
  });

  it('both tiers populate decision_rule_inputs (non-null)', async () => {
    await seedFixtureCorpus();
    const result = await runHarnessTiered(db, { seed: 42 });
    expect(result.strict_3frame.decision_rule_inputs).toBeDefined();
    expect(result.relaxed_2frame.decision_rule_inputs).toBeDefined();
    expect(typeof result.strict_3frame.decision_rule_inputs.held_out_test_n).toBe('number');
    expect(typeof result.relaxed_2frame.decision_rule_inputs.held_out_test_n).toBe('number');
  });

  it('density signal is corpus-wide: identical across tiers', async () => {
    await seedFixtureCorpus();
    const result = await runHarnessTiered(db, { seed: 42 });
    expect(JSON.stringify(result.strict_3frame.density)).toBe(
      JSON.stringify(result.relaxed_2frame.density),
    );
  });
});

describe('n=0 / corpus-too-sparse sentinel (CONTEXT.md decision 6)', () => {
  it('runHarnessTiered does NOT throw when a tier produces zero pairs; held_out_test_n=0 sentinel set', async () => {
    // Seed a corpus that PASSES the floor (≥50 events, ≥3 projects) but
    // where no two events share an exception type — so labelPairs
    // produces zero pairs at any tier. Each event gets a unique outer
    // exception class.
    for (let i = 0; i < 60; i++) {
      const project = i < 20 ? 'p1' : i < 40 ? 'p2' : 'p3';
      const trace = `UniqueException${i}: marker
    at fn1 (file${i}.js:1:1)
    at fn2 (file${i}.js:2:1)
    at fn3 (file${i}.js:3:1)
    at fn4 (file${i}.js:4:1)`;
      writeToolResult({
        db,
        sessionId: `sess-${i}`,
        project,
        toolName: 'Bash',
        toolInput: {},
        toolResult: trace,
        turnNumber: i,
        errorFingerprintEnabled: false,
      });
    }
    db.prepare(`UPDATE episodic_events SET ts_epoch = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
    await runBackfill(db, { dryRun: false });

    const result = await runHarnessTiered(db, { seed: 42 });
    // Both tiers should be at zero — every event has a unique exception
    // type so no pairs qualify under either threshold.
    expect(result.strict_3frame.pairs.total).toBe(0);
    expect(result.relaxed_2frame.pairs.total).toBe(0);
    expect(result.strict_3frame.decision_rule_inputs.held_out_test_n).toBe(0);
    expect(result.relaxed_2frame.decision_rule_inputs.held_out_test_n).toBe(0);
    // Wilson CI sentinels at zero-n: deltas are zero, p99_ratio is zero.
    expect(result.strict_3frame.decision_rule_inputs.fused_p5_minus_semantic_p5.delta).toBe(0);
    expect(result.relaxed_2frame.decision_rule_inputs.p99_fused_over_p99_semantic).toBe(0);
  });
});

describe('runHarness backwards compat (Phase 2 strict-only entrypoint)', () => {
  it('runHarness returns single HarnessRunResult; pairs.total equals runHarnessTiered.strict_3frame.pairs.total', async () => {
    await seedFixtureCorpus();
    const single = await runHarness(db, { seed: 42 });
    const tiered = await runHarnessTiered(db, { seed: 42 });
    expect(single.pairs.total).toBe(tiered.strict_3frame.pairs.total);
    // Top-level shape is single-tier, not the tiered shape.
    expect((single as unknown as Record<string, unknown>).strict_3frame).toBeUndefined();
    expect((single as unknown as Record<string, unknown>).relaxed_2frame).toBeUndefined();
  });
});
