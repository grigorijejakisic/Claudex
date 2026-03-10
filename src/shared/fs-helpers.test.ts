import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFile, readJsonFile, writeJsonFile, ensureDir } from './fs-helpers.js';

describe('fs-helpers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe('ensureDir', () => {
    it('creates nested directories', () => {
      const nested = path.join(tmpDir, 'a', 'b', 'c');
      const result = ensureDir(nested);
      expect(result).toBe(true);
      expect(fs.existsSync(nested)).toBe(true);
    });

    it('returns true for existing directory', () => {
      expect(ensureDir(tmpDir)).toBe(true);
    });
  });

  describe('readJsonFile', () => {
    it('returns null for missing file', () => {
      const result = readJsonFile(path.join(tmpDir, 'nonexistent.json'));
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, 'not json', 'utf-8');
      const result = readJsonFile(filePath);
      expect(result).toBeNull();
    });

    it('reads valid JSON', () => {
      const filePath = path.join(tmpDir, 'good.json');
      fs.writeFileSync(filePath, '{"key": "value"}', 'utf-8');
      const result = readJsonFile<{ key: string }>(filePath);
      expect(result).toEqual({ key: 'value' });
    });
  });

  describe('atomicWriteFile', () => {
    it('creates file with content', async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      const result = await atomicWriteFile(filePath, 'hello world');
      expect(result).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
    });

    it('creates parent directories', async () => {
      const filePath = path.join(tmpDir, 'nested', 'dir', 'test.txt');
      const result = await atomicWriteFile(filePath, 'nested content');
      expect(result).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('nested content');
    });
  });

  describe('writeJsonFile + readJsonFile roundtrip', () => {
    it('writes and reads back identical data', async () => {
      const filePath = path.join(tmpDir, 'roundtrip.json');
      const data = { name: 'test', count: 42, nested: { flag: true } };
      const written = await writeJsonFile(filePath, data);
      expect(written).toBe(true);
      const read = readJsonFile<typeof data>(filePath);
      expect(read).toEqual(data);
    });
  });
});
