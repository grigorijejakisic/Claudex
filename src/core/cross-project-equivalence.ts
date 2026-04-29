/**
 * Phase 6.5 — HYBRID cross-project content equivalence.
 *
 * Two-stage equivalence function consumed by both the Experience Tier scorer
 * (session-start surfacing) and the claudex_search query-expansion path.
 *
 * Stage 1 — fast filter: telemetry-handle overlap ≥ 3 across the four handle
 * dimensions. Cheap; narrows the candidate set without LLM/embedder calls.
 *
 * Stage 2 — precision check: cosine similarity on salience text via
 * snowflake-arctic-embed2 (1024d, Ollama /api/embed). Threshold ≥ 0.85
 * confirms equivalence; 0.70 ≤ cosine < 0.85 is logged as ambiguous (V21
 * telemetry event_kind='cross_project_ambiguous'); < 0.70 rejects.
 *
 * Embedder failure (timeout / non-2xx / empty response) returns null cosine
 * and reuses the Phase 6 RETR-08 reranker_fallback telemetry surface — no
 * new event_kind is added for this case.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { incrementRerankerFallbackCounter } from './telemetry-counters.js';

export interface HandleSet {
  tools_used: string[];
  files_touched: string[];
  user_framing_tokens: string[];
  errors_encountered: string[];
}

export type EquivalenceBand = 'match' | 'ambiguous' | 'reject' | 'stage1-fail';

export interface EquivalenceResult {
  match: boolean;
  stage1Shared: number;
  stage2Cosine: number | null;
  band: EquivalenceBand;
}

export const STAGE_1_THRESHOLD = 3;
export const STAGE_2_MATCH_THRESHOLD = 0.85;
export const STAGE_2_AMBIGUOUS_FLOOR = 0.70;

const EMBED_URL = 'http://localhost:11434/api/embed';
const EMBED_MODEL = 'snowflake-arctic-embed2';
const EMBED_TIMEOUT_MS = 1000;

/** Optional embedder injection for tests; real callers use the default. */
export type EmbedderFn = (texts: string[]) => Promise<number[][] | null>;

/**
 * Default embedder — calls Ollama /api/embed with snowflake-arctic-embed2.
 * Returns null on any failure (timeout, non-2xx, empty payload).
 */
async function defaultEmbedder(texts: string[]): Promise<number[][] | null> {
  try {
    const response = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) return null;
    return data.embeddings;
  } catch {
    return null;
  }
}

/**
 * Normalize a file path into a 2-element token list `[basename, parentDir]`
 * so close-but-non-identical paths (e.g., scraper.ts vs scraper-v2.ts;
 * src/auth/jwt.ts vs src/auth/middleware.ts) share at least one token.
 */
function normalizeFilePath(p: string): string[] {
  if (!p) return [];
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(s => s.length > 0);
  if (parts.length === 0) return [];
  const basename = parts[parts.length - 1];
  const parentDir = parts.length >= 2 ? parts[parts.length - 2] : '';
  const tokens: string[] = [];
  if (basename) tokens.push(basename.toLowerCase());
  if (parentDir) tokens.push(parentDir.toLowerCase());
  return tokens;
}

function tokenize(arr: string[] | undefined): Set<string> {
  if (!arr) return new Set();
  const out = new Set<string>();
  for (const v of arr) {
    if (typeof v === 'string' && v.trim().length > 0) {
      out.add(v.trim().toLowerCase());
    }
  }
  return out;
}

function tokenizeFiles(arr: string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!arr) return out;
  for (const p of arr) {
    for (const t of normalizeFilePath(p)) {
      out.add(t);
    }
  }
  return out;
}

/**
 * Stage 1 — handle overlap.
 *
 * Computes total intersect-size across all four dimensions: tools_used,
 * files_touched (basename+parent normalized), user_framing_tokens, and
 * errors_encountered. Each shared token counts once per dimension.
 */
export function stageOneHandleOverlap(a: HandleSet, b: HandleSet): number {
  const dimensions: Array<[Set<string>, Set<string>]> = [
    [tokenize(a.tools_used), tokenize(b.tools_used)],
    [tokenizeFiles(a.files_touched), tokenizeFiles(b.files_touched)],
    [tokenize(a.user_framing_tokens), tokenize(b.user_framing_tokens)],
    [tokenize(a.errors_encountered), tokenize(b.errors_encountered)],
  ];
  let total = 0;
  for (const [setA, setB] of dimensions) {
    for (const tok of setA) {
      if (setB.has(tok)) total++;
    }
  }
  return total;
}

/**
 * Stage 2 — cosine similarity over salience texts using the bi-encoder.
 *
 * Returns null on embedder failure so the caller can degrade gracefully.
 * The salience texts are passed verbatim — no truncation here; the embedder
 * client will handle it (Ollama /api/embed accepts up to ~8k tokens).
 */
export async function stageTwoCosine(
  salienceA: string,
  salienceB: string,
  embedder: EmbedderFn = defaultEmbedder,
): Promise<number | null> {
  const embeddings = await embedder([salienceA, salienceB]);
  if (!embeddings || embeddings.length !== 2) return null;
  const [embA, embB] = embeddings;
  if (!Array.isArray(embA) || !Array.isArray(embB) || embA.length !== embB.length) {
    return null;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < embA.length; i++) {
    dot += embA[i] * embB[i];
    na += embA[i] * embA[i];
    nb += embB[i] * embB[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Log a Stage-2 ambiguous match (0.70 ≤ cosine < 0.85) for telemetry tuning.
 * Uses the V21 telemetry CHECK enum; pre-V21 DBs swallow the CHECK violation.
 */
export function logAmbiguous(
  db: Database,
  sessionId: string,
  aId: number,
  bId: number,
  cosine: number,
  projectA: string,
  projectB: string,
): void {
  try {
    cachedPrepare(db,
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
         VALUES (?, 'cross_project_ambiguous', ?, 'cross-project-equivalence')`
    ).run(
      sessionId,
      JSON.stringify({ a_id: aId, b_id: bId, cosine, project_a: projectA, project_b: projectB }),
    );
  } catch {
    // Non-throwing: telemetry must never break the equivalence path.
  }
}

export interface EquivalenceCandidate extends HandleSet {
  id: number;
  project: string;
  salience: string;
}

/**
 * HYBRID equivalence — the canonical function consumed by Plan 02 Experience
 * Tier and Plan 03 query expansion.
 *
 * 1. Stage 1 — handle overlap; if shared < 3, return stage1-fail (no Stage 2).
 * 2. Stage 2 — cosine; if embedder fails (null), record reranker_fallback
 *    telemetry and return reject with stage2Cosine=null.
 * 3. cosine ≥ 0.85 → match band.
 * 4. 0.70 ≤ cosine < 0.85 → ambiguous; log and return reject (not surfaced).
 * 5. cosine < 0.70 → reject.
 */
export async function isCrossProjectEquivalent(
  a: EquivalenceCandidate,
  b: EquivalenceCandidate,
  db: Database,
  sessionId: string,
  embedder: EmbedderFn = defaultEmbedder,
): Promise<EquivalenceResult> {
  const stage1Shared = stageOneHandleOverlap(a, b);
  if (stage1Shared < STAGE_1_THRESHOLD) {
    return { match: false, stage1Shared, stage2Cosine: null, band: 'stage1-fail' };
  }

  const cosine = await stageTwoCosine(a.salience, b.salience, embedder);
  if (cosine === null) {
    // Reuse the Phase 6 RETR-08 reranker_fallback telemetry surface for
    // embedder failures during equivalence checks. The reason 'unreachable'
    // captures any failure mode of the bi-encoder path (timeout, non-2xx,
    // empty response, true network unreachable) — the equivalence path
    // doesn't need to distinguish these for tuning.
    incrementRerankerFallbackCounter(db, sessionId, 'unreachable');
    return { match: false, stage1Shared, stage2Cosine: null, band: 'reject' };
  }

  if (cosine >= STAGE_2_MATCH_THRESHOLD) {
    return { match: true, stage1Shared, stage2Cosine: cosine, band: 'match' };
  }
  if (cosine >= STAGE_2_AMBIGUOUS_FLOOR) {
    logAmbiguous(db, sessionId, a.id, b.id, cosine, a.project, b.project);
    return { match: false, stage1Shared, stage2Cosine: cosine, band: 'ambiguous' };
  }
  return { match: false, stage1Shared, stage2Cosine: cosine, band: 'reject' };
}
