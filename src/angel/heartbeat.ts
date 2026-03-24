/**
 * Angel Heartbeat — configurable loop that runs when sessions are idle.
 *
 * Each tick:
 *   1. Check for idle active sessions → send warnings
 *   2. Find completed sessions the Angel hasn't processed → extract patterns
 *   3. Classify domains for unclassified sessions
 *   4. Guardian duties (pruning, verification, orphan cleanup)
 *   5. Memory monitor (CC auto-memory migration)
 *   6. Bulk artifact linking (Qdrant similarity)
 *   7. Observation consolidation (merge similar obs, rate-limited)
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
import { getUnverifiedFrequentPatterns, incrementVerificationCount } from '../intelligence/experience-patterns.js';
import { monitorMemoryFiles } from './memory-monitor.js';
import { consolidateObservationBatch, shouldConsolidate, markConsolidationRan } from './consolidator.js';

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
  artifacts_linked?: number;
  observations_consolidated?: number;
  consolidation_clusters?: number;
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

      // 4c: Auto-verify patterns with strong positive signal (triggered 5+ times, all helpful)
      const unverified = getUnverifiedFrequentPatterns(ctx.db, '__global__', 5);
      for (const p of unverified) {
        if (p.helpful_count >= 3 && p.harmful_count === 0) {
          incrementVerificationCount(ctx.db, p.id);
          incrementVerificationCount(ctx.db, p.id); // Needs 2 to become verified
        }
      }

      // 4d: Close orphaned sessions (active > 2 hours with no recent observations)
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

    // Phase 6: Bulk artifact linking — populate artifact_links via Qdrant similarity
    try {
      const linked = await linkUnlinkedArtifacts(ctx.db);
      if (linked > 0) {
        result.artifacts_linked = linked;
      }
    } catch {
      // Non-critical — linking failure doesn't break the heartbeat
    }

    // Phase 7: Observation consolidation — merge similar observations into summaries
    // Rate-limited to once per 5 minutes. Skipped if pattern extraction ran this tick
    // (avoid competing for resources).
    try {
      const patternExtractionRan = result.sessions_processed > 0;
      if (!patternExtractionRan && shouldConsolidate()) {
        markConsolidationRan();
        const consResult = await consolidateObservationBatch(
          ctx.db,
          50,
          ctx.config.localModel,
        );
        if (consResult.consolidated > 0) {
          result.observations_consolidated = consResult.consolidated;
          result.consolidation_clusters = consResult.clusters;
        }
      }
    } catch {
      // Non-critical — consolidation failure doesn't break the heartbeat
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  result.duration_ms = Date.now() - start;
  return result;
}

// ---------------------------------------------------------------------------
// Phase 6: Bulk artifact linking
// ---------------------------------------------------------------------------

/** Rate limit: run bulk linking at most once per 5 minutes. */
let _lastLinkingEpoch = 0;
const LINKING_INTERVAL_MS = 5 * 60 * 1000;

/** Max artifacts to link per tick. */
const LINKING_BATCH_SIZE = 20;

/** Minimum cosine similarity for creating a link. */
const LINKING_THRESHOLD = 0.6;

/** Max outgoing links per artifact. */
const MAX_LINKS_PER_ARTIFACT = 5;

/**
 * Find artifacts with embeddings but no outgoing links, then create
 * bidirectional 'related' links to their nearest Qdrant neighbors.
 *
 * Rate-limited to once per 5 minutes to avoid Qdrant pressure.
 * Batch size: 20 artifacts per tick.
 *
 * Non-throwing — returns 0 on any failure.
 */
export async function linkUnlinkedArtifacts(
  db: Database,
  batchSize: number = LINKING_BATCH_SIZE,
): Promise<number> {
  try {
    // Rate limit
    const now = Date.now();
    if (now - _lastLinkingEpoch < LINKING_INTERVAL_MS) return 0;
    _lastLinkingEpoch = now;

    // Find artifacts with embeddings but no outgoing links
    const unlinked = cachedPrepare(db,
      `SELECT a.id, a.project FROM artifacts a
       LEFT JOIN artifact_links al ON a.id = al.source_id
       WHERE al.source_id IS NULL
         AND a.embedding IS NOT NULL
         AND a.state != 'packed'
       LIMIT ?`
    ).all(batchSize) as Array<{ id: number; project: string }>;

    if (unlinked.length === 0) return 0;

    // Dynamic import — Qdrant is optional
    const { searchArtifacts } = await import('../embeddings/qdrant-client.js');

    let linksCreated = 0;

    const insertStmt = cachedPrepare(db,
      `INSERT OR IGNORE INTO artifact_links (source_id, target_id, link_type, strength, valid_at_epoch)
       VALUES (?, ?, 'related', ?, ?)`
    );

    const nowEpoch = Math.floor(Date.now() / 1000);

    for (const artifact of unlinked) {
      try {
        // Get the artifact's embedding BLOB from SQLite
        const row = cachedPrepare(db,
          'SELECT embedding FROM artifacts WHERE id = ?'
        ).get(artifact.id) as { embedding: Buffer | null } | undefined;

        if (!row?.embedding) continue;

        // Decode Float32Array BLOB → number[] (inverse of Buffer.from(Float32Array.buffer))
        const buf = row.embedding;
        const embedding = Array.from(
          new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
        );
        if (embedding.length === 0) continue;

        // Search Qdrant for similar artifacts (top MAX_LINKS_PER_ARTIFACT + 1 to account for self)
        const neighbors = await searchArtifacts(
          embedding,
          artifact.project,
          MAX_LINKS_PER_ARTIFACT + 1,
          { excludeSuperseded: true },
        );

        for (const neighbor of neighbors) {
          const neighborId = typeof neighbor.id === 'number'
            ? neighbor.id
            : (neighbor.payload?.artifact_id as number);

          if (!neighborId || neighborId === artifact.id) continue;
          if (neighbor.score < LINKING_THRESHOLD) continue;

          // Bidirectional: A→B and B→A
          insertStmt.run(artifact.id, neighborId, neighbor.score, nowEpoch);
          insertStmt.run(neighborId, artifact.id, neighbor.score, nowEpoch);
          linksCreated++;
        }
      } catch {
        // Individual artifact linking failure — continue with others
      }
    }

    return linksCreated;
  } catch {
    return 0;
  }
}

/** Reset linking rate limit (for testing). */
export function resetLinkingRateLimit(): void {
  _lastLinkingEpoch = 0;
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
