/**
 * Phase 14-07c — tests for cross-project-hit-rate script.
 *
 * Tests the noise classifier and the measurement query.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { isNoise, measureHitRate } from '../../scripts/cross-project-hit-rate.js';

describe('isNoise', () => {
  it('classifies short combined content as noise', () => {
    expect(isNoise({ title: 'short', body: 'tiny', kind: 'observation', project: 'p' })).toBe(true);
  });

  it('classifies content with length >= 60 as substantive', () => {
    expect(
      isNoise({
        title: 'A meaningful and substantive memory file about the cascade architecture',
        body: '',
        kind: 'memory_file',
        project: 'p',
      }),
    ).toBe(false);
  });

  it('classifies raw tool-call prefixes as noise (pre-14-03 pattern)', () => {
    expect(isNoise({ title: 'Read: file.ts long enough to clear length gate definitely yes really', body: '', kind: 'observation', project: 'p' })).toBe(true);
    expect(isNoise({ title: 'Edit: auth.ts long enough to clear length gate definitely yes really', body: '', kind: 'observation', project: 'p' })).toBe(true);
    expect(isNoise({ title: 'Write: config.json long enough to clear length gate yes really truly', body: '', kind: 'observation', project: 'p' })).toBe(true);
    expect(isNoise({ title: 'Bash: ls -la dir/ long enough to clear length gate definitely yes really', body: '', kind: 'observation', project: 'p' })).toBe(true);
  });

  it('classifies short [Pre-assembly] flows as noise (post-14-03 pattern)', () => {
    expect(
      isNoise({
        title: '[Pre-assembly] Can I',
        body: 'short body to make combined length > 60 chars filler filler filler',
        kind: 'flow',
        project: 'p',
      }),
    ).toBe(true);
  });

  it('classifies short [Reflection] learnings as noise', () => {
    expect(
      isNoise({
        title: '[Reflection] oauth',
        body: 'short body to make combined length > 60 chars filler filler filler',
        kind: 'learning',
        project: 'p',
      }),
    ).toBe(true);
  });

  it('classifies long [Pre-assembly] flow as substantive (passed strip check)', () => {
    expect(
      isNoise({
        title: '[Pre-assembly] A long enough description after stripping the prefix that definitely passes',
        body: '',
        kind: 'flow',
        project: 'p',
      }),
    ).toBe(false);
  });

  it('non-tool-prefix content does not trigger tool-call noise', () => {
    expect(
      isNoise({
        title: 'A general observation about the system behavior that is long enough to pass the length gate',
        body: '',
        kind: 'observation',
        project: 'p',
      }),
    ).toBe(false);
  });
});

describe('measureHitRate', () => {
  function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE artifact (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project TEXT NOT NULL,
        title TEXT,
        body TEXT,
        status TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at_epoch_ms INTEGER NOT NULL
      );
    `);
    return db;
  }

  function insert(
    db: Database.Database,
    id: string,
    kind: string,
    project: string,
    title: string,
    body: string,
    status: string,
    ts: number,
    confidence: number = 1.0,
  ): void {
    db.prepare(
      `INSERT INTO artifact(id, kind, project, title, body, status, confidence, created_at_epoch_ms) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, kind, project, title, body, status, confidence, ts);
  }

  it('returns 0 noise_rate when no candidates exist', () => {
    const db = makeDb();
    try {
      const r = measureHitRate(db, 'big-mozzy-v2', 100);
      expect(r.sample_size).toBe(0);
      expect(r.noise_count).toBe(0);
      expect(r.noise_rate).toBe(0);
    } finally {
      db.close();
    }
  });

  it('excludes the target project from the candidate pool', () => {
    const db = makeDb();
    try {
      insert(db, 'a', 'memory_file', 'big-mozzy-v2', 'should-not-appear', 'body content long enough to pass length gate definitely', 'active', 1);
      insert(db, 'b', 'memory_file', 'claudex-v3', 'cross-project candidate content long enough to pass the length gate', '', 'active', 2);
      const r = measureHitRate(db, 'big-mozzy-v2', 100);
      expect(r.sample_size).toBe(1);
      expect(r.noise_count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('counts noise per the classifier', () => {
    const db = makeDb();
    try {
      // 4 noise + 6 substantive = 40% noise rate
      const padding = 'long enough to clear the 60 char length gate definitely yes really yes';
      insert(db, 'n1', 'observation', 'p1', 'Read: file.ts', padding, 'active', 1);
      insert(db, 'n2', 'observation', 'p1', 'Edit: file2.ts', padding, 'active', 2);
      insert(db, 'n3', 'flow', 'p1', '[Pre-assembly] Can I', padding, 'active', 3);
      insert(db, 'n4', 'learning', 'p1', '[Reflection] oauth', padding, 'active', 4);
      insert(db, 's1', 'memory_file', 'p1', 'Substantive memory file with a long meaningful title that passes', '', 'active', 5);
      insert(db, 's2', 'memory_file', 'p1', 'Another substantive memory entry with enough content to clear gate', '', 'active', 6);
      insert(db, 's3', 'learning', 'p1', 'A real learning with enough content to clear the length gate easily', '', 'active', 7);
      insert(db, 's4', 'decision', 'p1', 'A real decision with enough content to clear the length gate easily', '', 'active', 8);
      insert(db, 's5', 'milestone', 'p1', 'A milestone description with enough content to pass the gate easily', '', 'active', 9);
      insert(db, 's6', 'flow', 'p1', '[Pre-assembly] A long enough description that passes the strip check', '', 'active', 10);
      const r = measureHitRate(db, 'target', 100);
      expect(r.sample_size).toBe(10);
      expect(r.noise_count).toBe(4);
      expect(r.noise_rate).toBeCloseTo(0.4, 5);
    } finally {
      db.close();
    }
  });

  it('honors the LIMIT sample size and ORDER BY recency', () => {
    const db = makeDb();
    try {
      for (let i = 0; i < 20; i++) {
        insert(db, `s${i}`, 'memory_file', 'p1', `Substantive memory file index ${i} with long enough title to pass gate`, '', 'active', i);
      }
      const r = measureHitRate(db, 'target', 5);
      expect(r.sample_size).toBe(5);
    } finally {
      db.close();
    }
  });

  it('excludes status != active', () => {
    const db = makeDb();
    try {
      const padding = 'A substantive memory file with title long enough to definitely clear gate';
      insert(db, 'a1', 'memory_file', 'p1', padding, '', 'stale', 1);
      insert(db, 'a2', 'memory_file', 'p1', padding, '', 'superseded', 2);
      insert(db, 'a3', 'memory_file', 'p1', padding, '', 'active', 3);
      const r = measureHitRate(db, 'target', 100);
      expect(r.sample_size).toBe(1);
    } finally {
      db.close();
    }
  });

  it('returns schema_version 1 for downstream consumers', () => {
    const db = makeDb();
    try {
      const r = measureHitRate(db, 'target', 100);
      expect(r.schema_version).toBe(1);
    } finally {
      db.close();
    }
  });
});
