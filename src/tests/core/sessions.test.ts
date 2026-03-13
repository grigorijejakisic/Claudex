import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  createSession,
  getSession,
  endSession,
  getActiveSession,
  incrementObservationCount,
} from '../../core/sessions.js';
import {
  insertDecision,
  getDecisionsBySession,
  getDecisionsByProject,
  resetSessionDecisions,
} from '../../core/decisions.js';
import {
  upsertLearning,
  getLearningsByProject,
  getTopLearnings,
} from '../../core/learnings.js';

describe('sessions CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('createSession inserts session', () => {
    createSession(db, {
      session_id: 's1',
      scope: 'project',
      project: 'myapp',
      cwd: '/home/user/myapp',
      source: 'cli',
    });

    const row = db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get('s1') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.session_id).toBe('s1');
    expect(row.scope).toBe('project');
    expect(row.project).toBe('myapp');
    expect(row.status).toBe('active');
    expect(row.observation_count).toBe(0);
  });

  it('getSession returns session by id', () => {
    createSession(db, { session_id: 's2', project: 'proj' });
    const session = getSession(db, 's2');
    expect(session).toBeDefined();
    expect(session!.session_id).toBe('s2');
    expect(session!.status).toBe('active');
  });

  it('endSession updates status and ended_at_epoch', () => {
    createSession(db, { session_id: 's3' });
    endSession(db, 's3', 'completed');
    const session = getSession(db, 's3');
    expect(session!.status).toBe('completed');
    expect(session!.ended_at_epoch).not.toBeNull();
  });

  it('getActiveSession returns most recent active session', () => {
    createSession(db, { session_id: 's4' });
    createSession(db, { session_id: 's5' });
    endSession(db, 's4', 'completed');

    const active = getActiveSession(db);
    expect(active).toBeDefined();
    expect(active!.session_id).toBe('s5');
  });

  it('getActiveSession filters by project', () => {
    createSession(db, { session_id: 's6', project: 'alpha' });
    createSession(db, { session_id: 's7', project: 'beta' });

    const active = getActiveSession(db, 'alpha');
    expect(active).toBeDefined();
    expect(active!.session_id).toBe('s6');
    expect(active!.project).toBe('alpha');
  });

  it('incrementObservationCount increases count', () => {
    createSession(db, { session_id: 's8' });
    incrementObservationCount(db, 's8');
    incrementObservationCount(db, 's8');

    const session = getSession(db, 's8');
    expect(session!.observation_count).toBe(2);
  });
});

describe('decisions CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: 's1', project: 'myproject' });
  });

  afterEach(() => {
    db.close();
  });

  it('insertDecision stores decision and returns id', () => {
    const id = insertDecision(db, {
      session_id: 's1',
      project: 'myproject',
      content: 'Use ESM modules',
      source: 'explicit',
      fingerprint: 'fp1',
    });
    expect(id).toBeGreaterThan(0);

    const rows = getDecisionsBySession(db, 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('Use ESM modules');
  });

  it('insertDecision returns null for duplicate fingerprint in same session', () => {
    insertDecision(db, {
      session_id: 's1',
      content: 'decision A',
      source: 'confirmation',
      fingerprint: 'dup-fp',
    });
    const secondId = insertDecision(db, {
      session_id: 's1',
      content: 'decision A again',
      source: 'confirmation',
      fingerprint: 'dup-fp',
    });
    expect(secondId).toBeNull();

    const rows = getDecisionsBySession(db, 's1');
    expect(rows).toHaveLength(1);
  });

  it('getDecisionsByProject returns decisions for project', () => {
    insertDecision(db, {
      session_id: 's1',
      project: 'myproject',
      content: 'decision 1',
      source: 'direction',
      fingerprint: 'fp-a',
    });
    insertDecision(db, {
      session_id: 's1',
      project: 'other',
      content: 'decision 2',
      source: 'direction',
      fingerprint: 'fp-b',
    });

    const rows = getDecisionsByProject(db, 'myproject');
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe('myproject');
  });

  it('getDecisionsBySession returns all decisions without hard limit', () => {
    // Insert more than the old LIMIT 50 to verify no hard cap
    for (let i = 0; i < 55; i++) {
      insertDecision(db, {
        session_id: 's1',
        project: 'myproject',
        content: `Decision ${i}`,
        source: 'explicit',
        fingerprint: `fp-mass-${i}`,
      });
    }

    const rows = getDecisionsBySession(db, 's1');
    expect(rows).toHaveLength(55);
  });

  it('getDecisionsBySession respects optional limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      insertDecision(db, {
        session_id: 's1',
        project: 'myproject',
        content: `Decision ${i}`,
        source: 'explicit',
        fingerprint: `fp-limit-${i}`,
      });
    }

    const limited = getDecisionsBySession(db, 's1', { limit: 3 });
    expect(limited).toHaveLength(3);

    const unlimited = getDecisionsBySession(db, 's1');
    expect(unlimited).toHaveLength(10);
  });

  it('resetSessionDecisions deletes all session decisions', () => {
    insertDecision(db, {
      session_id: 's1',
      content: 'to delete 1',
      source: 'explicit',
      fingerprint: 'fp-del-1',
    });
    insertDecision(db, {
      session_id: 's1',
      content: 'to delete 2',
      source: 'explicit',
      fingerprint: 'fp-del-2',
    });

    const count = resetSessionDecisions(db, 's1');
    expect(count).toBe(2);

    const rows = getDecisionsBySession(db, 's1');
    expect(rows).toHaveLength(0);
  });
});

describe('learnings CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('upsertLearning creates new learning', () => {
    upsertLearning(db, {
      fingerprint: 'learn-fp1',
      content: 'Always use strict mode',
    });

    const rows = getLearningsByProject(db, '__global__');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('Always use strict mode');
    expect(rows[0].promotion_count).toBe(1);
    expect(rows[0].project).toBe('__global__');
    expect(rows[0].agent_id).toBe('default');
  });

  it('upsertLearning increments promotion_count on duplicate fingerprint', () => {
    upsertLearning(db, {
      fingerprint: 'learn-fp2',
      content: 'Check null first',
    });
    upsertLearning(db, {
      fingerprint: 'learn-fp2',
      content: 'Check null first',
    });

    const rows = getLearningsByProject(db, '__global__');
    expect(rows).toHaveLength(1);
    expect(rows[0].promotion_count).toBe(2);
  });

  it('getLearningsByProject includes global learnings', () => {
    upsertLearning(db, {
      project: '__global__',
      fingerprint: 'global-fp',
      content: 'Global learning',
    });
    upsertLearning(db, {
      project: 'myapp',
      fingerprint: 'app-fp',
      content: 'App learning',
    });

    const rows = getLearningsByProject(db, 'myapp');
    expect(rows).toHaveLength(2);
    const projects = rows.map((r) => r.project);
    expect(projects).toContain('__global__');
    expect(projects).toContain('myapp');
  });

  it('getTopLearnings respects count limit', () => {
    for (let i = 0; i < 15; i++) {
      upsertLearning(db, {
        fingerprint: `fp-${i}`,
        content: `Learning ${i}`,
      });
    }

    const top5 = getTopLearnings(db, '__global__', 5);
    expect(top5).toHaveLength(5);

    const topDefault = getTopLearnings(db, '__global__');
    expect(topDefault).toHaveLength(10);
  });
});
