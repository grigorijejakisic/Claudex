/**
 * label-candidates.ts — LLM labeler + human-review CLI (Plan 03-03).
 *
 * Reads `fixture-candidates.jsonl`, asks a NON-glm-5.1 labeler model to
 * produce `{is_directive, scope, polarity, self_confidence, reasoning}` per
 * candidate, and writes `gold-labels.jsonl` with `human_verified: false` for
 * every row.
 *
 * A subsequent `--review` run presents flagged rows (self_confidence < 0.8,
 * 10% spot-check seed, and optional detector/labeler disagreements) to the
 * operator for accept / override / skip.
 *
 * Self-agreement-bias guard: the labeler MUST NOT be `glm-5.1:cloud` (the
 * detector's model). Default is `deepseek-v3.2:cloud` (different family).
 * Override with `--labeler-model=...`.
 *
 * Usage:
 *   # Label pass (LLM)
 *   node dist/benchmarks/directive-detector/label-candidates.cjs label
 *     [--input=.planning/.../fixtures/fixture-candidates.jsonl]
 *     [--output=.planning/.../fixtures/gold-labels.jsonl]
 *     [--labeler-model=deepseek-v3.2:cloud]
 *     [--batch-size=8]
 *     [--limit=N]            # label first N only — useful for smoke test
 *
 *   # Review pass (human)
 *   node dist/benchmarks/directive-detector/label-candidates.cjs review
 *     [--labels=.planning/.../fixtures/gold-labels.jsonl]
 *     [--candidates=.planning/.../fixtures/fixture-candidates.jsonl]
 *     [--detector-run=<path>.json]      # optional disagreement file
 *     [--spot-check-rate=0.1]
 *     [--seed=42]
 *
 *   # List flagged (reviewer-prep)
 *   node dist/benchmarks/directive-detector/label-candidates.cjs list-flagged
 *     [--labels=...] [--spot-check-rate=0.1] [--seed=42]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { callLocalLLM } from '../../angel/llama-client.js';
import type { FixtureCandidate, ContextTurn } from './build-candidates.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LabelFields {
  is_directive: boolean;
  scope: 'session' | 'project' | 'universal' | null;
  polarity: 'prescriptive' | 'prohibitive' | null;
  self_confidence: number;
  reasoning: string;
}

export interface GoldLabelRow {
  candidate_id: string;
  label: LabelFields;
  labeled_by: string;
  labeled_at_epoch: number;
  human_verified: boolean;
  reviewer_override?: Partial<LabelFields>;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  subcommand: 'label' | 'review' | 'list-flagged';
  input: string;
  output: string;
  labels: string;
  candidates: string;
  labelerModel: string;
  batchSize: number;
  limit: number | null;
  spotCheckRate: number;
  seed: number;
  detectorRun: string | null;
}

function defaultFixturePath(file: string): string {
  return path.join(
    process.cwd(),
    '.planning',
    'phases',
    '03-p2-directive-detector',
    'fixtures',
    file,
  );
}

function parseArgs(argv: string[]): CliArgs {
  const sub = argv[0];
  if (sub !== 'label' && sub !== 'review' && sub !== 'list-flagged') {
    throw new Error(`Unknown subcommand: ${sub}. Use label | review | list-flagged`);
  }
  const out: CliArgs = {
    subcommand: sub,
    input: defaultFixturePath('fixture-candidates.jsonl'),
    output: defaultFixturePath('gold-labels.jsonl'),
    labels: defaultFixturePath('gold-labels.jsonl'),
    candidates: defaultFixturePath('fixture-candidates.jsonl'),
    labelerModel: 'deepseek-v3.2:cloud',
    batchSize: 8,
    limit: null,
    spotCheckRate: 0.1,
    seed: 42,
    detectorRun: null,
  };
  for (const arg of argv.slice(1)) {
    const [k, v] = arg.split('=');
    if (v === undefined) continue;
    if (k === '--input') out.input = v;
    else if (k === '--output') out.output = v;
    else if (k === '--labels') out.labels = v;
    else if (k === '--candidates') out.candidates = v;
    else if (k === '--labeler-model') out.labelerModel = v;
    else if (k === '--batch-size') out.batchSize = parseInt(v, 10);
    else if (k === '--limit') out.limit = parseInt(v, 10);
    else if (k === '--spot-check-rate') out.spotCheckRate = parseFloat(v);
    else if (k === '--seed') out.seed = parseInt(v, 10);
    else if (k === '--detector-run') out.detectorRun = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSONL I/O
// ---------------------------------------------------------------------------

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as T);
}

function writeJsonlAtomic<T>(file: string, rows: T[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Labeler LLM call
// ---------------------------------------------------------------------------

const LABELER_SYSTEM_PROMPT = `You are labeling candidate directives in user turns from a coding agent's
conversation transcripts. You are NOT the detector — your job is to label
these examples for a precision eval set, independently of whatever another
model might say.

A DIRECTIVE is a standing rule the user states for future turns — not:
- a task request ("add a button")
- a clarifying question
- an observation or complaint about the past
- a one-off instruction for the current step only

Scope taxonomy:
- session: scoped to the current task, PR, debugging loop, or review
- project: applies everywhere in the current repo
- universal: applies across every project the user works on

Polarity:
- prescriptive: do X
- prohibitive: don't do X

Output JSON only, one JSON object per candidate in the ORDER given, wrapped in:
{ "labels": [ { "candidate_id": "...", "is_directive": bool,
                "scope": "session"|"project"|"universal"|null,
                "polarity": "prescriptive"|"prohibitive"|null,
                "self_confidence": number (0..1),
                "reasoning": string }, ... ] }

When is_directive=false, set scope/polarity to null.
Err toward marking is_directive=false for questions, observations, hedged
preferences, and one-off task instructions. Precision beats recall here.`;

function formatContextWindow(prev: ContextTurn[], next: ContextTurn[]): string {
  const lines: string[] = [];
  for (const t of prev) {
    if (t.user_text) lines.push(`[Turn ${t.turn_idx}] USER: ${t.user_text}`);
    if (t.assistant_text) lines.push(`[Turn ${t.turn_idx}] ASSISTANT: ${t.assistant_text}`);
  }
  for (const t of next) {
    if (t.user_text) lines.push(`[Turn ${t.turn_idx}] USER: ${t.user_text}`);
    if (t.assistant_text) lines.push(`[Turn ${t.turn_idx}] ASSISTANT: ${t.assistant_text}`);
  }
  return lines.join('\n');
}

function formatBatchPrompt(batch: FixtureCandidate[]): string {
  const items = batch
    .map((c, i) => {
      const ctx = formatContextWindow(c.context_prev_2, c.context_next_2);
      return `=== Candidate #${i + 1} id=${c.candidate_id} ===
CONTEXT BEFORE:
${c.context_prev_2.map(t => t.user_text ? `[Turn ${t.turn_idx}] USER: ${t.user_text}` : '').filter(Boolean).join('\n') || '(none)'}

--- CANDIDATE TURN (turn ${c.turn_idx}) ---
${c.raw_text}
--- END CANDIDATE ---

CONTEXT AFTER:
${c.context_next_2.map(t => t.user_text ? `[Turn ${t.turn_idx}] USER: ${t.user_text}` : '').filter(Boolean).join('\n') || '(none)'}
matched_regex_families: ${JSON.stringify(c.matched_families)}
`;
    })
    .join('\n');

  return `Label each of the following ${batch.length} candidates. Output JSON only.\n\n${items}`;
}

function parseBatchResponse(raw: string, batch: FixtureCandidate[]): LabelFields[] | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(raw.substring(start, end + 1)) as { labels?: unknown };
    const rawLabels = Array.isArray(obj.labels) ? obj.labels : null;
    if (!rawLabels || rawLabels.length !== batch.length) return null;

    const out: LabelFields[] = [];
    for (const rl of rawLabels) {
      const r = rl as Record<string, unknown>;
      out.push({
        is_directive: r.is_directive === true,
        scope:
          r.scope === 'session' || r.scope === 'project' || r.scope === 'universal'
            ? r.scope
            : null,
        polarity:
          r.polarity === 'prescriptive' || r.polarity === 'prohibitive'
            ? r.polarity
            : null,
        self_confidence: typeof r.self_confidence === 'number'
          ? Math.max(0, Math.min(1, r.self_confidence))
          : 0,
        reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
      });
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: label
// ---------------------------------------------------------------------------

async function runLabelPass(args: CliArgs): Promise<number> {
  if (args.labelerModel === 'glm-5.1:cloud') {
    console.error('REFUSED: --labeler-model must NOT be glm-5.1:cloud (self-agreement bias).');
    return 2;
  }
  if (!fs.existsSync(args.input)) {
    console.error(`label: input not found at ${args.input}`);
    return 2;
  }
  const candidates = readJsonl<FixtureCandidate>(args.input);
  if (candidates.length === 0) {
    console.error('label: input is empty');
    return 2;
  }
  const subset = args.limit != null ? candidates.slice(0, args.limit) : candidates;

  // Load existing labels and skip already-labeled candidate_ids (resumable).
  const existing = readJsonl<GoldLabelRow>(args.output);
  const already = new Set(existing.map(r => r.candidate_id));
  const todo = subset.filter(c => !already.has(c.candidate_id));

  console.log(`Labeling ${todo.length} candidates via ${args.labelerModel} (${existing.length} already in ${path.basename(args.output)})`);
  const nowEpoch = Date.now();
  const out: GoldLabelRow[] = [...existing];

  for (let i = 0; i < todo.length; i += args.batchSize) {
    const batch = todo.slice(i, i + args.batchSize);
    try {
      const raw = await callLocalLLM({
        system: LABELER_SYSTEM_PROMPT,
        prompt: formatBatchPrompt(batch),
        model: args.labelerModel,
        temperature: 0,
        maxTokens: 2048,
        timeoutMs: 180_000,
      });
      const labels = parseBatchResponse(raw, batch);
      if (!labels) {
        console.error(`  batch ${i}-${i + batch.length}: parse failed, skipping`);
        continue;
      }
      for (let j = 0; j < batch.length; j++) {
        out.push({
          candidate_id: batch[j].candidate_id,
          label: labels[j],
          labeled_by: args.labelerModel,
          labeled_at_epoch: nowEpoch,
          human_verified: false,
        });
      }
      console.log(`  batch ${i}-${i + batch.length - 1}: ${batch.length} labeled`);
      // Persist after every batch so a mid-run crash is recoverable.
      writeJsonlAtomic(args.output, out);
    } catch (e) {
      console.error(`  batch ${i}-${i + batch.length - 1} errored: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`Done. ${out.length} total labels in ${args.output}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: list-flagged / review shared
// ---------------------------------------------------------------------------

interface DetectorRunEntry {
  candidate_id: string;
  is_directive?: boolean;
  scope?: string | null;
}

function loadDetectorRun(pathStr: string | null): Map<string, DetectorRunEntry> {
  if (!pathStr || !fs.existsSync(pathStr)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(pathStr, 'utf8')) as { detections?: DetectorRunEntry[] };
    const out = new Map<string, DetectorRunEntry>();
    for (const d of parsed.detections ?? []) out.set(d.candidate_id, d);
    return out;
  } catch {
    return new Map();
  }
}

function seededRandom(seed: number): () => number {
  // mulberry32 — small, fast, well-distributed deterministic PRNG.
  // JS bitwise ops produce signed int32; we use `>>> 0` consistently to
  // normalize back to uint32 before dividing into the [0,1) range. (An
  // earlier xorshift32 + naive cast inflated 10% spot-check to ~60%.)
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function identifyFlagged(
  labels: GoldLabelRow[],
  spotCheckRate: number,
  seed: number,
  detectorRun: Map<string, DetectorRunEntry>,
): { lowConf: GoldLabelRow[]; disagree: GoldLabelRow[]; spotCheck: GoldLabelRow[] } {
  const lowConf = labels.filter(l => l.label.self_confidence < 0.8);

  const disagree = labels.filter(l => {
    const d = detectorRun.get(l.candidate_id);
    if (!d) return false;
    if (typeof d.is_directive === 'boolean' && d.is_directive !== l.label.is_directive) return true;
    if (d.scope != null && d.scope !== (l.label.scope ?? null)) return true;
    return false;
  });

  const highConf = labels.filter(l => l.label.self_confidence >= 0.8 && !disagree.includes(l));
  const rand = seededRandom(seed);
  const spotCheck = highConf.filter(() => rand() < spotCheckRate);

  return { lowConf, disagree, spotCheck };
}

async function runListFlagged(args: CliArgs): Promise<number> {
  const labels = readJsonl<GoldLabelRow>(args.labels);
  const candidates = readJsonl<FixtureCandidate>(args.candidates);
  const byCid = new Map(candidates.map(c => [c.candidate_id, c]));
  const detectorRun = loadDetectorRun(args.detectorRun);
  const { lowConf, disagree, spotCheck } = identifyFlagged(labels, args.spotCheckRate, args.seed, detectorRun);

  const union = new Map<string, { reason: string; row: GoldLabelRow }>();
  for (const r of lowConf) union.set(r.candidate_id, { reason: `low_confidence=${r.label.self_confidence.toFixed(2)}`, row: r });
  for (const r of disagree) union.set(r.candidate_id, { reason: 'detector_disagreement', row: r });
  for (const r of spotCheck) if (!union.has(r.candidate_id)) {
    union.set(r.candidate_id, { reason: 'spot_check', row: r });
  }

  const entries = Array.from(union.values());
  console.log(`# flagged candidates (${entries.length}): lowConf=${lowConf.length} disagree=${disagree.length} spotCheck=${spotCheck.length}\n`);
  for (const e of entries) {
    const c = byCid.get(e.row.candidate_id);
    const text = c?.raw_text.replace(/\s+/g, ' ').slice(0, 180) ?? '<missing candidate>';
    const l = e.row.label;
    console.log(`- id=${e.row.candidate_id}`);
    console.log(`  flag=${e.reason}`);
    console.log(`  text: ${text}`);
    console.log(`  labeler: is_directive=${l.is_directive} scope=${l.scope ?? '-'} polarity=${l.polarity ?? '-'} conf=${l.self_confidence.toFixed(2)}`);
    console.log(`  reason: ${l.reasoning.replace(/\s+/g, ' ').slice(0, 200)}`);
    console.log('');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: review (interactive readline)
// ---------------------------------------------------------------------------

function prompt(rl: readline.Interface, q: string): Promise<string> {
  return new Promise(res => rl.question(q, res));
}

async function runReview(args: CliArgs): Promise<number> {
  const labels = readJsonl<GoldLabelRow>(args.labels);
  const candidates = readJsonl<FixtureCandidate>(args.candidates);
  const byCid = new Map(candidates.map(c => [c.candidate_id, c]));
  const byLid = new Map(labels.map(l => [l.candidate_id, l]));
  const detectorRun = loadDetectorRun(args.detectorRun);
  const { lowConf, disagree, spotCheck } = identifyFlagged(labels, args.spotCheckRate, args.seed, detectorRun);

  const flagged = new Map<string, string>();
  for (const r of lowConf) flagged.set(r.candidate_id, `low_conf=${r.label.self_confidence.toFixed(2)}`);
  for (const r of disagree) flagged.set(r.candidate_id, 'detector_disagree');
  for (const r of spotCheck) if (!flagged.has(r.candidate_id)) flagged.set(r.candidate_id, 'spot_check');

  if (flagged.size === 0) {
    console.log('Nothing flagged. Done.');
    return 0;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let i = 0;
    for (const [cid, reason] of flagged) {
      i++;
      const row = byLid.get(cid);
      const cand = byCid.get(cid);
      if (!row || !cand) continue;

      console.log(`\n--- [${i}/${flagged.size}] cid=${cid} flag=${reason} ---`);
      console.log(`CANDIDATE: ${cand.raw_text}`);
      if (cand.context_prev_2.length) console.log(`prev: ${cand.context_prev_2.map(t => t.user_text).join(' | ')}`);
      if (cand.context_next_2.length) console.log(`next: ${cand.context_next_2.map(t => t.user_text).join(' | ')}`);
      console.log(`labeler says: is_directive=${row.label.is_directive} scope=${row.label.scope} polarity=${row.label.polarity} conf=${row.label.self_confidence.toFixed(2)}`);
      console.log(`reason: ${row.label.reasoning}`);

      const ans = (await prompt(rl, '[a]ccept / [o]verride / [s]kip / [q]uit: ')).trim().toLowerCase();
      if (ans === 'q') break;
      if (ans === 's') continue;
      if (ans === 'a') {
        row.human_verified = true;
        continue;
      }
      if (ans === 'o') {
        const isDirectiveAns = (await prompt(rl, '  is_directive (y/n): ')).trim().toLowerCase();
        const isDirective = isDirectiveAns === 'y';
        let scope: LabelFields['scope'] = null;
        let polarity: LabelFields['polarity'] = null;
        if (isDirective) {
          const scopeAns = (await prompt(rl, '  scope [session|project|universal]: ')).trim();
          scope = (scopeAns === 'session' || scopeAns === 'project' || scopeAns === 'universal')
            ? scopeAns : null;
          const polAns = (await prompt(rl, '  polarity [prescriptive|prohibitive]: ')).trim();
          polarity = (polAns === 'prescriptive' || polAns === 'prohibitive') ? polAns : null;
        }
        row.reviewer_override = {
          is_directive: isDirective,
          scope,
          polarity,
          self_confidence: 1.0,
          reasoning: 'human reviewer override',
        };
        row.human_verified = true;
      }
    }
  } finally {
    rl.close();
  }

  writeJsonlAtomic(args.labels, labels);
  const verifiedCount = labels.filter(r => r.human_verified).length;
  console.log(`\nreview complete — ${verifiedCount} verified / ${labels.length} total written to ${args.labels}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.subcommand === 'label') return runLabelPass(args);
  if (args.subcommand === 'list-flagged') return runListFlagged(args);
  return runReview(args);
}

export {
  main,
  parseArgs,
  parseBatchResponse,
  formatBatchPrompt,
  identifyFlagged,
  LABELER_SYSTEM_PROMPT,
};

declare const require: { main: unknown } | undefined;
declare const module: unknown;
try {
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    main(process.argv.slice(2))
      .then(code => process.exit(code))
      .catch(e => {
        console.error(e);
        process.exit(1);
      });
  }
} catch { /* noop */ }
