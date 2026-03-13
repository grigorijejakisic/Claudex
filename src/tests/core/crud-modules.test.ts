import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import {
  upsertThreadState,
  getThreadState,
  resetThreadState,
} from '../../core/thread.js';
import {
  updatePressureScore,
  getPressureByProject,
  getHotFiles,
  decayPressure,
} from '../../core/pressure.js';
import {
  getCheckpointTracking,
  updateCheckpointTracking,
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

  it('upsertThreadState redacts secrets in topic and summary', () => {
    upsertThreadState(db, {
      session_id: 's1',
      topic: 'Working with key sk-abcdefghijklmnopqrstuvwxyz',
      summary: 'Used token ghp_ABCDEFghijklmnopqrstuvwxyz0123456789',
    });

    const state = getThreadState(db, 's1');
    expect(state).toBeDefined();
    expect(state!.topic).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(state!.topic).toContain('[REDACTED_SECRET]');
    expect(state!.summary).not.toContain('ghp_ABCDEFghijklmnopqrstuvwxyz0123456789');
    expect(state!.summary).toContain('[REDACTED_SECRET]');
  });

  it('upsertThreadState redacts secrets in key_exchanges gists', () => {
    upsertThreadState(db, {
      session_id: 's1',
      key_exchanges: [
        { role: 'user', gist: 'sent Bearer abcdefghijklmnopqrstuvwxyz1234 to API' },
      ],
    });

    const state = getThreadState(db, 's1');
    expect(state!.key_exchanges).toHaveLength(1);
    expect(state!.key_exchanges[0].gist).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz1234');
    expect(state!.key_exchanges[0].gist).toContain('[REDACTED_SECRET]');
    // Role should be preserved
    expect(state!.key_exchanges[0].role).toBe('user');
  });

  it('resetThreadState deletes thread state', () => {
    upsertThreadState(db, {
      session_id: 's1',
      topic: 'to be deleted',
    });
    resetThreadState(db, 's1');

    const state = getThreadState(db, 's1');
    expect(state).toBeUndefined();
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

    const rows = getPressureByProject(db, 'myapp');
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe('src/auth.ts');
    expect(rows[0].raw_pressure).toBeCloseTo(0.3);
    expect(rows[0].temperature).toBe('COLD');
  });

  it('updatePressureScore accumulates pressure on existing entry', () => {
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.2);
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.2);

    const rows = getPressureByProject(db, 'myapp');
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_pressure).toBeCloseTo(0.4);
  });

  it('updatePressureScore sets HOT temperature above threshold', () => {
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.3);
    updatePressureScore(db, 'src/auth.ts', 'myapp', 0.3);

    const rows = getPressureByProject(db, 'myapp');
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

  it('decayPressure reduces pressure and demotes to COLD', () => {
    updatePressureScore(db, 'src/file.ts', 'myapp', 0.6);
    expect(getPressureByProject(db, 'myapp')[0].temperature).toBe('HOT');

    // Decay heavily: 0.6 * (1 - 0.95) = 0.03 < 0.1 threshold
    const affected = decayPressure(db, 'myapp', 0.95);
    expect(affected).toBe(1);

    const rows = getPressureByProject(db, 'myapp');
    expect(rows[0].raw_pressure).toBeCloseTo(0.03);
    expect(rows[0].temperature).toBe('COLD');
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
    updateCheckpointTracking(db, 's1', 25);

    const tracking = getCheckpointTracking(db, 's1');
    expect(tracking).toBeDefined();
    expect(tracking!.session_id).toBe('s1');
    expect(tracking!.observation_count).toBe(25);
    expect(tracking!.thresholds_hit).toEqual([]);
  });

  it('updateCheckpointTracking creates or updates tracking', () => {
    updateCheckpointTracking(db, 's1', 10);
    let tracking = getCheckpointTracking(db, 's1');
    expect(tracking!.observation_count).toBe(10);

    updateCheckpointTracking(db, 's1', 20);
    tracking = getCheckpointTracking(db, 's1');
    expect(tracking!.observation_count).toBe(20);
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
    updateCheckpointTracking(db, 's1', 0);
    recordThresholdHit(db, 's1', 25);
    recordThresholdHit(db, 's1', 50);

    const tracking = getCheckpointTracking(db, 's1');
    expect(tracking!.thresholds_hit).toEqual([25, 50]);
  });
});
