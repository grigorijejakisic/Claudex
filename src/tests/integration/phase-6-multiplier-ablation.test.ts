/**
 * Phase 6 Plan 01 — Per-multiplier ablation harness (scaffold).
 *
 * **Purpose.** This file is the substrate for the Phase 6 W2 per-multiplier
 * ablation sweep. W1 lands the harness with a single concrete assertion:
 * the all-enabled (production) flag set passes ≥80% of the probe set.
 *
 * The full sweep (turn each of the seven multipliers off in isolation, capture
 * pass-rate delta vs the baseline, and write `06-MULTIPLIER-ABLATION.md`
 * verdicts) is the W2 task — wired here as a `describe.skip` block that W2
 * unskips after collecting the JSON output.
 *
 * **Why ≥80%.** Probe set is 11 deterministic seed-and-recall pairs across
 * four recall flavors (lesson, entity, constraint, handoff). Practical floor;
 * not a significance claim. With N=11 the per-flag delta resolution is ~9pp,
 * so a 1pp swing is noise.
 *
 * **Why hybridSearchSync.** The sync path is what session-start and
 * user-prompt-submit hooks use under the deadlock-safe constraint. It is
 * also the only path that today applies all seven multipliers (qMultiplier
 * lives in sync only — that sync↔async mismatch is Plan 03's alignment).
 *
 * Output:
 *   `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-01-baseline.json`
 *
 * Invocation:
 *   `bun run test src/tests/integration/phase-6-multiplier-ablation.test.ts`
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestDbWithSession } from '../helpers/test-db.js';
import { createArtifact } from '../../core/artifacts.js';
import {
  hybridSearchSync,
  type MultiplierName,
  type ScoredArtifact,
} from '../../core/hybrid-retrieval.js';

// ---------------------------------------------------------------------------
// Probe set
// ---------------------------------------------------------------------------

export interface Probe {
  /** Stable identifier used in the per-probe JSON output. */
  id: string;
  /** Recall flavor — used for per-flavor breakdowns in W2. */
  flavor: 'lesson' | 'entity' | 'constraint' | 'handoff';
  /** Seed: artifacts to insert (target first, then distractors). */
  seed: Array<{
    summary: string;
    content: string;
    type: 'observation' | 'learning' | 'decision' | 'hot_file' | 'flow' | 'milestone' | 'memory_file' | 'session_log' | 'handoff';
    importance: number;
    isTarget: boolean;
  }>;
  /** Query string to retrieve the target artifact. */
  query: string;
  /** Top-K window: target must appear in this many results to pass. */
  topK: number;
}

/**
 * 11-probe set spanning the four recall flavors. Each probe seeds one target
 * artifact and ≥4 distractors so a passing retrieval must rank the target
 * within the top-`topK`. Distractors share at least one query token with the
 * target so the test exercises the multiplier stack rather than trivial
 * keyword matching.
 */
export const PROBES: Probe[] = [
  // ---- Lesson recall (4) — paraphrase robustness, ported from
  //      phase-4-1-perceptual-similarity-probes.test.ts substrate.
  {
    id: 'lesson-shadowban-canonical',
    flavor: 'lesson',
    query: 'rate limit shadowban polls window',
    topK: 3,
    seed: [
      { summary: 'Backend X 60-poll shadowban — 15-min IP ban after window',
        content: 'shadowban rate limit polls window 15min IP ban backoff',
        type: 'learning', importance: 4, isTarget: true },
      { summary: 'API rate limit retry-after header guidance',
        content: 'rate limit retry-after header generic backoff', type: 'learning', importance: 3, isTarget: false },
      { summary: 'Polling cadence design notes',
        content: 'polling intervals window timing', type: 'observation', importance: 2, isTarget: false },
      { summary: 'IP allow-listing for staging cluster',
        content: 'IP allow-list staging cluster network', type: 'observation', importance: 2, isTarget: false },
      { summary: 'OAuth token rotation schedule',
        content: 'oauth token rotation schedule auth', type: 'decision', importance: 3, isTarget: false },
    ],
  },
  {
    id: 'lesson-shadowban-paraphrase',
    flavor: 'lesson',
    query: 'too many requests poll backoff window',
    topK: 3,
    seed: [
      { summary: 'Backend X 60-poll shadowban — 15-min IP ban after window',
        content: 'shadowban rate limit polls window 15min IP ban backoff', type: 'learning', importance: 4, isTarget: true },
      { summary: 'Generic backoff strategies catalog',
        content: 'generic backoff strategies cataloged exponential jitter', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Polls dashboard panel layout',
        content: 'dashboard polls layout grafana panel', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Window function aggregation in SQL',
        content: 'sql window function aggregation over partition', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Backoff retry queue spec',
        content: 'backoff retry queue specification draft', type: 'decision', importance: 2, isTarget: false },
    ],
  },
  {
    id: 'lesson-mock-prod-divergence',
    flavor: 'lesson',
    query: 'mock test passed but production migration failed',
    topK: 3,
    seed: [
      { summary: 'Mocked DB tests passed; prod migration broke — drop mocks for migration tests',
        content: 'mock database mocked tests prod production migration broke divergence', type: 'learning', importance: 5, isTarget: true },
      { summary: 'DB connection pooling config',
        content: 'db connection pool size warmup', type: 'decision', importance: 3, isTarget: false },
      { summary: 'Production canary rollout plan',
        content: 'production canary rollout staged release plan', type: 'decision', importance: 3, isTarget: false },
      { summary: 'Mocks vs fakes vs stubs glossary',
        content: 'mocks fakes stubs definitions glossary', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Migration runner dry-run flag',
        content: 'migration runner dry-run flag preview', type: 'observation', importance: 3, isTarget: false },
    ],
  },
  {
    id: 'lesson-summary-trailing',
    flavor: 'lesson',
    query: 'stop summarizing what you did at the end',
    topK: 3,
    seed: [
      { summary: 'Terse responses preferred — no trailing what-I-did summaries',
        content: 'terse no trailing summary user preference reading diff is enough', type: 'learning', importance: 4, isTarget: true },
      { summary: 'Diff viewer keybindings cheatsheet',
        content: 'diff viewer keybindings cheatsheet', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Summary writing style guide',
        content: 'summary writing style guide markdown', type: 'observation', importance: 2, isTarget: false },
      { summary: 'End-of-day standup template',
        content: 'end-of-day standup template fields', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Trailing whitespace lint rule',
        content: 'trailing whitespace lint eslint rule', type: 'decision', importance: 2, isTarget: false },
    ],
  },
  // ---- Entity recall (3) — query a paraphrase of the entity name.
  {
    id: 'entity-vesna-probe',
    flavor: 'entity',
    query: 'vesna probe agent gate',
    topK: 3,
    seed: [
      { summary: 'Vesna behavioral probe — SC#1 gate for v4 phases',
        content: 'vesna probe behavioral SC1 gate v4 phases agent', type: 'observation', importance: 4, isTarget: true },
      { summary: 'BGE reranker service notes',
        content: 'bge reranker service port 7439 cross encoder', type: 'observation', importance: 3, isTarget: false },
      { summary: 'Probe rotation schedule',
        content: 'probe rotation schedule weekly cadence', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Agent definitions in teams.md',
        content: 'agent definitions teams md catalog', type: 'observation', importance: 2, isTarget: false },
      { summary: 'V4 trajectory audit log',
        content: 'v4 trajectory audit log evidence', type: 'observation', importance: 3, isTarget: false },
    ],
  },
  {
    id: 'entity-angel-process',
    flavor: 'entity',
    query: 'guardian heartbeat extractor process',
    topK: 3,
    seed: [
      { summary: 'Angel — persistent guardian extractor running heartbeat phases',
        content: 'angel guardian heartbeat extractor patterns memory_md_writer process supervised', type: 'observation', importance: 4, isTarget: true },
      { summary: 'Heartbeat polling intervals tuning',
        content: 'heartbeat polling intervals tuning seconds', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Extractor batch size config',
        content: 'extractor batch size config tuning', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Guardian role in security hardening',
        content: 'guardian security hardening generic role', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Process supervision via systemd',
        content: 'process supervision systemd unit file', type: 'observation', importance: 2, isTarget: false },
    ],
  },
  {
    id: 'entity-claudex-db',
    flavor: 'entity',
    query: 'sqlite source of truth database',
    topK: 3,
    seed: [
      { summary: 'Claudex DB — single SQLite source of truth at ~/.claudex/db/claudex.db',
        content: 'claudex db sqlite source truth single store vec0 fts5 unified', type: 'observation', importance: 5, isTarget: true },
      { summary: 'SQLite WAL mode configuration',
        content: 'sqlite wal mode configuration journal', type: 'observation', importance: 3, isTarget: false },
      { summary: 'Database backup retention policy',
        content: 'database backup retention policy weekly', type: 'decision', importance: 3, isTarget: false },
      { summary: 'Truth table for boolean simplification',
        content: 'truth table boolean simplification logic', type: 'observation', importance: 1, isTarget: false },
      { summary: 'Source code organization conventions',
        content: 'source code organization conventions repo', type: 'observation', importance: 2, isTarget: false },
    ],
  },
  // ---- Constraint recall (2).
  {
    id: 'constraint-no-mock-db',
    flavor: 'constraint',
    query: 'integration tests must hit real database',
    topK: 3,
    seed: [
      { summary: 'Integration tests MUST use real DB; mocks forbidden in this layer',
        content: 'integration tests real database not mocked migration safety constraint', type: 'decision', importance: 5, isTarget: true },
      { summary: 'Test pyramid distribution guidelines',
        content: 'test pyramid unit integration e2e distribution', type: 'observation', importance: 3, isTarget: false },
      { summary: 'Real-world API throttling examples',
        content: 'real world api throttling examples', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Database connection retry strategy',
        content: 'database connection retry strategy backoff', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Mock library comparison: vitest vs jest',
        content: 'mock library comparison vitest jest sinon', type: 'observation', importance: 2, isTarget: false },
    ],
  },
  {
    id: 'constraint-no-hook-cli-call',
    flavor: 'constraint',
    query: 'never call CC API from hook deadlock',
    topK: 3,
    seed: [
      { summary: 'Hook deadlock — never call CC CLIProxyAPI from a hook; use Ollama',
        content: 'hook deadlock never call cc cliproxyapi from hook ollama instead constraint', type: 'decision', importance: 5, isTarget: true },
      { summary: 'CC CLI flag glossary',
        content: 'cc cli flag glossary common options', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Ollama installation notes',
        content: 'ollama installation notes setup ports', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Deadlock detection in concurrent code',
        content: 'deadlock detection concurrent code locking', type: 'observation', importance: 2, isTarget: false },
      { summary: 'API rate limits across vendors',
        content: 'api rate limits vendors comparison generic', type: 'observation', importance: 2, isTarget: false },
    ],
  },
  // ---- Handoff pickup (2).
  {
    id: 'handoff-phase-4-1',
    flavor: 'handoff',
    query: 'phase 4.1 wave 5 live fire gate next session',
    topK: 3,
    seed: [
      { summary: 'Phase 4.1 wave 5 — live-fire gate PASS; ready for Phase 5',
        content: 'phase 4.1 wave 5 live fire gate pass next session phase 5 handoff', type: 'handoff', importance: 5, isTarget: true },
      { summary: 'Gate criteria glossary across phases',
        content: 'gate criteria glossary across phases generic', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Live-fire methodology overview',
        content: 'live fire methodology overview testing', type: 'observation', importance: 3, isTarget: false },
      { summary: 'Phase 5 plan-discussion notes',
        content: 'phase 5 plan discussion notes pre-research', type: 'observation', importance: 3, isTarget: false },
      { summary: 'Wave-based execution model',
        content: 'wave based execution model gsd planning', type: 'observation', importance: 2, isTarget: false },
    ],
  },
  {
    id: 'handoff-phase-5',
    flavor: 'handoff',
    query: 'phase 5 simplification SC#1 vesna probe complete',
    topK: 3,
    seed: [
      { summary: 'Phase 5 complete — SC#1 Vesna ≥80% gate PASS; ready for Phase 5.5',
        content: 'phase 5 complete sc1 vesna gate pass ready phase 5.5 simplification handoff', type: 'handoff', importance: 5, isTarget: true },
      { summary: 'Vesna probe failure-mode catalog',
        content: 'vesna probe failure mode catalog scenarios', type: 'observation', importance: 3, isTarget: false },
      { summary: 'Phase 5.5 curation feedback loop notes',
        content: 'phase 5.5 curation feedback loop notes pointer', type: 'observation', importance: 3, isTarget: false },
      { summary: 'SC#2 cache stability harness layout',
        content: 'sc2 cache stability harness layout three layer', type: 'observation', importance: 2, isTarget: false },
      { summary: 'Simplification ledger SUMMARY pattern',
        content: 'simplification ledger summary pattern markdown', type: 'observation', importance: 2, isTarget: false },
    ],
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Names of the six multipliers under per-flag ablation. */
const MULTIPLIERS_TO_ABLATE: MultiplierName[] = [
  'recency', 'importance', 'relevance',
  'retrieval', 'novelty', 'activation',
];

export interface ProbeOutcome {
  probeId: string;
  flavor: Probe['flavor'];
  passed: boolean;
  /** Index of target in the result list (-1 = not in window). */
  targetRank: number;
}

export function runProbe(probe: Probe, flags: Partial<Record<MultiplierName, boolean>>): ProbeOutcome {
  const { db, sessionId, project } = createTestDbWithSession();

  const targetSummaries: string[] = [];
  for (const item of probe.seed) {
    const id = createArtifact(db, sessionId, project, item.type, null, item.summary, item.content, item.importance);
    if (item.isTarget) targetSummaries.push(item.summary);
    void id;
  }

  const results: ScoredArtifact[] = hybridSearchSync(db, probe.query, project, {
    limit: probe.topK,
    multiplierFlags: flags,
  });

  const targetRank = results.findIndex(r => targetSummaries.includes(r.summary ?? ''));
  db.close();

  return {
    probeId: probe.id,
    flavor: probe.flavor,
    passed: targetRank >= 0,
    targetRank,
  };
}

interface RunRecord {
  flags: Partial<Record<MultiplierName, boolean>>;
  perProbe: ProbeOutcome[];
  passRate: number;
  passCount: number;
  total: number;
  /** Per-recall-flavor breakdown for KEEP-WITH-TRADE-OFF detection. */
  perCategoryPassRate: Record<Probe['flavor'], { passed: number; total: number; rate: number }>;
}

function aggregateByCategory(perProbe: ProbeOutcome[]): RunRecord['perCategoryPassRate'] {
  const out: RunRecord['perCategoryPassRate'] = {
    lesson:     { passed: 0, total: 0, rate: 0 },
    entity:     { passed: 0, total: 0, rate: 0 },
    constraint: { passed: 0, total: 0, rate: 0 },
    handoff:    { passed: 0, total: 0, rate: 0 },
  };
  for (const p of perProbe) {
    out[p.flavor].total += 1;
    if (p.passed) out[p.flavor].passed += 1;
  }
  for (const k of Object.keys(out) as Probe['flavor'][]) {
    out[k].rate = out[k].total === 0 ? 0 : out[k].passed / out[k].total;
  }
  return out;
}

function runOnce(flags: Partial<Record<MultiplierName, boolean>>): RunRecord {
  const perProbe = PROBES.map(p => runProbe(p, flags));
  const passCount = perProbe.filter(p => p.passed).length;
  return {
    flags,
    perProbe,
    passRate: passCount / PROBES.length,
    passCount,
    total: PROBES.length,
    perCategoryPassRate: aggregateByCategory(perProbe),
  };
}

function writeRunJson(filename: string, record: RunRecord): void {
  const dir = path.resolve(
    process.cwd(),
    '.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs',
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2));
}

// ---------------------------------------------------------------------------
// W1: baseline + RRF-only invariants
// ---------------------------------------------------------------------------

describe('Phase 6 multiplier ablation harness — W1 baseline', () => {
  it('baseline (all flags enabled = production) passes ≥80% of the probe set', () => {
    const baseline = runOnce({});
    writeRunJson('06-01-baseline.json', baseline);

    expect(baseline.total).toBe(PROBES.length);
    expect(baseline.passCount).toBeGreaterThanOrEqual(Math.ceil(PROBES.length * 0.8));
  });

  it('all-disabled flag set: hybrid_score === rrfScore (RRF-only invariant)', () => {
    // RRF-only invariant: when every multiplier is off, hybrid_score collapses
    // to the raw rrfScore (since baseScore = rrfScore × (1 + 0) and every
    // outer multiplier is 1.0). This is the structural floor of the harness:
    // any future scoring change must preserve it.
    const flags: Partial<Record<MultiplierName, boolean>> = {};
    for (const m of MULTIPLIERS_TO_ABLATE) flags[m] = false;

    const probe = PROBES[0];
    const { db, sessionId, project } = createTestDbWithSession();
    for (const item of probe.seed) {
      createArtifact(db, sessionId, project, item.type, null, item.summary, item.content, item.importance);
    }

    const results = hybridSearchSync(db, probe.query, project, {
      limit: 5,
      multiplierFlags: flags,
    });
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      const breakdown = r.score_breakdown!;
      const rrf = breakdown.rrf_fts5 + breakdown.rrf_vector + breakdown.rrf_recency;
      // Strict equality: the formula reduces to hybrid_score = rrfScore × (1 + 0) × 1 × 1 × 1 × 1.
      expect(r.hybrid_score).toBeCloseTo(rrf, 12);
    }

    db.close();
  });
});

// ---------------------------------------------------------------------------
// W2: per-multiplier sweep — emits one JSON per ablation plus a summary.
// ---------------------------------------------------------------------------

describe('Phase 6 multiplier ablation harness — W2 per-multiplier sweep', () => {
  /**
   * Runs the baseline + 7 single-multiplier-disabled runs + the all-disabled
   * sanity run. Writes:
   *   - 06-02-baseline.json       (all enabled)
   *   - 06-02-disable-{m}.json    (one per multiplier)
   *   - 06-02-all-disabled.json   (RRF only)
   *   - 06-02-sweep-summary.json  (baseline + sweep + deltas + verdicts)
   */
  it('emits per-flag JSONs and a sweep summary suitable for paste into 06-MULTIPLIER-ABLATION.md', () => {
    const baseline = runOnce({});
    writeRunJson('06-02-baseline.json', baseline);

    interface SweepEntry {
      disabled: MultiplierName;
      record: RunRecord;
      deltaPp: number;
      perCategoryDeltaPp: Record<Probe['flavor'], number>;
      simpleVerdict: 'KEEP' | 'DROP';
      finalVerdict: 'KEEP' | 'DROP' | 'KEEP-WITH-TRADE-OFF';
    }

    const sweep: SweepEntry[] = [];
    for (const m of MULTIPLIERS_TO_ABLATE) {
      const flags: Partial<Record<MultiplierName, boolean>> = {};
      flags[m] = false;
      const record = runOnce(flags);
      writeRunJson(`06-02-disable-${m}.json`, record);

      const deltaPp = (record.passRate - baseline.passRate) * 100;
      const perCategoryDeltaPp: Record<Probe['flavor'], number> = {
        lesson:     (record.perCategoryPassRate.lesson.rate     - baseline.perCategoryPassRate.lesson.rate)     * 100,
        entity:     (record.perCategoryPassRate.entity.rate     - baseline.perCategoryPassRate.entity.rate)     * 100,
        constraint: (record.perCategoryPassRate.constraint.rate - baseline.perCategoryPassRate.constraint.rate) * 100,
        handoff:    (record.perCategoryPassRate.handoff.rate    - baseline.perCategoryPassRate.handoff.rate)    * 100,
      };

      // Simple delta rule: a >1pp drop in overall pass rate when the
      // multiplier is disabled means the multiplier is load-bearing → KEEP.
      // Otherwise → DROP (delta ≤1pp = within harness noise floor at N=11).
      const simpleVerdict: SweepEntry['simpleVerdict'] = deltaPp < -1 ? 'KEEP' : 'DROP';

      // Edge-case override: if the simple rule says DROP but ANY category
      // degrades by >2pp, override to KEEP-WITH-TRADE-OFF — the multiplier
      // helps a specific recall flavor even if the aggregate is flat.
      const anyCategoryDegrades = Object.values(perCategoryDeltaPp).some(d => d < -2);
      const finalVerdict: SweepEntry['finalVerdict'] =
        simpleVerdict === 'DROP' && anyCategoryDegrades
          ? 'KEEP-WITH-TRADE-OFF'
          : simpleVerdict;

      sweep.push({
        disabled: m,
        record,
        deltaPp,
        perCategoryDeltaPp,
        simpleVerdict,
        finalVerdict,
      });
    }

    // All-disabled sanity run (RRF only).
    const allDisabledFlags: Partial<Record<MultiplierName, boolean>> = {};
    for (const m of MULTIPLIERS_TO_ABLATE) allDisabledFlags[m] = false;
    const allDisabled = runOnce(allDisabledFlags);
    writeRunJson('06-02-all-disabled.json', allDisabled);

    // Sweep summary — single source of truth for 06-MULTIPLIER-ABLATION.md.
    writeRunJson('06-02-sweep-summary.json', {
      flags: {},
      perProbe: [],
      passRate: baseline.passRate,
      passCount: baseline.passCount,
      total: baseline.total,
      perCategoryPassRate: baseline.perCategoryPassRate,
    });
    fs.writeFileSync(
      path.resolve(
        process.cwd(),
        '.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/runs/06-02-sweep-summary.json',
      ),
      JSON.stringify({
        captured_at: new Date().toISOString(),
        probe_count: PROBES.length,
        baseline: {
          passRate: baseline.passRate,
          passCount: baseline.passCount,
          total: baseline.total,
          perCategoryPassRate: baseline.perCategoryPassRate,
        },
        all_disabled: {
          passRate: allDisabled.passRate,
          passCount: allDisabled.passCount,
          total: allDisabled.total,
          perCategoryPassRate: allDisabled.perCategoryPassRate,
        },
        sweep: sweep.map(s => ({
          disabled: s.disabled,
          enabledRate: baseline.passRate,
          disabledRate: s.record.passRate,
          deltaPp: s.deltaPp,
          perCategoryDeltaPp: s.perCategoryDeltaPp,
          simpleVerdict: s.simpleVerdict,
          finalVerdict: s.finalVerdict,
        })),
      }, null, 2),
    );

    // Sanity check on shape; the planning-doc bar lives in the SUMMARY/ABLATION
    // doc, not at the test layer (per plan).
    expect(sweep.length).toBe(MULTIPLIERS_TO_ABLATE.length);
    expect(baseline.passRate).toBeGreaterThanOrEqual(0.8);
  });

  /**
   * Sanity check: the 4 lesson-recall paraphrase probes carried over from
   * Phase 4.1 / 5 must still pass at 100% under the all-enabled baseline.
   * If they don't, the harness has drifted relative to Phase 5 Vesna baseline
   * and Wave 3 verdict adoption must block.
   */
  it('lesson-recall subset matches Phase 5 Vesna baseline (4/4 = 100%)', () => {
    const baseline = runOnce({});
    const lessonProbes = baseline.perProbe.filter(p => p.flavor === 'lesson');
    const lessonPassRate = lessonProbes.filter(p => p.passed).length / lessonProbes.length;
    expect(lessonProbes.length).toBe(4);
    expect(lessonPassRate).toBe(1.0);
  });
});
