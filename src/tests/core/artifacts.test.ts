import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  createArtifact,
  getArtifactsByProject,
  getPackedArtifacts,
  getMaterializedArtifacts,
  materializeArtifacts,
  tickArtifactTTL,
  packAllArtifacts,
  searchArtifacts,
  searchArtifactsGlobal,
} from '../../core/artifacts.js';
import {
  formatReferenceLayer,
  formatMaterializationLayer,
} from '../../assembly/sections.js';
import type { ArtifactRow } from '../../core/artifacts.js';

describe('artifact CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('createArtifact inserts and returns id', () => {
    const id = createArtifact(
      db, 'sess-1', 'myproject', 'observation', 'obs-42',
      'API endpoint analysis', 'GET /api/threads returns ThreadState with artifacts array',
      4,
    );

    expect(id).toBeGreaterThan(0);
  });

  it('createArtifact sets defaults correctly', () => {
    const id = createArtifact(
      db, 'sess-1', 'myproject', 'learning', null,
      'Windows paths need normalization', 'Use forward slashes everywhere',
      5,
    );

    const rows = getArtifactsByProject(db, 'myproject');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].state).toBe('fresh');
    expect(rows[0].ttl).toBe(8); // importance 5 → TTL 8
    expect(rows[0].importance).toBe(5);
    expect(rows[0].artifact_ref).toBeNull();
    expect(rows[0].last_materialized_epoch).toBeNull();
  });

  it('getArtifactsByProject returns all artifacts for project', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', 'obs-1', 'First', 'content1', 3);
    createArtifact(db, 'sess-1', 'myproject', 'decision', 'dec-1', 'Second', 'content2', 4);
    createArtifact(db, 'sess-1', 'other-project', 'learning', null, 'Third', 'content3', 2);

    const rows = getArtifactsByProject(db, 'myproject');
    expect(rows).toHaveLength(2);
  });

  it('getArtifactsByProject filters by state', () => {
    const id1 = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Fresh one', 'c1', 3);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'Also fresh', 'c2', 4);

    // Pack the first one
    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?").run(id1);

    const packed = getArtifactsByProject(db, 'myproject', { state: 'packed' });
    expect(packed).toHaveLength(1);
    expect(packed[0].summary).toBe('Fresh one');

    const fresh = getArtifactsByProject(db, 'myproject', { state: 'fresh' });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].summary).toBe('Also fresh');
  });

  it('getArtifactsByProject filters by type', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Obs', 'c1', 3);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'Dec', 'c2', 4);
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Obs2', 'c3', 2);

    const obs = getArtifactsByProject(db, 'myproject', { type: 'observation' });
    expect(obs).toHaveLength(2);
  });

  it('getArtifactsByProject filters by state and type combined', () => {
    const id1 = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Obs packed', 'c1', 3);
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Obs fresh', 'c2', 4);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'Dec fresh', 'c3', 2);

    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?").run(id1);

    const packedObs = getArtifactsByProject(db, 'myproject', { state: 'packed', type: 'observation' });
    expect(packedObs).toHaveLength(1);
    expect(packedObs[0].summary).toBe('Obs packed');
  });

  it('getArtifactsByProject respects limit', () => {
    for (let i = 0; i < 5; i++) {
      createArtifact(db, 'sess-1', 'myproject', 'observation', null, `Obs ${i}`, `content ${i}`, 3);
    }

    const limited = getArtifactsByProject(db, 'myproject', { limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('getArtifactsByProject orders by importance DESC', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Low', 'c1', 1);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'High', 'c2', 5);
    createArtifact(db, 'sess-1', 'myproject', 'learning', null, 'Mid', 'c3', 3);

    const rows = getArtifactsByProject(db, 'myproject');
    expect(rows[0].summary).toBe('High');
    expect(rows[1].summary).toBe('Mid');
    expect(rows[2].summary).toBe('Low');
  });
});

describe('artifact TTL lifecycle', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('tickArtifactTTL decrements TTL', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Test', 'content', 3);

    tickArtifactTTL(db, 'myproject');

    const rows = getArtifactsByProject(db, 'myproject');
    expect(rows[0].ttl).toBe(3); // importance 3 → TTL 4, after 1 tick → 3
    expect(rows[0].state).toBe('fresh');
  });

  it('tickArtifactTTL packs at TTL 0', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Test', 'content', 3);

    // importance 3 → TTL 4. Tick 4 times to reach 0
    tickArtifactTTL(db, 'myproject');
    tickArtifactTTL(db, 'myproject');
    tickArtifactTTL(db, 'myproject');
    const result = tickArtifactTTL(db, 'myproject');

    expect(result.packed).toBe(1);

    const rows = getArtifactsByProject(db, 'myproject');
    expect(rows[0].state).toBe('packed');
    expect(rows[0].ttl).toBe(0);
  });

  it('tickArtifactTTL does not affect already packed artifacts', () => {
    const id = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Test', 'content', 3);
    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?").run(id);

    const result = tickArtifactTTL(db, 'myproject');

    expect(result.packed).toBe(0);
    expect(result.total).toBe(0);

    const rows = getArtifactsByProject(db, 'myproject');
    expect(rows[0].state).toBe('packed');
  });

  it('tickArtifactTTL is project-scoped', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null, 'A', 'ca', 3);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null, 'B', 'cb', 3);

    tickArtifactTTL(db, 'project-a');

    const a = getArtifactsByProject(db, 'project-a');
    const b = getArtifactsByProject(db, 'project-b');
    expect(a[0].ttl).toBe(3); // importance 3 → TTL 4, after 1 tick → 3
    expect(b[0].ttl).toBe(4); // untouched (importance 3 → TTL 4)
  });
});

describe('artifact materialization', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('materializeArtifacts changes state and sets TTL', () => {
    const id = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Test', 'full content', 3);
    // Pack it first
    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?").run(id);

    materializeArtifacts(db, [id]);

    const rows = getArtifactsByProject(db, 'myproject');
    expect(rows[0].state).toBe('materialized');
    expect(rows[0].ttl).toBe(2);
    expect(rows[0].last_materialized_epoch).not.toBeNull();
  });

  it('materializeArtifacts handles empty array', () => {
    // Should not throw
    materializeArtifacts(db, []);
  });

  it('materializeArtifacts handles multiple IDs', () => {
    const id1 = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'First', 'c1', 3);
    const id2 = createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'Second', 'c2', 4);

    // Pack both
    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE project = ?").run('myproject');

    materializeArtifacts(db, [id1, id2]);

    const rows = getArtifactsByProject(db, 'myproject');
    expect(rows.every((r) => r.state === 'materialized')).toBe(true);
    expect(rows.every((r) => r.ttl === 2)).toBe(true);
  });

  it('getMaterializedArtifacts returns fresh and materialized artifacts', () => {
    const id1 = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Fresh one', 'c1', 3);
    const id2 = createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'To materialize', 'c2', 4);
    createArtifact(db, 'sess-1', 'myproject', 'learning', null, 'To pack', 'c3', 2);

    // Pack the third, materialize the second
    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE importance = 2").run();
    materializeArtifacts(db, [id2]);

    const visible = getMaterializedArtifacts(db, 'myproject');
    expect(visible).toHaveLength(2);
    const states = visible.map((r) => r.state);
    expect(states).toContain('fresh');
    expect(states).toContain('materialized');
  });

  it('getPackedArtifacts returns only packed artifacts', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Fresh', 'c1', 3);
    const id2 = createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'Packed', 'c2', 4);

    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?").run(id2);

    const packed = getPackedArtifacts(db, 'myproject');
    expect(packed).toHaveLength(1);
    expect(packed[0].summary).toBe('Packed');
  });
});

describe('packAllArtifacts (compaction)', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('packAllArtifacts packs all non-packed artifacts', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'A', 'c1', 3);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'B', 'c2', 4);

    const count = packAllArtifacts(db, 'myproject');
    expect(count).toBe(2);

    const all = getArtifactsByProject(db, 'myproject');
    expect(all.every((r) => r.state === 'packed')).toBe(true);
    expect(all.every((r) => r.ttl === 0)).toBe(true);
  });

  it('packAllArtifacts skips already-packed artifacts', () => {
    const id1 = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'A', 'c1', 3);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'B', 'c2', 4);

    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?").run(id1);

    const count = packAllArtifacts(db, 'myproject');
    expect(count).toBe(1); // Only the decision
  });

  it('packAllArtifacts is project-scoped', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null, 'A', 'ca', 3);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null, 'B', 'cb', 3);

    packAllArtifacts(db, 'project-a');

    const a = getArtifactsByProject(db, 'project-a');
    const b = getArtifactsByProject(db, 'project-b');
    expect(a[0].state).toBe('packed');
    expect(b[0].state).toBe('fresh');
  });
});

describe('searchArtifacts', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('finds artifacts by summary text', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'API endpoint analysis', 'some content', 4);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'Database schema choice', 'other content', 3);

    const results = searchArtifacts(db, 'myproject', 'endpoint');
    expect(results).toHaveLength(1);
    expect(results[0].summary).toBe('API endpoint analysis');
  });

  it('finds artifacts by keyword in summary', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'JWT authentication analysis', 'Uses JWT for auth', 4);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null, 'Password storage choice', 'Plain password storage', 3);

    const results = searchArtifacts(db, 'myproject', 'authentication analysis');
    expect(results).toHaveLength(1);
    expect(results[0].summary).toContain('JWT');
  });

  it('respects project scope', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null, 'JWT analysis', 'JWT content', 4);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null, 'JWT analysis', 'JWT content', 4);

    const results = searchArtifacts(db, 'project-a', 'JWT');
    expect(results).toHaveLength(1);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      createArtifact(db, 'sess-1', 'myproject', 'observation', null, `Database migration step ${i}`, `migration content ${i}`, 3);
    }

    const results = searchArtifacts(db, 'myproject', 'database migration', 2);
    expect(results).toHaveLength(2);
  });

  it('returns empty array for no matches', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Something', 'content', 3);

    const results = searchArtifacts(db, 'myproject', 'nonexistent-query-xyz');
    expect(results).toHaveLength(0);
  });
});

describe('project isolation', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('all queries are project-scoped', () => {
    createArtifact(db, 'sess-1', 'alpha', 'observation', null, 'Alpha obs', 'alpha content', 4);
    createArtifact(db, 'sess-1', 'beta', 'observation', null, 'Beta obs', 'beta content', 3);
    createArtifact(db, 'sess-1', 'alpha', 'decision', null, 'Alpha dec', 'alpha decision', 5);

    expect(getArtifactsByProject(db, 'alpha')).toHaveLength(2);
    expect(getArtifactsByProject(db, 'beta')).toHaveLength(1);
    expect(getArtifactsByProject(db, 'gamma')).toHaveLength(0);

    expect(getPackedArtifacts(db, 'alpha')).toHaveLength(0);
    expect(getMaterializedArtifacts(db, 'alpha')).toHaveLength(2);
    expect(getMaterializedArtifacts(db, 'beta')).toHaveLength(1);

    packAllArtifacts(db, 'alpha');
    expect(getPackedArtifacts(db, 'alpha')).toHaveLength(2);
    expect(getPackedArtifacts(db, 'beta')).toHaveLength(0);

    expect(searchArtifacts(db, 'alpha', 'obs')).toHaveLength(1);
    expect(searchArtifacts(db, 'beta', 'obs')).toHaveLength(1);
  });
});

describe('searchArtifactsGlobal', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('finds artifacts across all projects', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null, 'SSH config analysis', 'SSH content', 4);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null, 'SSH server setup', 'SSH server content', 4);

    const results = searchArtifactsGlobal(db, 'project-a', 'SSH config server');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('prioritizes current project in results', () => {
    createArtifact(db, 'sess-1', 'project-a', 'decision', null, 'Deployment strategy', 'Deploy to prod', 5);
    createArtifact(db, 'sess-1', 'project-b', 'decision', null, 'Deployment strategy', 'Deploy to staging', 5);

    const results = searchArtifactsGlobal(db, 'project-a', 'deployment strategy');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Current project should come first
    expect(results[0].project).toBe('project-a');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 15; i++) {
      createArtifact(db, 'sess-1', `proj-${i}`, 'decision', null, `Auth decision ${i}`, `Auth content ${i}`, 4);
    }

    const results = searchArtifactsGlobal(db, 'proj-0', 'auth decision', 5);
    expect(results).toHaveLength(5);
  });
});

describe('getMaterializedArtifacts globalScope', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns artifacts from all projects when globalScope=true', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null, 'A obs', 'content a', 4);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null, 'B obs', 'content b', 4);

    const scoped = getMaterializedArtifacts(db, 'project-a');
    expect(scoped).toHaveLength(1);

    const global = getMaterializedArtifacts(db, 'project-a', true);
    expect(global).toHaveLength(2);
  });

  it('prioritizes current project in global results', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null, 'A obs', 'content a', 3);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null, 'B obs', 'content b', 5);

    const global = getMaterializedArtifacts(db, 'project-a', true);
    // project-a comes first despite lower importance (project priority)
    expect(global[0].project).toBe('project-a');
  });

  it('respects LIMIT cap', () => {
    for (let i = 0; i < 25; i++) {
      createArtifact(db, 'sess-1', `proj-${i}`, 'observation', null, `Obs ${i}`, `Content ${i}`, 4);
    }

    const global = getMaterializedArtifacts(db, 'proj-0', true);
    expect(global.length).toBeLessThanOrEqual(20);
  });
});

describe('materializeArtifacts with scopeProject', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('only materializes same-project artifacts when scopeProject set', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null, 'A obs', 'content a', 4);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null, 'B obs', 'content b', 4);

    // Pack all first
    packAllArtifacts(db, 'project-a');
    packAllArtifacts(db, 'project-b');

    const allArtifacts = [...getArtifactsByProject(db, 'project-a'), ...getArtifactsByProject(db, 'project-b')];
    const allIds = allArtifacts.map(a => a.id);

    // Materialize with scope — only project-a should change
    materializeArtifacts(db, allIds, 'project-a');

    const matA = getMaterializedArtifacts(db, 'project-a');
    const matB = getMaterializedArtifacts(db, 'project-b');
    expect(matA).toHaveLength(1);
    expect(matB).toHaveLength(0); // project-b was NOT materialized
  });
});

describe('section formatters', () => {
  it('formatReferenceLayer returns null for empty array', () => {
    expect(formatReferenceLayer([])).toBeNull();
  });

  it('formatReferenceLayer returns null for null/undefined', () => {
    expect(formatReferenceLayer(null as unknown as ArtifactRow[])).toBeNull();
    expect(formatReferenceLayer(undefined as unknown as ArtifactRow[])).toBeNull();
  });

  it('formatReferenceLayer renders packed artifact summaries', () => {
    const now = Math.floor(Date.now() / 1000);
    const artifacts: ArtifactRow[] = [
      {
        id: 1, session_id: 's1', project: 'p', artifact_type: 'observation',
        artifact_ref: null, summary: 'API endpoint analysis', content: null,
        state: 'packed', ttl: 0, importance: 4, timestamp_epoch: now - 7200,
        last_materialized_epoch: null,
      },
      {
        id: 2, session_id: 's1', project: 'p', artifact_type: 'learning',
        artifact_ref: null, summary: 'Windows paths need normalization', content: null,
        state: 'packed', ttl: 0, importance: 5, timestamp_epoch: now - 60,
        last_materialized_epoch: null,
      },
      {
        id: 3, session_id: 's1', project: 'p', artifact_type: 'decision',
        artifact_ref: null, summary: 'Use TTL-based lifecycle', content: null,
        state: 'packed', ttl: 0, importance: 3, timestamp_epoch: now - 3600,
        last_materialized_epoch: null,
      },
    ];

    const result = formatReferenceLayer(artifacts);
    expect(result).not.toBeNull();
    expect(result).toContain('## Available Context');
    expect(result).toContain('[obs] "API endpoint analysis"');
    expect(result).toContain('[learn] "Windows paths need normalization"');
    expect(result).toContain('[decision] "Use TTL-based lifecycle"');
    expect(result).toContain('importance: 4');
    expect(result).toContain('importance: 5');
  });

  it('formatMaterializationLayer returns null for empty array', () => {
    expect(formatMaterializationLayer([])).toBeNull();
  });

  it('formatMaterializationLayer returns null when no artifacts have content', () => {
    const artifacts: ArtifactRow[] = [
      {
        id: 1, session_id: 's1', project: 'p', artifact_type: 'observation',
        artifact_ref: null, summary: 'No content', content: null,
        state: 'fresh', ttl: 3, importance: 4, timestamp_epoch: 0,
        last_materialized_epoch: null,
      },
    ];

    expect(formatMaterializationLayer(artifacts)).toBeNull();
  });

  it('formatMaterializationLayer renders full content', () => {
    const artifacts: ArtifactRow[] = [
      {
        id: 1, session_id: 's1', project: 'p', artifact_type: 'observation',
        artifact_ref: null, summary: 'API endpoint analysis',
        content: 'GET /api/threads returns ThreadState with artifacts array.',
        state: 'materialized', ttl: 2, importance: 4,
        timestamp_epoch: Math.floor(Date.now() / 1000),
        last_materialized_epoch: Math.floor(Date.now() / 1000),
      },
      {
        id: 2, session_id: 's1', project: 'p', artifact_type: 'decision',
        artifact_ref: null, summary: 'Use TTL-based lifecycle',
        content: 'Decided during IAM analysis session. TTL replaces consumed flag.',
        state: 'fresh', ttl: 3, importance: 3,
        timestamp_epoch: Math.floor(Date.now() / 1000),
        last_materialized_epoch: null,
      },
    ];

    const result = formatMaterializationLayer(artifacts);
    expect(result).not.toBeNull();
    expect(result).toContain('## Materialized Context');
    expect(result).toContain('### [obs] [p] API endpoint analysis');
    expect(result).toContain('GET /api/threads returns ThreadState with artifacts array.');
    expect(result).toContain('### [decision] [p] Use TTL-based lifecycle');
    expect(result).toContain('TTL replaces consumed flag.');
  });

  it('formatMaterializationLayer skips artifacts without content', () => {
    const artifacts: ArtifactRow[] = [
      {
        id: 1, session_id: 's1', project: 'p', artifact_type: 'observation',
        artifact_ref: null, summary: 'Has content',
        content: 'Real content here.',
        state: 'fresh', ttl: 3, importance: 4,
        timestamp_epoch: 0, last_materialized_epoch: null,
      },
      {
        id: 2, session_id: 's1', project: 'p', artifact_type: 'decision',
        artifact_ref: null, summary: 'No content',
        content: null,
        state: 'fresh', ttl: 3, importance: 3,
        timestamp_epoch: 0, last_materialized_epoch: null,
      },
    ];

    const result = formatMaterializationLayer(artifacts);
    expect(result).toContain('Has content');
    expect(result).not.toContain('No content');
  });
});
