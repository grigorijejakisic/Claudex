import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  getSessionContext,
  renderSessionContextSummary,
  getLatestSession,
  type SessionContext,
} from '../../core/session-query.js';
import { createSession } from '../../core/sessions.js';
import { upsertThreadState } from '../../core/thread.js';
import { insertDecision } from '../../core/decisions.js';
import { upsertLearning } from '../../core/learnings.js';

describe('session-query', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getSessionContext', () => {
    it('returns safe defaults with empty DB', () => {
      const ctx = getSessionContext(db, 'test-project');
      expect(ctx.project).toBe('test-project');
      expect(ctx.scope).toBeNull();
      expect(ctx.threadTopic).toBeNull();
      expect(ctx.threadSummary).toBeNull();
      expect(ctx.lastSummary).toBeNull();
      expect(ctx.recentDecisions).toEqual([]);
      expect(ctx.topLearnings).toEqual([]);
    });

    it('returns safe defaults with session ID but no data', () => {
      createSession(db, {
        session_id: 's1',
        project: 'test-project',
        cwd: '/test',
        source: 'test',
      });

      const ctx = getSessionContext(db, 'test-project', 's1');
      expect(ctx.project).toBe('test-project');
      expect(ctx.threadTopic).toBeNull();
      expect(ctx.recentDecisions).toEqual([]);
      expect(ctx.topLearnings).toEqual([]);
    });

    it('returns thread state when available', () => {
      createSession(db, {
        session_id: 's1',
        project: 'myproj',
        cwd: '/test',
        scope: 'repo-scope',
      });
      upsertThreadState(db, {
        session_id: 's1',
        topic: 'refactoring auth module',
        summary: 'Working on JWT token refresh logic',
      });

      const ctx = getSessionContext(db, 'myproj', 's1');
      expect(ctx.threadTopic).toBe('refactoring auth module');
      expect(ctx.threadSummary).toBe('Working on JWT token refresh logic');
      expect(ctx.scope).toBe('repo-scope');
    });

    it('returns recent decisions scoped to session', () => {
      createSession(db, {
        session_id: 's1',
        project: 'myproj',
        cwd: '/test',
      });
      insertDecision(db, {
        session_id: 's1',
        project: 'myproj',
        content: 'Use SQLite for storage',
        source: 'explicit',
        fingerprint: 'fp1',
      });
      insertDecision(db, {
        session_id: 's1',
        project: 'myproj',
        content: 'Avoid ORM overhead',
        source: 'direction',
        fingerprint: 'fp2',
      });

      const ctx = getSessionContext(db, 'myproj', 's1');
      expect(ctx.recentDecisions).toHaveLength(2);
      expect(ctx.recentDecisions[0].content).toBeDefined();
      expect(ctx.recentDecisions[0].source).toBeDefined();
      expect(ctx.recentDecisions[0].timestamp_epoch).toBeGreaterThan(0);
    });

    it('respects decisionLimit option', () => {
      createSession(db, {
        session_id: 's1',
        project: 'myproj',
        cwd: '/test',
      });
      for (let i = 0; i < 10; i++) {
        insertDecision(db, {
          session_id: 's1',
          project: 'myproj',
          content: `Decision ${i}`,
          source: 'explicit',
          fingerprint: `fp${i}`,
        });
      }

      const ctx = getSessionContext(db, 'myproj', 's1', { decisionLimit: 3 });
      expect(ctx.recentDecisions).toHaveLength(3);
    });

    it('returns top learnings', () => {
      upsertLearning(db, {
        project: 'myproj',
        fingerprint: 'learn1',
        content: 'Always use parameterized queries',
      });
      // Promote it to increase count
      upsertLearning(db, {
        project: 'myproj',
        fingerprint: 'learn1',
        content: 'Always use parameterized queries',
      });
      upsertLearning(db, {
        project: 'myproj',
        fingerprint: 'learn2',
        content: 'Test edge cases',
      });

      const ctx = getSessionContext(db, 'myproj');
      expect(ctx.topLearnings).toHaveLength(2);
      // First should be learn1 (promotion_count=2)
      expect(ctx.topLearnings[0].content).toBe('Always use parameterized queries');
      expect(ctx.topLearnings[0].use_count).toBe(2);
    });

    it('respects learningLimit option', () => {
      for (let i = 0; i < 15; i++) {
        upsertLearning(db, {
          project: 'myproj',
          fingerprint: `learn${i}`,
          content: `Learning ${i}`,
        });
      }

      const ctx = getSessionContext(db, 'myproj', undefined, { learningLimit: 5 });
      expect(ctx.topLearnings).toHaveLength(5);
    });

    it('returns last session summary from prior session', () => {
      // Create a prior session with thread state
      createSession(db, {
        session_id: 'prior-session',
        project: 'myproj',
        cwd: '/test',
      });
      upsertThreadState(db, {
        session_id: 'prior-session',
        summary: 'Completed auth refactor, JWT refresh working',
      });

      const ctx = getSessionContext(db, 'myproj');
      expect(ctx.lastSummary).toBe('Completed auth refactor, JWT refresh working');
    });

    it('falls back to project-scoped decisions when no sessionId', () => {
      createSession(db, {
        session_id: 's1',
        project: 'myproj',
        cwd: '/test',
      });
      insertDecision(db, {
        session_id: 's1',
        project: 'myproj',
        content: 'Project-level decision',
        source: 'explicit',
        fingerprint: 'fp1',
      });

      const ctx = getSessionContext(db, 'myproj'); // no sessionId
      expect(ctx.recentDecisions).toHaveLength(1);
      expect(ctx.recentDecisions[0].content).toBe('Project-level decision');
    });
  });

  describe('renderSessionContextSummary', () => {
    it('renders empty context with safe defaults', () => {
      const ctx: SessionContext = {
        project: 'test',
        scope: null,
        threadTopic: null,
        threadSummary: null,
        lastSummary: null,
        recentDecisions: [],
        topLearnings: [],
      };

      const rendered = renderSessionContextSummary(ctx);
      expect(rendered).toContain('## Session Context (from DB)');
      expect(rendered).toContain('no prior sessions');
      expect(rendered).not.toContain('**Key decisions**');
      expect(rendered).not.toContain('**Active learnings**');
    });

    it('renders full context with all fields populated', () => {
      const ctx: SessionContext = {
        project: 'myproj',
        scope: '/repos/myproj',
        threadTopic: 'refactoring auth',
        threadSummary: 'JWT refresh logic',
        lastSummary: 'Completed initial auth setup',
        recentDecisions: [
          { content: 'Use SQLite', source: 'explicit', timestamp_epoch: 1000 },
          { content: 'Avoid ORM', source: 'direction', timestamp_epoch: 999 },
        ],
        topLearnings: [
          { content: 'Parameterized queries', use_count: 5 },
          { content: 'Test edge cases', use_count: 3 },
        ],
      };

      const rendered = renderSessionContextSummary(ctx);
      expect(rendered).toContain('## Session Context (from DB)');
      expect(rendered).toContain('**Topic**: refactoring auth');
      expect(rendered).toContain('**Last session**: Completed initial auth setup');
      expect(rendered).toContain('**Thread**: JWT refresh logic');
      expect(rendered).toContain('**Key decisions** (last 2):');
      expect(rendered).toContain('- [explicit] Use SQLite');
      expect(rendered).toContain('- [direction] Avoid ORM');
      expect(rendered).toContain('**Active learnings**: 2 learnings loaded');
    });

    it('truncates long strings', () => {
      const longSummary = 'A'.repeat(200);
      const ctx: SessionContext = {
        project: 'test',
        scope: null,
        threadTopic: null,
        threadSummary: null,
        lastSummary: longSummary,
        recentDecisions: [],
        topLearnings: [],
      };

      const rendered = renderSessionContextSummary(ctx);
      expect(rendered).toContain('...');
      // Truncated to 120 chars
      expect(rendered.length).toBeLessThan(longSummary.length);
    });

    it('keeps rendered output under 500 tokens', () => {
      // Populate with maximum realistic data
      const ctx: SessionContext = {
        project: 'large-project',
        scope: '/repos/large-project',
        threadTopic: 'Complex refactoring of authentication and authorization subsystem',
        threadSummary: 'Working on replacing the legacy auth middleware with a new JWT-based system that supports refresh tokens and role-based access control',
        lastSummary: 'Previous session completed the initial scaffolding of the auth module, set up database tables for users and roles, and wrote integration tests for the login flow',
        recentDecisions: Array.from({ length: 5 }, (_, i) => ({
          content: `Important decision number ${i + 1} about the architecture that has some detail`,
          source: 'explicit' as const,
          timestamp_epoch: 1000 - i,
        })),
        topLearnings: Array.from({ length: 10 }, (_, i) => ({
          content: `Learning about best practice ${i + 1}`,
          use_count: 10 - i,
        })),
      };

      const rendered = renderSessionContextSummary(ctx);
      // Rough token estimate: ~4 chars per token for English text
      const estimatedTokens = Math.ceil(rendered.length / 4);
      expect(estimatedTokens).toBeLessThan(500);
    });
  });

  describe('getLatestSession', () => {
    it('returns null when no sessions exist', () => {
      const result = getLatestSession(db, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns the most recent session with summary', () => {
      // Insert with explicit timestamps to ensure ordering (unixepoch() has second precision)
      db.prepare(
        `INSERT INTO sessions (session_id, project, cwd, created_at_epoch) VALUES (?, ?, ?, ?)`,
      ).run('old-session', 'myproj', '/test', 1000);
      upsertThreadState(db, {
        session_id: 'old-session',
        summary: 'Old summary',
      });

      db.prepare(
        `INSERT INTO sessions (session_id, project, cwd, created_at_epoch) VALUES (?, ?, ?, ?)`,
      ).run('new-session', 'myproj', '/test', 2000);
      upsertThreadState(db, {
        session_id: 'new-session',
        summary: 'New summary',
      });

      const result = getLatestSession(db, 'myproj');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('new-session');
      expect(result!.summary).toBe('New summary');
      expect(result!.createdAt).toBe(2000);
    });

    it('returns session without summary (null summary)', () => {
      createSession(db, {
        session_id: 's1',
        project: 'myproj',
        cwd: '/test',
      });
      // No thread state — no summary

      const result = getLatestSession(db, 'myproj');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('s1');
      expect(result!.summary).toBeNull();
    });

    it('does not return sessions from other projects', () => {
      createSession(db, {
        session_id: 's-other',
        project: 'other-project',
        cwd: '/other',
      });
      upsertThreadState(db, {
        session_id: 's-other',
        summary: 'Other project summary',
      });

      const result = getLatestSession(db, 'myproj');
      expect(result).toBeNull();
    });
  });
});
