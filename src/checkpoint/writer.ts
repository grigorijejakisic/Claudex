/**
 * DB-first checkpoint writer with ULID IDs, threshold logic, debounce,
 * YAML serialization, and optional LLM enrichment.
 * All public functions are non-throwing.
 */

import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import * as yaml from 'js-yaml';
import { emitTelemetry } from '../observability/telemetry.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { emitErrorTelemetry } from '../observability/error-telemetry.js';
import type { TokenUsage } from '../shared/types.js';
import type { CheckpointTrackingRow } from '../core/checkpoint-tracking.js';
import { recordThresholdHit } from '../core/checkpoint-tracking.js';
import { getDecisionsBySession } from '../core/decisions.js';
import { getThreadState } from '../core/thread.js';
import { getHotFiles } from '../core/pressure.js';
import { getTopLearnings } from '../core/learnings.js';
import { enrichCheckpoint, mergeEnrichment } from '../intelligence/enrichment.js';
import type { EnrichmentProvider, CheckpointData } from '../intelligence/enrichment.js';
import { atomicWriteFile, ensureDir, writeCompressedFile } from '../shared/fs-helpers.js';
import { getCheckpointsDir } from '../shared/paths.js';
import {
  THRESHOLDS_200K,
  THRESHOLDS_1M,
  WINDOW_THRESHOLD,
  type CheckpointV3,
  type CheckpointTrigger,
  type WriteCheckpointParams,
  type WriteCheckpointResult,
} from './types.js';

/**
 * Filters decisions for checkpoint inclusion. Rejects:
 * - Too short (< 30 chars after stripping markdown)
 * - Tool title prefixes (Edit:, Bash:, Read:, etc.)
 * - Conversational filler (yes, ok, send, etc.)
 * - Pure markdown formatting (bold/italic wrappers with little content)
 */
function isCheckpointWorthy(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 30) return false;
  if (/^(Edit|Read|Write|Bash|Grep|Glob|NotebookEdit|WebFetch|WebSearch|Run):/i.test(trimmed)) return false;
  if (/^(yes|no|yeah|ok|sure|send|go|done|please|let me|I see|do it)\b/i.test(trimmed)) return false;
  const stripped = trimmed.replace(/[*_#`~>-]/g, '').trim();
  if (stripped.length < 20) return false;
  return true;
}

/**
 * Extract open items from assistant text via regex.
 * Patterns: TODO, FIXME, HACK, remaining/still need/need to.
 * Non-throwing — returns [] on error.
 */
export function extractOpenItems(text: string | null | undefined): string[] {
  try {
    if (!text) return [];

    const patterns = [
      /TODO:?\s+(.+)/gi,
      /FIXME:?\s+(.+)/gi,
      /HACK:?\s+(.+)/gi,
      /(?:remaining|still need|need to)\s+(.+)/gi,
    ];

    const items = new Set<string>();
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const item = match[1].trim();
        if (item) items.add(item);
      }
    }

    return Array.from(items);
  } catch {
    return [];
  }
}


/**
 * Determines whether a checkpoint should be triggered based on trigger type,
 * token usage, tracking state, and debounce.
 * Non-throwing — returns false on error.
 */
export function shouldTriggerCheckpoint(params: {
  trigger: CheckpointTrigger;
  tokenUsage?: TokenUsage;
  tracking?: CheckpointTrackingRow;
  debounceSeconds?: number;
}): boolean {
  try {
    const { trigger, tokenUsage, tracking, debounceSeconds = 60 } = params;

    if (trigger === 'compaction') return true;
    if (trigger === 'session_end') return true;

    // threshold trigger
    if (!tokenUsage) return false;

    const windowSize = tokenUsage.contextWindowTokens;
    const thresholds = windowSize < WINDOW_THRESHOLD ? THRESHOLDS_200K : THRESHOLDS_1M;

    // Find highest threshold crossed
    let highestCrossed: number | null = null;
    for (const t of thresholds) {
      if (tokenUsage.utilization >= t) {
        highestCrossed = t;
      }
    }
    if (highestCrossed === null) return false;

    // Check if already hit
    if (tracking?.thresholds_hit?.includes(highestCrossed)) return false;

    // Apply debounce
    if (tracking?.last_checkpoint_epoch_ms) {
      const nowMs = Date.now();
      if (nowMs - tracking.last_checkpoint_epoch_ms < debounceSeconds * 1000) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * DB-first checkpoint writer. Full lifecycle:
 * INSERT pending -> build data -> UPDATE committed -> enrich -> write file -> UPDATE mirrored.
 * Non-throwing — returns null on error.
 */
export async function writeCheckpoint(
  params: WriteCheckpointParams
): Promise<WriteCheckpointResult | null> {
  const {
    db,
    sessionId,
    project,
    projectDir,
    trigger,
    tokenUsage,
    gsd,
    lastAssistantText,
    enrichmentProvider,
    scope,
    compression,
  } = params;

  const checkpointId = ulid();
  const datePrefix = new Date().toISOString().slice(0, 10);
  const ext = compression ? '.yaml.gz' : '.yaml';
  const basename = `${datePrefix}_${checkpointId}${ext}`;
  const checkpointsDir = getCheckpointsDir(projectDir);
  const filePath = `${checkpointsDir}/${basename}`;
  let enriched = false;

  try {
    // Step 1: INSERT pending record BEFORE reads — if a read throws, the pending
    // row remains for failure traceability (catch block can UPDATE its status).
    cachedPrepare(db,
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, created_at_epoch_ms, updated_at_epoch_ms)
       VALUES (?, ?, ?, 'pending', unixepoch() * 1000, unixepoch() * 1000)`
    ).run(checkpointId, sessionId, trigger);

    // Step 2: Read current state from DB
    const rawDecisions = getDecisionsBySession(db, sessionId).slice(0, 15);
    const decisions = rawDecisions.filter(d => isCheckpointWorthy(d.content));
    const threadState = getThreadState(db, sessionId);
    const hotFiles = getHotFiles(db, project, 15);
    const topLearnings = getTopLearnings(db, project, 10);
    const openItems = extractOpenItems(lastAssistantText);

    let readFiles: string[] = [];
    try {
      const rows = db
        .prepare(
          `SELECT file_path FROM (
             SELECT json_each.value AS file_path, MAX(observations.timestamp_epoch_ms) AS last_seen
             FROM observations, json_each(observations.files_modified)
             WHERE observations.session_id = ? AND observations.deleted_at_epoch_ms IS NULL
             GROUP BY json_each.value
           ) ORDER BY last_seen DESC LIMIT 20`
        )
        .all(sessionId) as Array<{ file_path: string }>;
      readFiles = rows.map((r) => r.file_path);
    } catch {
      // json_each may fail on invalid data — skip
    }

    let previousCheckpoint: string | null = null;
    try {
      const prev = db
        .prepare(
          `SELECT checkpoint_id FROM checkpoint_meta
           WHERE session_id = ? AND status IN ('committed', 'mirrored')
           AND checkpoint_id != ?
           ORDER BY created_at_epoch_ms DESC LIMIT 1`
        )
        .get(sessionId, checkpointId) as { checkpoint_id: string } | undefined;
      if (prev) {
        const prevRow = db
          .prepare('SELECT mirror_path FROM checkpoint_meta WHERE checkpoint_id = ?')
          .get(prev.checkpoint_id) as { mirror_path: string | null } | undefined;
        if (prevRow?.mirror_path) {
          const parts = prevRow.mirror_path.replace(/\\/g, '/').split('/');
          previousCheckpoint = parts[parts.length - 1];
        }
      }
    } catch {
      // No previous checkpoint — ok
    }

    let verifiedFacts: string[] = [];
    try {
      const factRows = db
        .prepare(
          `SELECT fact FROM verified_facts WHERE session_id = ? ORDER BY created_at_epoch_ms DESC LIMIT 20`
        )
        .all(sessionId) as Array<{ fact: string }>;
      verifiedFacts = factRows.map((r) => r.fact);
    } catch {
      // Table may not exist yet — non-fatal
    }

    let currentObjective: string | null = null;
    try {
      const parts: string[] = [];
      if (threadState?.topic) parts.push(`Task: ${threadState.topic}`);
      if (threadState?.summary) parts.push(threadState.summary);
      if (parts.length === 0 && gsd && typeof gsd === 'object' && 'goal' in (gsd as Record<string, unknown>)) {
        parts.push(`Goal: ${(gsd as Record<string, unknown>).goal}`);
      }
      if (parts.length > 0) {
        currentObjective = parts.join('. ').slice(0, 200);
      }
    } catch {
      // Non-fatal
    }

    // Steps 1+3+4 in a transaction: INSERT pending → build → UPDATE committed.
    // Reads (step 2) already done above to minimize write-lock hold time.
    const checkpoint: CheckpointV3 = {
      schema: 'claudex/checkpoint',
      version: 3,
      meta: {
        checkpoint_id: checkpointId,
        session_id: sessionId,
        scope: scope ?? null,
        trigger,
        token_usage: tokenUsage
          ? {
              input_tokens: tokenUsage.inputTokens,
              output_tokens: tokenUsage.outputTokens,
              window_size: tokenUsage.contextWindowTokens,
              utilization: tokenUsage.utilization,
            }
          : null,
        previous_checkpoint: previousCheckpoint,
      },
      working: {
        task: null,
        status: null,
        next_action: null,
        branch: null,
      },
      decisions: decisions.map((d) => ({
        content: d.content,
        source: d.source,
        timestamp: d.timestamp_epoch_ms,
      })),
      files: {
        hot: hotFiles.map((f) => ({
          path: f.file_path,
        })),
        read: readFiles,
      },
      thread: {
        topic: threadState?.topic ?? null,
        summary: threadState?.summary ?? null,
        key_exchanges: (threadState?.key_exchanges ?? []).filter(
          (ex: unknown) => ex && typeof ex === 'object' && typeof (ex as Record<string, unknown>).role === 'string' && (ex as Record<string, unknown>).role !== '__cooldown'
        ) as Array<{ role: string; gist: string }>,
      },
      open_items: openItems,
      learnings: topLearnings.map((l) => l.content),
      gsd: gsd ?? null,
      current_objective: currentObjective,
      verified_facts: verifiedFacts,
    };

    // Step 4: UPDATE committed (pending row already exists from step 1)
    cachedPrepare(db,
      `UPDATE checkpoint_meta SET status = 'committed', data = ?, updated_at_epoch_ms = unixepoch() * 1000
       WHERE checkpoint_id = ?`
    ).run(JSON.stringify(checkpoint), checkpointId);

    // Step 5: Optional enrichment (outside transaction — can timeout)
    if (enrichmentProvider) {
      try {
        const cpData: CheckpointData = {
          topic: checkpoint.thread.topic ?? undefined,
          task: checkpoint.working.task ?? undefined,
          status: checkpoint.working.status ?? undefined,
          decisions: checkpoint.decisions.map((d) => d.content),
          open_items: checkpoint.open_items,
          learnings: checkpoint.learnings,
          summary: checkpoint.thread.summary ?? undefined,
          key_exchanges: checkpoint.thread.key_exchanges,
        };

        const enrichedData = await enrichCheckpoint(cpData, enrichmentProvider);
        if (enrichedData) {
          const merged = mergeEnrichment(cpData, enrichedData);

          // Apply merged data back to checkpoint
          if (merged.topic) checkpoint.thread.topic = merged.topic;
          if (merged.summary) checkpoint.thread.summary = merged.summary;
          if (merged.task) checkpoint.working.task = merged.task;
          if (merged.decisions) checkpoint.decisions = merged.decisions.map((d) => ({ content: d, source: 'enriched', timestamp: Math.floor(Date.now() / 1000) }));
          if (merged.open_items) checkpoint.open_items = merged.open_items;
          if (merged.learnings) checkpoint.learnings = merged.learnings;
          if (merged.key_exchanges) checkpoint.thread.key_exchanges = merged.key_exchanges;

          cachedPrepare(db,
            `UPDATE checkpoint_meta SET data = ?, updated_at_epoch_ms = unixepoch() * 1000
             WHERE checkpoint_id = ?`
          ).run(JSON.stringify(checkpoint), checkpointId);

          enriched = true;
        }
      } catch {
        // Enrichment failure is non-fatal
      }
    }

    // Step 6-7: Write YAML file (optionally compressed)
    // Use JSON_SCHEMA for round-trip consistency (prevents "true" -> boolean coercion)
    const yamlContent = yaml.dump(checkpoint, { lineWidth: 120, noRefs: true, schema: yaml.JSON_SCHEMA });
    let writeOk: boolean;
    if (compression) {
      writeOk = await writeCompressedFile(filePath, yamlContent);
    } else {
      writeOk = await atomicWriteFile(filePath, yamlContent);
    }

    if (!writeOk) {
      cachedPrepare(db,
        `UPDATE checkpoint_meta SET error = 'File write failed', updated_at_epoch_ms = unixepoch() * 1000
         WHERE checkpoint_id = ?`
      ).run(checkpointId);
      return {
        checkpointId,
        status: 'committed',
        filePath: null,
        enriched,
      };
    }

    // Step 8: Update latest.yaml
    const latestOk = await atomicWriteFile(`${checkpointsDir}/latest.yaml`, `ref: ${basename}\n`);

    // Step 9: UPDATE mirrored (only if latest.yaml also written successfully)
    if (latestOk) {
      cachedPrepare(db,
        `UPDATE checkpoint_meta SET status = 'mirrored', mirror_path = ?, updated_at_epoch_ms = unixepoch() * 1000
         WHERE checkpoint_id = ?`
      ).run(filePath, checkpointId);
    } else {
      cachedPrepare(db,
        `UPDATE checkpoint_meta SET mirror_path = ?, updated_at_epoch_ms = unixepoch() * 1000
         WHERE checkpoint_id = ?`
      ).run(filePath, checkpointId);
    }

    // Step 10: Record threshold hit
    if (trigger === 'threshold' && tokenUsage) {
      const windowSize = tokenUsage.contextWindowTokens;
      const thresholds = windowSize < WINDOW_THRESHOLD ? THRESHOLDS_200K : THRESHOLDS_1M;
      let highestCrossed: number | null = null;
      for (const t of thresholds) {
        if (tokenUsage.utilization >= t) highestCrossed = t;
      }
      if (highestCrossed !== null) {
        recordThresholdHit(db, sessionId, highestCrossed);
      }
    }

    return {
      checkpointId,
      status: latestOk ? 'mirrored' : 'committed',
      filePath,
      enriched,
    };
  } catch (err) {
    // Set error on checkpoint_meta if it was inserted
    try {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      cachedPrepare(db,
        `UPDATE checkpoint_meta SET error = ?, updated_at_epoch_ms = unixepoch() * 1000
         WHERE checkpoint_id = ?`
      ).run(msg, checkpointId);
    } catch {
      // Best effort
    }
    emitErrorTelemetry(db, sessionId, 'checkpoint/write', err);
    return null;
  }
}

