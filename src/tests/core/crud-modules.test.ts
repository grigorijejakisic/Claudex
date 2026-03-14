import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import {
  upsertThreadState,
  getThreadState,
} from '../../core/thread.js';
import {
  updatePressureScore,
  getHotFiles,
} from '../../core/pressure.js';
import {
  getCheckpointTracking,
  markPostCompactPending,
  clearPostCompactPending,
  recordThresholdHit,
} from '../../core/checkpoint-tracking.js';

describe('thread state CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('upsertThreadState creates thread state', () => {
    upsertThreadState(db, {
      session_id: 's1',
      topic: 'refactoring auth',
      summary: 'Working on JWT changes',
    });

    const state = getThreadState(db, 's1');
    expect(state).toBeDefined();
    expect(state!.topic).toBe('refactoring auth');
    expect(state!.summary).toBe('Working on JWT changes');
    expect(state!.key_exchanges).toEqual([]);
  });

  it('upsertThreadState updates existing thread state', () => {
    upsertThreadState(db, {
      session_id: 's1',
      topic: 'initial topic',
    });
    upsertThreadState(db, {
      session_id: 's1',
      topic: 'new topic',
      key_exchanges: [{ role: 'user', gist: 'switch to new approach' }],
    });

    const state = getThreadState(db, 's1');
    expect(state!.topic).toBe('new topic');
    expect(state!.key_exchanges).toHaveLength(1);
    expect(state!.key_exchanges[0].gist).toBe('switch to new approach');
  });

  it('getThreadState returns parsed key_exchanges', () => {
    const exchanges = [
      { role: 'user', gist: 'asked about auth' },
      { role: 'assistant', gist: 'suggested JWT' },
    ];
    upsertThreadState(db, {
      session_id: 's1',
      key_exchanges: exchanges,
    });

    const state = getThreadState(db, 's1');
    expect(state!.key_exchanges).toEqual(exchanges);
  });

  it('upsertThreadState stores content as-is (redaction is caller responsibility)', () => {
    upsertThreadState(db, {
      session_id: 's1',
      topic: 'Working with key sk-abcdefghijklmnopqrstuvwxyz',
      summary: 'Used token ghp_ABCDEFghijklmnopqrstuvwxyz0123456789',
      key_exchanges: [
        { role: 'user', gist: 'sent Bearer abcdefghijklmnopqrstuvwxyz1234 to API' },
      ],
    });

    const state = getThreadState(db, 's1');
    expect(state).toBeDefined();
    // Core layer stores verbatim — callers must redact before calling
    expect(state!.topic).toBe('Working with key sk-abcdefghijklmnopqrstuvwxyz');
    expect(state!.summary).toBe('Used token ghp_ABCDEFghijklmnopqrstuvwxyz0123456789');
    expect(state!.key_exchanges[0].gist).toBe('sent Bearer abcdefghijklmnopqrstuvwxyz1234 to API');
    expect(state!.key_exchanges[0].role).toBe('user');
  });

});

describe('pressure scores CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('updatePressureScore creates new entry', () => {
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.3);

    const rows = db.prepare('SELECT * FROM pressure_scores WHERE project = ? ORDER BY raw_pressure DESC').all('myapp') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe('src/auth.ts');
    expect(rows[0].raw_pressure).toBeCloseTo(0.3);
    expect(rows[0].temperature).toBe('COLD');
  });

  it('updatePressureScore accumulates pressure on existing entry', () => {
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.2);
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.2);

    const rows = db.prepare('SELECT * FROM pressure_scores WHERE project = ? ORDER BY raw_pressure DESC').all('myapp') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_pressure).toBeCloseTo(0.4);
  });

  it('updatePressureScore sets HOT temperature above threshold', () => {
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.3);
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.3);

    const rows = db.prepare('SELECT * FROM pressure_scores WHERE project = ? ORDER BY raw_pressure DESC').all('myapp') as any[];
    expect(rows[0].raw_pressure).toBeCloseTo(0.6);
    expect(rows[0].temperature).toBe('HOT');
  });

  it('getHotFiles returns only HOT files for project', () => {
    updatePressureScore(db, 'src/hot.ts', 'myapp', 0.6);
    updatePressureScore(db, 'src/cold.ts', 'myapp', 0.1);
    updatePressureScore(db, 'src/other.ts', 'other-project', 0.8);

    const hot = getHotFiles(db, 'myapp');
    expect(hot).toHaveLength(1);
    expect(hot[0].file_path).toBe('src/hot.ts');
    expect(hot[0].project).toBe('myapp');
  });
});

describe('checkpoint tracking CRUD', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('getCheckpointTracking returns tracking state', () => {
    db.prepare(
      `INSERT INTO checkpoint_tracking (session_id, observation_count, last_checkpoint_epoch, updated_at_epoch)
       VALUES (?, ?, unixepoch(), unixepoch())`
    ).run('s1', 25);

    const tracking = getCheckpointTracking(db, 's1');
    expect(tracking).toBeDefined();
    expect(tracking!.session_id).toBe('s1');
    expect(tracking!.observation_count).toBe(25);
    expect(tracking!.thresholds_hit).toEqual([]);
  });

  it('markPostCompactPending sets flag', () => {
    markPostCompactPending(db, 's1');

    const tracking = getCheckpointTracking(db, 's1');
    expect(tracking!.post_compact_pending).toBe(1);
  });

  it('clearPostCompactPending resets flag', () => {
    markPostCompactPending(db, 's1');
    clearPostCompactPending(db, 's1');

    const tracking = getCheckpointTracking(db, 's1');
    expect(tracking!.post_compact_pending).toBe(0);
  });

  it('recordThresholdHit appends to thresholds_hit array', () => {
    db.prepare(
      `INSERT INTO checkpoint_tracking (session_id, observation_count, last_checkpoint_epoch, updated_at_epoch)
       VALUES (?, ?, unixepoch(), unixepoch())`
    ).run('s1', 0);
    recordThresholdHit(db, 's1', 25);
    recordThresholdHit(db, 's1', 50);

    const tracking = getCheckpointTracking(db, 's1');
    expect(tracking!.thresholds_hit).toEqual([25, 50]);
  });
});
