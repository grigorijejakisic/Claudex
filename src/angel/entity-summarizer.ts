/**
 * Angel Entity Summarizer — generates consolidated entity summaries with trends.
 *
 * Hindsight-inspired observation layer: for recurring entities (projects, tools,
 * people, concepts mentioned in 3+ sessions), synthesize a summary with:
 * - Evidence-grounded description
 * - Trend: STABLE | STRENGTHENING | WEAKENING | NEW | STALE
 * - Last evidence timestamp
 *
 * Stored as artifacts with artifact_type = 'entity_summary'.
 * Regenerated when new evidence arrives (tracked via evidence count hash).
 *
 * A6 (Phase 11): CC's Magic Docs (ant-only, magicDocs.ts) auto-updates files
 * that start with `# MAGIC DOC: <title>`. If Magic Docs ships externally,
 * Angel must check for this header before writing to any file and SKIP if
 * present — otherwise both systems would race on the same file. Currently
 * safe because Magic Docs is behind USER_TYPE === 'ant' gate.
 *
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { ulid } from 'ulid';
import { callLocalLLM } from './llama-client.js';

export interface EntitySummaryResult {
  entities_summarized: number;
  entities_updated: number;
}

interface EntityCandidate {
  entity_name: string;
  mention_count: number;
  session_count: number;
  projects: string;
  latest_epoch: number;
  earliest_epoch: number;
}

/**
 * Find recurring entities across sessions — entities mentioned in 3+ sessions.
 * Uses session_events entity field as the primary source.
 */
function findRecurringEntities(db: Database, limit: number = 10): EntityCandidate[] {
  try {
    return cachedPrepare(db,
      `SELECT entity AS entity_name,
              COUNT(*) AS mention_count,
              COUNT(DISTINCT session_id) AS session_count,
              GROUP_CONCAT(DISTINCT project) AS projects,
              MAX(timestamp_epoch) AS latest_epoch,
              MIN(timestamp_epoch) AS earliest_epoch
       FROM session_events
       WHERE entity != '' AND entity IS NOT NULL
       GROUP BY LOWER(entity)
       HAVING COUNT(DISTINCT session_id) >= 3
       ORDER BY COUNT(*) DESC
       LIMIT ?`
    ).all(limit) as EntityCandidate[];
  } catch {
    return [];
  }
}

/**
 * Compute trend from evidence timestamps.
 */
function computeTrend(earliest: number, latest: number, mentionCount: number): string {
  const now = Math.floor(Date.now() / 1000);
  const age = now - earliest;
  const recency = now - latest;
  const daysSinceLatest = recency / 86400;
  const totalDays = Math.max(1, age / 86400);
  const density = mentionCount / totalDays;

  if (daysSinceLatest > 14) return 'STALE';
  if (totalDays < 3) return 'NEW';
  if (density > 2 && daysSinceLatest < 3) return 'STRENGTHENING';
  if (density < 0.3) return 'WEAKENING';
  return 'STABLE';
}

/**
 * Check if an entity summary exists and is current (evidence count matches).
 */
function getExistingSummary(
  db: Database,
  entityName: string,
): { id: number; content: string; metadata: string } | null {
  try {
    return cachedPrepare(db,
      `SELECT id, content, metadata FROM artifacts
       WHERE artifact_type = 'entity_summary'
         AND ref = ?
       LIMIT 1`
    ).get(`entity:${entityName.toLowerCase()}`) as { id: number; content: string; metadata: string } | null;
  } catch {
    return null;
  }
}

/**
 * Generate or update entity summaries for recurring entities.
 * Uses LLM to synthesize summaries from collected evidence.
 * Non-throwing.
 */
export async function generateEntitySummaries(
  db: Database,
  model: string,
): Promise<EntitySummaryResult> {
  const result: EntitySummaryResult = { entities_summarized: 0, entities_updated: 0 };

  try {
    const entities = findRecurringEntities(db, 10);
    if (entities.length === 0) return result;

    for (const entity of entities) {
      try {
        const existing = getExistingSummary(db, entity.entity_name);
        const evidenceHash = `${entity.mention_count}:${entity.latest_epoch}`;

        // Skip if summary exists and evidence hasn't changed
        if (existing?.metadata?.includes(evidenceHash)) continue;

        // Gather evidence for this entity
        const evidence = cachedPrepare(db,
          `SELECT action, detail, project, timestamp_epoch
           FROM session_events
           WHERE LOWER(entity) = LOWER(?)
           ORDER BY timestamp_epoch DESC
           LIMIT 20`
        ).all(entity.entity_name) as Array<{
          action: string; detail: string | null; project: string; timestamp_epoch: number;
        }>;

        const trend = computeTrend(entity.earliest_epoch, entity.latest_epoch, entity.mention_count);

        // Try LLM synthesis via local llama-server (Gemma 4 31B Q6_K).
        // Falls through to the template fallback below if the server is
        // unreachable or returns malformed output.
        let summary = '';
        try {
          const evidenceText = evidence.map(e =>
            `[${e.project}] ${e.action}: ${(e.detail ?? '').substring(0, 100)}`
          ).join('\n');

          summary = await callLocalLLM({
            prompt: `Summarize this entity in 2-3 sentences based on the evidence. Entity: "${entity.entity_name}"\nEvidence:\n${evidenceText}\n\nOutput only the summary.`,
            maxTokens: 200,
            timeoutMs: 30000,
          });
        } catch { /* LLM failed — use template */ }

        if (!summary) {
          summary = `${entity.entity_name}: mentioned in ${entity.session_count} sessions across projects ${entity.projects}. Trend: ${trend}.`;
        }

        const fullContent = `## ${entity.entity_name}\n${summary}\n\n**Trend:** ${trend} | **Mentions:** ${entity.mention_count} across ${entity.session_count} sessions | **Projects:** ${entity.projects}`;

        if (existing) {
          // Update existing summary
          cachedPrepare(db,
            `UPDATE artifacts SET content = ?, metadata = ?, timestamp_epoch = ? WHERE id = ?`
          ).run(fullContent, JSON.stringify({ evidence_hash: evidenceHash, trend }), Math.floor(Date.now() / 1000), existing.id);
          result.entities_updated++;
        } else {
          // Create new entity summary artifact
          const now = Math.floor(Date.now() / 1000);
          cachedPrepare(db,
            `INSERT INTO artifacts (ref, content, artifact_type, importance, project, timestamp_epoch, state, metadata)
             VALUES (?, ?, 'entity_summary', 3, ?, ?, 'active', ?)`
          ).run(
            `entity:${entity.entity_name.toLowerCase()}`,
            fullContent,
            entity.projects.split(',')[0] ?? '__global__',
            now,
            JSON.stringify({ evidence_hash: evidenceHash, trend }),
          );
          result.entities_summarized++;
        }
      } catch { /* individual entity failure — continue */ }
    }
  } catch { /* non-fatal */ }

  return result;
}
