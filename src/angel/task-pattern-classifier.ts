/**
 * Phase 6.5 — Task-pattern fingerprint classifier.
 *
 * Classifies an artifact (or lesson) into a canonical task_pattern from the
 * Phase 4.1 shape_vocabulary table. Regex-first; abstain-allowed when no
 * heuristic clears confidence ≥ 0.85.
 *
 * Three public surfaces:
 *   - classifyTaskPattern(handles, shape) → ClassifierResult
 *   - writeTaskPattern(db, artifactId, result) → void (INSERT OR IGNORE)
 *   - backfillTaskPatternsBatch(db, batchSize) → counts (idempotent batch)
 *
 * Classifier algorithm (highest-confidence path wins):
 *   1. Direct shape match — shape.task_shape ∈ canonical vocab → 1.0
 *   2. Token Jaccard ≥ 0.5 against canonical → 0.85 + (jaccard - 0.5) * 0.3
 *   3. Files-touched / framing-token / errors_encountered topology → 0.85
 *   4. Otherwise abstain (confidence 0; caller must NOT write a row).
 *
 * Backfill is regex-only (no LLM, no shape lookup since legacy artifacts
 * have no recorded shape). Abstained rows write a `__abstain__` sentinel so
 * the heartbeat doesn't re-process them every tick.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { TelemetryHandles, ShapeHandles } from './lesson-types.js';

export type ClassifierSource = 'write_time' | 'heartbeat_backfill';

export interface ClassifierResult {
  task_pattern: string | null;       // null = abstain
  confidence: number;                  // 0..1
  source: ClassifierSource;
}

export const ABSTAIN_SENTINEL = '__abstain__';
const CONFIDENCE_FLOOR = 0.85;

// Files-topology rules (planner discretion, hardcoded starter set per CONTEXT.md).
const TOPOLOGY_RULES: Array<{
  pattern: string;
  matchesFiles?: RegExp[];
  matchesErrors?: RegExp;
  matchesFramingTokens?: RegExp;
}> = [
  {
    pattern: 'scraping-rate-limit-investigation',
    matchesFiles: [/(?:^|[\/\\])scraper[^\/\\]*\.(?:ts|js|py)$/i, /(?:^|[\/\\])crawler[^\/\\]*\.(?:ts|js|py)$/i],
    matchesErrors: /\b(?:429|403|rate[-_ ]?limit|cloudflare|throttl(?:e|ed|ing)|shadowban)\b/i,
    matchesFramingTokens: /\b(?:rate[-_ ]?limit|throttl|shadowban|cloudflare|429|403|crawl|scrape)\b/i,
  },
  {
    pattern: 'schema-migration-design',
    matchesFiles: [/prisma[\/\\]migrations?/i, /(?:^|[\/\\])migrations?[\/\\]/i, /\.sql$/i, /schema\.(?:ts|js|prisma)$/i],
    matchesFramingTokens: /\b(?:ALTER|migration|migrate|schema|column|downtime|backfill)\b/i,
  },
  {
    pattern: 'auth-flow-design',
    matchesFiles: [/(?:^|[\/\\])auth(?:entication)?[\/\\]/i, /session[^\/\\]*\.(?:ts|js)$/i, /token[^\/\\]*\.(?:ts|js)$/i, /middleware[^\/\\]*\.(?:ts|js)$/i],
    matchesFramingTokens: /\b(?:auth|authenticate|authorize|session|token|jwt|cookie|logout|kicked)\b/i,
  },
];

/**
 * Token-set Jaccard helper. Compares two arrays of tokens after lowercase +
 * dedupe. Returns 0..1.
 */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a.map(s => s.toLowerCase()));
  const B = new Set(b.map(s => s.toLowerCase()));
  let inter = 0;
  for (const tok of A) {
    if (B.has(tok)) inter++;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Tokenize a canonical task_shape value into a token-set for Jaccard
 * comparison: split on `-` and `_`, lowercase, dedupe.
 */
function tokenizePattern(value: string): string[] {
  return value.toLowerCase().split(/[-_\s]+/).filter(t => t.length > 0);
}

/**
 * Load canonical task_shape vocabulary from shape_vocabulary table.
 * Empty array if vocabulary not yet seeded.
 */
function loadCanonicalTaskShapes(db: Database): string[] {
  try {
    const rows = cachedPrepare(db,
      `SELECT value FROM shape_vocabulary WHERE field = 'task_shape'`
    ).all() as Array<{ value: string }>;
    return rows.map(r => r.value);
  } catch {
    return [];
  }
}

/**
 * Classify task pattern from telemetry handles + (optional) shape handles.
 *
 * Returns abstain when no rule clears CONFIDENCE_FLOOR.
 *
 * Source defaults to 'write_time'. Backfill callers must override.
 */
export function classifyTaskPattern(
  db: Database,
  handles: TelemetryHandles,
  shape: ShapeHandles | undefined,
  source: ClassifierSource = 'write_time',
): ClassifierResult {
  const canonical = loadCanonicalTaskShapes(db);
  const canonicalSet = new Set(canonical);

  // Step 1 — direct shape match (highest confidence).
  if (shape?.task_shape && canonicalSet.has(shape.task_shape)) {
    return { task_pattern: shape.task_shape, confidence: 1.0, source };
  }

  // Step 2 — regex-style Jaccard over framing tokens vs canonical pattern names.
  const framing = handles.user_framing_tokens ?? [];
  if (framing.length > 0 && canonical.length > 0) {
    let bestPattern: string | null = null;
    let bestScore = 0;
    for (const cand of canonical) {
      const score = jaccard(framing, tokenizePattern(cand));
      if (score > bestScore) {
        bestScore = score;
        bestPattern = cand;
      }
    }
    if (bestPattern && bestScore >= 0.5) {
      const confidence = Math.min(1.0, 0.85 + (bestScore - 0.5) * 0.3);
      if (confidence >= CONFIDENCE_FLOOR) {
        return { task_pattern: bestPattern, confidence, source };
      }
    }
  }

  // Step 3 — files-touched / errors / framing topology.
  for (const rule of TOPOLOGY_RULES) {
    let matched = false;
    if (rule.matchesFiles && handles.files_touched) {
      for (const fileRe of rule.matchesFiles) {
        if (handles.files_touched.some(f => fileRe.test(f))) {
          matched = true;
          break;
        }
      }
    }
    if (!matched && rule.matchesErrors && handles.errors_encountered) {
      if (handles.errors_encountered.some(e => rule.matchesErrors!.test(e))) {
        matched = true;
      }
    }
    if (!matched && rule.matchesFramingTokens && framing.length > 0) {
      if (framing.some(t => rule.matchesFramingTokens!.test(t))) {
        matched = true;
      }
    }
    if (matched) {
      return { task_pattern: rule.pattern, confidence: 0.85, source };
    }
  }

  // Abstain.
  return { task_pattern: null, confidence: 0, source };
}

/**
 * Persist a classifier result for an artifact_id. INSERT OR IGNORE makes
 * this safe to call repeatedly without throwing on the PRIMARY KEY conflict.
 *
 * Skips entirely when result.task_pattern is null (caller wants to abstain).
 * Backfill callers should pass the abstain sentinel `__abstain__` explicitly
 * to record "we already tried, abstained" so heartbeat doesn't re-process.
 */
export function writeTaskPattern(
  db: Database,
  artifactId: number,
  result: ClassifierResult,
): void {
  if (!result.task_pattern) return;
  cachedPrepare(db,
    `INSERT OR IGNORE INTO artifact_task_pattern
       (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
       VALUES (?, ?, ?, ?, ?)`
  ).run(
    artifactId,
    result.task_pattern,
    Date.now(),
    result.confidence,
    result.source,
  );
}

/**
 * Heartbeat backfill batch. Scans artifacts of relevant kinds that don't
 * yet have an artifact_task_pattern row, classifies them via regex-only
 * (no LLM), and writes results.
 *
 * Idempotent: rows that get a sentinel `__abstain__` are not retried because
 * the LEFT JOIN sees them as "already classified" on subsequent ticks.
 *
 * Returns aggregate counts for the batch.
 */
export function backfillTaskPatternsBatch(
  db: Database,
  batchSize: number = 200,
): { classified: number; abstained: number; alreadyDone: number } {
  // Pull the next batch of un-classified artifacts.
  const rows = cachedPrepare(db,
    `SELECT a.id, a.summary, a.content, a.artifact_type
       FROM artifacts a
       LEFT JOIN artifact_task_pattern atp ON atp.artifact_id = a.id
      WHERE atp.artifact_id IS NULL
        AND a.artifact_type IN ('learning', 'observation', 'memory_file', 'flow', 'milestone')
      LIMIT ?`
  ).all(batchSize) as Array<{ id: number; summary: string; content: string | null; artifact_type: string }>;

  let classified = 0;
  let abstained = 0;
  const alreadyDone = 0; // rows already classified are filtered by the JOIN

  const insert = cachedPrepare(db,
    `INSERT OR IGNORE INTO artifact_task_pattern
       (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
       VALUES (?, ?, ?, ?, ?)`
  );

  for (const row of rows) {
    // Synthesize a fake TelemetryHandles from summary + content. Backfill is
    // regex-only — no LLM, no shape lookup since legacy artifacts have no
    // recorded shape.
    const text = `${row.summary ?? ''}\n${row.content ?? ''}`;
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter(t => t.length > 1);
    const handles: TelemetryHandles = {
      tools_used: [],
      files_touched: [],
      errors_encountered: tokens, // routes through both errors + framing rules
      user_framing_tokens: tokens,
      session_arc: [],
      duration_min: 0,
      correction_count: 0,
    };

    const result = classifyTaskPattern(db, handles, undefined, 'heartbeat_backfill');

    if (result.task_pattern) {
      insert.run(
        row.id,
        result.task_pattern,
        Date.now(),
        result.confidence,
        'heartbeat_backfill',
      );
      classified++;
    } else {
      // Sentinel: never re-process this row.
      insert.run(
        row.id,
        ABSTAIN_SENTINEL,
        Date.now(),
        0,
        'heartbeat_backfill',
      );
      abstained++;
    }
  }

  return { classified, abstained, alreadyDone };
}
