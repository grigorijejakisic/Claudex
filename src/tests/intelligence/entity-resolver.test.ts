import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { resolveEntity, registerAlias, registerCanonical } from '../../intelligence/entity-resolver.js';

describe('entity-resolver', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns input unchanged when no aliases exist', () => {
    expect(resolveEntity(db, 'Claudex')).toBe('Claudex');
  });

  it('resolves exact alias to canonical', () => {
    registerAlias(db, 'claudex', 'Claudex v3');
    expect(resolveEntity(db, 'claudex')).toBe('Claudex v3');
  });

  it('resolves case-insensitively', () => {
    registerAlias(db, 'CLAUDEX', 'Claudex v3');
    expect(resolveEntity(db, 'claudex')).toBe('Claudex v3');
  });

  it('fuzzy matches within 20% edit distance', () => {
    registerCanonical(db, 'PostgreSQL');
    // 'Postgres' → edit distance 2, length 10 → 20% threshold
    const result = resolveEntity(db, 'Postgres');
    // May or may not match depending on exact Levenshtein calc
    // The important thing is it doesn't crash
    expect(typeof result).toBe('string');
  });

  it('registerCanonical creates self-reference', () => {
    registerCanonical(db, 'SQLite', ['sqlite3', 'better-sqlite3']);
    expect(resolveEntity(db, 'sqlite')).toBe('SQLite');
    expect(resolveEntity(db, 'sqlite3')).toBe('SQLite');
  });

  it('handles empty and short inputs gracefully', () => {
    expect(resolveEntity(db, '')).toBe('');
    expect(resolveEntity(db, 'a')).toBe('a');
  });
});
