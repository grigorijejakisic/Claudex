/**
 * Phase 2 Plan 04 — harness orchestrator tests.
 *
 *   - smoke run on a fixture corpus ≥ floor
 *   - read-only assertion (SQL-trace spy)
 *   - determinism on fixed seed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { writeToolResult } from '../../../core/episodic-events.js';
import { runBackfill } from '../../../benchmark/episodic-density/backfill.js';
import { runHarness } from '../../../benchmark/episodic-density/harness.js';
import { PHASE1_SHIP_TS_EPOCH } from '../../../benchmark/episodic-density/types.js';

const TRACE_TEMPLATE = (sessId: number, marker: string) => `TypeError: x is not a function in session ${sessId}
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
  // 60 fingerprinted tool_result rows across 3 projects, 60 distinct sessions
  // The shared 4 frames (a.js:1, 2, 3, 4) drive the auto-pair-labeler;
  // the per-row marker keeps shingles diverse so the harness has signal.
  for (let i = 0; i < 60; i++) {
    const project = i < 20 ? 'p-A' : i < 40 ? 'p-B' : 'p-C';
    writeToolResult({
      db,
      sessionId: `sess-${i}`,
      project,
      toolName: 'Bash',
      toolInput: { command: 'fail' },
      toolResult: TRACE_TEMPLATE(i, `m-${i % 6}`),
      turnNumber: i,
      errorFingerprintEnabled: false,
    });
  }
  db.prepare(`UPDATE episodic_events SET ts_epoch = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
  await runBackfill(db, { dryRun: false });
}

describe('runHarness orchestrator', () => {
  it('smoke run produces a HarnessRunResult with all required fields populated', async () => {
    await seedFixtureCorpus();
    const result = await runHarness(db, { seed: 42 });
    expect(result.corpus_size.total).toBeGreaterThanOrEqual(50);
    expect(result.corpus_size.projects.length).toBeGreaterThanOrEqual(3);
    expect(result.pairs.total).toBeGreaterThan(0);
    expect(result.pairs.train + result.pairs.test).toBe(result.pairs.total);
    expect(result.metrics.pooled.A).toBeDefined();
    expect(result.metrics.pooled.B).toBeDefined();
    expect(result.metrics.pooled.C).toBeDefined();
    expect(result.deltas.pooled.B_vs_A).toBeDefined();
    expect(result.deltas.pooled.C_vs_A).toBeDefined();
    expect(result.density.random_pair_sample_size).toBe(1000);
    expect(typeof result.decision_rule_inputs.held_out_test_n).toBe('number');
    expect(typeof result.decision_rule_inputs.intra_project_share).toBe('number');
    expect(typeof result.decision_rule_inputs.p99_fused_over_p99_semantic).toBe('number');
  });

  it('throws BELOW corpus floor (engineering-doc Recommendation #1: fail loud)', async () => {
    // Only seed 10 rows — well below the 50 floor
    for (let i = 0; i < 10; i++) {
      writeToolResult({
        db,
        sessionId: `sess-${i}`,
        project: 'p',
        toolName: 'Bash',
        toolInput: {},
        toolResult: TRACE_TEMPLATE(i, 'm'),
        turnNumber: i,
        errorFingerprintEnabled: false,
      });
    }
    db.prepare(`UPDATE episodic_events SET ts_epoch = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
    await runBackfill(db, { dryRun: false });
    await expect(runHarness(db, { seed: 42 })).rejects.toThrow(/floor/i);
  });

  it('read-only — never INSERT/UPDATE/DELETE against episodic_events, the sidecar, or artifacts during runHarness', async () => {
    await seedFixtureCorpus();
    const compiled: string[] = [];
    const origPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      compiled.push(sql);
      return origPrepare(sql);
    });
    await runHarness(db, { seed: 42 });
    spy.mockRestore();

    const writeKeywords = /\b(INSERT|UPDATE|DELETE)\b/i;
    const targetTables = /(episodic_events|episodic_index_error_fingerprint|artifacts)/i;
    const offending = compiled.filter(sql => writeKeywords.test(sql) && targetTables.test(sql));
    expect(offending).toEqual([]);
  });

  it('deterministic: same fixture + same seed -> byte-equal HarnessRunResult (modulo ts_epoch + wall-clock latency)', async () => {
    await seedFixtureCorpus();
    const a = await runHarness(db, { seed: 42 });
    const b = await runHarness(db, { seed: 42 });
    // Wall-clock latency_ms percentiles naturally jitter; the structural
    // outputs (corpus_size, pairs split, metric points + CIs, deltas, density,
    // decision_rule_inputs except p99 ratio) must be byte-equal under a
    // fixed seed.
    function strip(obj: Record<string, unknown>): Record<string, unknown> {
      // deep-clone and zero out every latency_ms object + p99 ratio.
      const cloned = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
      function visit(node: unknown): void {
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        if ('p50' in obj && 'p95' in obj && 'p99' in obj) {
          obj.p50 = 0;
          obj.p95 = 0;
          obj.p99 = 0;
          return;
        }
        for (const v of Object.values(obj)) visit(v);
      }
      visit(cloned);
      // Also zero the latency-derived ratio in decision_rule_inputs.
      const dri = (cloned as { decision_rule_inputs?: Record<string, unknown> }).decision_rule_inputs;
      if (dri) dri.p99_fused_over_p99_semantic = 0;
      cloned.ts_epoch = 0;
      return cloned;
    }
    expect(JSON.stringify(strip(a as unknown as Record<string, unknown>))).toBe(
      JSON.stringify(strip(b as unknown as Record<string, unknown>)),
    );
  });
});
