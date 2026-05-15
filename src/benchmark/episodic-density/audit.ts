/**
 * Phase 2.1 IDX-02 — descriptive spot-check audit (CONTEXT.md decision 3).
 *
 * Audit is descriptive, NOT gating. The 20 sampled pairs per tier are
 * stratified proportionally across the three corpus_origin tiers from
 * Plan 02.1-01 (`v4_backfill` / `phase1_organic_pre_phase2_close` /
 * `phase1_organic_post_phase2_close`). The auditor agent reviews each
 * pair and records valid/invalid judgment + reasoning; the final
 * precision figure (e.g. 17/20) becomes a measured CONDITION reported
 * in 02.1-RESULTS.md.
 *
 * NO precision gate. The Wilson CI binding from Phase 2 CONTEXT.md
 * item 5 is the only gating logic; audit precision is descriptive
 * context (CONTEXT.md decision 3b).
 *
 * Pure module — no DB, no clock — except the `runAudit` end-to-end
 * orchestrator which is the only entrypoint that touches disk + DB.
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  labelPairsByTier,
  type LabeledPair,
} from './pair-labeling.js';
import {
  type CorpusOrigin,
  type IndexedEvent,
  type LabelerTier,
} from './types.js';

const PHASE21_DIR = path.resolve(
  process.cwd(),
  '.planning',
  'phases',
  '02.1-corpus-expansion-rerun',
);

const AUDIT_SEED_DEFAULT = 4321;
const AUDIT_TARGET_DEFAULT = 20;

/* ------------------------------------------------------------------ */
/* Pure stratification math                                            */
/* ------------------------------------------------------------------ */

export interface AuditStratum {
  /** v4_backfill | phase1_organic_pre_phase2_close | phase1_organic_post_phase2_close | mixed */
  origin: CorpusOrigin | 'mixed';
  /** Total pairs in this stratum within the tier. */
  population: number;
  /** Allocated sample size. Mixed stratum is descriptive — allocation always 0. */
  allocation: number;
  /** Sampled LabeledPairs from this stratum (length === allocation). */
  sampled: LabeledPair[];
}

export interface AuditPlan {
  tier: LabelerTier;
  total_pairs: number;
  /** Sum of allocations across single-origin strata; ≤ target. */
  sampled_total: number;
  seed: number;
  target: number;
  /** Always ordered: v4_backfill, pre, post, mixed. */
  strata: AuditStratum[];
}

/** Pair stratum classification per CONTEXT.md decision 3a. */
function classifyPairStratum(p: LabeledPair): CorpusOrigin | 'mixed' {
  return p.origin_a === p.origin_b ? p.origin_a : 'mixed';
}

/** Mulberry32 — same PRNG as the rest of the harness for parity. */
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

const SINGLE_ORIGIN_TIERS: CorpusOrigin[] = [
  'v4_backfill',
  'phase1_organic_pre_phase2_close',
  'phase1_organic_post_phase2_close',
];

/**
 * Pure: given a tier's full pair list and the desired sample size,
 * compute proportional allocations across single-origin strata and
 * sample deterministically.
 *
 * Allocation algorithm:
 *   1. Group pairs by stratum (the three single-origin buckets + mixed).
 *      `totalSingleOrigin = sum(populations of v4 + pre + post)`. Mixed
 *      pairs are excluded from the stratification denominator.
 *   2. For each single-origin stratum O:
 *        floor_O = floor(target * pop_O / totalSingleOrigin)
 *      Record fractional remainder.
 *   3. If sum(floor_O) < target: distribute the missing slots
 *      (target - sum_floor) by descending fractional remainder.
 *   4. If a stratum's population < its allocation, downsize allocation
 *      to population (no upsampling); redistribute the remainder to
 *      other strata by descending fractional remainder. Edge case:
 *      population 0 -> allocation 0; redistribute.
 *   5. Final invariant: sum(allocation across single-origin strata) ==
 *      min(target, totalSingleOrigin).
 *
 * Sampling within each stratum: sort pairs by (a, b) for stability,
 * then mulberry32(seed) shuffle (Fisher-Yates), take first
 * `allocation_O`.
 */
export function planAudit(
  pairs: LabeledPair[],
  tier: LabelerTier,
  opts?: { target?: number; seed?: number },
): AuditPlan {
  const target = opts?.target ?? AUDIT_TARGET_DEFAULT;
  const seed = opts?.seed ?? AUDIT_SEED_DEFAULT;

  // Group pairs by stratum.
  const grouped: Record<CorpusOrigin | 'mixed', LabeledPair[]> = {
    v4_backfill: [],
    phase1_organic_pre_phase2_close: [],
    phase1_organic_post_phase2_close: [],
    mixed: [],
  };
  for (const p of pairs) {
    grouped[classifyPairStratum(p)].push(p);
  }

  const totalSingleOrigin =
    grouped.v4_backfill.length +
    grouped.phase1_organic_pre_phase2_close.length +
    grouped.phase1_organic_post_phase2_close.length;

  // Compute floor + fractional remainders for each single-origin stratum.
  const floorAlloc: Record<CorpusOrigin, number> = {
    v4_backfill: 0,
    phase1_organic_pre_phase2_close: 0,
    phase1_organic_post_phase2_close: 0,
  };
  const remainders: Array<{ origin: CorpusOrigin; remainder: number }> = [];
  let allocSum = 0;

  if (totalSingleOrigin > 0) {
    for (const origin of SINGLE_ORIGIN_TIERS) {
      const pop = grouped[origin].length;
      const exact = (target * pop) / totalSingleOrigin;
      const floor = Math.floor(exact);
      floorAlloc[origin] = Math.min(floor, pop);
      allocSum += floorAlloc[origin];
      remainders.push({ origin, remainder: exact - floor });
    }

    // Distribute missing slots by descending fractional remainder, with
    // overflow guard against population.
    let missing = Math.min(target, totalSingleOrigin) - allocSum;
    remainders.sort((a, b) => b.remainder - a.remainder);
    let idx = 0;
    while (missing > 0 && idx < remainders.length * 4) {
      const target_origin = remainders[idx % remainders.length].origin;
      if (floorAlloc[target_origin] < grouped[target_origin].length) {
        floorAlloc[target_origin]++;
        missing--;
      }
      idx++;
    }
  }

  // Per-stratum sampling: sort by (a, b), shuffle with seeded PRNG,
  // take first `allocation_O`.
  const rand = mulberry32(seed);
  const strata: AuditStratum[] = [];
  let sampled_total = 0;
  for (const origin of SINGLE_ORIGIN_TIERS) {
    const pop = grouped[origin];
    const allocation = floorAlloc[origin];
    sampled_total += allocation;
    if (allocation === 0) {
      strata.push({ origin, population: pop.length, allocation: 0, sampled: [] });
      continue;
    }
    const sorted = [...pop].sort((x, y) => x.a - y.a || x.b - y.b);
    for (let i = sorted.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = sorted[i];
      sorted[i] = sorted[j];
      sorted[j] = tmp;
    }
    strata.push({
      origin,
      population: pop.length,
      allocation,
      sampled: sorted.slice(0, allocation),
    });
  }

  // Mixed stratum: descriptive only — allocation always 0.
  strata.push({
    origin: 'mixed',
    population: grouped.mixed.length,
    allocation: 0,
    sampled: [],
  });

  return {
    tier,
    total_pairs: pairs.length,
    sampled_total,
    seed,
    target,
    strata,
  };
}

/* ------------------------------------------------------------------ */
/* Markdown / JSON renderers                                            */
/* ------------------------------------------------------------------ */

export interface RawEventContent {
  content: string;
  project: string;
  ts_epoch: number;
  outer_exception: string | null;
}

const TIER_LABEL: Record<LabelerTier, string> = {
  strict_3frame: 'Strict (≥3 frames)',
  relaxed_2frame: 'Relaxed (≥2 frames)',
};

function excerpt(content: string, lines = 10): string {
  return content.split('\n').slice(0, lines).join('\n');
}

export function renderAuditMarkdown(
  plan: AuditPlan,
  rawContentByEventId: Map<number, RawEventContent>,
): string {
  const v4Stratum = plan.strata.find(s => s.origin === 'v4_backfill')!;
  const preStratum = plan.strata.find(s => s.origin === 'phase1_organic_pre_phase2_close')!;
  const postStratum = plan.strata.find(s => s.origin === 'phase1_organic_post_phase2_close')!;
  const mixedStratum = plan.strata.find(s => s.origin === 'mixed')!;
  const generated = new Date().toISOString();
  const sampleSize = plan.sampled_total;

  const lines: string[] = [];
  lines.push(`# Phase 2.1 — ${TIER_LABEL[plan.tier]} Spot-Check Audit`);
  lines.push('');
  lines.push(`**Tier:** \`${plan.tier}\``);
  lines.push(`**Total pairs in tier:** ${plan.total_pairs}`);
  lines.push(`**Audit sample size:** ${sampleSize}${sampleSize < plan.target ? ` (corpus too sparse for full ${plan.target}-slot audit)` : ''}`);
  lines.push(`**Sampling seed:** ${plan.seed}`);
  lines.push(`**Generated:** ${generated}`);
  lines.push('');
  lines.push(
    '> **Audit is descriptive, NOT gating.** Per CONTEXT.md decision 3b, the precision figure below is a measured condition of this bound experience, reported in 02.1-RESULTS.md alongside n, delta_p5, Wilson CI, etc. It does NOT determine whether the tier ships — every tier ships its verdict + its conditions. The locked decision rule (Phase 2 CONTEXT.md item 5, Wilson CI binding) does the only gating.',
  );
  lines.push('');
  lines.push('## Stratification (proportional across corpus_origin)');
  lines.push('');
  lines.push('| Stratum | Population | Allocation | Pairs sampled |');
  lines.push('|---------|-----------|------------|---------------|');
  lines.push(`| v4_backfill | ${v4Stratum.population} | ${v4Stratum.allocation} | ${v4Stratum.sampled.length} |`);
  lines.push(`| phase1_organic_pre_phase2_close | ${preStratum.population} | ${preStratum.allocation} | ${preStratum.sampled.length} |`);
  lines.push(`| phase1_organic_post_phase2_close | ${postStratum.population} | ${postStratum.allocation} | ${postStratum.sampled.length} |`);
  lines.push(`| mixed (origin_a != origin_b) | ${mixedStratum.population} | (descriptive only — not counted) | 0 |`);
  lines.push('');
  lines.push(
    '**Note**: mixed-stratum pairs are reported descriptively here as a bound-experience condition; not sampled in the stratified slots (CONTEXT.md decision 3a final paragraph + planner choice in Plan 02.1-03).',
  );
  lines.push('');
  lines.push('## Auditor judgment per pair');
  lines.push('');
  lines.push(`Final precision: **{{TBD}}/${sampleSize}** (auditor agent updates after review).`);
  lines.push('');

  let pairIdx = 1;
  for (const stratum of plan.strata) {
    if (stratum.allocation === 0) continue;
    for (const pair of stratum.sampled) {
      const evA = rawContentByEventId.get(pair.a);
      const evB = rawContentByEventId.get(pair.b);
      lines.push(`### Pair ${pairIdx} — stratum: ${stratum.origin}`);
      lines.push(`- **Pair IDs:** a=${pair.a}, b=${pair.b}`);
      lines.push(`- **Outer exception:** ${pair.outer_exception}`);
      lines.push(`- **Frame overlap:** ${pair.overlap_frame_count}`);
      lines.push(`- **Same project?** ${pair.same_project ? 'yes' : 'no'} (a.project=${evA?.project ?? 'unknown'}, b.project=${evB?.project ?? 'unknown'})`);
      lines.push(`- **Event A excerpt** (full content in JSON sidecar):`);
      lines.push('  ```');
      for (const l of excerpt(evA?.content ?? '<missing>').split('\n')) lines.push(`  ${l}`);
      lines.push('  ```');
      lines.push(`- **Event B excerpt**:`);
      lines.push('  ```');
      for (const l of excerpt(evB?.content ?? '<missing>').split('\n')) lines.push(`  ${l}`);
      lines.push('  ```');
      lines.push(`- **Auditor judgment:** {{VALID | INVALID — reason}}`);
      lines.push('');
      pairIdx++;
    }
  }

  lines.push('## Per-stratum precision');
  lines.push('');
  lines.push('After per-pair judgments are filled in:');
  lines.push('');
  lines.push('| Stratum | Valid | Total sampled | Precision |');
  lines.push('|---------|-------|---------------|-----------|');
  lines.push(`| v4_backfill | {{v_v4}} | ${v4Stratum.allocation} | {{p_v4}} |`);
  lines.push(`| phase1_organic_pre_phase2_close | {{v_pre}} | ${preStratum.allocation} | {{p_pre}} |`);
  lines.push(`| phase1_organic_post_phase2_close | {{v_post}} | ${postStratum.allocation} | {{p_post}} |`);
  lines.push(`| **Tier total** | **{{V}}** | **${sampleSize}** | **{{P}}** |`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Spot-check methodology: a pair is VALID if the auditor agent agrees that the two events represent recurrence of the same root error (same root cause / same fix path), not just a coincidental same-exception-type collision. INVALID if the events share an exception type but represent unrelated bugs.');
  lines.push('- Stratified-by-corpus_origin sampling allows post-hoc analysis of whether one tier of corpus has systematically different auto-labeler precision (e.g., v4_backfill rows might have noisier auto-labeling than phase1_organic_pre_phase2_close).');
  lines.push('- Per CONTEXT.md decision 3c, this audit was conducted by the phase executor agent under autonomous-pipeline operating mode. No user-review gate at the artifact.');
  lines.push('');

  return lines.join('\n');
}

export interface AuditJsonSidecar {
  tier: LabelerTier;
  total_pairs: number;
  sampled_total: number;
  seed: number;
  target: number;
  generated_at_iso: string;
  strata: Array<{
    origin: AuditStratum['origin'];
    population: number;
    allocation: number;
    sampled: Array<{
      pair: LabeledPair;
      event_a: RawEventContent | null;
      event_b: RawEventContent | null;
    }>;
  }>;
}

export function renderAuditJson(
  plan: AuditPlan,
  rawContentByEventId: Map<number, RawEventContent>,
): string {
  const out: AuditJsonSidecar = {
    tier: plan.tier,
    total_pairs: plan.total_pairs,
    sampled_total: plan.sampled_total,
    seed: plan.seed,
    target: plan.target,
    generated_at_iso: new Date().toISOString(),
    strata: plan.strata.map(s => ({
      origin: s.origin,
      population: s.population,
      allocation: s.allocation,
      sampled: s.sampled.map(pair => ({
        pair,
        event_a: rawContentByEventId.get(pair.a) ?? null,
        event_b: rawContentByEventId.get(pair.b) ?? null,
      })),
    })),
  };
  return JSON.stringify(out, null, 2);
}

/* ------------------------------------------------------------------ */
/* End-to-end runner                                                   */
/* ------------------------------------------------------------------ */

const RAW_CONTENT_LOOKUP = `
  SELECT id, content, project, ts_epoch_ms AS ts_epoch, metadata_json
    FROM episodic_events
   WHERE id IN (__IDS__)
`;

function fetchRawContent(
  db: Database,
  ids: number[],
): Map<number, RawEventContent> {
  const out = new Map<number, RawEventContent>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const sql = RAW_CONTENT_LOOKUP.replace('__IDS__', placeholders);
  const rows = db.prepare(sql).all(...ids) as Array<{
    id: number;
    content: string;
    project: string;
    ts_epoch: number;
    metadata_json: string | null;
  }>;
  for (const row of rows) {
    let outer: string | null = null;
    if (row.metadata_json) {
      try {
        const md = JSON.parse(row.metadata_json) as { error_fingerprint?: { outer_exception?: string | null } };
        outer = md.error_fingerprint?.outer_exception ?? null;
      } catch {
        // Malformed metadata — leave outer_exception null.
      }
    }
    out.set(row.id, {
      content: row.content,
      project: row.project,
      ts_epoch: row.ts_epoch,
      outer_exception: outer,
    });
  }
  return out;
}

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function pathFor(tier: LabelerTier, kind: 'md' | 'json'): string {
  const base =
    tier === 'strict_3frame' ? '02.1-03-strict-audit' : '02.1-03-relaxed-audit';
  return path.join(PHASE21_DIR, `${base}.${kind}`);
}

/**
 * End-to-end runner — call from CLI's `audit` subcommand.
 *
 *   const events = loadCorpus(db);
 *   const plan = await runAudit(db, events, 'strict_3frame');
 *   // plan.markdownPath, plan.jsonPath written; plan.plan is the AuditPlan.
 *
 * Writes the markdown skeleton + JSON sidecar atomically. The auditor
 * agent then opens the markdown, fills in per-pair judgments, and
 * re-saves. Plan 02.1-05 (RESULTS authoring) joins the precision
 * figures from the markdown into 02.1-RESULTS.md.
 */
export async function runAudit(
  db: Database,
  events: IndexedEvent[],
  tier: LabelerTier,
  opts?: { target?: number; seed?: number; outputDir?: string },
): Promise<{ markdownPath: string; jsonPath: string; plan: AuditPlan }> {
  const pairs = labelPairsByTier(events, tier);
  const plan = planAudit(pairs, tier, { target: opts?.target, seed: opts?.seed });

  // Collect every sampled event id; fetch raw content in one round-trip.
  const sampledIds = new Set<number>();
  for (const stratum of plan.strata) {
    for (const pair of stratum.sampled) {
      sampledIds.add(pair.a);
      sampledIds.add(pair.b);
    }
  }
  const rawContent = fetchRawContent(db, [...sampledIds]);

  const baseDir = opts?.outputDir ?? PHASE21_DIR;
  const mdPath = path.join(
    baseDir,
    tier === 'strict_3frame' ? '02.1-03-strict-audit.md' : '02.1-03-relaxed-audit.md',
  );
  const jsonPath = path.join(
    baseDir,
    tier === 'strict_3frame' ? '02.1-03-strict-audit.json' : '02.1-03-relaxed-audit.json',
  );

  atomicWrite(mdPath, renderAuditMarkdown(plan, rawContent));
  atomicWrite(jsonPath, renderAuditJson(plan, rawContent));

  return { markdownPath: mdPath, jsonPath, plan };
}

/** Exposed for tests + Plan 02.1-05's RESULTS join (filename convention). */
export function defaultAuditMarkdownPath(tier: LabelerTier): string {
  return pathFor(tier, 'md');
}
