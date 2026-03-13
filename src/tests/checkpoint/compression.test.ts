/**
 * Tests for checkpoint compression (zlib gzip).
 * Round-trip: write compressed -> read -> verify identical data.
 * Backward compat: loader handles both compressed and uncompressed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import * as yaml from 'js-yaml';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { writeCheckpoint, writeCompressedFile, readCompressedFile } from '../../checkpoint/writer.js';
import { loadFromFile, followHopChain, loadCheckpoint } from '../../checkpoint/loader.js';
import type { CheckpointV3 } from '../../checkpoint/types.js';

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

describe('writeCompressedFile / readCompressedFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-compress-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips content through compress/decompress', async () => {
    const content = 'Hello, compressed world!';
    const filePath = path.join(tmpDir, 'test.yaml.gz');

    const ok = await writeCompressedFile(filePath, content);
    expect(ok).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);

    const result = readCompressedFile(filePath);
    expect(result).toBe(content);
  });

  it('compressed file is valid gzip', async () => {
    const content = yaml.dump(makeCheckpoint());
    const filePath = path.join(tmpDir, 'cp.yaml.gz');

    await writeCompressedFile(filePath, content);

    const raw = fs.readFileSync(filePath);
    // Gzip magic bytes: 0x1f 0x8b
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);
  });

  it('compressed file is smaller than uncompressed for YAML content', async () => {
    const cp = makeCheckpoint();
    const content = yaml.dump(cp, { lineWidth: 120, noRefs: true });
    const compressedPath = path.join(tmpDir, 'cp.yaml.gz');
    const uncompressedPath = path.join(tmpDir, 'cp.yaml');

    await writeCompressedFile(compressedPath, content);
    fs.writeFileSync(uncompressedPath, content, 'utf-8');

    const compressedSize = fs.statSync(compressedPath).size;
    const uncompressedSize = fs.statSync(uncompressedPath).size;
    expect(compressedSize).toBeLessThan(uncompressedSize);
  });

  it('readCompressedFile returns null for non-existent file', () => {
    const result = readCompressedFile(path.join(tmpDir, 'nonexistent.yaml.gz'));
    expect(result).toBeNull();
  });

  it('readCompressedFile returns null for invalid gzip data', () => {
    const filePath = path.join(tmpDir, 'bad.yaml.gz');
    fs.writeFileSync(filePath, 'not gzip data');
    const result = readCompressedFile(filePath);
    expect(result).toBeNull();
  });

  it('writeCompressedFile returns false for invalid path', async () => {
    const ok = await writeCompressedFile(path.join(tmpDir, 'bad\0path.yaml.gz'), 'content');
    expect(ok).toBe(false);
  });
});

describe('writeCheckpoint with compression', () => {
  let db: TestDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-compress-writer-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes .yaml.gz file when compression enabled', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
      compression: true,
    });

    expect(result).not.toBeNull();
    expect(result!.filePath).toBeTruthy();
    expect(result!.filePath!).toMatch(/\.yaml\.gz$/);
    expect(fs.existsSync(result!.filePath!)).toBe(true);

    // Verify it's valid gzip
    const raw = fs.readFileSync(result!.filePath!);
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);
  });

  it('writes .yaml file when compression disabled (default)', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    expect(result).not.toBeNull();
    expect(result!.filePath!).toMatch(/\.yaml$/);
    expect(result!.filePath!).not.toMatch(/\.yaml\.gz$/);
  });

  it('compressed checkpoint round-trips through write and load', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
      compression: true,
    });

    expect(result).not.toBeNull();

    // Load from file (should detect .yaml.gz)
    const loaded = loadFromFile(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.schema).toBe('claudex/checkpoint');
    expect(loaded!.version).toBe(3);
    expect(loaded!.meta.checkpoint_id).toBe(result!.checkpointId);
  });

  it('latest.yaml ref points to .yaml.gz basename', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
      compression: true,
    });

    const checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    const latestContent = fs.readFileSync(path.join(checkpointsDir, 'latest.yaml'), 'utf-8');
    expect(latestContent).toContain('.yaml.gz');
    expect(latestContent).toContain(result!.checkpointId);
  });
});

describe('loader backward compatibility', () => {
  let tmpDir: string;
  let checkpointsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-loader-compat-'));
    checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadFromFile reads uncompressed .yaml via latest.yaml ref', () => {
    const cp = makeCheckpoint();
    fs.writeFileSync(path.join(checkpointsDir, 'test.yaml'), yaml.dump(cp));
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: test.yaml\n');

    const result = loadFromFile(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');
  });

  it('loadFromFile reads compressed .yaml.gz via latest.yaml ref', () => {
    const cp = makeCheckpoint();
    const yamlContent = yaml.dump(cp);
    const compressed = zlib.gzipSync(Buffer.from(yamlContent, 'utf-8'));
    fs.writeFileSync(path.join(checkpointsDir, 'test.yaml.gz'), compressed);
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: test.yaml.gz\n');

    const result = loadFromFile(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');
    expect(result!.working.task).toBe('test task');
  });

  it('directory scan finds .yaml.gz files', () => {
    const cp = makeCheckpoint();
    const yamlContent = yaml.dump(cp);
    const compressed = zlib.gzipSync(Buffer.from(yamlContent, 'utf-8'));
    fs.writeFileSync(path.join(checkpointsDir, '2026-03-12_test.yaml.gz'), compressed);

    const result = loadFromFile(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');
  });

  it('directory scan prefers newest file regardless of format', async () => {
    const cpOld = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'OLD' } });
    const cpNew = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'NEW' } });

    // Write old uncompressed
    fs.writeFileSync(path.join(checkpointsDir, 'old.yaml'), yaml.dump(cpOld));

    // Small delay for mtime difference
    await new Promise((r) => setTimeout(r, 50));

    // Write new compressed
    const compressed = zlib.gzipSync(Buffer.from(yaml.dump(cpNew), 'utf-8'));
    fs.writeFileSync(path.join(checkpointsDir, 'new.yaml.gz'), compressed);

    const result = loadFromFile(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.meta.checkpoint_id).toBe('NEW');
  });

  it('followHopChain works with compressed files', () => {
    const cpB = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'B', previous_checkpoint: null } });
    const cpA = makeCheckpoint({ meta: { ...makeCheckpoint().meta, checkpoint_id: 'A', previous_checkpoint: 'B.yaml.gz' } });

    // A is uncompressed, B is compressed
    fs.writeFileSync(path.join(checkpointsDir, 'A.yaml'), yaml.dump(cpA));
    const compressed = zlib.gzipSync(Buffer.from(yaml.dump(cpB), 'utf-8'));
    fs.writeFileSync(path.join(checkpointsDir, 'B.yaml.gz'), compressed);

    const chain = followHopChain(checkpointsDir, 'A.yaml', 3);
    expect(chain).toHaveLength(2);
    expect(chain[0].meta.checkpoint_id).toBe('A');
    expect(chain[1].meta.checkpoint_id).toBe('B');
  });
});

describe('loadCheckpoint with compression', () => {
  let db: TestDatabase;
  let tmpDir: string;
  let checkpointsDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-load-compress-'));
    checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to compressed file when DB has no rows', () => {
    const cp = makeCheckpoint();
    const yamlContent = yaml.dump(cp);
    const compressed = zlib.gzipSync(Buffer.from(yamlContent, 'utf-8'));
    fs.writeFileSync(path.join(checkpointsDir, 'test.yaml.gz'), compressed);
    fs.writeFileSync(path.join(checkpointsDir, 'latest.yaml'), 'ref: test.yaml.gz\n');

    const result = loadCheckpoint(db, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('claudex/checkpoint');
    expect(result!.working.task).toBe('test task');
  });

  it('full round-trip: write compressed -> load via DB -> verify data', async () => {
    const writeResult = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
      compression: true,
    });

    expect(writeResult).not.toBeNull();

    // Load via DB layer (which stores checkpoint data in JSON)
    const loaded = loadCheckpoint(db, tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.schema).toBe('claudex/checkpoint');
    expect(loaded!.meta.checkpoint_id).toBe(writeResult!.checkpointId);
  });
});
