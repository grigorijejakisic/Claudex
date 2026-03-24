/**
 * Angel Heartbeat — configurable loop that runs when sessions are idle.
 *
 * Each tick:
 *   1. Check for idle active sessions → send warnings
 *   2. Find completed sessions the Angel hasn't processed → extract patterns
 *   3. Classify domains for unclassified sessions
 *
 * The heartbeat only runs meaningful work — no busy loops.
 * Design: easy, fast, purposeful. Every piece earns its place.
 *
 * Non-throwing — individual tick failures don't kill the loop.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { AngelConfig } from './types.js';
import { getIdleSessions, getUnprocessedSessions, hasIdleWarning, markSessionProcessed } from './session-monitor.js';
import { sendIdleWarning } from './message-sender.js';
import { extractPatternsFromSession, classifySessionDomains } from './pattern-extractor.js';
import { monitorMemoryFiles } from './memory-monitor.js';

export interface HeartbeatContext {
  db: Database;
  client: Anthropic;
  config: AngelConfig;
}

/** Telemetry for a single heartbeat tick. */
export interface TickResult {
  idle_warnings_sent: number;
  sessions_processed: number;
  patterns_extracted: number;
  domains_classified: number;
  learnings_pruned?: number;
  patterns_pruned?: number;
  memory_entries_migrated?: number;
  duration_ms: number;
  error?: string;
}

/**
 * Execute a single heartbeat tick.
 * Non-throwing — returns result with error field on failure.
 */
export async function heartbeatTick(ctx: HeartbeatContext): Promise<TickResult> {
  const start = Date.now();
  const result: TickResult = {
    idle_warnings_sent: 0,
    sessions_processed: 0,
    patterns_extracted: 0,
    domains_classified: 0,
    duration_ms: 0,
  };

  try {
    // Phase 1: Idle session detection
    const idleSessions = getIdleSessions(ctx.db, ctx.config.idleThresholdSeconds);

    for (const session of idleSessions) {
      // Don't spam — only warn once
      if (!hasIdleWarning(ctx.db, session.session_id)) {
        const sent = sendIdleWarning(ctx.db, session.session_id, session.idle_minutes, session.topic);
        if (sent) result.idle_warnings_sent++;
      }
    }

    // Phase 2: Process completed sessions (pattern extraction)
    const unprocessed = getUnprocessedSessions(ctx.db, 3); // Process max 3 per tick

    for (const session of unprocessed) {
      try {
        const extraction = await extractPatternsFromSession(
          ctx.db,
          session.session_id,
          session.project,
          ctx.client,
          ctx.config.cloudModel,
          ctx.config.maxPatternsPerSession,
          ctx.config.localModel,
        );

        result.sessions_processed++;
        result.patterns_extracted += extraction.patternsCreated;

        // Only mark as processed on definitive outcomes — NOT on transient failures.
        // 'too few turns', 'insufficient content', 'no corrections found' = definitive, mark processed.
        // 'extraction failed', 'no LLM available', 'empty LLM response' = transient, retry next tick.
        const definitiveOutcomes = ['too few turns', 'insufficient content', 'no corrections found'];
        const isDefinitive = extraction.patternsCreated > 0 || definitiveOutcomes.some(o => extraction.summary.includes(o));
        if (isDefinitive && extraction.patternsCreated === 0) {
          markSessionProcessed(ctx.db, session.session_id, session.project, extraction.summary);
        }

        // Phase 3: Domain classification for this session (Ollama only — trivial task)
        const domains = await classifySessionDomains(
          ctx.db,
          session.session_id,
          session.project,
          ctx.config.localModel,
        );
        result.domains_classified += domains;
      } catch {
        // Individual session processing failure — continue with others
      }
    }
    // Phase 4: Guardian duties — learning curation, pattern quality, DB maintenance
    try {
      // 4a: Prune garbage learnings (apply quality gate retroactively)
      const garbageLearnings = cachedPrepare(ctx.db,
        `SELECT id, content FROM learnings WHERE LENGTH(content) < 60 OR content LIKE '%?'`
      ).all() as Array<{ id: number; content: string }>;
      for (const l of garbageLearnings) {
        cachedPrepare(ctx.db, 'DELETE FROM learnings WHERE id = ?').run(l.id);
      }
      if (garbageLearnings.length > 0) {
        result.learnings_pruned = garbageLearnings.length;
      }

      // 4b: Prune low-quality patterns (harmful > helpful after 5+ triggers)
      const badPatterns = cachedPrepare(ctx.db,
        `SELECT id FROM experience_patterns
         WHERE times_triggered >= 5 AND harmful_count > helpful_count`
      ).all() as Array<{ id: string }>;
      for (const p of badPatterns) {
        cachedPrepare(ctx.db, 'DELETE FROM experience_patterns WHERE id = ?').run(p.id);
      }
      if (badPatterns.length > 0) {
        result.patterns_pruned = badPatterns.length;
      }

      // 4c: Close orphaned sessions (active > 2 hours with no recent observations)
      const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
      const orphans = cachedPrepare(ctx.db,
        `SELECT session_id FROM sessions
         WHERE status = 'active' AND created_at_epoch < ?
         AND session_id NOT IN (
           SELECT DISTINCT session_id FROM observations
           WHERE timestamp_epoch > ?
         )`
      ).all(twoHoursAgo, twoHoursAgo) as Array<{ session_id: string }>;
      for (const o of orphans) {
        cachedPrepare(ctx.db,
          `UPDATE sessions SET status = 'completed', ended_at_epoch = ? WHERE session_id = ?`
        ).run(Math.floor(Date.now() / 1000), o.session_id);
      }
    } catch {
      // Guardian duties are non-critical — failures don't break the heartbeat
    }

    // Phase 5: Memory monitor — migrate CC auto-memory to Claudex DB
    try {
      const memResult = monitorMemoryFiles(ctx.db);
      if (memResult.entries_migrated > 0) {
        result.memory_entries_migrated = memResult.entries_migrated;
      }
    } catch {
      // Non-critical — memory monitoring failure doesn't break the heartbeat
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  result.duration_ms = Date.now() - start;
  return result;
}

/**
 * Start the heartbeat loop. Runs indefinitely until the process is killed.
 * Returns a cleanup function.
 */
export function startHeartbeat(
  ctx: HeartbeatContext,
  onTick?: (result: TickResult) => void,
): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = true;

  async function tick() {
    if (!running) return;

    const result = await heartbeatTick(ctx);
    onTick?.(result);

    if (running) {
      timer = setTimeout(tick, ctx.config.heartbeatIntervalMs);
    }
  }

  // Run first tick after a short delay (let the process settle)
  timer = setTimeout(tick, 5000);

  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}
