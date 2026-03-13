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

  describe('paths with spaces', () => {
    it('ensureDir creates directory with spaces in name', () => {
      const dirWithSpaces = path.join(tmpDir, 'my directory', 'sub folder');
      const result = ensureDir(dirWithSpaces);
      expect(result).toBe(true);
      expect(fs.existsSync(dirWithSpaces)).toBe(true);
    });

    it('atomicWriteFile writes to path with spaces', async () => {
      const filePath = path.join(tmpDir, 'dir with spaces', 'my file.json');
      const result = await atomicWriteFile(filePath, '{"ok": true}');
      expect(result).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"ok": true}');
    });

    it('readJsonFile reads from path with spaces', async () => {
      const filePath = path.join(tmpDir, 'space dir', 'data.json');
      await atomicWriteFile(filePath, '{"key": "value"}');
      const result = readJsonFile<{ key: string }>(filePath);
      expect(result).toEqual({ key: 'value' });
    });

    it('writeJsonFile + readJsonFile roundtrip with spaces in path', async () => {
      const filePath = path.join(tmpDir, 'My Documents', 'config data.json');
      const data = { name: 'test with spaces', count: 1 };
      const written = await writeJsonFile(filePath, data);
      expect(written).toBe(true);
      const read = readJsonFile<typeof data>(filePath);
      expect(read).toEqual(data);
    });
  });

  describe('paths with unicode characters', () => {
    it('ensureDir creates directory with unicode name', () => {
      const unicodeDir = path.join(tmpDir, 'Ünîcödé', 'проект');
      const result = ensureDir(unicodeDir);
      expect(result).toBe(true);
      expect(fs.existsSync(unicodeDir)).toBe(true);
    });

    it('atomicWriteFile writes to unicode path', async () => {
      const filePath = path.join(tmpDir, 'données', 'fichier.json');
      const result = await atomicWriteFile(filePath, '{"ünïcödé": true}');
      expect(result).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"ünïcödé": true}');
    });

    it('readJsonFile reads from unicode path', async () => {
      const filePath = path.join(tmpDir, 'données', 'lecture.json');
      await atomicWriteFile(filePath, '{"clé": "valeur"}');
      const result = readJsonFile<{ clé: string }>(filePath);
      expect(result).toEqual({ clé: 'valeur' });
    });

    it('writeJsonFile + readJsonFile roundtrip with unicode data and path', async () => {
      const filePath = path.join(tmpDir, '日本語フォルダ', 'データ.json');
      const data = { 名前: 'テスト', カウント: 42 };
      const written = await writeJsonFile(filePath, data);
      expect(written).toBe(true);
      const read = readJsonFile<typeof data>(filePath);
      expect(read).toEqual(data);
    });

    it('handles CJK characters in directory names', () => {
      const cjkDir = path.join(tmpDir, '用户', '项目', '子目录');
      const result = ensureDir(cjkDir);
      expect(result).toBe(true);
      expect(fs.existsSync(cjkDir)).toBe(true);
    });
  });

  describe('long paths (>260 chars)', () => {
    it('ensureDir creates deeply nested directory structure', () => {
      const segments = Array.from({ length: 20 }, (_, i) => `segment_${i}`);
      const deepDir = path.join(tmpDir, ...segments);
      const result = ensureDir(deepDir);
      expect(result).toBe(true);
      expect(fs.existsSync(deepDir)).toBe(true);
    });

    it('atomicWriteFile writes to long path', async () => {
      const longName = 'a'.repeat(100);
      const filePath = path.join(tmpDir, longName, `${longName}.json`);
      const result = await atomicWriteFile(filePath, 'long path content');
      expect(result).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('long path content');
    });

    it('writeJsonFile + readJsonFile roundtrip with long path', async () => {
      const segments = Array.from({ length: 15 }, (_, i) => `dir_${i}_name`);
      const filePath = path.join(tmpDir, ...segments, 'data.json');
      const data = { long: true };
      const written = await writeJsonFile(filePath, data);
      expect(written).toBe(true);
      const read = readJsonFile<typeof data>(filePath);
      expect(read).toEqual(data);
    });
  });
});
