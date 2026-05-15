/**
 * Cross-session learning dashboard — read-only inspection CLI.
 * Queries SQLite DB and displays accumulated learnings, decisions,
 * and topic/observation patterns across sessions.
 *
 * Usage:
 *   claudex dashboard learnings [--project X]
 *   claudex dashboard decisions [--project X] [--session S]
 *   claudex dashboard stats [--project X]
 *   claudex dashboard topics [--project X]
 *
 * Non-throwing — exits with code 1 on error.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';

// ── Arg parsing ──────────────────────────────────────────────────────

export interface DashboardArgs {
  subcommand: 'learnings' | 'decisions' | 'stats' | 'topics' | 'help';
  project?: string;
  session?: string;
}

/**
 * Parses process.argv-style arguments into DashboardArgs.
 * Exported for testability.
 */
export function parseArgs(argv: string[]): DashboardArgs {
  // Strip node path and script path
  const args = argv.slice(2);

  // Find subcommand (first non-flag argument)
  let subcommand: DashboardArgs['subcommand'] = 'help';
  let project: string | undefined;
  let session: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--project' && i + 1 < args.length) {
      project = args[++i];
    } else if (arg === '--session' && i + 1 < args.length) {
      session = args[++i];
    } else if (arg === 'dashboard') {
      // Skip the 'dashboard' keyword itself
      continue;
    } else if (!arg.startsWith('-')) {
      const sub = arg.toLowerCase();
      if (sub === 'learnings' || sub === 'decisions' || sub === 'stats' || sub === 'topics' || sub === 'help') {
        subcommand = sub;
      }
    }
  }

  return { subcommand, project, session };
}

// ── DB query helpers ─────────────────────────────────────────────────

export interface LearningResult {
  content: string;
  project: string;
  promotion_count: number;
  first_seen_epoch_ms: number;
  last_promoted_epoch_ms: number;
}

export interface DecisionResult {
  content: string;
  source: string;
  session_id: string;
  project: string;
  timestamp_epoch: number;
}

export interface StatsResult {
  total_observations: number;
  total_decisions: number;
  total_learnings: number;
  total_sessions: number;
  top_categories: Array<{ category: string; count: number }>;
  recent_sessions: Array<{ session_id: string; project: string | null; status: string; created_at_epoch_ms: number; observation_count: number }>;
}

export interface TopicResult {
  session_id: string;
  topic: string | null;
  summary: string | null;
  updated_at_epoch: number;
}

/**
 * Queries promoted learnings across sessions.
 * Returns learnings ordered by promotion_count DESC.
 */
export function queryLearnings(db: Database.Database, project?: string): LearningResult[] {
  try {
    if (project) {
      return db
        .prepare(
          `SELECT content, project, promotion_count, first_seen_epoch_ms, last_promoted_epoch_ms
           FROM learnings
           WHERE project = ? OR project = '__global__'
           ORDER BY promotion_count DESC
           LIMIT 50`
        )
        .all(project) as LearningResult[];
    }
    return db
      .prepare(
        `SELECT content, project, promotion_count, first_seen_epoch_ms, last_promoted_epoch_ms
         FROM learnings
         ORDER BY promotion_count DESC
         LIMIT 50`
      )
      .all() as LearningResult[];
  } catch (err) {
    console.error(`[dashboard] queryLearnings failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Queries captured decisions.
 * Optionally filtered by project and/or session.
 */
export function queryDecisions(db: Database.Database, project?: string, session?: string): DecisionResult[] {
  try {
    // Warn when both --session and --project are provided (session takes precedence)
    if (session && project) {
      console.warn('Warning: both --session and --project provided. Filtering by session only (--project ignored).');
    }

    if (session) {
      return db
        .prepare(
          `SELECT content, source, session_id, project, timestamp_epoch
           FROM decisions
           WHERE session_id = ?
           ORDER BY timestamp_epoch DESC
           LIMIT 100`
        )
        .all(session) as DecisionResult[];
    }
    if (project) {
      return db
        .prepare(
          `SELECT content, source, session_id, project, timestamp_epoch
           FROM decisions
           WHERE project = ?
           ORDER BY timestamp_epoch DESC
           LIMIT 100`
        )
        .all(project) as DecisionResult[];
    }
    return db
      .prepare(
        `SELECT content, source, session_id, project, timestamp_epoch
         FROM decisions
         ORDER BY timestamp_epoch DESC
         LIMIT 100`
      )
      .all() as DecisionResult[];
  } catch (err) {
    console.error(`[dashboard] queryDecisions failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Queries aggregate stats: observation counts, session history, top categories.
 */
export function queryStats(db: Database.Database, project?: string): StatsResult {
  const empty: StatsResult = {
    total_observations: 0,
    total_decisions: 0,
    total_learnings: 0,
    total_sessions: 0,
    top_categories: [],
    recent_sessions: [],
  };

  try {
    const projectFilter = project ? `WHERE project = ?` : '';
    const projectFilterObs = project ? `WHERE project = ? AND deleted_at_epoch_ms IS NULL` : `WHERE deleted_at_epoch_ms IS NULL`;
    const params = project ? [project] : [];

    const obsCount = db
      .prepare(`SELECT COUNT(*) as cnt FROM observations ${projectFilterObs}`)
      .get(...params) as { cnt: number } | undefined;

    const decCount = db
      .prepare(`SELECT COUNT(*) as cnt FROM decisions ${projectFilter}`)
      .get(...params) as { cnt: number } | undefined;

    const learnCount = db
      .prepare(`SELECT COUNT(*) as cnt FROM learnings ${projectFilter}`)
      .get(...params) as { cnt: number } | undefined;

    const sessCount = db
      .prepare(`SELECT COUNT(*) as cnt FROM sessions ${projectFilter}`)
      .get(...params) as { cnt: number } | undefined;

    const topCats = db
      .prepare(
        `SELECT category, COUNT(*) as count
         FROM observations
         ${projectFilterObs}
         GROUP BY category
         ORDER BY count DESC
         LIMIT 10`
      )
      .all(...params) as Array<{ category: string; count: number }>;

    const recentSessions = db
      .prepare(
        `SELECT session_id, project, status, created_at_epoch_ms, observation_count
         FROM sessions
         ${projectFilter}
         ORDER BY created_at_epoch_ms DESC
         LIMIT 10`
      )
      .all(...params) as StatsResult['recent_sessions'];

    return {
      total_observations: obsCount?.cnt ?? 0,
      total_decisions: decCount?.cnt ?? 0,
      total_learnings: learnCount?.cnt ?? 0,
      total_sessions: sessCount?.cnt ?? 0,
      top_categories: topCats,
      recent_sessions: recentSessions,
    };
  } catch (err) {
    console.error(`[dashboard] queryStats failed: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}

/**
 * Queries topic/thread state across sessions.
 */
export function queryTopics(db: Database.Database, project?: string): TopicResult[] {
  try {
    if (project) {
      return db
        .prepare(
          `SELECT ts.session_id, ts.topic, ts.summary, ts.updated_at_epoch
           FROM thread_state ts
           JOIN sessions s ON ts.session_id = s.session_id
           WHERE s.project = ?
           ORDER BY ts.updated_at_epoch DESC
           LIMIT 50`
        )
        .all(project) as TopicResult[];
    }
    return db
      .prepare(
        `SELECT session_id, topic, summary, updated_at_epoch
         FROM thread_state
         ORDER BY updated_at_epoch DESC
         LIMIT 50`
      )
      .all() as TopicResult[];
  } catch (err) {
    console.error(`[dashboard] queryTopics failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Formatting ───────────────────────────────────────────────────────

function formatEpoch(epoch: number): string {
  try {
    return new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return 'unknown';
  }
}

function formatEpochMs(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return 'unknown';
  }
}

export function formatLearnings(learnings: LearningResult[]): string {
  if (learnings.length === 0) return 'No learnings found.';

  const lines: string[] = ['=== Learnings ===', ''];
  for (const l of learnings) {
    lines.push(`[${l.project}] (promoted ${l.promotion_count}x)`);
    lines.push(`  ${l.content}`);
    lines.push(`  First seen: ${formatEpochMs(l.first_seen_epoch_ms)} | Last promoted: ${formatEpochMs(l.last_promoted_epoch_ms)}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatDecisions(decisions: DecisionResult[]): string {
  if (decisions.length === 0) return 'No decisions found.';

  const lines: string[] = ['=== Decisions ===', ''];
  for (const d of decisions) {
    lines.push(`[${d.source}] ${formatEpoch(d.timestamp_epoch)} (session: ${d.session_id})`);
    lines.push(`  ${d.content}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatStats(stats: StatsResult): string {
  const lines: string[] = [
    '=== Stats ===',
    '',
    `Sessions:     ${stats.total_sessions}`,
    `Observations: ${stats.total_observations}`,
    `Decisions:    ${stats.total_decisions}`,
    `Learnings:    ${stats.total_learnings}`,
  ];

  if (stats.top_categories.length > 0) {
    lines.push('', '--- Top Categories ---');
    for (const c of stats.top_categories) {
      lines.push(`  ${c.category}: ${c.count}`);
    }
  }

  if (stats.recent_sessions.length > 0) {
    lines.push('', '--- Recent Sessions ---');
    for (const s of stats.recent_sessions) {
      const proj = s.project ?? '(none)';
      lines.push(`  ${s.session_id} | ${proj} | ${s.status} | obs: ${s.observation_count} | ${formatEpochMs(s.created_at_epoch_ms)}`);
    }
  }

  return lines.join('\n');
}

export function formatTopics(topics: TopicResult[]): string {
  if (topics.length === 0) return 'No topic history found.';

  const lines: string[] = ['=== Topic History ===', ''];
  for (const t of topics) {
    const topic = t.topic ?? '(no topic)';
    lines.push(`${formatEpoch(t.updated_at_epoch)} | session: ${t.session_id}`);
    lines.push(`  Topic: ${topic}`);
    if (t.summary) {
      lines.push(`  Summary: ${t.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatHelp(): string {
  return [
    'Usage: claudex dashboard <subcommand> [options]',
    '',
    'Subcommands:',
    '  learnings  [--project X]              Show promoted learnings',
    '  decisions  [--project X] [--session S] Show captured decisions',
    '  stats      [--project X]              Show observation counts, session history, top categories',
    '  topics     [--project X]              Show topic shift history',
    '  help                                  Show this help message',
  ].join('\n');
}

// ── Main execution ───────────────────────────────────────────────────

/**
 * Runs the dashboard with given args and a DB path.
 * Returns formatted output string. Exported for testability.
 */
export function runDashboard(args: DashboardArgs, dbPath: string): string {
  if (args.subcommand === 'help') {
    return formatHelp();
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    return `Error: Could not open database at ${dbPath}. ${err instanceof Error ? err.message : ''}`;
  }

  try {
    switch (args.subcommand) {
      case 'learnings':
        return formatLearnings(queryLearnings(db, args.project));
      case 'decisions':
        return formatDecisions(queryDecisions(db, args.project, args.session));
      case 'stats':
        return formatStats(queryStats(db, args.project));
      case 'topics':
        return formatTopics(queryTopics(db, args.project));
      default:
        return formatHelp();
    }
  } finally {
    try {
      db.close();
    } catch {
      // Non-throwing
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────
// Only runs when executed directly (not when imported as a module by tests).

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].includes('dashboard') || process.argv[1].endsWith('dashboard.cjs'));

if (isDirectExecution) {
  try {
    const args = parseArgs(process.argv);
    const output = runDashboard(args, getDbPath());
    process.stdout.write(output + '\n');
  } catch (err) {
    process.stderr.write(`Dashboard error: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
    process.exit(1);
  }
}
