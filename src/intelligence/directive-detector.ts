/**
 * Directive detector — Phase 3 P2.
 *
 * Turns user-authored directives in a completed session transcript into
 * `artifact(kind='directive_rule', ...)` rows. Runs in Angel's extraction
 * phase (wired by Plan 03-04 at heartbeat.ts:219-261), BEFORE the generic
 * pattern-extractor. No injection-path changes.
 *
 * Pipeline per CONTEXT §Area 1-5:
 *   1. Fetch user turns from `conversation_turns` for the session.
 *   2. Strip fenced + inline code; apply 12 regex families for pre-filter.
 *   3. For each candidate, fetch ±2 un-stripped surrounding turns as context.
 *   4. Call `callLocalLLM(glm-5.1:cloud)` for rich JSON confirmation
 *      (is_directive + confidence + scope + polarity + normalized text).
 *   5. Reject if `!is_directive`, confidence < thresholdGeneral, or
 *      `scope==='universal'` with confidence < thresholdUniversal. No downgrade.
 *   6. Embed `suggested_title + normalized_text` via snowflake-arctic-embed2.
 *   7. vec0 top-3 same-scope same-project `directive_rule` lookup.
 *   8. If max cosine ≥ 0.80 → one LLM relation call → 4-branch write policy:
 *        restatement  → UPDATE (bump reinforcement_count + reinforcements[])
 *        opposite     → INSERT + annotate data.possible_contradicts
 *        related      → INSERT + annotate data.related_to / data.related_cosine
 *        unrelated    → INSERT (standalone)
 *      Else → INSERT (standalone).
 *   9. `dryRun: true` short-circuits all writes; `decisions[]` still populated.
 *
 * Non-throwing at top level: individual candidate failures bump `errors` and
 * processing continues. P8 handles supersession, decay, and contradiction
 * resolution — P2 only writes passive annotations.
 */

import type { Database } from 'better-sqlite3';
import { callLocalLLM } from '../angel/llama-client.js';
import { embedText } from '../embeddings/embed-pipeline.js';
import { encodeVector, loadSqliteVec } from '../core/sqlite-vec-loader.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import {
  DIRECTIVE_REGEX_FAMILIES,
  matchFamilies,
  stripCodeBlocks,
} from './directive-detector-regex.js';
import {
  DEFAULT_CONFIG,
  loadConfig,
  type DirectiveDetectorConfig,
} from './directive-detector-config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DirectiveScope = 'session' | 'project' | 'universal';
export type DirectivePolarity = 'prescriptive' | 'prohibitive';
export type DedupRelation =
  | 'restatement'
  | 'opposite_polarity'
  | 'related_but_distinct'
  | 'unrelated';
export type DetectionDecision =
  | 'rejected_regex'
  | 'rejected_confirm'
  | 'inserted'
  | 'updated'
  | 'annotated_opposite'
  | 'annotated_related'
  | 'error';

export interface ConfirmationResult {
  is_directive: boolean;
  confidence: number;
  polarity: DirectivePolarity | null;
  scope: DirectiveScope | null;
  suggested_title: string | null;
  normalized_text: string | null;
  reasoning: string | null;
}

export interface DedupHit {
  top1_id: string;
  cosine: number;
  relation: DedupRelation;
  reasoning?: string;
}

export interface DetectionRecord {
  session_id: string;
  turn_idx: number;
  raw_text: string;
  matched_families: string[];
  confirmation?: ConfirmationResult;
  decision: DetectionDecision;
  artifact_id?: string;
  dedup?: DedupHit;
  error?: string;
}

export interface ExtractResult {
  candidates: number;
  confirmed: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  decisions: DetectionRecord[];
}

interface TurnRow {
  id: number;
  turn_number: number;
  user_text: string | null;
  assistant_text: string | null;
}

interface DedupShortlistRow {
  id: string;
  body: string;
  title: string | null;
  data: string;
  distance: number;
}

// ---------------------------------------------------------------------------
// Inline prompt stubs — replaced by file-backed loader in Plan 03-02
// ---------------------------------------------------------------------------

// TODO(Plan 03-02): replace with loadPromptAssets() that reads
// src/intelligence/directive-detector-prompts/{confirmation,scope-rubric}-*
// and fills the {{FEW_SHOT}} placeholder at module init.
const CONFIRMATION_SYSTEM_PROMPT_INLINE = `You detect user directives in conversation transcripts from a coding agent.

A directive is a STANDING RULE the user states for future turns — not a task request, not
a clarifying question, not an observation, not a one-off instruction for the current step.

Scope taxonomy:
- session: scoped to the current task, PR, debugging loop, or review
- project: applies everywhere in the current repo
- universal: applies across every project the user works on

Polarity:
- prescriptive: do X (positive assertion)
- prohibitive: don't do X (negative assertion)

Output JSON only, matching this schema exactly:
{ "is_directive": boolean,
  "confidence": number (0..1),
  "polarity": "prescriptive"|"prohibitive"|null,
  "scope": "session"|"project"|"universal"|null,
  "suggested_title": string|null,
  "normalized_text": string|null,
  "reasoning": string }

Reject (is_directive=false) for:
- Question phrasing ("should we always X?")
- Past-tense observation ("I noticed we always do X")
- Hedged preference ("I kind of prefer X")
- Quoted speech from outside the user

When is_directive=false, set polarity/scope/suggested_title/normalized_text to null.`;

// TODO(Plan 03-02): dedup-relation prompt stays inline per CONTEXT — no fixture needed.
const DEDUP_RELATION_SYSTEM_PROMPT = `You classify the relation between a candidate directive and an existing directive_rule.

Given CANDIDATE and CANDIDATES_EXISTING[] (ordered by cosine desc), pick ONE relation for the FIRST existing item:
- "restatement": same rule, same polarity, same scope — just reworded.
- "opposite_polarity": same rule target, FLIPPED polarity (one prescribes, the other prohibits).
- "related_but_distinct": talks about the same topic but states a different rule.
- "unrelated": different topic; cosine was a false positive.

Output JSON only: { "relation": "restatement"|"opposite_polarity"|"related_but_distinct"|"unrelated", "reasoning": string }.`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * sqlite-vec's `artifact_embeddings` declares `embedding float[1024]` with no
 * distance-metric hint → vec0 defaults to L2. snowflake-arctic-embed2 returns
 * L2-normalized vectors, so for unit vectors L2² = 2 − 2·cos(θ), hence
 *
 *   cos(θ) = 1 − d²/2
 *
 * Maps d=0 → cos=1, d=√2 → cos=0, d=2 → cos=-1. Caller must ensure embeddings
 * are unit-normalized (arctic-embed2 is natively, verified in unit test).
 */
export function l2DistanceToCosine(d: number): number {
  return 1 - (d * d) / 2;
}

/**
 * Sanity-check that a vector is unit-normalized (norm in [0.999, 1.001]).
 * Used by the vec0 unit test to guard against future model changes breaking
 * the l2-to-cosine conversion.
 */
export function cosineNorm(v: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  return Math.sqrt(sumSq);
}

/**
 * Apply the 4-line reject logic per CONTEXT §Area 2 + RESEARCH §4 Q1.
 * Universal-under-0.85 rejects OUTRIGHT; no downgrade to `project`.
 */
export function shouldReject(
  c: ConfirmationResult,
  cfg: DirectiveDetectorConfig,
): 'reject_is_directive' | 'reject_threshold' | 'accept' {
  if (!c.is_directive) return 'reject_is_directive';
  if (c.confidence < cfg.thresholdGeneral) return 'reject_threshold';
  if (c.scope === 'universal' && c.confidence < cfg.thresholdUniversal) {
    return 'reject_threshold';
  }
  return 'accept';
}

/**
 * Extract a JSON object from an LLM response using balanced-brace matching.
 * Tolerant of leading/trailing prose. Returns null on unparseable input.
 */
function extractFirstJsonObject(raw: string): unknown | null {
  if (!raw) return null;
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
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(raw.substring(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parse and shape-guard a confirmer response.
 * Returns null on any schema violation (unparseable JSON, wrong field types).
 */
export function parseConfirmation(raw: string): ConfirmationResult | null {
  const obj = extractFirstJsonObject(raw) as Record<string, unknown> | null;
  if (!obj) return null;
  if (typeof obj.is_directive !== 'boolean') return null;
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence)) return null;

  const polarity = obj.polarity;
  const scope = obj.scope;

  const confirm: ConfirmationResult = {
    is_directive: obj.is_directive,
    confidence: Math.max(0, Math.min(1, obj.confidence)),
    polarity:
      polarity === 'prescriptive' || polarity === 'prohibitive'
        ? polarity
        : null,
    scope:
      scope === 'session' || scope === 'project' || scope === 'universal'
        ? scope
        : null,
    suggested_title: typeof obj.suggested_title === 'string' ? obj.suggested_title : null,
    normalized_text: typeof obj.normalized_text === 'string' ? obj.normalized_text : null,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : null,
  };
  return confirm;
}

/**
 * Parse a dedup-relation LLM response. Returns `'unrelated'` on unparseable
 * input (conservative — a malformed relation shouldn't collapse a fresh
 * INSERT into an UPDATE).
 */
export function parseDedupRelation(raw: string): { relation: DedupRelation; reasoning: string } {
  const obj = extractFirstJsonObject(raw) as Record<string, unknown> | null;
  const rel = obj?.relation;
  const reasoning = typeof obj?.reasoning === 'string' ? obj.reasoning : '';
  if (
    rel === 'restatement' ||
    rel === 'opposite_polarity' ||
    rel === 'related_but_distinct' ||
    rel === 'unrelated'
  ) {
    return { relation: rel, reasoning };
  }
  return { relation: 'unrelated', reasoning };
}

/**
 * Format ±2 surrounding turns for the LLM confirmer. Matches the
 * pattern-extractor transcript style with an explicit CANDIDATE marker.
 */
export function formatContextForLLM(
  window: TurnRow[],
  targetTurnNumber: number,
): string {
  const parts: string[] = [];
  for (const t of window) {
    const marker = t.turn_number === targetTurnNumber ? ' [CANDIDATE]' : '';
    if (t.user_text) {
      parts.push(`[Turn ${t.turn_number}${marker}] USER: ${t.user_text}`);
    }
    if (t.assistant_text) {
      parts.push(`[Turn ${t.turn_number}${marker}] ASSISTANT: ${t.assistant_text}`);
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function fetchUserTurns(db: Database, sessionId: string): TurnRow[] {
  try {
    return cachedPrepare(
      db,
      `SELECT id, turn_number, user_text, assistant_text
       FROM conversation_turns
       WHERE session_id = ? AND user_text IS NOT NULL
       ORDER BY turn_number ASC`,
    ).all(sessionId) as TurnRow[];
  } catch {
    return [];
  }
}

function fetchContextWindow(
  db: Database,
  sessionId: string,
  centerTurn: number,
  span = 2,
): TurnRow[] {
  try {
    return cachedPrepare(
      db,
      `SELECT id, turn_number, user_text, assistant_text
       FROM conversation_turns
       WHERE session_id = ?
         AND turn_number BETWEEN ? AND ?
       ORDER BY turn_number ASC`,
    ).all(sessionId, centerTurn - span, centerTurn + span) as TurnRow[];
  } catch {
    return [];
  }
}

/**
 * vec0 top-K same-scope same-project `directive_rule` dedup lookup.
 *
 * Two-stage query: sqlite-vec's vec0 virtual table doesn't expose its
 * distance column through JOINs reliably (the KNN constraint must be a bare
 * predicate against the vtab), so we (1) run the KNN alone to collect
 * rowid+distance pairs, then (2) fetch the matching `artifact` rows by
 * `embedding_ref IN (...)` and stitch the distance back in JS.
 */
export async function dedupLookup(
  db: Database,
  embedding: number[],
  scope: DirectiveScope,
  projectId: string,
  limit = 3,
): Promise<DedupShortlistRow[]> {
  try {
    loadSqliteVec(db);
    const queryVec = encodeVector(embedding);
    const knnLimit = 50;

    const knn = db
      .prepare(
        `SELECT rowid, distance
           FROM artifact_embeddings
          WHERE embedding MATCH ? AND k = ?
          ORDER BY distance`,
      )
      .all(queryVec, knnLimit) as Array<{ rowid: number | bigint; distance: number }>;
    if (knn.length === 0) return [];

    const distByRowid = new Map<number, number>();
    for (const row of knn) {
      const rid = typeof row.rowid === 'bigint' ? Number(row.rowid) : row.rowid;
      distByRowid.set(rid, row.distance);
    }

    const placeholders = Array.from(distByRowid.keys()).map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT a.id AS id, a.title AS title, a.body AS body, a.data AS data, a.embedding_ref AS embedding_ref
           FROM artifact a
          WHERE a.kind = 'directive_rule'
            AND a.scope = ?
            AND a.project_id = ?
            AND a.status = 'active'
            AND a.embedding_ref IN (${placeholders})`,
      )
      .all(scope, projectId, ...Array.from(distByRowid.keys())) as Array<{
        id: string; title: string | null; body: string; data: string; embedding_ref: number;
      }>;

    const enriched: DedupShortlistRow[] = rows
      .map(r => ({
        id: r.id,
        title: r.title,
        body: r.body,
        data: r.data,
        distance: distByRowid.get(r.embedding_ref) ?? Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
    return enriched;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM calls (confirmation + dedup relation)
// ---------------------------------------------------------------------------

async function confirmCandidate(
  cfg: DirectiveDetectorConfig,
  candidateText: string,
  contextBlock: string,
): Promise<ConfirmationResult | null> {
  try {
    const userPrompt = `CONTEXT (±2 surrounding turns):\n\n${contextBlock}\n\nThe CANDIDATE turn is marked [CANDIDATE]. Analyze it for a standing directive. Reply with JSON only.`;
    const raw = await callLocalLLM({
      system: CONFIRMATION_SYSTEM_PROMPT_INLINE,
      prompt: userPrompt,
      model: cfg.model,
      temperature: 0,
      maxTokens: 512,
    });
    return parseConfirmation(raw);
  } catch {
    return null;
  }
}

async function classifyRelation(
  cfg: DirectiveDetectorConfig,
  candidateBody: string,
  shortlist: DedupShortlistRow[],
): Promise<{ relation: DedupRelation; reasoning: string }> {
  try {
    const listed = shortlist
      .map((row, i) => `#${i + 1} (cosine≈${l2DistanceToCosine(row.distance).toFixed(3)}): ${row.title ?? ''} — ${row.body}`)
      .join('\n');
    const userPrompt = `CANDIDATE:\n${candidateBody}\n\nCANDIDATES_EXISTING (ordered by cosine desc):\n${listed}\n\nClassify the relation between CANDIDATE and item #1. JSON only.`;
    const raw = await callLocalLLM({
      system: DEDUP_RELATION_SYSTEM_PROMPT,
      prompt: userPrompt,
      model: cfg.model,
      temperature: 0,
      maxTokens: 256,
    });
    return parseDedupRelation(raw);
  } catch {
    return { relation: 'unrelated', reasoning: '' };
  }
}

// ---------------------------------------------------------------------------
// Write path (CONTEXT §Area 5 + RESEARCH §3.2)
// ---------------------------------------------------------------------------

function randomUuid(): string {
  const bytes = new Uint8Array(16);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto') as typeof import('node:crypto');
    crypto.randomFillSync(bytes);
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

interface WriteInput {
  sessionId: string;
  projectId: string;
  turnIdx: number;
  matchedFamilies: string[];
  confirmation: ConfirmationResult;
  embedding: number[];
  dedupHit: DedupHit | null;
  dedupRow: DedupShortlistRow | null;
}

interface WriteOutput {
  decision: DetectionDecision;
  artifactId: string;
}

/**
 * Slide-window trim on `data.reinforcements[]`. Called only after a restatement
 * UPDATE inflates the array past `cap`. Reads the current array length cheaply
 * via `json_array_length`, then rewrites with the tail window in one UPDATE.
 */
function trimReinforcements(db: Database, artifactId: string, cap: number): void {
  try {
    const row = db
      .prepare(`SELECT json_array_length(json_extract(data, '$.reinforcements')) AS n FROM artifact WHERE id = ?`)
      .get(artifactId) as { n: number | null } | undefined;
    const n = row?.n ?? 0;
    if (n <= cap) return;
    const drop = n - cap;
    // json_remove path expression '$.reinforcements[0]' removes index 0.
    // Chain `drop` removals in one exec for atomicity.
    const removals = Array.from({ length: drop }, () => `'$.reinforcements[0]'`).join(', ');
    db.prepare(
      `UPDATE artifact SET data = json_remove(data, ${removals}) WHERE id = ?`,
    ).run(artifactId);
  } catch {
    // Non-fatal: cap is a soft bound; a leaky row is better than a thrown error.
  }
}

function writeArtifact(
  db: Database,
  input: WriteInput,
  cfg: DirectiveDetectorConfig,
): WriteOutput {
  const { confirmation, dedupHit, dedupRow } = input;
  const now = Date.now();

  // ── Restatement: UPDATE only, no new row ─────────────────────────
  if (dedupHit && dedupHit.relation === 'restatement' && dedupRow) {
    const newReinforcement = {
      session_id: input.sessionId,
      turn_idx: input.turnIdx,
      seen_at_epoch: now,
      regex_family: input.matchedFamilies[0] ?? null,
    };
    // Read existing reinforcements, extend in JS, write back. SQLite's
    // json_group_array + UNION approach stringifies objects (round-trips via
    // TEXT, collapsing structure), so a JS-side compose is both simpler and
    // correct-by-construction.
    const existing = JSON.parse(dedupRow.data) as Record<string, unknown>;
    const existingReinforcements = Array.isArray(existing.reinforcements)
      ? (existing.reinforcements as Array<Record<string, unknown>>)
      : [];
    const extended = [...existingReinforcements, newReinforcement];
    const newCount = (typeof existing.reinforcement_count === 'number'
      ? existing.reinforcement_count
      : 1) + 1;

    db.prepare(
      `UPDATE artifact
          SET updated_at_epoch = ?,
              data = json_set(
                       json_set(data, '$.reinforcement_count', ?),
                       '$.reinforcements',
                       json(?)
                     )
        WHERE id = ?`,
    ).run(now, newCount, JSON.stringify(extended), dedupRow.id);

    trimReinforcements(db, dedupRow.id, cfg.reinforcementCap);
    return { decision: 'updated', artifactId: dedupRow.id };
  }

  // ── INSERT paths (fresh | opposite_polarity | related_but_distinct | unrelated) ──
  const id = randomUuid();
  const regexFamily = input.matchedFamilies[0] ?? null;

  const baseData: Record<string, unknown> = {
    polarity: confirmation.polarity,
    reasoning: confirmation.reasoning,
    source_session_id: input.sessionId,
    source_turn_idx: input.turnIdx,
    regex_family: regexFamily,
    reinforcement_count: 1,
    reinforcements: [
      {
        session_id: input.sessionId,
        turn_idx: input.turnIdx,
        seen_at_epoch: now,
        regex_family: regexFamily,
      },
    ],
  };

  let decision: DetectionDecision = 'inserted';

  if (dedupHit && dedupRow) {
    if (dedupHit.relation === 'opposite_polarity') {
      baseData.possible_contradicts = dedupRow.id;
      baseData.contradict_reason = dedupHit.reasoning ?? '';
      decision = 'annotated_opposite';
    } else if (dedupHit.relation === 'related_but_distinct') {
      baseData.related_to = dedupRow.id;
      baseData.related_cosine = dedupHit.cosine;
      baseData.related_relation = 'related_but_distinct';
      decision = 'annotated_related';
    }
  }

  db.prepare(
    `INSERT INTO artifact(
       id, kind, title, body, scope, status, confidence,
       created_at_epoch, updated_at_epoch, session_id, project_id, data
     ) VALUES (?, 'directive_rule', ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    confirmation.suggested_title ?? null,
    confirmation.normalized_text ?? '',
    confirmation.scope ?? null,
    confirmation.confidence,
    now,
    now,
    input.sessionId,
    input.projectId,
    JSON.stringify(baseData),
  );

  // Embedding — sqlite-vec's vec0 virtual table does NOT support
  // RETURNING rowid (returns null). Allocate rowid explicitly via
  // MAX(rowid)+1 and INSERT with that value, then back-link the artifact.
  try {
    loadSqliteVec(db);
    const vec = encodeVector(input.embedding);
    const maxRow = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM artifact_embeddings`).get() as { m: number | bigint };
    const prev = typeof maxRow.m === 'bigint' ? maxRow.m : BigInt(maxRow.m);
    const nextId = prev + 1n;
    // vec0 requires rowid bound as BigInt; cast to Number only for artifact.embedding_ref (INTEGER column).
    db.prepare(`INSERT INTO artifact_embeddings(rowid, embedding) VALUES (?, ?)`).run(nextId, vec);
    db.prepare(`UPDATE artifact SET embedding_ref = ? WHERE id = ?`).run(Number(nextId), id);
  } catch {
    // Embedding failure is non-fatal — the artifact row still exists and is
    // retrievable via FTS. The next backfill pass can re-embed.
  }

  return { decision, artifactId: id };
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

/**
 * Run the directive detector over one completed session.
 *
 * Non-throwing at the top level: individual candidate failures bump `errors`
 * and processing continues. Returns a populated `decisions[]` for the
 * precision harness (Plan 03-05) to inspect without querying the DB.
 *
 * `dryRun: true` skips all INSERT/UPDATE writes but still makes the LLM
 * confirmation + dedup calls — this exercises the exact production code path
 * minus side effects.
 */
export async function extractDirectivesFromSession(
  db: Database,
  sessionId: string,
  projectId: string,
  opts?: Partial<DirectiveDetectorConfig>,
): Promise<ExtractResult> {
  const cfg = loadConfig(opts);
  const result: ExtractResult = {
    candidates: 0,
    confirmed: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    decisions: [],
  };

  const turns = fetchUserTurns(db, sessionId);
  if (turns.length === 0) return result;

  // 1. Regex pre-filter ----------------------------------------------------
  const candidates: Array<{ turn: TurnRow; families: string[] }> = [];
  for (const t of turns) {
    if (!t.user_text) continue;
    const stripped = stripCodeBlocks(t.user_text);
    const fams = matchFamilies(stripped);
    if (fams.length > 0) candidates.push({ turn: t, families: fams });
  }
  result.candidates = candidates.length;

  // 2. Per-candidate pipeline ---------------------------------------------
  for (const { turn, families } of candidates) {
    const record: DetectionRecord = {
      session_id: sessionId,
      turn_idx: turn.turn_number,
      raw_text: turn.user_text ?? '',
      matched_families: families,
      decision: 'rejected_regex',
    };
    try {
      // 2a. Fetch context window (±2 un-stripped)
      const window = fetchContextWindow(db, sessionId, turn.turn_number, 2);
      const contextBlock = formatContextForLLM(window, turn.turn_number);

      // 2b. LLM confirmation
      const confirmation = await confirmCandidate(cfg, turn.user_text ?? '', contextBlock);
      if (!confirmation) {
        record.decision = 'rejected_confirm';
        result.skipped++;
        result.decisions.push(record);
        continue;
      }
      record.confirmation = confirmation;

      // 2c. Threshold gate
      const verdict = shouldReject(confirmation, cfg);
      if (verdict !== 'accept') {
        record.decision = 'rejected_confirm';
        result.skipped++;
        result.decisions.push(record);
        continue;
      }
      result.confirmed++;

      const scope = confirmation.scope;
      if (!scope) {
        record.decision = 'rejected_confirm';
        result.skipped++;
        result.decisions.push(record);
        continue;
      }

      // 2d. Embed + dedup shortlist
      const toEmbed = `${confirmation.suggested_title ?? ''}\n${confirmation.normalized_text ?? ''}`.trim();
      const embedding = await embedText(toEmbed);
      let dedupHit: DedupHit | null = null;
      let dedupRow: DedupShortlistRow | null = null;

      if (embedding) {
        const shortlist = await dedupLookup(db, embedding, scope, projectId, 3);
        if (shortlist.length > 0) {
          const topCosine = l2DistanceToCosine(shortlist[0].distance);
          if (topCosine >= cfg.dedupCosineThreshold) {
            const relationOut = await classifyRelation(cfg, toEmbed, shortlist);
            dedupHit = {
              top1_id: shortlist[0].id,
              cosine: topCosine,
              relation: relationOut.relation,
              reasoning: relationOut.reasoning,
            };
            dedupRow = shortlist[0];
          }
        }
      }

      record.dedup = dedupHit ?? undefined;

      // 2e. Write (or dry-run short-circuit)
      if (cfg.dryRun) {
        // Materialize a plausible decision path for harness auditability.
        if (dedupHit) {
          if (dedupHit.relation === 'restatement') record.decision = 'updated';
          else if (dedupHit.relation === 'opposite_polarity') record.decision = 'annotated_opposite';
          else if (dedupHit.relation === 'related_but_distinct') record.decision = 'annotated_related';
          else record.decision = 'inserted';
        } else {
          record.decision = 'inserted';
        }
        if (record.decision === 'updated') result.updated++;
        else result.inserted++;
        result.decisions.push(record);
        continue;
      }

      if (!embedding) {
        // Embedding failure: still write the artifact, but with no vec link.
        // Dedup was skipped above, so this reduces to a plain fresh INSERT.
      }

      const out = writeArtifact(
        db,
        {
          sessionId,
          projectId,
          turnIdx: turn.turn_number,
          matchedFamilies: families,
          confirmation,
          embedding: embedding ?? new Array(1024).fill(0),
          dedupHit,
          dedupRow,
        },
        cfg,
      );

      record.decision = out.decision;
      record.artifact_id = out.artifactId;

      if (out.decision === 'updated') result.updated++;
      else result.inserted++;
    } catch (e) {
      record.decision = 'error';
      record.error = e instanceof Error ? e.message : String(e);
      result.errors++;
    }
    result.decisions.push(record);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exports for unit tests (kept at the bottom to keep the public API at top)
// ---------------------------------------------------------------------------

export const __internals = {
  DIRECTIVE_REGEX_FAMILIES,
  DEFAULT_CONFIG,
  CONFIRMATION_SYSTEM_PROMPT_INLINE,
  DEDUP_RELATION_SYSTEM_PROMPT,
  randomUuid,
  trimReinforcements,
  writeArtifact,
};
