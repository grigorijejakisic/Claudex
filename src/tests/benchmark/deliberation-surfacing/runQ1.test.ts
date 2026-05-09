/**
 * POLISH-13 — runQ1 orchestration regression tests.
 *
 * Tests cover:
 *   - Pre-flight reranker health check (success / failure / skipped)
 *   - r1+r2 paired-McNemar verdict computation via mocked replicationDriver
 *   - Bi-encoder fallback rate threshold INCONCLUSIVE
 *   - Per-judge error rate >1 INCONCLUSIVE
 *   - Replication driver missing INCONCLUSIVE
 *   - Probe count != 30 INCONCLUSIVE
 *
 * No live LLM calls — all dispatchers are mocked. Live cloud plumbing is the
 * operator's job at run-time per Plan 11-06 Task 2.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import {
  runQ1,
  preflightRerankerHealth,
  pairReplicationOutcomes,
  aggregateJudgeErrors,
  writeQ1Verdict,
  readQ1Gate,
  writeQ2Skipped,
  applyConditionalOutcomes,
  loadAndClassifyPhase11,
  type Q1ReplicationResult,
  type Q1ReplicationOutcome,
  type Q1Verdict,
  type Q1ReplicationDriver,
} from '../../../benchmark/deliberation-surfacing/runner.js';
import type { JudgeIdentity, Phase11VerdictTriple } from '../../../benchmark/deliberation-surfacing/types.js';
import type { JudgeDispatcher, VerdictParser } from '../../../benchmark/deliberation-surfacing/judge-ensemble.js';

const PASS_PARSER: VerdictParser = (raw) => {
  if (raw === 'PASS') return true;
  if (raw === 'FAIL') return false;
  return null;
};

const NOOP_DISPATCHER: JudgeDispatcher = async () => 'PASS';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-runq1-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  vi.restoreAllMocks();
});

function freshDb(): Database.Database {
  // Minimal V32-shaped DB for runQ1 substrate-ish needs (loadProbes reads
  // the fixture from disk, not the DB; the DB is only used by the
  // replicationDriver in a real run). Tests pass mocked drivers.
  return new Database(':memory:');
}

function buildOutcome(
  probeId: string,
  aPass: boolean,
  bPass: boolean,
  opts: Partial<Q1ReplicationOutcome> = {},
): Q1ReplicationOutcome {
  return {
    probe_id: probeId,
    kind: opts.kind ?? 'a',
    a_arm_pass: aPass,
    b_arm_pass: bPass,
    ensemble_error: opts.ensemble_error ?? false,
    judge_error_count: opts.judge_error_count ?? 0,
    errored_judges: opts.errored_judges ?? [],
    bi_encoder_fallback: opts.bi_encoder_fallback ?? false,
  };
}

function buildReplication(
  index: 1 | 2,
  outcomes: Q1ReplicationOutcome[],
  opts: { reranker_calls?: number; bi_encoder_fallbacks?: number; seed?: number } = {},
): Q1ReplicationResult {
  return {
    seed: opts.seed ?? (index === 1 ? 1001 : 1002),
    replication_index: index,
    outcomes,
    reranker_calls: opts.reranker_calls ?? outcomes.length,
    bi_encoder_fallbacks: opts.bi_encoder_fallbacks ?? 0,
    started_at_iso: '2026-05-09T22:00:00.000Z',
    completed_at_iso: '2026-05-09T22:30:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// preflightRerankerHealth
// ---------------------------------------------------------------------------

describe('preflightRerankerHealth (POLISH-13)', () => {
  it('returns true on a 200 from /rerank', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    expect(await preflightRerankerHealth(fetcher)).toBe(true);
  });

  it('returns false on non-200', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await preflightRerankerHealth(fetcher)).toBe(false);
  });

  it('returns false on fetch error (unreachable)', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await preflightRerankerHealth(fetcher)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pairReplicationOutcomes
// ---------------------------------------------------------------------------

describe('pairReplicationOutcomes (POLISH-13)', () => {
  it('pairs r1 + r2 by probe_id', () => {
    const r1 = buildReplication(1, [
      buildOutcome('p1', true, false),
      buildOutcome('p2', false, true),
    ]);
    const r2 = buildReplication(2, [
      buildOutcome('p1', false, true),
      buildOutcome('p2', false, true),
    ]);
    const paired = pairReplicationOutcomes(r1, r2);
    expect(paired.length).toBe(2);
    const p1 = paired.find((p) => p.probe_id === 'p1')!;
    expect(p1.r1_a_arm_pass).toBe(true);
    expect(p1.r2_b_arm_pass).toBe(true);
  });

  it('marks missing probe in one replication as fail in that replication', () => {
    const r1 = buildReplication(1, [buildOutcome('p1', true, true)]);
    const r2 = buildReplication(2, []); // empty
    const paired = pairReplicationOutcomes(r1, r2);
    const p1 = paired.find((p) => p.probe_id === 'p1')!;
    expect(p1.r1_a_arm_pass).toBe(true);
    expect(p1.r2_a_arm_pass).toBe(false); // missing → fail
    expect(p1.r2_b_arm_pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// aggregateJudgeErrors
// ---------------------------------------------------------------------------

describe('aggregateJudgeErrors (POLISH-13)', () => {
  it('sums per-judge errored_judges across all replications', () => {
    const r1 = buildReplication(1, [
      buildOutcome('p1', true, true, { errored_judges: ['gemini-3-flash'] }),
      buildOutcome('p2', true, true, { errored_judges: ['gemini-3-flash', 'glm-5.1'] }),
    ]);
    const r2 = buildReplication(2, [
      buildOutcome('p1', true, true, { errored_judges: ['kimi-k2.6'] }),
    ]);
    const errors = aggregateJudgeErrors([r1, r2]);
    expect(errors['gemini-3-flash']).toBe(2);
    expect(errors['glm-5.1']).toBe(1);
    expect(errors['kimi-k2.6']).toBe(1);
    expect(errors['claude-opus-4-7']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runQ1 — orchestration paths
// ---------------------------------------------------------------------------

describe('runQ1 (POLISH-13)', () => {
  it('returns INCONCLUSIVE when reranker pre-flight fails', async () => {
    const failingFetcher = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const result = await runQ1(freshDb(), {
      outDir: tmpDir,
      r1Seed: 1, r2Seed: 2,
      dispatcher: NOOP_DISPATCHER,
      parser: PASS_PARSER,
      rerankerHealthFetcher: failingFetcher,
    });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.preflight.reranker_health).toBe('fail');
    expect(result.reason).toContain('Reranker pre-flight failed');
  });

  it('returns INCONCLUSIVE when replicationDriver missing', async () => {
    const result = await runQ1(freshDb(), {
      outDir: tmpDir,
      r1Seed: 1, r2Seed: 2,
      dispatcher: NOOP_DISPATCHER,
      parser: PASS_PARSER,
      skipRerankerHealthCheck: true,
    });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toContain('replicationDriver');
  });

  it('locked-30 guard: loadProbes throws when fixture count !=30 (defensive double-check)', async () => {
    // The default probe loader reads .planning/phases/09-empirical-measurement/probes/
    // which has exactly 30 probes. The probe-loader's own guard throws with an
    // operator-actionable message before runQ1 even sees the count — this is the
    // first defensive layer; runQ1's own count==30 check is a defense-in-depth.
    fs.mkdirSync(path.join(tmpDir, 'too-few-probes'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'too-few-probes', 'drift-a-01.json'),
      JSON.stringify({
        id: 'drift-a-01', kind: 'a', source: 'real',
        prompt: 'A short prompt that exceeds twenty characters.',
        past_artifact_ref: ['x'],
        transcript_anchor: { session_id: 's', turn_index_range: [0, 0], description: 'min ten chars desc' },
        condition_shift: { past_state: 'past state', current_state: 'current state', delta: 'changed delta' },
        pass_criterion: 'Agent must surface the past-state-vs-current-state delta.',
      }),
    );
    await expect(
      runQ1(freshDb(), {
        probesDir: path.join(tmpDir, 'too-few-probes'),
        outDir: tmpDir,
        r1Seed: 1, r2Seed: 2,
        dispatcher: NOOP_DISPATCHER,
        parser: PASS_PARSER,
        skipRerankerHealthCheck: true,
      }),
    ).rejects.toThrow(/Expected 30 probes/);
  });

  it('happy path: drives r1+r2, computes paired-McNemar, returns BIND_POSITIVE', async () => {
    // Build a mocked replicationDriver that returns deterministic per-probe outcomes
    // simulating B-arm dominance.
    const probeIds = Array.from({ length: 30 }, (_, i) =>
      `drift-${'abcde'[i % 5]}-${String((i % 6) + 1).padStart(2, '0')}`);
    const driver: Q1ReplicationDriver = vi.fn(async ({ replicationIndex, seed }) => {
      const outcomes: Q1ReplicationOutcome[] = probeIds.map((id, i) => {
        // 22 b_only, 3 a_only, 5 concordant — produces clear b-dominance.
        let aPass = false, bPass = false;
        if (i < 22) { aPass = false; bPass = true; }       // b_only
        else if (i < 25) { aPass = true; bPass = false; }  // a_only
        else { aPass = true; bPass = true; }               // concordant
        return buildOutcome(id, aPass, bPass);
      });
      return buildReplication(replicationIndex, outcomes, { seed });
    });

    const result = await runQ1(freshDb(), {
      outDir: tmpDir,
      r1Seed: 11, r2Seed: 22,
      dispatcher: NOOP_DISPATCHER,
      parser: PASS_PARSER,
      skipRerankerHealthCheck: true,
      replicationDriver: driver,
    });

    expect(driver).toHaveBeenCalledTimes(2);
    expect(result.verdict).toBe('BIND_POSITIVE');
    expect(result.paired_mcnemar).toBeDefined();
    expect(result.paired_mcnemar!.b_only).toBeGreaterThan(result.paired_mcnemar!.a_only);
    expect(result.r1).toBeDefined();
    expect(result.r2).toBeDefined();
  });

  it('returns INCONCLUSIVE when bi-encoder fallback rate exceeds threshold', async () => {
    const probeIds = Array.from({ length: 30 }, (_, i) =>
      `drift-${'abcde'[i % 5]}-${String((i % 6) + 1).padStart(2, '0')}`);
    const driver: Q1ReplicationDriver = async ({ replicationIndex, seed }) => {
      const outcomes = probeIds.map((id) => buildOutcome(id, true, true));
      return buildReplication(replicationIndex, outcomes, {
        seed,
        reranker_calls: 30,
        bi_encoder_fallbacks: 20, // 20/30 = 67% fallback per replication
      });
    };
    const result = await runQ1(freshDb(), {
      outDir: tmpDir,
      r1Seed: 1, r2Seed: 2,
      dispatcher: NOOP_DISPATCHER,
      parser: PASS_PARSER,
      skipRerankerHealthCheck: true,
      replicationDriver: driver,
      fallbackRateThresholdPct: 10,
    });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toContain('fallback rate');
    expect(result.fallback_rate_pct).toBeCloseTo(66.67, 0);
  });

  it('returns INCONCLUSIVE when >1 judge exceeds error rate', async () => {
    const probeIds = Array.from({ length: 30 }, (_, i) =>
      `drift-${'abcde'[i % 5]}-${String((i % 6) + 1).padStart(2, '0')}`);
    const driver: Q1ReplicationDriver = async ({ replicationIndex, seed }) => {
      // 5 probes errored on gemini, 5 on claude — both > 10% of 30 = 3 → INCONCLUSIVE
      const outcomes = probeIds.map((id, i) => {
        const errored: JudgeIdentity['name'][] = [];
        if (i < 5) errored.push('gemini-3-flash');
        if (i >= 5 && i < 10) errored.push('claude-opus-4-7');
        return buildOutcome(id, true, true, { errored_judges: errored, judge_error_count: errored.length });
      });
      return buildReplication(replicationIndex, outcomes, { seed });
    };
    const result = await runQ1(freshDb(), {
      outDir: tmpDir,
      r1Seed: 1, r2Seed: 2,
      dispatcher: NOOP_DISPATCHER,
      parser: PASS_PARSER,
      skipRerankerHealthCheck: true,
      replicationDriver: driver,
      perJudgeErrorThresholdPct: 10,
    });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toContain('judge');
    expect(result.reason).toContain('exceeded');
  });
});

// ---------------------------------------------------------------------------
// writeQ1Verdict + readQ1Gate + writeQ2Skipped
// ---------------------------------------------------------------------------

describe('Q1/Q2 gate I/O (POLISH-14)', () => {
  it('writeQ1Verdict + readQ1Gate roundtrip on BIND_POSITIVE', () => {
    const verdict: Q1Verdict = {
      verdict: 'BIND_POSITIVE',
      fallback_rate_pct: 0,
      per_judge_errors_pct: {},
      q1_started_at: '2026-05-09T22:00:00.000Z',
      q1_completed_at: '2026-05-09T22:30:00.000Z',
      preflight: { reranker_health: 'ok' },
    };
    const writtenPath = writeQ1Verdict(verdict, tmpDir);
    expect(fs.existsSync(writtenPath)).toBe(true);
    const gate = readQ1Gate(tmpDir);
    expect(gate.proceed).toBe(true);
    expect(gate.q1Verdict?.verdict).toBe('BIND_POSITIVE');
  });

  it('readQ1Gate skips Q2 when Q1 verdict is INCONCLUSIVE', () => {
    const verdict: Q1Verdict = {
      verdict: 'INCONCLUSIVE',
      reason: 'fallback rate exceeded',
      fallback_rate_pct: 50,
      per_judge_errors_pct: {},
      q1_started_at: '2026-05-09T22:00:00.000Z',
      q1_completed_at: '2026-05-09T22:30:00.000Z',
      preflight: { reranker_health: 'ok' },
    };
    writeQ1Verdict(verdict, tmpDir);
    const gate = readQ1Gate(tmpDir);
    expect(gate.proceed).toBe(false);
    expect(gate.skipReason).toContain('INCONCLUSIVE');
    expect(gate.q1Verdict?.verdict).toBe('INCONCLUSIVE');
  });

  it('readQ1Gate returns proceed=false when q1-verdict.json missing', () => {
    const gate = readQ1Gate(tmpDir);
    expect(gate.proceed).toBe(false);
    expect(gate.skipReason).toContain('missing');
  });

  it('writeQ2Skipped emits q2-skipped.json with reason', () => {
    const skipPath = writeQ2Skipped('Q1 not BIND_POSITIVE', tmpDir);
    expect(fs.existsSync(skipPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(skipPath, 'utf8'));
    expect(parsed.skip_reason).toBe('Q1 not BIND_POSITIVE');
    expect(parsed.skipped_at).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// applyConditionalOutcomes
// ---------------------------------------------------------------------------

describe('applyConditionalOutcomes (POLISH-15)', () => {
  function q1(verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE'): Q1Verdict {
    return {
      verdict,
      fallback_rate_pct: 0,
      per_judge_errors_pct: {},
      q1_started_at: '', q1_completed_at: '',
      preflight: { reranker_health: 'ok' },
    };
  }

  it('Q1 missing → incomplete', () => {
    expect(applyConditionalOutcomes({})).toBe('incomplete');
  });

  it('Q1 BIND_NEGATIVE → kill_receipt_q1_negative', () => {
    expect(applyConditionalOutcomes({ q1: q1('BIND_NEGATIVE') })).toBe('kill_receipt_q1_negative');
  });

  it('Q1 INCONCLUSIVE → kill_receipt_q1_inconclusive', () => {
    expect(applyConditionalOutcomes({ q1: q1('INCONCLUSIVE') })).toBe('kill_receipt_q1_inconclusive');
  });

  it('Q1 BIND_POSITIVE + Q2 BIND_NEGATIVE → kill_receipt_q2_negative', () => {
    const triple: Phase11VerdictTriple = {
      q1: q1('BIND_POSITIVE'),
      q2: { verdict: 'BIND_NEGATIVE' },
    };
    expect(applyConditionalOutcomes(triple)).toBe('kill_receipt_q2_negative');
  });

  it('Q1 BIND_POSITIVE + Q2 INCONCLUSIVE → p11_1_corpus_expansion', () => {
    expect(applyConditionalOutcomes({
      q1: q1('BIND_POSITIVE'),
      q2: { verdict: 'INCONCLUSIVE' },
    })).toBe('p11_1_corpus_expansion');
  });

  it('Q1+Q2 BIND_POSITIVE, Q3 missing → engineering_close_within_corpus_bind', () => {
    expect(applyConditionalOutcomes({
      q1: q1('BIND_POSITIVE'),
      q2: { verdict: 'BIND_POSITIVE' },
    })).toBe('engineering_close_within_corpus_bind');
  });

  it('Q1+Q2+Q3 BIND_POSITIVE → engineering_close_strong_bind', () => {
    expect(applyConditionalOutcomes({
      q1: q1('BIND_POSITIVE'),
      q2: { verdict: 'BIND_POSITIVE' },
      q3: { verdict: 'BIND_POSITIVE' },
    })).toBe('engineering_close_strong_bind');
  });

  it('Q1+Q2 BIND_POSITIVE, Q3 BIND_NEGATIVE → engineering_close_recursive_echo', () => {
    expect(applyConditionalOutcomes({
      q1: q1('BIND_POSITIVE'),
      q2: { verdict: 'BIND_POSITIVE' },
      q3: { verdict: 'BIND_NEGATIVE' },
    })).toBe('engineering_close_recursive_echo');
  });

  it('Q1+Q2 BIND_POSITIVE, Q3 INCONCLUSIVE → engineering_close_within_corpus_bind', () => {
    expect(applyConditionalOutcomes({
      q1: q1('BIND_POSITIVE'),
      q2: { verdict: 'BIND_POSITIVE' },
      q3: { verdict: 'INCONCLUSIVE' },
    })).toBe('engineering_close_within_corpus_bind');
  });

  it('Q1+Q2 BIND_POSITIVE, Q3 skipped → engineering_close_within_corpus_bind', () => {
    expect(applyConditionalOutcomes({
      q1: q1('BIND_POSITIVE'),
      q2: { verdict: 'BIND_POSITIVE' },
      q3: { verdict: 'INCONCLUSIVE', skipped: true },
    })).toBe('engineering_close_within_corpus_bind');
  });
});

// ---------------------------------------------------------------------------
// loadAndClassifyPhase11
// ---------------------------------------------------------------------------

describe('loadAndClassifyPhase11 (POLISH-15)', () => {
  it('loads Q1 + Q2 + Q3 verdict files from disk and classifies', () => {
    fs.writeFileSync(path.join(tmpDir, 'q1-verdict.json'), JSON.stringify({
      verdict: 'BIND_POSITIVE', fallback_rate_pct: 0, per_judge_errors_pct: {},
      q1_started_at: '', q1_completed_at: '', preflight: { reranker_health: 'ok' },
    }));
    fs.writeFileSync(path.join(tmpDir, 'q2-verdict.json'), JSON.stringify({ verdict: 'BIND_POSITIVE' }));
    fs.writeFileSync(path.join(tmpDir, 'q3-verdict.json'), JSON.stringify({ verdict: 'BIND_POSITIVE' }));
    const result = loadAndClassifyPhase11(tmpDir);
    expect(result.branch).toBe('engineering_close_strong_bind');
  });

  it('loads q2-skipped.json as INCONCLUSIVE+skipped', () => {
    fs.writeFileSync(path.join(tmpDir, 'q1-verdict.json'), JSON.stringify({
      verdict: 'BIND_NEGATIVE', fallback_rate_pct: 0, per_judge_errors_pct: {},
      q1_started_at: '', q1_completed_at: '', preflight: { reranker_health: 'ok' },
    }));
    fs.writeFileSync(path.join(tmpDir, 'q2-skipped.json'), JSON.stringify({
      skipped_at: '2026-05-09T22:00:00.000Z',
      skip_reason: 'Q1 not BIND_POSITIVE',
      q1_verdict: 'BIND_NEGATIVE',
    }));
    const result = loadAndClassifyPhase11(tmpDir);
    expect(result.branch).toBe('kill_receipt_q1_negative');
    expect(result.triple.q2?.skipped).toBe(true);
  });

  it('returns incomplete when nothing on disk', () => {
    const result = loadAndClassifyPhase11(tmpDir);
    expect(result.branch).toBe('incomplete');
  });
});
