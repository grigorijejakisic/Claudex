import { describe, it, expect } from 'vitest';
import { scoreFileAccess, ensureStateDir } from '../../src/cm-adapter/state-files.js';
import type { FileAccess } from '../../src/cm-adapter/types.js';

describe('resolveStateDir validation', () => {
  it('rejects session IDs with path traversal characters', async () => {
    await expect(ensureStateDir('../etc/passwd')).rejects.toThrow('Invalid session ID: contains disallowed characters');
  });

  it('rejects session IDs with slashes', async () => {
    await expect(ensureStateDir('foo/bar')).rejects.toThrow('Invalid session ID: contains disallowed characters');
  });

  it('rejects session IDs with spaces', async () => {
    await expect(ensureStateDir('foo bar')).rejects.toThrow('Invalid session ID: contains disallowed characters');
  });

  it('rejects session IDs with dots', async () => {
    await expect(ensureStateDir('foo.bar')).rejects.toThrow('Invalid session ID: contains disallowed characters');
  });
});

describe('scoreFileAccess', () => {
  const now = new Date('2026-03-07T12:00:00Z');

  function makeFile(overrides: Partial<FileAccess> & { last_accessed: string }): FileAccess {
    return {
      path: '/test/file.ts',
      access_count: 1,
      kind: 'read',
      ...overrides,
    };
  }

  it('scores a recently accessed file higher than an old file', () => {
    const recent = makeFile({ last_accessed: '2026-03-07T11:55:00Z' }); // 5 min ago
    const old = makeFile({ last_accessed: '2026-03-07T06:00:00Z' });    // 6 hours ago

    const recentScore = scoreFileAccess(recent, now);
    const oldScore = scoreFileAccess(old, now);

    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it('scores a modified file 1.5x vs a read file (same recency and count)', () => {
    const readFile = makeFile({
      last_accessed: now.toISOString(),
      kind: 'read',
    });
    const modFile = makeFile({
      last_accessed: now.toISOString(),
      kind: 'modified',
    });

    const readScore = scoreFileAccess(readFile, now);
    const modScore = scoreFileAccess(modFile, now);

    expect(modScore / readScore).toBeCloseTo(1.5, 5);
  });

  it('scores higher access_count higher', () => {
    const low = makeFile({ last_accessed: now.toISOString(), access_count: 1 });
    const high = makeFile({ last_accessed: now.toISOString(), access_count: 5 });

    const lowScore = scoreFileAccess(low, now);
    const highScore = scoreFileAccess(high, now);

    expect(highScore).toBeGreaterThan(lowScore);
    expect(highScore / lowScore).toBeCloseTo(5, 5);
  });

  it('scores very old file approaching 0', () => {
    const veryOld = makeFile({
      last_accessed: '2026-03-01T00:00:00Z', // ~6.5 days ago
    });

    const score = scoreFileAccess(veryOld, now);
    expect(score).toBeLessThan(0.01);
  });

  it('scores file accessed at exactly now as access_count * kindBonus', () => {
    const file = makeFile({
      last_accessed: now.toISOString(),
      access_count: 3,
      kind: 'modified',
    });

    const score = scoreFileAccess(file, now);
    // recency = exp(0) = 1, kindBonus = 1.5
    expect(score).toBeCloseTo(3 * 1.5, 5);
  });

  it('uses exponential decay with rate 0.003 per minute', () => {
    // 100 minutes ago → recency = exp(-0.003 * 100) = exp(-0.3) ≈ 0.7408
    const file = makeFile({
      last_accessed: new Date(now.getTime() - 100 * 60000).toISOString(),
      access_count: 1,
      kind: 'read',
    });

    const score = scoreFileAccess(file, now);
    expect(score).toBeCloseTo(Math.exp(-0.3), 4);
  });

  it('treats malformed last_accessed as zero age (max recency)', () => {
    const file = makeFile({
      last_accessed: 'not-a-date',
      access_count: 2,
      kind: 'read',
    });

    const score = scoreFileAccess(file, now);
    // NaN timestamp → ageMinutes = 0 → recency = exp(0) = 1
    expect(score).toBeCloseTo(2, 5);
  });
});
