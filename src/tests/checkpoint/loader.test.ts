import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import * as yaml from 'js-yaml';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  recoverFromDb,
  loadFromFile,
  loadCheckpoint,
} from '../../checkpoint/loader.js';
import type { CheckpointV3, CheckpointMeta } from '../../checkpoint/types.js';

/** Create a session row so loadCheckpoint's JOIN finds a match. */
function ensureSession(db: TestDatabase, sessionId: string, project: string = 'test', obsCount: number = 5): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status, observation_count, created_at_epoch)
     VALUES (?, ?, 'active', ?, unixepoch())`
  ).run(sessionId, project, obsCount);
}

function makeCheckpoint(overrides?: Partial<CheckpointV3>): CheckpointV3 {
  return {
    schema: 'claudex/checkpoint',
    version: 3,
    meta: {
      checkpoint_id: 'TEST_ID',
      session_id: 's1',
      scope: null,
      trigger: 'session_end',
      token_usage: null,
      previous_checkpoint: null,
    },
    working: { task: 'test task', status: 'in_progress', next_action: null, branch: null },
    decisions: [{ content: 'decision 1', source: 'confirmation', timestamp: 1000 }],
    files: { hot: [{ path: 'src/a.ts', last_action: 'edited' }], read: ['src/b.ts'] },
    thread: { topic: 'test topic', summary: 'test summary', key_exchanges: [{ role: 'user', gist: 'asked' }] },
    open_items: ['todo 1'],
    learnings: ['learning 1'],
    gsd: { phase: 6 },
    ...overrides,
  };
}

describe('recoverFromDb', () => {
  let db: TestDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-loader-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-mirrors committed rows to YAML files', async () => {
    const cp = makeCheckpoint();
    const checkpointsDir = path.join(tmpDir, 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const mirrorPath = path.join(checkpointsDir, 'test_cp.yaml');

    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'committed', ?, ?, unixepoch(), unixepoch())`
    ).run('cp1', 's1', 'session_end', JSON.stringify(cp), mirrorPath);

    await recoverFromDb(db);

    const row = db.prepare('SELECT status FROM checkpoint_meta WHERE checkpoint_id = ?').get('cp1') as { status: string };
    expect(row.status).toBe('mirrored');
  });

  it('deletes pending rows', async () => {
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'pending', unixepoch(), unixepoch())`
    ).run('cp-pending', 's1', 'session_end');

    await recoverFromDb(db);

    const row = db.prepare('SELECT * FROM checkpoint_meta WHERE checkpoint_id = ?').get('cp-pending');
    expect(row).toBeUndefined();
  });

  it('handles empty checkpoint_meta gracefully', async () => {
    await expect(recoverFromDb(db)).resolves.not.toThrow();
  });

  it('is non-throwing on invalid data column', async () => {
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'committed', ?, unixepoch(), unixepoch())`
    ).run('cp-bad', 's1', 'session_end', 'not-json');

    await expect(recoverFromDb(db)).resolves.not.toThrow();
  });

  it('does NOT mark mirrored when file write fails', async () => {
    const cp = makeCheckpoint();
    // Use path with null byte to force write failure
    const badMirrorPath = path.join(tmpDir, 'bad\0path.yaml');

    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'committed', ?, ?, unixepoch(), unixepoch())`
    ).run('cp-fail', 's1', 'session_end', JSON.stringify(cp), badMirrorPath);

    await recoverFromDb(db);

    const row = db.prepare('SELECT status FROM checkpoint_meta WHERE checkpoint_id = ?').get('cp-fail') as { status: string };
    expect(row.status).toBe('committed');
  });
});

describe('loadFromFile', () => {
  let tmpDir: string;
  let checkpointsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-loader-'));
    checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads checkpoint via latest.yaml ref', () => {
    const cp = makeCheckpoint();
    fs.writeFileSync(path.join(checkpointsDir, 'test_cp.yaml'), yaml.dump(cp));
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: test_cp.yaml\n');

    const result = loadFromFile(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');
    expect(result!.working.task).toBe('test task');
  });

  it('falls back to directory scan when latest.yaml missing', () => {
    const cp = makeCheckpoint();
    fs.writeFileSync(path.join(checkpointsDir, '2026-03-12_test.yaml'), yaml.dump(cp));

    const result = loadFromFile(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');
  });

  it('directory scan picks newest file by mtime', async () => {
    const cp1 = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'OLD' } });
    const cp2 = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'NEW' } });

    fs.writeFileSync(path.join(checkpointsDir, 'old.yaml'), yaml.dump(cp1));

    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(path.join(checkpointsDir, 'new.yaml'), yaml.dump(cp2));

    const result = loadFromFile(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.meta.checkpoint_id).toBe('NEW');
  });

  it('returns null when no valid checkpoint files exist', () => {
    // Empty dir
    const result = loadFromFile(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when directory does not exist', () => {
    const result = loadFromFile('/nonexistent/dir');
    expect(result).toBeNull();
  });

  it('handles invalid YAML gracefully', () => {
    fs.writeFileSync(path.join(checkpointsDir, 'bad.yaml'), '{{{{invalid yaml');

    const result = loadFromFile(tmpDir);
    expect(result).toBeNull();
  });
});

describe('loadCheckpoint', () => {
  let db: TestDatabase;
  let tmpDir: string;
  let checkpointsDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-load-'));
    checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads from DB when mirrored row exists (fast path)', () => {
    ensureSession(db, 's1');
    const cp = makeCheckpoint();
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'mirrored', ?, ?, unixepoch(), unixepoch())`
    ).run('cp1', 's1', 'session_end', JSON.stringify(cp), path.join(checkpointsDir, 'cp1.yaml'));

    const result = loadCheckpoint(db, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.meta.checkpoint_id).toBe('TEST_ID');
    expect(result!.working.task).toBe('test task');
  });

  it('re-mirrors committed row and returns data', () => {
    ensureSession(db, 's1');
    const cp = makeCheckpoint();
    const mirrorPath = path.join(checkpointsDir, 'cp1.yaml');
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'committed', ?, ?, unixepoch(), unixepoch())`
    ).run('cp1', 's1', 'session_end', JSON.stringify(cp), mirrorPath);

    const result = loadCheckpoint(db, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');

    // Verify status updated
    const row = db.prepare('SELECT status FROM checkpoint_meta WHERE checkpoint_id = ?').get('cp1') as { status: string };
    expect(row.status).toBe('mirrored');
  });

  it('falls back to file when DB is null', () => {
    const cp = makeCheckpoint();
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: test.yaml\n');
    fs.writeFileSync(path.join(checkpointsDir, 'test.yaml'), yaml.dump(cp));

    const result = loadCheckpoint(null, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');
  });

  it('falls back to file when DB has no rows', () => {
    const cp = makeCheckpoint();
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: test.yaml\n');
    fs.writeFileSync(path.join(checkpointsDir, 'test.yaml'), yaml.dump(cp));

    const result = loadCheckpoint(db, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');
  });

  it('returns null when both layers fail', () => {
    const result = loadCheckpoint(null, '/nonexistent');
    expect(result).toBeNull();
  });

  it('filters by project when project parameter is provided', () => {
    // Create sessions for two different projects (observation_count > 0 required by loader)
    ensureSession(db, 's-projA', 'projectA');
    ensureSession(db, 's-projB', 'projectB');

    // Create checkpoint for projectA
    const cpA = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'CPA' } });
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'mirrored', ?, unixepoch(), unixepoch())`
    ).run('cpA', 's-projA', 'session_end', JSON.stringify(cpA));

    // Create checkpoint for projectB
    const cpB = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'CPB' } });
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'mirrored', ?, unixepoch() + 1, unixepoch() + 1)`
    ).run('cpB', 's-projB', 'session_end', JSON.stringify(cpB));

    // Loading with projectA filter should return projectA's checkpoint, not projectB's
    const resultA = loadCheckpoint(db, tmpDir, undefined, 'projectA');
    expect(resultA).not.toBeNull();
    expect(resultA!.meta.checkpoint_id).toBe('CPA');

    // Loading with projectB filter should return projectB's checkpoint
    const resultB = loadCheckpoint(db, tmpDir, undefined, 'projectB');
    expect(resultB).not.toBeNull();
    expect(resultB!.meta.checkpoint_id).toBe('CPB');

    // Loading without project filter returns the newest (projectB, which has +1 epoch)
    const resultAll = loadCheckpoint(db, tmpDir);
    expect(resultAll).not.toBeNull();
    expect(resultAll!.meta.checkpoint_id).toBe('CPB');
  });

  it('returns null when no checkpoints exist for the requested project', () => {
    // Create session and checkpoint for projectA only
    ensureSession(db, 's-projA', 'projectA');
    const cpA = makeCheckpoint();
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'mirrored', ?, unixepoch(), unixepoch())`
    ).run('cpA', 's-projA', 'session_end', JSON.stringify(cpA));

    // Loading with a different project should return null (falls back to file, which is also empty)
    const result = loadCheckpoint(db, '/nonexistent', undefined, 'projectX');
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Phase 13.1 Fix #6 (2026-05-15): minCreatedAtEpoch freshness floor
  // -----------------------------------------------------------------------
  it('drops checkpoints older than minCreatedAtEpoch (project filtered)', () => {
    ensureSession(db, 's-old', 'projA');
    ensureSession(db, 's-new', 'projA');

    const cpOld = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'CP_OLD' } });
    const cpNew = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'CP_NEW' } });

    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, 'session_end', 'mirrored', ?, ?, ?)`
    ).run('CP_OLD', 's-old', JSON.stringify(cpOld), 1000, 1000);
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, 'session_end', 'mirrored', ?, ?, ?)`
    ).run('CP_NEW', 's-new', JSON.stringify(cpNew), 5000, 5000);

    // Floor at 3000 — CP_OLD (epoch 1000) should drop, CP_NEW (epoch 5000) survives.
    const result = loadCheckpoint(db, '/nonexistent', undefined, 'projA', 3000);
    expect(result).not.toBeNull();
    expect(result!.meta.checkpoint_id).toBe('CP_NEW');
  });

  it('drops checkpoints older than minCreatedAtEpoch (no project filter)', () => {
    ensureSession(db, 's-old');
    ensureSession(db, 's-new');

    const cpOld = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'CP_OLD' } });
    const cpNew = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'CP_NEW' } });

    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, 'session_end', 'mirrored', ?, ?, ?)`
    ).run('CP_OLD', 's-old', JSON.stringify(cpOld), 1000, 1000);
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, 'session_end', 'mirrored', ?, ?, ?)`
    ).run('CP_NEW', 's-new', JSON.stringify(cpNew), 5000, 5000);

    const result = loadCheckpoint(db, '/nonexistent', undefined, undefined, 3000);
    expect(result).not.toBeNull();
    expect(result!.meta.checkpoint_id).toBe('CP_NEW');
  });

  it('returns null when ALL checkpoints are older than the floor (project)', () => {
    ensureSession(db, 's-old', 'projA');
    const cp = makeCheckpoint();
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, 'session_end', 'mirrored', ?, ?, ?)`
    ).run('cp1', 's-old', JSON.stringify(cp), 1000, 1000);

    const result = loadCheckpoint(db, '/nonexistent', undefined, 'projA', 9999);
    expect(result).toBeNull();
  });

  it('keeps default behavior when minCreatedAtEpoch is undefined', () => {
    ensureSession(db, 's-old', 'projA');
    const cp = makeCheckpoint();
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, 'session_end', 'mirrored', ?, ?, ?)`
    ).run('cp1', 's-old', JSON.stringify(cp), 1000, 1000);

    const result = loadCheckpoint(db, '/nonexistent', undefined, 'projA');
    expect(result).not.toBeNull();
  });
});

describe('selective loading', () => {
  let db: TestDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-preset-'));
    const checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });

    ensureSession(db, 's1');
    const cp = makeCheckpoint();
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'mirrored', ?, unixepoch(), unixepoch())`
    ).run('cp1', 's1', 'session_end', JSON.stringify(cp));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ALWAYS preset keeps only meta, working, thread.topic', () => {
    const result = loadCheckpoint(db, tmpDir, 'ALWAYS');
    expect(result).not.toBeNull();
    expect(result!.working.task).toBe('test task');
    expect(result!.thread.topic).toBe('test topic');
    expect(result!.decisions).toEqual([]);
    expect(result!.files).toEqual({ hot: [], read: [] });
    expect(result!.thread.summary).toBeNull();
    expect(result!.thread.key_exchanges).toEqual([]);
    expect(result!.open_items).toEqual([]);
    expect(result!.learnings).toEqual([]);
    expect(result!.gsd).toBeNull();
  });

  it('RESUME preset keeps everything except gsd', () => {
    const result = loadCheckpoint(db, tmpDir, 'RESUME');
    expect(result).not.toBeNull();
    expect(result!.decisions).toHaveLength(1);
    expect(result!.files.hot).toHaveLength(1);
    expect(result!.thread.summary).toBe('test summary');
    expect(result!.open_items).toHaveLength(1);
    expect(result!.learnings).toHaveLength(1);
    expect(result!.gsd).toBeNull();
  });

  it('GSD preset keeps everything', () => {
    const result = loadCheckpoint(db, tmpDir, 'GSD');
    expect(result).not.toBeNull();
    expect(result!.decisions).toHaveLength(1);
    expect(result!.gsd).toEqual({ phase: 6 });
  });

  it('no preset returns full checkpoint', () => {
    const result = loadCheckpoint(db, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.decisions).toHaveLength(1);
    expect(result!.gsd).toEqual({ phase: 6 });
    expect(result!.thread.summary).toBe('test summary');
  });
});

describe('Fix 1: recoverFromDb writes compressed for .yaml.gz mirror paths', () => {
  let db: TestDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-fix1-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-mirrors .yaml.gz path as valid gzip', async () => {
    const cp = makeCheckpoint();
    const checkpointsDir = path.join(tmpDir, 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const mirrorPath = path.join(checkpointsDir, 'test_cp.yaml.gz');

    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'committed', ?, ?, unixepoch(), unixepoch())`
    ).run('cp-gz', 's1', 'session_end', JSON.stringify(cp), mirrorPath);

    await recoverFromDb(db);

    // File should exist and be valid gzip
    expect(fs.existsSync(mirrorPath)).toBe(true);
    const raw = fs.readFileSync(mirrorPath);
    expect(raw[0]).toBe(0x1f); // gzip magic byte
    expect(raw[1]).toBe(0x8b);

    // Should decompress to valid YAML
    const decompressed = zlib.gunzipSync(raw).toString('utf-8');
    const parsed = yaml.load(decompressed, { schema: yaml.JSON_SCHEMA }) as CheckpointV3;
    expect(parsed.schema).toBe('claudex/checkpoint');

    // DB status should be mirrored
    const row = db.prepare('SELECT status FROM checkpoint_meta WHERE checkpoint_id = ?').get('cp-gz') as { status: string };
    expect(row.status).toBe('mirrored');
  });

  it('loadCheckpoint sync re-mirror writes gzip for .yaml.gz path', () => {
    ensureSession(db, 's1');
    const cp = makeCheckpoint();
    const cpDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });
    const mirrorPath = path.join(cpDir, 'sync_cp.yaml.gz');

    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'committed', ?, ?, unixepoch(), unixepoch())`
    ).run('cp-sync-gz', 's1', 'session_end', JSON.stringify(cp), mirrorPath);

    const result = loadCheckpoint(db, tmpDir);
    expect(result).not.toBeNull();

    // Verify the file is valid gzip
    expect(fs.existsSync(mirrorPath)).toBe(true);
    const raw = fs.readFileSync(mirrorPath);
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);
  });
});

describe('Fix 2: path traversal prevention', () => {
  let tmpDir: string;
  let checkpointsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-fix2-'));
    checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadFromFile rejects ../  traversal in latest.yaml ref', () => {
    // Write a valid checkpoint outside checkpointsDir
    const cp = makeCheckpoint();
    fs.writeFileSync(path.join(tmpDir, 'context', 'escape.yaml'), yaml.dump(cp));

    // latest.yaml references a path that escapes the checkpoints dir
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: ../escape.yaml\n');

    const result = loadFromFile(tmpDir);
    // Should NOT load the escaped file — falls through to dir scan (which finds nothing)
    expect(result).toBeNull();
  });

});

describe('Fix 3: gzip bomb prevention', () => {
  let tmpDir: string;
  let checkpointsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-fix3-'));
    checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects compressed file larger than 10MB', () => {
    // Create a file that claims to be gzip but is > 10MB of garbage
    // We use a real gzip header + padding to exceed the limit
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 0x42);
    // Write with gzip magic bytes so the extension check passes but size check fails
    const filePath = path.join(checkpointsDir, 'bomb.yaml.gz');
    fs.writeFileSync(filePath, bigBuffer);
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: bomb.yaml.gz\n');

    // Should return null (bomb rejected), not crash
    const result = loadFromFile(tmpDir);
    expect(result).toBeNull();
  });
});

describe('Fix 5: recoverFromDb per-directory latest.yaml', () => {
  let db: TestDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-fix5-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes latest.yaml per-directory not just globally', async () => {
    const cp1 = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'CP1' } });
    const cp2 = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'CP2' } });

    const dirA = path.join(tmpDir, 'checkpoints', 'dirA');
    const dirB = path.join(tmpDir, 'checkpoints', 'dirB');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const mirrorPathA = path.join(dirA, 'cp1.yaml');
    const mirrorPathB = path.join(dirB, 'cp2.yaml');

    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'committed', ?, ?, 1000, 1000)`
    ).run('cp1', 's1', 'session_end', JSON.stringify(cp1), mirrorPathA);

    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, 'committed', ?, ?, 2000, 2000)`
    ).run('cp2', 's1', 'session_end', JSON.stringify(cp2), mirrorPathB);

    await recoverFromDb(db);

    // Both directories should have their own latest.yaml
    const latestA = fs.readFileSync(path.join(dirA, 'latest.yaml'), 'utf-8');
    expect(latestA).toContain('ref: cp1.yaml');

    const latestB = fs.readFileSync(path.join(dirB, 'latest.yaml'), 'utf-8');
    expect(latestB).toContain('ref: cp2.yaml');
  });
});

describe('Fix 6: JSON_SCHEMA prevents type coercion', () => {
  let tmpDir: string;
  let checkpointsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-fix6-'));
    checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadFromFile preserves string "true" without coercion to boolean', () => {
    const cp = makeCheckpoint({
      learnings: ['true', 'false', 'null', 'yes', 'no'],
      open_items: ['1', '0'],
    });
    // Write with JSON_SCHEMA to prevent coercion on dump
    const yamlContent = yaml.dump(cp, { schema: yaml.JSON_SCHEMA });
    fs.writeFileSync(path.join(checkpointsDir, 'test.yaml'), yamlContent);
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: test.yaml\n');

    const result = loadFromFile(tmpDir);
    expect(result).not.toBeNull();
    // With JSON_SCHEMA, these should remain as strings
    expect(result!.learnings).toContain('true');
    expect(result!.learnings).toContain('false');
    expect(result!.learnings).toContain('null');
    expect(result!.open_items).toContain('1');
    expect(result!.open_items).toContain('0');
    // Verify they are strings, not booleans/numbers
    expect(typeof result!.learnings[0]).toBe('string');
    expect(typeof result!.open_items[0]).toBe('string');
  });
});
