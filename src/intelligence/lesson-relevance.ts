/**
 * Phase 14-07j — lesson relevance scoring.
 *
 * Combines trigger-match (lexical) with link-distance (structural)
 * for a single per-lesson score. Used by the assembler to select
 * which lessons to inline-expand at session-start.
 *
 * Relevance formula (locked in 14-07-CONTEXT):
 *   combined = trigger_weight * trigger_match + (1 - trigger_weight) * link_distance
 *
 * Where:
 *   - trigger_match: keyword-overlap between lesson trigger (or body fallback) and pivot text
 *   - link_distance: 1 / hop_distance from lesson artifact to any pivot artifact (0 if unreachable)
 *   - trigger_weight: default 0.6; configurable via CLAUDEX_LESSON_RELEVANCE_TRIGGER_WEIGHT
 *
 * Sparse-link fallback: when the link graph is empty or the lesson has no artifact_id,
 * link_distance = 0 and relevance degrades gracefully to trigger-only selection.
 *
 * Missing trigger frontmatter: if a lesson file has no `trigger:` field (pre-14-07h
 * migration state), the first ~100 chars of the body are used as the trigger proxy.
 * Quality is lower but inline-expansion remains functional.
 *
 * Anti-scope: does NOT write links, does NOT modify link-writer.ts, does NOT
 * modify lesson files.
 */

import * as fs from 'fs';
import type { Database } from 'better-sqlite3';
import { handleClaudexTrace } from '../mcp/tools/claudex-trace.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default weight for trigger-match in the combined relevance formula. */
export const DEFAULT_TRIGGER_WEIGHT = 0.6;

/** Default weight for link-distance in the combined relevance formula. */
export const DEFAULT_LINK_WEIGHT = 0.4;

/** Default number of top-K lessons to inline-expand. */
export const DEFAULT_TOP_K = 3;

/** Hard cap on K to bound token budget. */
export const MAX_TOP_K = 5;

/** Max hop distance for link-distance scoring. */
const MAX_HOPS_DEFAULT = 4;

/**
 * English stopwords filtered from trigger/pivot text during keyword overlap.
 * Small set; covers the highest-frequency noise words.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'it', 'this', 'that', 'these', 'those',
  'as', 'if', 'not', 'no', 'so', 'i', 'we', 'you', 'they', 'he', 'she',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LessonRelevanceParams {
  /** Absolute path to the lesson .md file. */
  lesson_file_path: string;
  /** V17 artifact ID of the lesson, if the lesson is indexed in the artifact table. */
  lesson_artifact_id?: string;
  /** Current session pivot string — describes what work is in progress. */
  pivot_text: string;
  /** Artifact IDs for the pivot context, used for link-distance scoring. */
  pivot_artifact_ids: string[];
  db: Database;
  /** Trigger weight [0, 1]. Default DEFAULT_TRIGGER_WEIGHT (0.6). */
  trigger_weight?: number;
}

export interface LessonRelevanceResult {
  lesson_file_path: string;
  combined_score: number;
  trigger_match_score: number;
  link_distance_score: number;
  /** The trigger text used for matching. null means no trigger or body-fallback failed. */
  trigger_text: string | null;
}

export interface SelectTopKParams {
  /** List of lesson file paths (and optional artifact IDs) to score. */
  lessons: Array<{ file_path: string; artifact_id?: string }>;
  /** Current session pivot string. */
  pivot_text: string;
  /** Artifact IDs for the pivot context. */
  pivot_artifact_ids: string[];
  db: Database;
  /** Number of top lessons to return. Default DEFAULT_TOP_K (3), capped at MAX_TOP_K (5). */
  k?: number;
  /** Trigger weight. Default DEFAULT_TRIGGER_WEIGHT (0.6). */
  trigger_weight?: number;
}

// ─── Stopword-filtered tokenizer ─────────────────────────────────────────────

/**
 * Split text into lowercase words, filtering stopwords and short tokens.
 * Returns a Set<string> for O(1) lookup in overlap computation.
 */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

// ─── Trigger reader ───────────────────────────────────────────────────────────

/**
 * Read the `trigger:` field from a lesson file's YAML frontmatter.
 *
 * Phase 14-07j: H's `readLessonTrigger(filePath)` export from lesson-writer.ts
 * will provide this as a stable API once H ships (14-07h). Until then, this
 * local reader parses the raw frontmatter directly.
 *
 * Returns null when:
 *   - File does not exist or cannot be read
 *   - No `trigger:` field in frontmatter
 *   - Frontmatter is malformed
 */
export function readLessonTrigger(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n')) return null;
    const endIdx = normalized.indexOf('\n---\n', 4);
    if (endIdx < 0) return null;
    const frontmatter = normalized.slice(4, endIdx);

    for (const line of frontmatter.split('\n')) {
      // Match `trigger: <value>` (top-level, no leading whitespace)
      const match = /^trigger:\s*(.*?)\s*(?:#.*)?$/.exec(line);
      if (match && !line.startsWith(' ') && !line.startsWith('\t')) {
        const value = match[1].trim();
        return value.length > 0 ? value : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the body of a lesson file (content after the closing `---` delimiter).
 *
 * Returns null if the file cannot be read or has no body.
 */
function readLessonBody(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const normalized = raw.replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n')) return null;
    const endIdx = normalized.indexOf('\n---\n', 4);
    if (endIdx < 0) return null;
    const body = normalized.slice(endIdx + 5).replace(/^\n+/, '');
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

// ─── Scoring functions ────────────────────────────────────────────────────────

/**
 * Compute keyword-overlap score between a trigger string and the pivot text.
 *
 * Score = (count of common non-stopword words) / (count of non-stopword words in trigger).
 * Both strings are lowercased; stopwords filtered; score ∈ [0, 1].
 *
 * Returns 0 when trigger or pivot is empty/whitespace-only.
 */
export function computeTriggerMatch(trigger: string, pivot: string): number {
  if (!trigger || !pivot) return 0;

  const triggerWords = tokenize(trigger);
  const pivotWords = tokenize(pivot);

  if (triggerWords.size === 0 || pivotWords.size === 0) return 0;

  let overlap = 0;
  for (const word of triggerWords) {
    if (pivotWords.has(word)) overlap += 1;
  }

  return overlap / triggerWords.size;
}

/**
 * Compute link-distance score: 1 / shortest_hop_distance from lesson_artifact_id
 * to any pivot_artifact_id via the link graph (soft + confirmed hard links).
 *
 * Returns:
 *   - 1.0 when directly linked (1 hop)
 *   - 0.5 at 2 hops
 *   - ~0.33 at 3 hops
 *   - etc.
 *   - 0.0 when unreachable within max_hops, or when lesson_artifact_id is
 *     undefined, or when pivot_artifact_ids is empty.
 *
 * Uses handleClaudexTrace BFS (general walker; handles both soft and confirmed
 * hard links). Per plan: claudex_trace's BFS is more general for relevance
 * scoring than provenance-walker (which is directed/incoming-only).
 */
export function computeLinkDistanceScore(
  db: Database,
  lesson_artifact_id: string | undefined,
  pivot_artifact_ids: string[],
  max_hops: number = MAX_HOPS_DEFAULT,
): number {
  if (!lesson_artifact_id || pivot_artifact_ids.length === 0) return 0;

  try {
    const traceResult = handleClaudexTrace(db, {
      artifact_id: lesson_artifact_id,
      max_hops,
      direction: 'both',
    });

    // Build a map from artifact_id → hop_distance from the trace
    const distanceMap = new Map<string, number>();
    for (const row of traceResult.results) {
      distanceMap.set(row.artifact_id, row.hop_distance);
    }

    // Find the minimum hop distance to any pivot artifact
    let minHops = Infinity;
    for (const pivotId of pivot_artifact_ids) {
      const dist = distanceMap.get(pivotId);
      if (dist !== undefined && dist < minHops) {
        minHops = dist;
      }
    }

    // hop_distance=0 means same artifact — shouldn't happen (lesson = pivot artifact)
    // but guard against divide-by-zero.
    if (!Number.isFinite(minHops) || minHops === 0) return 0;

    return 1 / minHops;
  } catch {
    return 0;
  }
}

/**
 * Compute the combined relevance score for a single lesson.
 *
 * Combines trigger-match (lexical) and link-distance (structural).
 * Formula: combined = trigger_weight * trigger_match + (1 - trigger_weight) * link_distance
 *
 * Reads trigger from `trigger:` frontmatter field (14-07h addition); falls back
 * to first ~100 characters of the lesson body when trigger field is absent.
 */
export function computeLessonRelevance(p: LessonRelevanceParams): LessonRelevanceResult {
  const trigger_weight = p.trigger_weight ?? DEFAULT_TRIGGER_WEIGHT;

  // Read trigger: prefer `trigger:` frontmatter, fall back to truncated body
  let trigger_text = readLessonTrigger(p.lesson_file_path);
  if (!trigger_text) {
    // Body fallback: use first ~100 chars as trigger proxy
    const body = readLessonBody(p.lesson_file_path);
    if (body) {
      trigger_text = body.slice(0, 100);
    }
  }

  // Trigger match score
  const trigger_match_score = trigger_text
    ? computeTriggerMatch(trigger_text, p.pivot_text)
    : 0;

  // Link distance score
  const link_distance_score = computeLinkDistanceScore(
    p.db,
    p.lesson_artifact_id,
    p.pivot_artifact_ids,
  );

  // Combined score
  const link_weight = 1 - trigger_weight;
  const combined_score =
    trigger_weight * trigger_match_score + link_weight * link_distance_score;

  return {
    lesson_file_path: p.lesson_file_path,
    combined_score,
    trigger_match_score,
    link_distance_score,
    trigger_text,
  };
}

/**
 * Score all provided lessons and return the top-K by combined relevance score.
 *
 * Respects env var overrides:
 *   - CLAUDEX_LESSON_RELEVANCE_TRIGGER_WEIGHT → trigger_weight (float 0–1)
 *   - CLAUDEX_LESSON_INLINE_K → K (integer 1–MAX_TOP_K)
 *
 * Tie-break: alphabetical by file_path (deterministic).
 */
export function selectTopKLessons(p: SelectTopKParams): LessonRelevanceResult[] {
  // Resolve K from params → env var → default
  const envK = parseInt(process.env.CLAUDEX_LESSON_INLINE_K ?? '', 10);
  const requestedK = p.k ?? (Number.isFinite(envK) && envK > 0 ? envK : DEFAULT_TOP_K);
  const k = Math.min(Math.max(1, requestedK), MAX_TOP_K);

  // Resolve trigger_weight from params → env var → default
  const envWeight = parseFloat(process.env.CLAUDEX_LESSON_RELEVANCE_TRIGGER_WEIGHT ?? '');
  const trigger_weight =
    p.trigger_weight ??
    (Number.isFinite(envWeight) && envWeight >= 0 && envWeight <= 1
      ? envWeight
      : DEFAULT_TRIGGER_WEIGHT);

  // Score all lessons
  const scored: LessonRelevanceResult[] = p.lessons.map(lesson =>
    computeLessonRelevance({
      lesson_file_path: lesson.file_path,
      lesson_artifact_id: lesson.artifact_id,
      pivot_text: p.pivot_text,
      pivot_artifact_ids: p.pivot_artifact_ids,
      db: p.db,
      trigger_weight,
    }),
  );

  // Sort: desc by combined_score, then asc alphabetical by file_path (tie-break)
  scored.sort((a, b) => {
    if (b.combined_score !== a.combined_score) {
      return b.combined_score - a.combined_score;
    }
    return a.lesson_file_path.localeCompare(b.lesson_file_path);
  });

  return scored.slice(0, k);
}
