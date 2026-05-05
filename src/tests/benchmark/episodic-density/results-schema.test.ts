/**
 * Phase 2.1 Plan 02.1-04 Task 5 — schema test (CONTEXT.md decision 2a + 5
 * bindings).
 *
 * Asserts:
 *   - 02.1-results.json top-level shape:
 *       {schema_version, generated_at_ts_epoch, harness, verdicts}
 *   - verdicts has EXACTLY two keys: {strict_3frame, relaxed_2frame}.
 *   - NO `combined`, `winning`, `primary` key at any depth (depth-first walk).
 *   - Per-tier verdict shape preserves Phase 2's Verdict shape.
 *   - decision_rule_quote is byte-equal to Phase 2's published quote
 *     (CONTEXT.md decision 5 — REUSED VERBATIM).
 *   - Aggregator file shape: {schema_version, question, bound_experiences},
 *     no combined/winning/primary/current_consensus at top level.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { writeToolResult } from '../../../core/episodic-events.js';
import { runBackfill } from '../../../benchmark/episodic-density/backfill.js';
import { runFullPhase21Measurement } from '../../../benchmark/episodic-density/runner-tiered.js';
import { PHASE1_SHIP_TS_EPOCH } from '../../../benchmark/episodic-density/types.js';

const TRACE = (i: number, marker: string) => `TypeError: x is not a function in session ${i}
    at fn1 (a.js:1:1)
    at fn2 (a.js:2:1)
    at fn3 (a.js:3:1)
    at fn4 (a.js:4:1)
    at fnExtra-${marker} (e.js:9:9)`;

const REPO_ROOT = process.cwd();
const PHASE2_RESULTS_JSON = path.resolve(
  REPO_ROOT,
  '.planning',
  'phases',
  '02-multi-modal-index-seeds-density-check',
  '02-results.json',
);

let db: Database.Database;
let tmpDir: string;
let RESULTS_JSON: string;
let RESULTS_MD: string;
let AGGREGATOR_PATH: string;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase21-schema-'));
  RESULTS_JSON = path.join(tmpDir, '02.1-results.json');
  RESULTS_MD = path.join(tmpDir, '02.1-RESULTS.md');
  AGGREGATOR_PATH = path.join(tmpDir, 'multi-handle.json');
});

afterEach(() => {
  db.close();
  if (fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
});

async function seedFloorCorpus(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    writeToolResult({
      db,
      sessionId: `sess-${i}`,
      project: i < 20 ? 'pa' : i < 40 ? 'pb' : 'pc',
      toolName: 'Bash',
      toolInput: {},
      toolResult: TRACE(i, `m-${i % 6}`),
      turnNumber: i,
      errorFingerprintEnabled: false,
    });
  }
  db.prepare(`UPDATE episodic_events SET ts_epoch = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
  await runBackfill(db, { dryRun: false });
}

/**
 * Depth-first walk: collect ALL keys at every level of the parsed JSON
 * tree, including nested objects and array elements.
 */
function collectAllKeys(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectAllKeys(item, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      acc.push(k);
      collectAllKeys((node as Record<string, unknown>)[k], acc);
    }
  }
  return acc;
}

describe('02.1-results.json schema (CONTEXT.md decision 2a + 5)', () => {
  it('top-level keys are exactly {schema_version, generated_at_ts_epoch, harness, verdicts}', async () => {
    await seedFloorCorpus();
    await runFullPhase21Measurement(db, {
      seed: 42,
      ts_epoch: 1000,
      resultsJsonPath: RESULTS_JSON,
      resultsMdPath: RESULTS_MD,
      aggregatorPath: AGGREGATOR_PATH,
    });
    const parsed = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['generated_at_ts_epoch', 'harness', 'schema_version', 'verdicts'].sort(),
    );
  });

  it('verdicts has exactly two keys: {strict_3frame, relaxed_2frame}', async () => {
    await seedFloorCorpus();
    await runFullPhase21Measurement(db, {
      seed: 42,
      ts_epoch: 1000,
      resultsJsonPath: RESULTS_JSON,
      resultsMdPath: RESULTS_MD,
      aggregatorPath: AGGREGATOR_PATH,
    });
    const parsed = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8')) as { verdicts: Record<string, unknown> };
    expect(Object.keys(parsed.verdicts).sort()).toEqual(['relaxed_2frame', 'strict_3frame']);
  });

  it('depth-first walk: NO combined/winning/primary key at any depth in 02.1-results.json', async () => {
    await seedFloorCorpus();
    await runFullPhase21Measurement(db, {
      seed: 42,
      ts_epoch: 1000,
      resultsJsonPath: RESULTS_JSON,
      resultsMdPath: RESULTS_MD,
      aggregatorPath: AGGREGATOR_PATH,
    });
    const parsed = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'));
    const allKeys = collectAllKeys(parsed);
    for (const forbidden of ['combined', 'winning', 'primary']) {
      expect(allKeys).not.toContain(forbidden);
    }
  });

  it('per-tier verdict shape: {kind, criteria, reasoning, computed_at_ts_epoch, decision_rule_quote}; kind in {GREEN_LIGHT,SCOPE_DOWN,KILL,BLOCKED}', async () => {
    await seedFloorCorpus();
    await runFullPhase21Measurement(db, {
      seed: 42,
      ts_epoch: 1000,
      resultsJsonPath: RESULTS_JSON,
      resultsMdPath: RESULTS_MD,
      aggregatorPath: AGGREGATOR_PATH,
    });
    const parsed = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8')) as {
      verdicts: Record<string, { kind: string; criteria: { criterion_1: unknown; criterion_2: unknown; criterion_3: unknown }; reasoning: string; computed_at_ts_epoch: number; decision_rule_quote: string }>;
    };
    for (const tier of ['strict_3frame', 'relaxed_2frame']) {
      const v = parsed.verdicts[tier];
      expect(v).toBeDefined();
      expect(['GREEN_LIGHT', 'SCOPE_DOWN', 'KILL', 'BLOCKED']).toContain(v.kind);
      expect(v.criteria).toBeDefined();
      expect(v.criteria.criterion_1).toBeDefined();
      expect(v.criteria.criterion_2).toBeDefined();
      expect(v.criteria.criterion_3).toBeDefined();
      expect(typeof v.reasoning).toBe('string');
      expect(typeof v.computed_at_ts_epoch).toBe('number');
      expect(typeof v.decision_rule_quote).toBe('string');
    }
  });

  it('decision_rule_quote on each tier is byte-equal to Phase 2 published quote (CONTEXT.md decision 5 REUSED VERBATIM)', async () => {
    // Snapshot Phase 2's published quote at the START of the test, before
    // any concurrent test (Phase 2's verdict.test.ts ordering test) can
    // delete the file. If the file is missing entirely (clean checkout),
    // import the in-source DECISION_RULE_QUOTE constant directly — it is
    // the same string by construction (verdict.ts is the only writer).
    let phase2Quote: string | null = null;
    if (fs.existsSync(PHASE2_RESULTS_JSON)) {
      try {
        const phase2 = JSON.parse(fs.readFileSync(PHASE2_RESULTS_JSON, 'utf8')) as {
          verdict?: { decision_rule_quote?: string };
        };
        phase2Quote = phase2.verdict?.decision_rule_quote ?? null;
      } catch {
        phase2Quote = null;
      }
    }
    if (phase2Quote == null) {
      const { DECISION_RULE_QUOTE } = await import('../../../benchmark/episodic-density/verdict.js');
      phase2Quote = DECISION_RULE_QUOTE;
    }

    await seedFloorCorpus();
    await runFullPhase21Measurement(db, {
      seed: 42,
      ts_epoch: 1000,
      resultsJsonPath: RESULTS_JSON,
      resultsMdPath: RESULTS_MD,
      aggregatorPath: AGGREGATOR_PATH,
    });
    const phase21 = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8')) as {
      verdicts: Record<string, { decision_rule_quote: string }>;
    };
    expect(phase21.verdicts.strict_3frame.decision_rule_quote).toBe(phase2Quote);
    expect(phase21.verdicts.relaxed_2frame.decision_rule_quote).toBe(phase2Quote);
  });
});

describe('multi-handle.json aggregator schema (CONTEXT.md decision 4d)', () => {
  it('top-level keys are exactly {schema_version, question, bound_experiences}', async () => {
    await seedFloorCorpus();
    await runFullPhase21Measurement(db, {
      seed: 42,
      ts_epoch: 1000,
      resultsJsonPath: RESULTS_JSON,
      resultsMdPath: RESULTS_MD,
      aggregatorPath: AGGREGATOR_PATH,
    });
    const parsed = JSON.parse(fs.readFileSync(AGGREGATOR_PATH, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['bound_experiences', 'question', 'schema_version']);
  });

  it('NO combined/winning/primary/current_consensus at top level', async () => {
    await seedFloorCorpus();
    await runFullPhase21Measurement(db, {
      seed: 42,
      ts_epoch: 1000,
      resultsJsonPath: RESULTS_JSON,
      resultsMdPath: RESULTS_MD,
      aggregatorPath: AGGREGATOR_PATH,
    });
    const parsed = JSON.parse(fs.readFileSync(AGGREGATOR_PATH, 'utf8')) as Record<string, unknown>;
    for (const forbidden of ['combined', 'winning', 'primary', 'current_consensus']) {
      expect(parsed[forbidden]).toBeUndefined();
    }
  });

  it('bound_experiences entries have shape {phase, labeler, date, n, verdict, conditions, metrics}', async () => {
    await seedFloorCorpus();
    await runFullPhase21Measurement(db, {
      seed: 42,
      ts_epoch: 1000,
      resultsJsonPath: RESULTS_JSON,
      resultsMdPath: RESULTS_MD,
      aggregatorPath: AGGREGATOR_PATH,
    });
    const parsed = JSON.parse(fs.readFileSync(AGGREGATOR_PATH, 'utf8')) as { bound_experiences: Array<Record<string, unknown>> };
    expect(parsed.bound_experiences.length).toBeGreaterThanOrEqual(2);
    for (const entry of parsed.bound_experiences) {
      const keys = Object.keys(entry).sort();
      expect(keys).toEqual(['conditions', 'date', 'labeler', 'metrics', 'n', 'phase', 'verdict']);
    }
  });
});
