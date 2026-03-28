/**
 * Angel Proactive Curator — SQL-based memory optimization.
 *
 * Runs on the Angel heartbeat to actively improve memory quality:
 *   1. Promote frequently-retrieved artifacts (usage-based importance boost)
 *   2. Decay never-accessed packed artifacts (active forgetting)
 *   3. Detect contradictions and log to knowledge_gaps
 *   4. Cool stale HOT files (pressure_scores decay)
 *   5. Archive abandoned projects (pack their artifacts)
 *   6. Generate periodic DB health reports (session_messages)
 *   7. Prepare away-digests for projects with recent but not current activity
 *
 * All SQL-based. No LLM calls. Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { sendMessage } from './message-sender.js';
import type { CurationResult, RetentionConfig } from './types.js';

// ---------------------------------------------------------------------------
// Module-level rate limits
// ---------------------------------------------------------------------------

let _lastCurationEpoch = 0;
let _lastHealthReportEpoch = 0;

/** Reset both rate limits (for testing). */
export function resetCurationRateLimit(): void {
  _lastCurationEpoch = 0;
  _lastHealthReportEpoch = 0;
}

// ---------------------------------------------------------------------------
// Empty result sentinel
// ---------------------------------------------------------------------------

const EMPTY_RESULT: CurationResult = {
  artifacts_promoted: 0,
  artifacts_decayed: 0,
  contradictions_detected: 0,
  hot_files_cooled: 0,
  projects_archived: 0,
  health_report_sent: false,
  digests_prepared: 0,
};

// ---------------------------------------------------------------------------
// 1. Promote frequently-retrieved artifacts
// ---------------------------------------------------------------------------

/**
 * Promote artifacts that have been referenced in ≥10 retrieval events (last 30 days)
 * but still have importance below 4.
 *
 * Never promotes to importance 5 — that tier is reserved for user/angel explicit marks.
 * Returns count of rows updated.
 */
export function promoteFrequentlyRetrieved(db: Database): number {
  try {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

    const result = cachedPrepare(db,
      `UPDATE artifacts SET importance = 4
       WHERE id IN (
         SELECT re.artifact_id
         FROM retrieval_events re
         WHERE re.was_referenced = 1
           AND re.timestamp_epoch >= ?
         GROUP BY re.artifact_id
         HAVING COUNT(*) >= 10
       )
       AND importance < 4
       AND importance >= 1`,
    ).run(thirtyDaysAgo);

    return result.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 2. Accelerate decay for never-accessed packed artifacts
// ---------------------------------------------------------------------------

/**
 * Packed artifacts older than 30 days with zero retrieval events get their
 * activation_score halved — accelerating their eventual deletion by the
 * retention sweep.
 *
 * Only affects importance < 4 (user-pinned and angel-pinned are immune).
 * Processes at most 100 per curation run to bound write pressure.
 * Returns count of rows updated.
 */
export function accelerateNeverAccessed(db: Database): number {
  try {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

    const result = cachedPrepare(db,
      `UPDATE artifacts SET activation_score = activation_score * 0.5
       WHERE state = 'packed'
         AND importance < 4
         AND activation_score > 0.05
         AND timestamp_epoch < ?
         AND id NOT IN (SELECT DISTINCT artifact_id FROM retrieval_events)
       LIMIT 100`,
    ).run(thirtyDaysAgo);

    return result.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 3. Detect contradictions and log to knowledge_gaps
// ---------------------------------------------------------------------------

/**
 * Find high-strength 'contradicts' links that haven't yet been logged as
 * knowledge gaps. Inserts one knowledge_gap row per new contradiction pair.
 *
 * Gracefully skips if knowledge_gaps table is unavailable or has unexpected schema.
 * Returns count of new gaps logged.
 */
export function detectContradictions(db: Database): number {
  try {
    // Find strong contradiction links
    const links = cachedPrepare(db,
      `SELECT al.source_id, al.target_id, al.strength
       FROM artifact_links al
       WHERE al.link_type = 'contradicts'
         AND al.strength > 0.7
       LIMIT 10`,
    ).all() as Array<{ source_id: number; target_id: number; strength: number }>;

    if (links.length === 0) return 0;

    let logged = 0;

    for (const link of links) {
      try {
        // Check if this pair is already in knowledge_gaps
        const description = `Artifact contradiction: artifact ${link.source_id} contradicts artifact ${link.target_id} (strength=${link.strength.toFixed(2)})`;

        const existing = cachedPrepare(db,
          `SELECT id FROM knowledge_gaps
           WHERE description = ?
             AND resolved_at_epoch IS NULL
           LIMIT 1`,
        ).get(description) as { id: number } | undefined;

        if (existing) continue;

        // Determine the project from the source artifact
        const artifact = cachedPrepare(db,
          `SELECT project FROM artifacts WHERE id = ? LIMIT 1`,
        ).get(link.source_id) as { project: string } | undefined;

        const project = artifact?.project ?? '__global__';

        cachedPrepare(db,
          `INSERT INTO knowledge_gaps (project, domain, description, detected_by, priority)
           VALUES (?, 'contradiction', ?, 'angel:curator', 0.8)`,
        ).run(project, description);

        logged++;
      } catch {
        // Individual link processing failure — continue with others
      }
    }

    return logged;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 4. Cool stale HOT files
// ---------------------------------------------------------------------------

/**
 * Files in pressure_scores with temperature='HOT' that haven't been touched
 * in 7 days get their raw_pressure decayed to 30% of current value.
 *
 * Uses the exact column names confirmed from schema: raw_pressure, temperature,
 * last_touched_epoch.
 * Returns count of rows updated.
 */
export function coolStaleHotFiles(db: Database): number {
  try {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

    const result = cachedPrepare(db,
      `UPDATE pressure_scores
       SET raw_pressure = raw_pressure * 0.3
       WHERE temperature = 'HOT'
         AND raw_pressure > 5
         AND last_touched_epoch < ?
       LIMIT 50`,
    ).run(sevenDaysAgo);

    return result.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 5. Archive abandoned projects
// ---------------------------------------------------------------------------

/**
 * Projects with no sessions in the last `config.abandonedProjectDays` days
 * get their artifacts packed and activation_scores halved.
 *
 * Excludes '__global__' and NULL projects. Processes at most 10 per run.
 * Returns count of projects archived.
 */
export function archiveAbandonedProjects(db: Database, config: RetentionConfig): number {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - config.abandonedProjectDays * 86400;

    // Find projects with any sessions that have no recent sessions
    const abandoned = cachedPrepare(db,
      `SELECT DISTINCT project FROM sessions
       WHERE project NOT IN (
         SELECT DISTINCT project FROM sessions
         WHERE created_at_epoch > ?
           AND project IS NOT NULL
           AND project != '__global__'
       )
       AND project != '__global__'
       AND project IS NOT NULL
       LIMIT 10`,
    ).all(cutoff) as Array<{ project: string }>;

    if (abandoned.length === 0) return 0;

    let archived = 0;

    for (const row of abandoned) {
      try {
        cachedPrepare(db,
          `UPDATE artifacts
           SET state = 'packed',
               activation_score = activation_score * 0.5
           WHERE project = ?
             AND state != 'packed'
             AND importance < 5`,
        ).run(row.project);

        archived++;
      } catch {
        // Individual project failure — continue with others
      }
    }

    return archived;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 6. Generate DB health report
// ---------------------------------------------------------------------------

/**
 * Every `config.healthReportIntervalHours` hours, compute DB health stats and
 * deliver them to the most recently active session via session_messages.
 *
 * Has its own rate limit separate from the main curation sweep.
 * Returns true if a report was sent, false otherwise.
 */
export function generateHealthReport(db: Database, config: RetentionConfig): boolean {
  try {
    const now = Date.now();
    const intervalMs = config.healthReportIntervalHours * 3_600_000;

    // Check DB-persisted timestamp first (survives Angel restarts).
    // Falls back to in-memory rate limit for the current process lifetime.
    try {
      const lastReport = cachedPrepare(db,
        `SELECT MAX(timestamp_epoch) as last_epoch FROM telemetry
         WHERE session_id = 'angel' AND event_kind = 'health_report'`
      ).get() as { last_epoch: number | null } | undefined;
      if (lastReport?.last_epoch && (lastReport.last_epoch * 1000 + intervalMs) > now) {
        return false;
      }
    } catch { /* fall through to in-memory check */ }

    if (now - _lastHealthReportEpoch < intervalMs) {
      return false;
    }

    // Compute core stats in a single query
    const stats = cachedPrepare(db,
      `SELECT
         (SELECT COUNT(*) FROM sessions) AS total_sessions,
         (SELECT COUNT(*) FROM observations WHERE deleted_at_epoch IS NULL) AS active_observations,
         (SELECT COUNT(*) FROM artifacts) AS total_artifacts,
         (SELECT COUNT(*) FROM artifacts WHERE embedding IS NOT NULL) AS embedded_artifacts,
         (SELECT COUNT(*) FROM conversation_turns) AS total_turns,
         (SELECT COUNT(*) FROM learnings) AS total_learnings,
         (SELECT COUNT(*) FROM experience_patterns) AS total_patterns`,
    ).get() as {
      total_sessions: number;
      active_observations: number;
      total_artifacts: number;
      embedded_artifacts: number;
      total_turns: number;
      total_learnings: number;
      total_patterns: number;
    } | undefined;

    if (!stats) return false;

    // Approximate table sizes via dbstat (optional — may not exist)
    let sizeSection = '';
    try {
      const sizes = cachedPrepare(db,
        `SELECT name, SUM(pgsize) AS size
         FROM dbstat
         WHERE name IN ('observations', 'artifacts', 'conversation_turns', 'session_journal')
         GROUP BY name`,
      ).all() as Array<{ name: string; size: number }>;

      if (sizes.length > 0) {
        const sizeLines = sizes
          .map(r => `  - ${r.name}: ${(r.size / 1024).toFixed(1)} KB`)
          .join('\n');
        sizeSection = `\n**Table sizes (approx)**\n${sizeLines}\n`;
      }
    } catch {
      // dbstat not available — skip size section
    }

    const embeddedPct = stats.total_artifacts > 0
      ? ((stats.embedded_artifacts / stats.total_artifacts) * 100).toFixed(1)
      : '0.0';

    const reportDate = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const content = [
      `**Claudex DB Health Report** (${reportDate})`,
      '',
      '**Core counts**',
      `  - Sessions: ${stats.total_sessions}`,
      `  - Active observations: ${stats.active_observations}`,
      `  - Artifacts: ${stats.total_artifacts} (${embeddedPct}% embedded)`,
      `  - Conversation turns: ${stats.total_turns}`,
      `  - Learnings: ${stats.total_learnings}`,
      `  - Experience patterns: ${stats.total_patterns}`,
      sizeSection,
      '_Generated by Angel:Curator_',
    ].join('\n');

    // Deliver to the most recently active session
    const targetRow = cachedPrepare(db,
      `SELECT session_id FROM sessions
       WHERE status = 'active'
       ORDER BY created_at_epoch DESC
       LIMIT 1`,
    ).get() as { session_id: string } | undefined;

    if (!targetRow?.session_id) return false;

    const sent = sendMessage(db, targetRow.session_id, content, 'advisory', 'advisory');

    if (sent) {
      _lastHealthReportEpoch = now;
      // Persist to DB so it survives Angel restarts
      try {
        cachedPrepare(db,
          `INSERT INTO telemetry (session_id, event_kind, detail, timestamp_epoch, adapter)
           VALUES ('angel', 'health_report', 'sent', ?, 'angel')`
        ).run(Math.floor(now / 1000));
      } catch { /* non-fatal */ }
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 7. Prepare away-digests
// ---------------------------------------------------------------------------

/**
 * For projects that had activity in the last 30 days but none in the last 3 days,
 * prepare a brief "what happened cross-project" digest artifact (type='flow').
 *
 * The digest captures recent decisions and high-promotion learnings from OTHER
 * projects, stored as a packed artifact in the target project for future recall.
 * Processes at most 5 projects per run.
 * Returns count of digest artifacts created.
 */
export function prepareAwayDigests(db: Database): number {
  try {
    const now = Math.floor(Date.now() / 1000);
    const threeDaysAgo = now - 3 * 86400;
    const thirtyDaysAgo = now - 30 * 86400;

    // Projects away 3–30 days (active enough to care about, but not recently seen)
    const awayProjects = cachedPrepare(db,
      `SELECT DISTINCT project FROM sessions
       WHERE project NOT IN (
         SELECT DISTINCT project FROM sessions
         WHERE created_at_epoch > ?
           AND project IS NOT NULL
           AND project != '__global__'
       )
       AND project != '__global__'
       AND project IS NOT NULL
       AND project IN (
         SELECT DISTINCT project FROM sessions
         WHERE created_at_epoch > ?
           AND project IS NOT NULL
           AND project != '__global__'
       )
       LIMIT 5`,
    ).all(threeDaysAgo, thirtyDaysAgo) as Array<{ project: string }>;

    if (awayProjects.length === 0) return 0;

    let prepared = 0;

    for (const row of awayProjects) {
      try {
        // Dedup: skip if we already created a digest for this project in the last 3 days
        const existingDigest = cachedPrepare(db,
          `SELECT 1 FROM artifacts
           WHERE project = ? AND artifact_type = 'flow'
             AND session_id = 'angel'
             AND summary LIKE 'Away-digest%'
             AND timestamp_epoch > ?
           LIMIT 1`,
        ).get(row.project, threeDaysAgo);
        if (existingDigest) continue;

        // Recent decisions from OTHER projects
        const recentDecisions = cachedPrepare(db,
          `SELECT content FROM decisions
           WHERE project != ?
             AND timestamp_epoch > ?
           ORDER BY timestamp_epoch DESC
           LIMIT 3`,
        ).all(row.project, threeDaysAgo) as Array<{ content: string }>;

        // High-promotion learnings from OTHER projects since the project went away
        const recentLearnings = cachedPrepare(db,
          `SELECT content FROM learnings
           WHERE project != ?
             AND updated_at_epoch > ?
           ORDER BY promotion_count DESC
           LIMIT 3`,
        ).all(row.project, threeDaysAgo) as Array<{ content: string }>;

        // Only write a digest if there's something cross-project to report
        if (recentDecisions.length === 0 && recentLearnings.length === 0) continue;

        const decisionLines = recentDecisions.length > 0
          ? `**Recent cross-project decisions**\n${recentDecisions.map(d => `- ${d.content}`).join('\n')}`
          : '';

        const learningLines = recentLearnings.length > 0
          ? `**Recent cross-project learnings**\n${recentLearnings.map(l => `- ${l.content}`).join('\n')}`
          : '';

        const digestDate = new Date().toISOString().replace('T', ' ').slice(0, 10);
        const summary = `Away-digest for ${row.project} (${digestDate}) — cross-project updates`;
        const content = [
          `# Away Digest: ${row.project}`,
          `_Generated ${digestDate} by Angel:Curator. Activity from other projects while this project was idle._`,
          '',
          decisionLines,
          learningLines,
        ].filter(Boolean).join('\n\n');

        // Store as a packed flow artifact in the target project
        // Use session_id='angel' as the synthetic creator
        cachedPrepare(db,
          `INSERT INTO artifacts
             (session_id, project, artifact_type, summary, content, state, ttl, importance, timestamp_epoch)
           VALUES ('angel', ?, 'flow', ?, ?, 'packed', 0, 3, ?)`,
        ).run(row.project, summary, content, now);

        prepared++;
      } catch {
        // Individual project failure — continue with others
      }
    }

    return prepared;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 8. Master curation function
// ---------------------------------------------------------------------------

/**
 * Run all proactive curation tasks. Rate-limited by config.sweepIntervalMinutes.
 * The health report has its own separate rate limit inside generateHealthReport().
 *
 * Non-throwing — returns EMPTY_RESULT on any top-level failure.
 */
export function runProactiveCuration(db: Database, config: RetentionConfig): CurationResult {
  if (!config.proactiveCuration) return { ...EMPTY_RESULT };

  const now = Date.now();

  // Health report runs independently of the main curation rate limit
  let health_report_sent = false;
  try {
    health_report_sent = generateHealthReport(db, config);
  } catch {
    // Non-critical
  }

  // Main sweep rate limit
  if (now - _lastCurationEpoch < config.sweepIntervalMinutes * 60_000) {
    return { ...EMPTY_RESULT, health_report_sent };
  }
  _lastCurationEpoch = now;

  try {
    const artifacts_promoted = promoteFrequentlyRetrieved(db);
    const artifacts_decayed = accelerateNeverAccessed(db);
    const contradictions_detected = detectContradictions(db);
    const hot_files_cooled = coolStaleHotFiles(db);
    const projects_archived = archiveAbandonedProjects(db, config);
    const digests_prepared = prepareAwayDigests(db);

    return {
      artifacts_promoted,
      artifacts_decayed,
      contradictions_detected,
      hot_files_cooled,
      projects_archived,
      health_report_sent,
      digests_prepared,
    };
  } catch {
    return { ...EMPTY_RESULT, health_report_sent };
  }
}
