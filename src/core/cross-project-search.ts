/**
 * Phase 6.5 (RETR-06) — claudex_search query expansion via HYBRID
 * cross-project equivalence.
 *
 * Used only when the query is task-shaped (verb + domain noun) AND the
 * per-project CLAUDE.md flag does not opt out. Pulls cross-project
 * candidates from artifact_task_pattern, runs HYBRID equivalence against
 * synthesized incoming handles, scores via Phase 6's consolidated
 * computeArtifactScore (synthetic rrfScore=1.0 since cross-project hits
 * came from fingerprint match, not FTS5).
 *
 * Telemetry: writes one `cross_project_query_expansion` row per call with
 * candidate counts (V21 enum from Plan 01).
 *
 * No new top-level MCP response keys (RETR-04 lock from Phase 6).
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import {
  isCrossProjectEquivalent,
  type EquivalenceCandidate,
  type HandleSet,
  type EmbedderFn,
} from './cross-project-equivalence.js';
import { computeArtifactScore } from './hybrid-retrieval.js';
import type { ArtifactRow } from './artifacts.js';
import type { TaskShapeResult } from './task-shape-detector.js';
import { readCrossProjectSearchFlag } from '../shared/claude-md-flags.js';

const CANDIDATE_POOL_SIZE = 50;
const RESULTS_LIMIT = 10;

export interface CrossProjectExpansionResult {
  crossProjectArtifacts: ArtifactRow[];
  ambiguousCount: number;
  stage1FailCount: number;
  matchedCount: number;
  candidateCount: number;
}

/**
 * Synthesize an incoming HandleSet from a query string + task-shape guess.
 * For v1 (CONTEXT.md "Claude's Discretion"), framing tokens are the
 * query split on non-word boundaries; tools/files/errors empty.
 */
function synthesizeIncomingHandlesFromQuery(query: string, taskShape: TaskShapeResult): HandleSet {
  const tokens = (query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(t => t.length > 1);
  // Add canonical-shape tokens to framing if the detector picked one — gives
  // the equivalence Stage-1 a small additional signal source even when the
  // user prompt didn't contain the exact canonical word.
  if (taskShape.canonicalShapeGuess) {
    for (const t of taskShape.canonicalShapeGuess.toLowerCase().split(/[-_\s]+/)) {
      if (t.length > 1 && !tokens.includes(t)) tokens.push(t);
    }
  }
  return {
    tools_used: [],
    files_touched: [],
    user_framing_tokens: tokens,
    errors_encountered: [],
  };
}

/**
 * Convenience: parse a project root from project string. For session paths
 * Claudex's project IDs are slugs; the live filesystem path is what
 * readCrossProjectSearchFlag needs. Caller in recall-server.ts resolves the
 * path via existing `resolveProjectPath` if known; otherwise fall back to
 * the slug-as-path heuristic in pathToCcSlug.
 */
export function isCrossProjectSearchEnabled(projectRoot: string): boolean {
  return readCrossProjectSearchFlag(projectRoot);
}

/**
 * Pull a bounded pool of cross-project candidates with a task_pattern
 * fingerprint. Same source as Experience Tier candidate query, but
 * project-filtered to NOT match the current project.
 */
function fetchCrossProjectCandidatePool(
  db: Database,
  currentProject: string,
  poolSize: number = CANDIDATE_POOL_SIZE,
): Array<EquivalenceCandidate & { artifactRow: ArtifactRow }> {
  try {
    const rows = cachedPrepare(db,
      `SELECT a.id AS artifact_id,
              a.session_id AS session_id,
              a.project AS project,
              a.artifact_type AS artifact_type,
              a.artifact_ref AS artifact_ref,
              a.summary AS summary,
              a.content AS content,
              a.state AS state,
              a.ttl AS ttl,
              a.importance AS importance,
              a.retrieval_score AS retrieval_score,
              a.timestamp_epoch AS timestamp_epoch,
              a.activation_score AS activation_score,
              a.confidence AS confidence,
              a.novelty_score AS novelty_score,
              atp.task_pattern AS task_pattern
         FROM artifacts a
         INNER JOIN artifact_task_pattern atp ON atp.artifact_id = a.id
        WHERE atp.task_pattern != '__abstain__'
          AND a.project != ?
          AND a.artifact_type IN ('learning', 'observation', 'memory_file', 'flow', 'milestone')
        ORDER BY a.timestamp_epoch DESC
        LIMIT ?`
    ).all(currentProject, poolSize) as Array<{
      artifact_id: number; session_id: string; project: string; artifact_type: string;
      artifact_ref: string | null; summary: string; content: string | null;
      state: string; ttl: number; importance: number; retrieval_score: number;
      timestamp_epoch: number; activation_score: number; confidence: number;
      novelty_score: number; task_pattern: string;
    }>;

    return rows.map(r => {
      // Synthesize HandleSet from artifact summary + content (same approach
      // as Experience Tier's regex-only synthesis).
      const text = `${r.summary || ''}\n${r.content || ''}`;
      const tokens = text.toLowerCase().split(/[^a-z0-9_-]+/).filter(t => t.length > 1);
      const handles: HandleSet = {
        tools_used: [],
        files_touched: [],
        user_framing_tokens: tokens,
        errors_encountered: tokens,
      };
      const candidate: EquivalenceCandidate = {
        id: r.artifact_id,
        project: r.project,
        salience: `${r.summary}\n${r.content ?? ''}`,
        ...handles,
      };
      const artifactRow: ArtifactRow = {
        id: r.artifact_id,
        session_id: r.session_id,
        project: r.project,
        artifact_type: r.artifact_type as ArtifactRow['artifact_type'],
        artifact_ref: r.artifact_ref,
        summary: r.summary,
        content: r.content,
        state: r.state as ArtifactRow['state'],
        ttl: r.ttl,
        importance: r.importance,
        retrieval_score: r.retrieval_score,
        timestamp_epoch: r.timestamp_epoch,
        activation_score: r.activation_score,
        confidence: r.confidence,
        novelty_score: r.novelty_score,
      } as ArtifactRow;
      return { ...candidate, artifactRow };
    });
  } catch {
    return [];
  }
}

/**
 * Run cross-project query expansion. Caller (recall-server.ts) is
 * responsible for skipping when the task is not task-shaped or the opt-out
 * flag is set.
 */
export async function expandSearchCrossProject(
  db: Database,
  sessionId: string,
  query: string,
  taskShape: TaskShapeResult,
  currentProject: string,
  embedder?: EmbedderFn,
): Promise<CrossProjectExpansionResult> {
  const incomingHandles = synthesizeIncomingHandlesFromQuery(query, taskShape);
  const incomingCandidate: EquivalenceCandidate = {
    id: -1,
    project: currentProject,
    salience: query,
    ...incomingHandles,
  };

  const pool = fetchCrossProjectCandidatePool(db, currentProject);

  let matched: ArtifactRow[] = [];
  let ambiguousCount = 0;
  let stage1FailCount = 0;

  for (const cand of pool) {
    const result = await isCrossProjectEquivalent(
      incomingCandidate,
      cand,
      db,
      sessionId,
      embedder,
    );
    if (result.band === 'match') {
      matched.push(cand.artifactRow);
    } else if (result.band === 'ambiguous') {
      ambiguousCount++;
    } else if (result.band === 'stage1-fail') {
      stage1FailCount++;
    }
  }

  // Score matched artifacts via Phase 6's consolidated computeArtifactScore.
  // Synthetic rrfScore=1.0 since cross-project candidates didn't pass through
  // the FTS5+vec channels — the fingerprint match is the relevance signal.
  if (matched.length > 1) {
    const scored = matched.map(a => ({
      a,
      score: computeArtifactScore(a, 1.0, {
        db,
        artifactId: a.id,
        relevance: 1.0,
      }),
    }));
    scored.sort((x, y) => y.score - x.score);
    matched = scored.slice(0, RESULTS_LIMIT).map(s => s.a);
  } else {
    matched = matched.slice(0, RESULTS_LIMIT);
  }

  // Telemetry — one row per expansion call (V21 enum).
  try {
    cachedPrepare(db,
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
         VALUES (?, 'cross_project_query_expansion', ?, 'recall-server')`
    ).run(
      sessionId,
      JSON.stringify({
        candidate_count: pool.length,
        matched_count: matched.length,
        ambiguous_count: ambiguousCount,
        stage1_fail_count: stage1FailCount,
        is_task_shaped: taskShape.isTaskShaped,
        canonical_shape_guess: taskShape.canonicalShapeGuess,
      }),
    );
  } catch {
    // Non-fatal: telemetry must never break the search path.
  }

  return {
    crossProjectArtifacts: matched,
    ambiguousCount,
    stage1FailCount,
    matchedCount: matched.length,
    candidateCount: pool.length,
  };
}
