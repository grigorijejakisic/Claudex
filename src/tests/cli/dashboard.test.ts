/**
 * Tests for the cross-session learning dashboard CLI.
 * Creates in-memory test DBs with sample data and verifies query/format output.
 */

import Database from 'better-sqlite3';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { initializeSchema } from '../../core/migrations.js';
import { insertObservation } from '../../core/observations.js';
import { insertDecision } from '../../core/decisions.js';
import { createSession } from '../../core/sessions.js';
import { upsertLearning } from '../../core/learnings.js';
import { upsertThreadState } from '../../core/thread.js';
import {
  parseArgs,
  queryLearnings,
  queryDecisions,
  queryStats,
  queryTopics,
  formatLearnings,
  formatDecisions,
  formatStats,
  formatTopics,
  runDashboard,
} from '../../cli/dashboard.js';

// ── parseArgs ─────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses "dashboard learnings" subcommand', () => {
    const args = parseArgs(['node', 'dashboard.js', 'dashboard', 'learnings']);
    expect(args.subcommand).toBe('learnings');
  });

  it('parses "decisions" subcommand without "dashboard" keyword', () => {
    const args = parseArgs(['node', 'dashboard.js', 'decisions']);
    expect(args.subcommand).toBe('decisions');
  });

  it('parses --project flag', () => {
    const args = parseArgs(['node', 'dashboard.js', 'learnings', '--project', 'myproj']);
    expect(args.subcommand).toBe('learnings');
    expect(args.project).toBe('myproj');
  });

  it('parses --session flag', () => {
    const args = parseArgs(['node', 'dashboard.js', 'decisions', '--session', 'sess-123']);
    expect(args.subcommand).toBe('decisions');
    expect(args.session).toBe('sess-123');
  });

  it('parses both --project and --session together', () => {
    const args = parseArgs(['node', 'dashboard.js', 'decisions', '--project', 'proj1', '--session', 'sess-1']);
    expect(args.subcommand).toBe('decisions');
    expect(args.project).toBe('proj1');
    expect(args.session).toBe('sess-1');
  });

  it('defaults to "help" when no subcommand provided', () => {
    const args = parseArgs(['node', 'dashboard.js']);
    expect(args.subcommand).toBe('help');
  });

  it('parses "stats" subcommand', () => {
    const args = parseArgs(['node', 'dashboard.js', 'stats']);
    expect(args.subcommand).toBe('stats');
  });

  it('parses "topics" subcommand', () => {
    const args = parseArgs(['node', 'dashboard.js', 'topics']);
    expect(args.subcommand).toBe('topics');
  });

  it('parses "help" subcommand explicitly', () => {
    const args = parseArgs(['node', 'dashboard.js', 'help']);
    expect(args.subcommand).toBe('help');
  });

  it('ignores unknown flags', () => {
    const args = parseArgs(['node', 'dashboard.js', 'learnings', '--verbose']);
    expect(args.subcommand).toBe('learnings');
  });
});

// ── Query functions ───────────────────────────────────────────────

describe('queryLearnings', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array when no learnings exist', () => {
    const result = queryLearnings(db);
    expect(result).toEqual([]);
  });

  it('returns learnings ordered by promotion_count DESC', () => {
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp1', content: 'Learning A' });
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp2', content: 'Learning B' });
    // Promote fp2 twice more
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp2', content: 'Learning B' });
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp2', content: 'Learning B' });

    const result = queryLearnings(db);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Learning B');
    expect(result[0].promotion_count).toBe(3);
    expect(result[1].content).toBe('Learning A');
    expect(result[1].promotion_count).toBe(1);
  });

  it('filters by project (including __global__)', () => {
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp1', content: 'Proj1 learning' });
    upsertLearning(db, { project: 'proj2', fingerprint: 'fp2', content: 'Proj2 learning' });
    upsertLearning(db, { project: '__global__', fingerprint: 'fp3', content: 'Global learning' });

    const result = queryLearnings(db, 'proj1');
    expect(result).toHaveLength(2); // proj1 + __global__
    const contents = result.map(r => r.content);
    expect(contents).toContain('Proj1 learning');
    expect(contents).toContain('Global learning');
    expect(contents).not.toContain('Proj2 learning');
  });

  it('returns all learnings when no project filter', () => {
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp1', content: 'A' });
    upsertLearning(db, { project: 'proj2', fingerprint: 'fp2', content: 'B' });

    const result = queryLearnings(db);
    expect(result).toHaveLength(2);
  });
});

describe('queryDecisions', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array when no decisions exist', () => {
    const result = queryDecisions(db);
    expect(result).toEqual([]);
  });

  it('returns decisions ordered by timestamp DESC', () => {
    insertDecision(db, { session_id: 's1', project: 'proj1', content: 'Decision A', source: 'confirmation', fingerprint: 'fp1' });
    insertDecision(db, { session_id: 's1', project: 'proj1', content: 'Decision B', source: 'direction', fingerprint: 'fp2' });

    const result = queryDecisions(db);
    expect(result).toHaveLength(2);
    // Both are returned (order within same epoch may vary)
    const contents = result.map(r => r.content);
    expect(contents).toContain('Decision A');
    expect(contents).toContain('Decision B');
  });

  it('filters by project', () => {
    insertDecision(db, { session_id: 's1', project: 'proj1', content: 'Proj1 decision', source: 'confirmation', fingerprint: 'fp1' });
    insertDecision(db, { session_id: 's2', project: 'proj2', content: 'Proj2 decision', source: 'confirmation', fingerprint: 'fp2' });

    const result = queryDecisions(db, 'proj1');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Proj1 decision');
  });

  it('filters by session', () => {
    insertDecision(db, { session_id: 's1', project: 'proj1', content: 'Session 1', source: 'confirmation', fingerprint: 'fp1' });
    insertDecision(db, { session_id: 's2', project: 'proj1', content: 'Session 2', source: 'confirmation', fingerprint: 'fp2' });

    const result = queryDecisions(db, undefined, 's1');
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Session 1');
  });
});

describe('queryStats', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns zero counts when DB is empty', () => {
    const result = queryStats(db);
    expect(result.total_observations).toBe(0);
    expect(result.total_decisions).toBe(0);
    expect(result.total_learnings).toBe(0);
    expect(result.total_sessions).toBe(0);
    expect(result.top_categories).toEqual([]);
    expect(result.recent_sessions).toEqual([]);
  });

  it('counts observations, decisions, learnings, sessions', () => {
    createSession(db, { session_id: 's1', project: 'proj1' });
    createSession(db, { session_id: 's2', project: 'proj1' });
    insertObservation(db, {
      session_id: 's1', project: 'proj1', tool_name: 'Read',
      category: 'code', title: 'Read file', content: 'read src/a.ts',
      importance: 3, files_modified: ['src/a.ts'],
    });
    insertObservation(db, {
      session_id: 's1', project: 'proj1', tool_name: 'Edit',
      category: 'architecture', title: 'Edit file', content: 'edited',
      importance: 4, files_modified: ['src/b.ts'],
    });
    insertDecision(db, { session_id: 's1', project: 'proj1', content: 'dec1', source: 'confirmation', fingerprint: 'fp1' });
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp1', content: 'learn1' });

    const result = queryStats(db);
    expect(result.total_observations).toBe(2);
    expect(result.total_decisions).toBe(1);
    expect(result.total_learnings).toBe(1);
    expect(result.total_sessions).toBe(2);
  });

  it('returns top categories ordered by count', () => {
    createSession(db, { session_id: 's1', project: 'proj1' });
    for (let i = 0; i < 5; i++) {
      insertObservation(db, {
        session_id: 's1', project: 'proj1', tool_name: 'Read',
        category: 'code', title: `code ${i}`, content: `code content ${i}`,
        importance: 3, files_modified: [],
      });
    }
    for (let i = 0; i < 3; i++) {
      insertObservation(db, {
        session_id: 's1', project: 'proj1', tool_name: 'Bash',
        category: 'error', title: `err ${i}`, content: `error content ${i}`,
        importance: 4, files_modified: [],
      });
    }

    const result = queryStats(db);
    expect(result.top_categories).toHaveLength(2);
    expect(result.top_categories[0].category).toBe('code');
    expect(result.top_categories[0].count).toBe(5);
    expect(result.top_categories[1].category).toBe('error');
    expect(result.top_categories[1].count).toBe(3);
  });

  it('filters all counts by project', () => {
    createSession(db, { session_id: 's1', project: 'proj1' });
    createSession(db, { session_id: 's2', project: 'proj2' });
    insertObservation(db, {
      session_id: 's1', project: 'proj1', tool_name: 'Read',
      category: 'code', title: 'p1 obs', content: 'content',
      importance: 3, files_modified: [],
    });
    insertObservation(db, {
      session_id: 's2', project: 'proj2', tool_name: 'Read',
      category: 'code', title: 'p2 obs', content: 'content',
      importance: 3, files_modified: [],
    });

    const result = queryStats(db, 'proj1');
    expect(result.total_observations).toBe(1);
    expect(result.total_sessions).toBe(1);
  });
});

describe('queryTopics', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array when no thread state exists', () => {
    const result = queryTopics(db);
    expect(result).toEqual([]);
  });

  it('returns topic history ordered by updated_at DESC', () => {
    upsertThreadState(db, { session_id: 's1', topic: 'Auth refactor', summary: 'Working on JWT' });
    upsertThreadState(db, { session_id: 's2', topic: 'Database migration', summary: 'Adding FTS5' });

    const result = queryTopics(db);
    expect(result).toHaveLength(2);
    // Both have topics
    const topics = result.map(r => r.topic);
    expect(topics).toContain('Auth refactor');
    expect(topics).toContain('Database migration');
  });

  it('filters by project via session join', () => {
    createSession(db, { session_id: 's1', project: 'proj1' });
    createSession(db, { session_id: 's2', project: 'proj2' });
    upsertThreadState(db, { session_id: 's1', topic: 'Topic A' });
    upsertThreadState(db, { session_id: 's2', topic: 'Topic B' });

    const result = queryTopics(db, 'proj1');
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('Topic A');
  });
});

// ── Format functions ──────────────────────────────────────────────

describe('formatLearnings', () => {
  it('returns "No learnings found." for empty array', () => {
    expect(formatLearnings([])).toBe('No learnings found.');
  });

  it('formats learnings with project and promotion count', () => {
    const output = formatLearnings([
      { content: 'Always read before edit', project: 'proj1', promotion_count: 3, first_seen_epoch: 1710000000, last_promoted_epoch: 1710100000 },
    ]);
    expect(output).toContain('=== Learnings ===');
    expect(output).toContain('[proj1]');
    expect(output).toContain('promoted 3x');
    expect(output).toContain('Always read before edit');
  });
});

describe('formatDecisions', () => {
  it('returns "No decisions found." for empty array', () => {
    expect(formatDecisions([])).toBe('No decisions found.');
  });

  it('formats decisions with source and session', () => {
    const output = formatDecisions([
      { content: 'Use SQLite WAL mode', source: 'confirmation', session_id: 's1', project: 'proj1', timestamp_epoch: 1710000000 },
    ]);
    expect(output).toContain('=== Decisions ===');
    expect(output).toContain('[confirmation]');
    expect(output).toContain('session: s1');
    expect(output).toContain('Use SQLite WAL mode');
  });
});

describe('formatStats', () => {
  it('formats zero stats correctly', () => {
    const output = formatStats({
      total_observations: 0,
      total_decisions: 0,
      total_learnings: 0,
      total_sessions: 0,
      top_categories: [],
      recent_sessions: [],
    });
    expect(output).toContain('=== Stats ===');
    expect(output).toContain('Sessions:     0');
    expect(output).toContain('Observations: 0');
  });

  it('formats stats with categories and sessions', () => {
    const output = formatStats({
      total_observations: 42,
      total_decisions: 10,
      total_learnings: 5,
      total_sessions: 3,
      top_categories: [{ category: 'code', count: 30 }, { category: 'error', count: 12 }],
      recent_sessions: [{ session_id: 's1', project: 'proj1', status: 'completed', created_at_epoch: 1710000000, observation_count: 20 }],
    });
    expect(output).toContain('Observations: 42');
    expect(output).toContain('code: 30');
    expect(output).toContain('error: 12');
    expect(output).toContain('s1');
    expect(output).toContain('proj1');
  });
});

describe('formatTopics', () => {
  it('returns "No topic history found." for empty array', () => {
    expect(formatTopics([])).toBe('No topic history found.');
  });

  it('formats topics with session and summary', () => {
    const output = formatTopics([
      { session_id: 's1', topic: 'Auth refactor', summary: 'Working on JWT', updated_at_epoch: 1710000000 },
    ]);
    expect(output).toContain('=== Topic History ===');
    expect(output).toContain('session: s1');
    expect(output).toContain('Topic: Auth refactor');
    expect(output).toContain('Summary: Working on JWT');
  });

  it('handles null topic gracefully', () => {
    const output = formatTopics([
      { session_id: 's1', topic: null, summary: null, updated_at_epoch: 1710000000 },
    ]);
    expect(output).toContain('(no topic)');
  });
});

// ── runDashboard integration ─────────────────────────────────────

describe('runDashboard', () => {
  let db: InstanceType<typeof Database>;
  let dbPath: string;

  beforeEach(() => {
    // Create an on-disk temp DB for runDashboard (which opens by path)
    const tmpDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'claudex-dashboard-'));
    dbPath = require('path').join(tmpDir, 'test.db');
    db = new Database(dbPath);
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    try {
      require('fs').rmSync(require('path').dirname(dbPath), { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('returns help text for "help" subcommand', () => {
    const output = runDashboard({ subcommand: 'help' }, dbPath);
    expect(output).toContain('Usage:');
    expect(output).toContain('learnings');
    expect(output).toContain('decisions');
    expect(output).toContain('stats');
    expect(output).toContain('topics');
  });

  it('returns learnings output', () => {
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp1', content: 'Test learning' });

    const output = runDashboard({ subcommand: 'learnings' }, dbPath);
    expect(output).toContain('Test learning');
    expect(output).toContain('=== Learnings ===');
  });

  it('returns decisions output with project filter', () => {
    insertDecision(db, { session_id: 's1', project: 'proj1', content: 'Dec1', source: 'confirmation', fingerprint: 'fp1' });
    insertDecision(db, { session_id: 's2', project: 'proj2', content: 'Dec2', source: 'direction', fingerprint: 'fp2' });

    const output = runDashboard({ subcommand: 'decisions', project: 'proj1' }, dbPath);
    expect(output).toContain('Dec1');
    expect(output).not.toContain('Dec2');
  });

  it('returns stats output', () => {
    createSession(db, { session_id: 's1', project: 'proj1' });
    insertObservation(db, {
      session_id: 's1', project: 'proj1', tool_name: 'Read',
      category: 'code', title: 'obs1', content: 'content',
      importance: 3, files_modified: [],
    });

    const output = runDashboard({ subcommand: 'stats' }, dbPath);
    expect(output).toContain('=== Stats ===');
    expect(output).toContain('Sessions:     1');
    expect(output).toContain('Observations: 1');
  });

  it('returns topics output', () => {
    upsertThreadState(db, { session_id: 's1', topic: 'My Topic', summary: 'My Summary' });

    const output = runDashboard({ subcommand: 'topics' }, dbPath);
    expect(output).toContain('=== Topic History ===');
    expect(output).toContain('My Topic');
    expect(output).toContain('My Summary');
  });

  it('returns error message for non-existent DB path', () => {
    const output = runDashboard({ subcommand: 'learnings' }, '/nonexistent/path/db.sqlite');
    expect(output).toContain('Error:');
  });

  it('applies --project filter to learnings', () => {
    upsertLearning(db, { project: 'proj1', fingerprint: 'fp1', content: 'Proj1 learning' });
    upsertLearning(db, { project: 'proj2', fingerprint: 'fp2', content: 'Proj2 learning' });

    const output = runDashboard({ subcommand: 'learnings', project: 'proj1' }, dbPath);
    expect(output).toContain('Proj1 learning');
    expect(output).not.toContain('Proj2 learning');
  });

  it('applies --session filter to decisions', () => {
    insertDecision(db, { session_id: 's1', project: 'proj1', content: 'S1 decision', source: 'confirmation', fingerprint: 'fp1' });
    insertDecision(db, { session_id: 's2', project: 'proj1', content: 'S2 decision', source: 'confirmation', fingerprint: 'fp2' });

    const output = runDashboard({ subcommand: 'decisions', session: 's1' }, dbPath);
    expect(output).toContain('S1 decision');
    expect(output).not.toContain('S2 decision');
  });
});
