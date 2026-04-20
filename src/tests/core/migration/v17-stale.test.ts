import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { scanStaleRows, STALE_KEYWORDS } from '../../../core/migration/v17-stale-scan.js';
import {
  writeStaleReview,
  parseStaleReview,
  getStaleIds,
} from '../../../core/migration/stale-review-parser.js';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-stale-'));
}

function seedPcc(db: Database.Database, rows: { content: string }[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_curated_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL
    );
  `);
  const stmt = db.prepare('INSERT INTO project_curated_context(content) VALUES (?)');
  for (const r of rows) stmt.run(r.content);
}

describe('v17-stale-scan.scanStaleRows', () => {
  let db: Database.Database;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('returns empty array when table does not exist', () => {
    expect(scanStaleRows(db)).toEqual([]);
  });

  it('returns empty array when no rows match', () => {
    seedPcc(db, [{ content: 'clean content' }, { content: 'nothing to see here' }]);
    expect(scanStaleRows(db)).toEqual([]);
  });

  it('matches "Gemma 4 31B" (case-insensitive)', () => {
    seedPcc(db, [
      { content: 'Uses Gemma 4 31B for local inference' },
      { content: 'Prefers gemma 4 31b locally' }, // case-insensitive
      { content: 'unrelated content' },
    ]);
    const m = scanStaleRows(db);
    expect(m.length).toBe(2);
    expect(m[0].legacyId).toBeLessThan(m[1].legacyId);
    expect(m[0].triggers).toContain('Gemma 4 31B');
  });

  it('matches "llama-server:8081"', () => {
    seedPcc(db, [{ content: 'points at llama-server:8081' }]);
    const m = scanStaleRows(db);
    expect(m.length).toBe(1);
    expect(m[0].triggers).toContain('llama-server:8081');
  });

  it('matches "local llama-server"', () => {
    seedPcc(db, [{ content: 'default routes through local llama-server by design' }]);
    const m = scanStaleRows(db);
    expect(m.length).toBe(1);
    expect(m[0].triggers).toContain('local llama-server');
  });

  it('captures multiple triggers on one row', () => {
    seedPcc(db, [{ content: 'Uses Gemma 4 31B via local llama-server on port 8081' }]);
    const m = scanStaleRows(db);
    expect(m.length).toBe(1);
    // 'Gemma 4 31B' + 'local llama-server' match.
    expect(m[0].triggers.length).toBeGreaterThanOrEqual(2);
  });

  it('produces preview with newlines collapsed and 120-char cap', () => {
    const long = 'line one\nline two\nline three ' + 'x'.repeat(200);
    seedPcc(db, [{ content: 'Gemma 4 31B at front, then ' + long }]);
    const m = scanStaleRows(db);
    expect(m.length).toBe(1);
    expect(m[0].contentPreview.length).toBeLessThanOrEqual(120);
    expect(m[0].contentPreview).not.toContain('\n');
  });

  it('orders results by legacyId ascending', () => {
    // Insert non-contiguous ids (SQLite AUTOINCREMENT handles it; we just assert monotonicity)
    seedPcc(db, [
      { content: 'first Gemma 4 31B' },
      { content: 'clean' },
      { content: 'second Gemma 4 31B' },
      { content: 'third llama-server:8081' },
    ]);
    const m = scanStaleRows(db);
    expect(m.length).toBe(3);
    expect(m[0].legacyId).toBeLessThan(m[1].legacyId);
    expect(m[1].legacyId).toBeLessThan(m[2].legacyId);
  });

  it('STALE_KEYWORDS matches the CONTEXT spec exactly', () => {
    expect([...STALE_KEYWORDS]).toEqual([
      'Gemma 4 31B',
      'llama-server:8081',
      'local llama-server',
    ]);
  });
});

describe('stale-review-parser.writeStaleReview + parseStaleReview round-trip', () => {
  let tmp: string;

  beforeEach(() => { tmp = mkTempDir(); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

  it('writes and re-parses the same matches', () => {
    const matches = [
      { legacyId: 10, contentPreview: 'one Gemma 4 31B', triggers: ['Gemma 4 31B' as const] },
      { legacyId: 7, contentPreview: 'two llama-server:8081', triggers: ['llama-server:8081' as const] },
    ];
    const p = path.join(tmp, 'stale-review.md');
    writeStaleReview(p, matches);
    const parsed = parseStaleReview(p);
    expect(parsed.heuristicMatches.length).toBe(2);
    // writer sorts by legacyId ascending
    expect(parsed.heuristicMatches[0].legacyId).toBe(7);
    expect(parsed.heuristicMatches[1].legacyId).toBe(10);
    expect(parsed.manualAdditions).toEqual([]);
  });

  it('empty matches still writes valid parseable file', () => {
    const p = path.join(tmp, 'stale-review.md');
    writeStaleReview(p, []);
    const parsed = parseStaleReview(p);
    expect(parsed.heuristicMatches).toEqual([]);
    expect(parsed.manualAdditions).toEqual([]);
  });

  it('getStaleIds excludes rows flipped to keep', () => {
    const p = path.join(tmp, 'stale-review.md');
    writeStaleReview(p, [
      { legacyId: 1, contentPreview: 'a Gemma 4 31B', triggers: ['Gemma 4 31B'] },
      { legacyId: 2, contentPreview: 'b Gemma 4 31B', triggers: ['Gemma 4 31B'] },
    ]);
    // Flip id=1 to keep by hand-editing
    const raw = fs.readFileSync(p, 'utf8');
    const flipped = raw.replace('id=1 | status=stale', 'id=1 | status=keep');
    fs.writeFileSync(p, flipped, 'utf8');
    const parsed = parseStaleReview(p);
    const ids = getStaleIds(parsed);
    expect(ids.has(1)).toBe(false);
    expect(ids.has(2)).toBe(true);
  });

  it('getStaleIds includes manual additions', () => {
    const p = path.join(tmp, 'stale-review.md');
    writeStaleReview(p, []);
    const raw = fs.readFileSync(p, 'utf8');
    const withManual = raw.replace(
      '<!-- add additional stale rows below -->',
      '<!-- add additional stale rows below -->\n- id=99 | status=stale | content="hand-added stale row"',
    );
    fs.writeFileSync(p, withManual, 'utf8');
    const parsed = parseStaleReview(p);
    expect(parsed.manualAdditions.length).toBe(1);
    expect(parsed.manualAdditions[0].legacyId).toBe(99);
    const ids = getStaleIds(parsed);
    expect(ids.has(99)).toBe(true);
  });

  it('throws on missing file with clear message', () => {
    expect(() => parseStaleReview(path.join(tmp, 'nope.md'))).toThrow(/missing/);
  });

  it('throws on malformed line with line number', () => {
    const p = path.join(tmp, 'stale-review.md');
    writeStaleReview(p, [
      { legacyId: 1, contentPreview: 'a', triggers: ['Gemma 4 31B'] },
    ]);
    const raw = fs.readFileSync(p, 'utf8');
    const broken = raw.replace(
      '- id=1 | status=stale',
      '- id=GARBAGE | status=notastatus',
    );
    fs.writeFileSync(p, broken, 'utf8');
    expect(() => parseStaleReview(p)).toThrow(/malformed at line/);
  });

  it('manual addition with status=keep is rejected', () => {
    const p = path.join(tmp, 'stale-review.md');
    writeStaleReview(p, []);
    const raw = fs.readFileSync(p, 'utf8');
    const invalid = raw.replace(
      '<!-- add additional stale rows below -->',
      '<!-- add additional stale rows below -->\n- id=5 | status=keep | content="no keeps in manual"',
    );
    fs.writeFileSync(p, invalid, 'utf8');
    expect(() => parseStaleReview(p)).toThrow(/manual addition must have status=stale/);
  });
});
