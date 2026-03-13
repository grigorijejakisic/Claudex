import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  insertObservation,
  getObservationsByProject,
  getObservationById,
  searchObservations,
  softDeleteObservation,
  incrementAccessCount,
} from '../../core/observations.js';

describe('observation CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('insertObservation stores observation and returns id', () => {
    const id = insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Found auth bug',
      content: 'The JWT validation skips expiry check',
      importance: 4,
      files_modified: ['src/auth.ts'],
    });

    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(id) as Record<string, unknown>;
    expect(row.title).toBe('Found auth bug');
    expect(row.content).toBe('The JWT validation skips expiry check');
    expect(row.importance).toBe(4);
  });

  it('insertObservation strips typed redaction markers from stored content', () => {
    const id = insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Has [REDACTED_SECRET] in title',
      content: 'key was [REDACTED_SECRET] and email [REDACTED_PII] and blob [REDACTED_ENTROPY]',
      importance: 3,
      files_modified: [],
    });

    const row = db
      .prepare('SELECT title, content FROM observations WHERE id = ?')
      .get(id) as { title: string; content: string };
    // Typed markers replaced with generic [REDACTED]
    expect(row.title).toBe('Has [REDACTED] in title');
    expect(row.content).toBe('key was [REDACTED] and email [REDACTED] and blob [REDACTED]');
    // "secret", "pii", "entropy" stems should NOT appear in stored content
    expect(row.content).not.toContain('SECRET');
    expect(row.content).not.toContain('PII');
    expect(row.content).not.toContain('ENTROPY');
  });

  it('FTS search does not match on redaction marker stems', () => {
    insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Normal file read',
      content: 'value was [REDACTED_SECRET] in the config',
      importance: 3,
      files_modified: [],
    });

    // Searching for "secret" should NOT return this observation
    // because [REDACTED_SECRET] is stored as [REDACTED]
    const results = searchObservations(db, 'secret', 'myapp');
    expect(results).toHaveLength(0);
  });

  it('insertObservation serializes files_modified as JSON', () => {
    const id = insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Edit',
      category: 'code',
      title: 'Updated files',
      content: 'Changed two files',
      importance: 3,
      files_modified: ['src/a.ts', 'src/b.ts'],
    });

    const row = db
      .prepare('SELECT files_modified FROM observations WHERE id = ?')
      .get(id) as { files_modified: string };
    expect(JSON.parse(row.files_modified)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('getObservationsByProject returns observations for specified project only', () => {
    insertObservation(db, {
      session_id: 's1',
      project: 'projectA',
      tool_name: 'Read',
      category: 'code',
      title: 'A observation',
      content: 'content A',
      importance: 3,
      files_modified: [],
    });
    insertObservation(db, {
      session_id: 's1',
      project: 'projectB',
      tool_name: 'Read',
      category: 'code',
      title: 'B observation',
      content: 'content B',
      importance: 3,
      files_modified: [],
    });

    const rows = getObservationsByProject(db, 'projectA');
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe('projectA');
    expect(rows[0].title).toBe('A observation');
  });

  it('getObservationsByProject excludes soft-deleted observations', () => {
    const id = insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Deleted obs',
      content: 'will be deleted',
      importance: 2,
      files_modified: [],
    });
    softDeleteObservation(db, id);

    const rows = getObservationsByProject(db, 'myapp');
    expect(rows).toHaveLength(0);
  });

  it('getObservationsByProject respects limit', () => {
    for (let i = 0; i < 5; i++) {
      insertObservation(db, {
        session_id: 's1',
        project: 'myapp',
        tool_name: 'Read',
        category: 'code',
        title: `Obs ${i}`,
        content: `Content ${i}`,
        importance: 3,
        files_modified: [],
      });
    }

    const rows = getObservationsByProject(db, 'myapp', { limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it('getObservationById returns single observation', () => {
    const id = insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Bash',
      category: 'architecture',
      title: 'Single obs',
      content: 'Detailed content here',
      importance: 5,
      files_modified: ['src/main.ts'],
    });

    const obs = getObservationById(db, id);
    expect(obs).toBeDefined();
    expect(obs!.id).toBe(id);
    expect(obs!.title).toBe('Single obs');
    expect(obs!.category).toBe('architecture');
  });

  it('searchObservations returns FTS5 matches ranked by relevance', () => {
    insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Authentication bug',
      content: 'JWT token validation is broken in the authentication module',
      importance: 4,
      files_modified: [],
    });
    insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Database schema',
      content: 'Added new migration for users table',
      importance: 3,
      files_modified: [],
    });

    const results = searchObservations(db, 'authentication', 'myapp');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe('Authentication bug');
  });

  it('searchObservations applies temporal re-ranking (recent results boosted)', () => {
    // Insert an old observation with explicit old timestamp
    const oldId = insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Old authentication fix',
      content: 'Fixed authentication in login module',
      importance: 3,
      files_modified: [],
    });
    // Set it 60 days old
    const sixtyDaysAgo = Math.floor(Date.now() / 1000) - 60 * 86400;
    db.prepare('UPDATE observations SET timestamp_epoch = ? WHERE id = ?').run(
      sixtyDaysAgo,
      oldId
    );

    // Insert a recent observation
    insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Recent authentication update',
      content: 'Updated authentication flow for OAuth',
      importance: 3,
      files_modified: [],
    });

    const results = searchObservations(db, 'authentication', 'myapp');
    expect(results.length).toBe(2);
    // Recent observation should be ranked first due to temporal boost
    expect(results[0].title).toBe('Recent authentication update');
  });

  it('searchObservations filters by project scope', () => {
    insertObservation(db, {
      session_id: 's1',
      project: 'projectA',
      tool_name: 'Read',
      category: 'code',
      title: 'Auth for A',
      content: 'Authentication setup for project A',
      importance: 3,
      files_modified: [],
    });
    insertObservation(db, {
      session_id: 's1',
      project: 'projectB',
      tool_name: 'Read',
      category: 'code',
      title: 'Auth for B',
      content: 'Authentication setup for project B',
      importance: 3,
      files_modified: [],
    });

    const results = searchObservations(db, 'authentication', 'projectA');
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe('projectA');
  });

  it('softDeleteObservation sets deleted_at_epoch', () => {
    const id = insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'To delete',
      content: 'Will be soft-deleted',
      importance: 2,
      files_modified: [],
    });

    softDeleteObservation(db, id);

    const row = db
      .prepare('SELECT deleted_at_epoch FROM observations WHERE id = ?')
      .get(id) as { deleted_at_epoch: number | null };
    expect(row.deleted_at_epoch).not.toBeNull();
    expect(row.deleted_at_epoch).toBeGreaterThan(0);
  });

  it('incrementAccessCount increases count and updates last_accessed_at_epoch', () => {
    const id = insertObservation(db, {
      session_id: 's1',
      project: 'myapp',
      tool_name: 'Read',
      category: 'code',
      title: 'Accessed obs',
      content: 'Track access',
      importance: 3,
      files_modified: [],
    });

    // Initially access_count should be 0
    let row = db
      .prepare(
        'SELECT access_count, last_accessed_at_epoch FROM observations WHERE id = ?'
      )
      .get(id) as { access_count: number; last_accessed_at_epoch: number | null };
    expect(row.access_count).toBe(0);
    expect(row.last_accessed_at_epoch).toBeNull();

    incrementAccessCount(db, id);

    row = db
      .prepare(
        'SELECT access_count, last_accessed_at_epoch FROM observations WHERE id = ?'
      )
      .get(id) as { access_count: number; last_accessed_at_epoch: number | null };
    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at_epoch).not.toBeNull();
    expect(row.last_accessed_at_epoch).toBeGreaterThan(0);
  });
});
