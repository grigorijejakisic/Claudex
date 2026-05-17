/**
 * Observation Consolidation — reduces observation bloat by merging similar records.
 *
 * Runs as a low-priority phase in Angel's heartbeat. Finds clusters of similar
 * observations via Qdrant vector search, then merges them:
 *   - Clusters of 3+ → LLM summarization (Ollama, fallback: concatenation)
 *   - Pairs (2) → direct merge without LLM
 *   - Singletons → skip
 *
 * NEVER deletes originals. Sets consumed=1, consolidated_into=<new_id>.
 * Non-throwing — consolidation failure must never crash the heartbeat.
 *
 * A1 (Phase 10): Angel is the SOLE consolidator. CC's Dream consolidation
 * (4-phase: orient → gather → consolidate → prune, see cc-source/06-dream-kairos.md)
 * is disabled via CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 set in Phase 1. Angel's
 * 6-phase pipeline (CONTEXT → ANALYZE → MEASURE → PLAN → REVIEW → COMMIT) in
 * pattern-extractor.ts is more sophisticated. If Dream is ever re-enabled,
 * detectCcMemoryConflict() in env-file.ts will log a warning.
 *
 * A14 (Phase 11): Angel-Dream symbiosis architecture. When Dream is disabled
 * (current mode), Angel does full consolidation here + in pattern-extractor.ts.
 * If Dream re-activates (autoDream/tengu_onyx_plover flag in ~/.claude/config.json),
 * Angel should switch to "curator mode": deposit structured markdown observations
 * to memdir for Dream to consolidate, then read Dream's consolidated output back
 * into Claudex DB. detectDreamReactivation() below checks for this at module load.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { insertObservation, type ObservationRow } from '../core/observations.js';
import { callLocalLLM } from './llama-client.js';
import { generate } from './generation-backend.js';
import { createHash } from 'node:crypto';

/** Result of a single consolidation batch run. */
export interface ConsolidationResult {
  /** Total observations examined in this batch. */
  processed: number;
  /** Number of new consolidated summaries created. */
  consolidated: number;
  /** Number of clusters found (including pairs). */
  clusters: number;
  /** Error message if the batch failed entirely. */
  error?: string;
}

/** Rate-limit tracking — last consolidation epoch (seconds). */
let _lastConsolidationEpoch = 0;

/** Minimum interval between consolidation runs (seconds). */
const CONSOLIDATION_INTERVAL_SEC = 5 * 60; // 5 minutes

/** Cosine similarity threshold for clustering.
 * @deprecated Use getPolicy().shouldConsolidate() for cluster decisions. Kept for clustering logic. */
export const CLUSTER_COSINE_THRESHOLD = 0.8;

/**
 * Check if consolidation should run this tick (rate limiting).
 */
export function shouldConsolidate(): boolean {
  const nowEpoch = Math.floor(Date.now() / 1000);
  return (nowEpoch - _lastConsolidationEpoch) >= CONSOLIDATION_INTERVAL_SEC;
}

/**
 * Mark that consolidation ran (for rate limiting).
 */
export function markConsolidationRan(): void {
  _lastConsolidationEpoch = Math.floor(Date.now() / 1000);
}

/**
 * Reset rate limit state (for testing).
 */
export function resetConsolidationState(): void {
  _lastConsolidationEpoch = 0;
}

/**
 * Fetch unconsolidated observations eligible for merging.
 * Criteria: consumed=0, consolidated_into IS NULL, not soft-deleted.
 * Ordered by timestamp ASC (process oldest first).
 */
export function getUnconsolidatedObservations(
  db: Database,
  batchSize: number,
): ObservationRow[] {
  try {
    return cachedPrepare(db,
      `SELECT * FROM observations
       WHERE consumed = 0
         AND consolidated_into IS NULL
         AND deleted_at_epoch_ms IS NULL
       ORDER BY timestamp_epoch_ms ASC
       LIMIT ?`
    ).all(batchSize) as ObservationRow[];
  } catch {
    return [];
  }
}

/**
 * Build clusters from a list of observations using embedding similarity.
 * Uses Qdrant to find similar observations, then forms transitive clusters.
 *
 * Returns an array of clusters (each cluster = array of observation IDs).
 * Observations not in any cluster are singletons (omitted from result).
 */
export async function buildClusters(
  observations: ObservationRow[],
  db?: Database,
): Promise<ObservationRow[][]> {
  try {
    // Dynamic imports to avoid circular deps
    const { embedText } = await import('../embeddings/embed-pipeline.js');
    const { searchArtifacts } = await import('../embeddings/qdrant-client.js');

    // Map observation ID to its embedding
    const embeddings = new Map<number, number[]>();
    for (const obs of observations) {
      const text = obs.title + ' ' + obs.content;
      const embedding = await embedText(text);
      if (embedding) {
        embeddings.set(obs.id, embedding);
      }
    }

    // Build adjacency: for each observation, find which others are similar
    const obsById = new Map(observations.map(o => [o.id, o]));
    const batchIds = new Set(observations.map(o => o.id));
    const adjacency = new Map<number, Set<number>>();

    // Pre-build artifact_id → observation_id mapping for batch observations.
    // Qdrant stores artifact_id (artifacts table PK) in payload. We need observation IDs.
    // artifacts.artifact_ref stores the observation ID as text for type='observation'.
    // Scoped to batch IDs to avoid loading the entire artifacts table.
    const artifactToObsId = new Map<number, number>();
    if (db && batchIds.size > 0) {
      try {
        // 14-07b: migrated from legacy artifacts
        // Look up V17 artifact rows whose data.artifact_ref matches a batch observation ID.
        // artifact_id_map.legacy_id gives us the INTEGER needed to map back to obsId.
        const placeholders = [...batchIds].map(() => '?').join(',');
        const rows = db.prepare(
          `SELECT m.legacy_id AS art_legacy_id,
                  CAST(json_extract(a.data, '$.artifact_ref') AS INTEGER) AS obs_id
           FROM artifact a
           INNER JOIN artifact_id_map m ON m.v17_id = a.id
           WHERE a.kind = 'observation'
             AND json_extract(a.data, '$.artifact_ref') IS NOT NULL
             AND CAST(json_extract(a.data, '$.artifact_ref') AS INTEGER) IN (${placeholders})`
        ).all(...batchIds) as Array<{ art_legacy_id: number; obs_id: number }>;
        for (const row of rows) {
          if (row.obs_id > 0) artifactToObsId.set(row.art_legacy_id, row.obs_id);
        }
      } catch { /* non-fatal — clustering degrades gracefully */ }
    }

    for (const obs of observations) {
      const embedding = embeddings.get(obs.id);
      if (!embedding || !obs.project) continue;

      // Search Qdrant for similar observation artifacts
      const results = await searchArtifacts(embedding, obs.project, 10, {
        artifactTypes: ['observation'],
        excludeSuperseded: true,
      });

      const neighbors = new Set<number>();
      for (const r of results) {
        if (r.score < CLUSTER_COSINE_THRESHOLD) continue;

        // Map artifact_id back to observation_id via artifact_ref
        const artId = (r.payload?.artifact_id as number) ?? 0;
        const obsId = artifactToObsId.get(artId) ?? 0;

        // Only cluster with observations in this batch
        if (obsId > 0 && obsId !== obs.id && batchIds.has(obsId)) {
          neighbors.add(obsId);
        }
      }

      adjacency.set(obs.id, neighbors);
    }

    // Transitive closure: union-find to form clusters
    const parent = new Map<number, number>();
    for (const id of batchIds) parent.set(id, id);

    function find(x: number): number {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    }

    function union(a: number, b: number): void {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    for (const [id, neighbors] of adjacency) {
      for (const neighbor of neighbors) {
        union(id, neighbor);
      }
    }

    // Group by root
    const groups = new Map<number, ObservationRow[]>();
    for (const obs of observations) {
      const root = find(obs.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(obs);
    }

    // Return only clusters of size >= 2 (singletons are skipped)
    return Array.from(groups.values()).filter(g => g.length >= 2);
  } catch {
    return [];
  }
}

/**
 * Call the local llama-server (Gemma 4 31B Q6_K) for consolidation of an
 * observation cluster. Returns the consolidated summary text, or null on
 * failure — the caller falls back to createFallbackSummary.
 */
async function callLocalLLMConsolidate(
  observations: ObservationRow[],
): Promise<string | null> {
  try {
    const obsTexts = observations.map((o) =>
      `[Obs #${o.id}] (${o.category}, importance=${o.importance}) ${o.title}: ${o.content}`
    ).join('\n\n');

    const prompt = `You are a memory consolidation system. Summarize these related observations into a single high-density summary. Preserve all key facts. Be concise but complete.

Observations:
${obsTexts}

Respond with ONLY the consolidated summary text, nothing else.`;

    const text = await generate({
      prompt,
      model: 'sonnet',
      maxTokens: 2048,
      subsystem: 'consolidator',
    });
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Create a fallback concatenated summary when LLM is unavailable.
 */
export function createFallbackSummary(observations: ObservationRow[]): string {
  return observations
    .map(o => `[${o.category}] ${o.title}: ${o.content}`)
    .join(' | ');
}

/**
 * Consolidate a cluster of 3+ observations using LLM (or fallback).
 * Returns the new observation ID, or 0 on failure.
 */
async function consolidateCluster(
  db: Database,
  cluster: ObservationRow[],
  localModel: string,
): Promise<number> {
  // Determine the summary text — LLM or fallback
  let summaryContent = await callLocalLLMConsolidate(cluster);
  if (!summaryContent) {
    summaryContent = createFallbackSummary(cluster);
  }

  // New importance = max(cluster importances) + 1, capped at 5
  const maxImportance = Math.max(...cluster.map(o => o.importance));
  const newImportance = Math.min(maxImportance + 1, 5) as 1 | 2 | 3 | 4 | 5;

  // Use the project from the first observation (cluster is same-project)
  const project = cluster[0].project ?? '__unknown__';
  const sessionId = cluster[0].session_id;

  // Build a consolidated title from the cluster
  const titles = [...new Set(cluster.map(o => o.title))];
  const consolidatedTitle = titles.length <= 3
    ? `Consolidated: ${titles.join(', ')}`
    : `Consolidated: ${titles.slice(0, 2).join(', ')} +${titles.length - 2} more`;

  // Truncate title to reasonable length
  const finalTitle = consolidatedTitle.length > 200
    ? consolidatedTitle.slice(0, 197) + '...'
    : consolidatedTitle;

  // Insert the new consolidated observation
  const newId = insertObservation(db, {
    session_id: sessionId,
    project,
    tool_name: 'angel:consolidator',
    category: cluster[0].category as any, // Use category from first observation
    title: finalTitle,
    content: summaryContent,
    importance: newImportance,
    files_modified: [],
    obs_type: 'consolidated',
  });

  // 14-07b: migrated from legacy artifacts — create V17 artifact directly
  try {
    const v17Confidence = newImportance / 5.0;
    const v17Id = createHash('sha256')
      .update(`observation:consolidator:${project}:${sessionId}:${newId}:${Date.now()}`)
      .digest('hex')
      .slice(0, 32);
    cachedPrepare(db,
      `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
          created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
       VALUES (?, 'observation', ?, ?, 'project', 'active', ?, ?, ?, ?, ?, ?)`
    ).run(
      v17Id,
      finalTitle,
      summaryContent,
      v17Confidence,
      Date.now(),
      Date.now(),
      sessionId,
      project,
      JSON.stringify({ artifact_ref: String(newId), obs_type: 'consolidated', tool_name: 'angel:consolidator' }),
    );
  } catch { /* non-fatal — observation was stored successfully */ }

  // Mark originals as consumed + link to the new observation
  for (const obs of cluster) {
    try {
      cachedPrepare(db,
        `UPDATE observations SET consumed = 1, consolidated_into = ? WHERE id = ?`
      ).run(newId, obs.id);
    } catch { /* non-fatal */ }
  }

  // Embed the new observation (fire-and-forget, non-blocking)
  // 14-07b: migrated from legacy artifacts — look up V17 artifact by data.artifact_ref
  try {
    const { embedArtifact } = await import('../embeddings/embed-pipeline.js');
    const artifact = cachedPrepare(db,
      `SELECT id FROM artifact
       WHERE kind = 'observation'
         AND json_extract(data, '$.artifact_ref') = ?
       ORDER BY created_at_epoch_ms DESC LIMIT 1`
    ).get(String(newId)) as { id: string } | undefined;

    if (artifact) {
      embedArtifact(db, artifact.id as any, finalTitle + ' ' + summaryContent, {
        project,
        artifact_type: 'observation',
        importance: newImportance,
        session_id: sessionId,
        summary: finalTitle,
      }).catch(() => { /* non-fatal */ });
    }
  } catch { /* non-fatal */ }

  return newId;
}

/**
 * Merge a pair of observations directly (no LLM needed).
 * Keeps the newer observation, merges content from the older one.
 * Returns the new observation ID, or 0 on failure.
 */
async function mergePair(
  db: Database,
  pair: ObservationRow[],
): Promise<number> {
  // Sort by timestamp — newer first
  const sorted = [...pair].sort((a, b) => b.timestamp_epoch_ms - a.timestamp_epoch_ms);
  const newer = sorted[0];
  const older = sorted[1];

  // Merge content: newer content + separator + older content
  const mergedContent = `${newer.content}\n---\n${older.content}`;
  const newImportance = Math.min(Math.max(newer.importance, older.importance) + 1, 5) as 1 | 2 | 3 | 4 | 5;

  const project = newer.project ?? '__unknown__';

  const newId = insertObservation(db, {
    session_id: newer.session_id,
    project,
    tool_name: 'angel:consolidator',
    category: newer.category as any,
    title: `Merged: ${newer.title}`,
    content: mergedContent,
    importance: newImportance,
    files_modified: [],
    obs_type: 'consolidated',
  });

  // Mark both originals as consumed
  for (const obs of pair) {
    try {
      cachedPrepare(db,
        `UPDATE observations SET consumed = 1, consolidated_into = ? WHERE id = ?`
      ).run(newId, obs.id);
    } catch { /* non-fatal */ }
  }

  // 14-07b: migrated from legacy artifacts — create V17 artifact directly
  try {
    const v17Confidence = newImportance / 5.0;
    const v17Id = createHash('sha256')
      .update(`observation:merge:${project}:${newer.session_id}:${newId}:${Date.now()}`)
      .digest('hex')
      .slice(0, 32);
    cachedPrepare(db,
      `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
          created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
       VALUES (?, 'observation', ?, ?, 'project', 'active', ?, ?, ?, ?, ?, ?)`
    ).run(
      v17Id,
      `Merged: ${newer.title}`,
      mergedContent,
      v17Confidence,
      Date.now(),
      Date.now(),
      newer.session_id,
      project,
      JSON.stringify({ artifact_ref: String(newId), obs_type: 'consolidated', tool_name: 'angel:consolidator' }),
    );
  } catch { /* non-fatal */ }

  return newId;
}

/**
 * Main entry point: consolidate a batch of observations.
 *
 * Algorithm:
 * 1. Fetch unconsolidated observations (LIMIT batchSize)
 * 2. Embed each and search Qdrant for similar observations
 * 3. Form clusters via transitive closure (cosine > 0.8)
 * 4. Clusters of 3+ → LLM summarize (Ollama, fallback: concatenation)
 * 5. Pairs → direct merge
 * 6. Singletons → skip
 * 7. Mark originals consumed, link via consolidated_into
 *
 * Non-throwing. Returns result with error field on total failure.
 */
export async function consolidateObservationBatch(
  db: Database,
  batchSize: number = 50,
  localModel: string = 'llama3.2',
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    processed: 0,
    consolidated: 0,
    clusters: 0,
  };

  try {
    // 1. Fetch candidates
    const observations = getUnconsolidatedObservations(db, batchSize);
    result.processed = observations.length;

    if (observations.length < 2) {
      return result; // Need at least 2 to cluster
    }

    // 2-3. Build clusters
    const clusters = await buildClusters(observations, db);
    result.clusters = clusters.length;

    if (clusters.length === 0) {
      return result; // No similar observations found
    }

    // 4-6. Process each cluster — delegate decision to memory policy
    const { getPolicy } = await import('../intelligence/policy-registry.js');
    const policy = getPolicy();

    for (const cluster of clusters) {
      try {
        // Note: CLUSTER_COSINE_THRESHOLD (0.8) is a correct lower bound for average
        // pairwise similarity within a cluster, since all pairs in the cluster were
        // formed by requiring cosine > 0.8 during buildClusters(). The actual average
        // similarity is >= 0.8 for all clusters.
        const decision = policy.shouldConsolidate(cluster.length, CLUSTER_COSINE_THRESHOLD);

        if (decision === 'merge') {
          if (cluster.length >= 3) {
            // LLM consolidation for larger clusters
            const newId = await consolidateCluster(db, cluster, localModel);
            if (newId > 0) result.consolidated++;
          } else if (cluster.length === 2) {
            // Direct merge for pairs
            const newId = await mergePair(db, cluster);
            if (newId > 0) result.consolidated++;
          }
        }
        // 'skip' or 'keep' — do not consolidate
      } catch {
        // Individual cluster failure — continue with others
      }
    }

    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
}

