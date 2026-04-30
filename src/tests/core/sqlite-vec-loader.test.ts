/**
 * Tests for the sqlite-vec loader (Phase 1 of the Qdrant → sqlite-vec migration).
 *
 * These tests verify that:
 * 1. The extension loads successfully on the current machine.
 * 2. encodeVector produces a Buffer that vec0 can accept.
 * 3. initializeSchema creates the 5 vec0 virtual tables after migration.
 * 4. KNN queries work end-to-end against the created tables.
 *
 * If sqlite-vec fails to load on a contributor's machine (missing binary,
 * platform mismatch), these tests will fail loudly with a clear error — which
 * is the signal to either install the package correctly or skip this migration
 * in that environment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import {
  loadSqliteVec,
  encodeVector,
  sqliteVecLoadStatus,
  resetSqliteVecLoadStatus,
} from '../../core/sqlite-vec-loader.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

describe('sqlite-vec loader', () => {
  beforeEach(() => {
    resetSqliteVecLoadStatus();
  });

  describe('loadSqliteVec', () => {
    it('loads the extension on a fresh in-memory DB', () => {
      const db = new Database(':memory:');
      const ok = loadSqliteVec(db);
      expect(ok).toBe(true);
      db.close();
    });

    it('vec_version() returns a non-null version string after loading', () => {
      const db = new Database(':memory:');
      loadSqliteVec(db);
      const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
      expect(row.v).toBeTruthy();
      expect(typeof row.v).toBe('string');
      db.close();
    });

    it('is idempotent per-connection (multiple calls succeed)', () => {
      const db = new Database(':memory:');
      expect(loadSqliteVec(db)).toBe(true);
      expect(loadSqliteVec(db)).toBe(true);
      expect(loadSqliteVec(db)).toBe(true);
      db.close();
    });

    it('reports success via sqliteVecLoadStatus after a successful load', () => {
      const db = new Database(':memory:');
      loadSqliteVec(db);
      const status = sqliteVecLoadStatus();
      expect(status.attempted).toBe(true);
      expect(status.succeeded).toBe(true);
      expect(status.error).toBeNull();
      db.close();
    });
  });

  describe('encodeVector', () => {
    it('wraps a Float32Array in a Buffer of correct byte length', () => {
      const arr = new Float32Array(1024).fill(0.5);
      const buf = encodeVector(arr);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(1024 * 4); // float32 = 4 bytes per element
    });

    it('converts a plain number array into a Float32-packed Buffer', () => {
      const arr = Array(10).fill(0.25);
      const buf = encodeVector(arr);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(10 * 4);
      // Read back the first float — should be 0.25.
      expect(buf.readFloatLE(0)).toBeCloseTo(0.25, 5);
    });

    it('preserves exact Float32Array byte content', () => {
      const arr = new Float32Array([1.0, 2.5, -3.25, 0.125]);
      const buf = encodeVector(arr);
      expect(buf.readFloatLE(0)).toBeCloseTo(1.0);
      expect(buf.readFloatLE(4)).toBeCloseTo(2.5);
      expect(buf.readFloatLE(8)).toBeCloseTo(-3.25);
      expect(buf.readFloatLE(12)).toBeCloseTo(0.125);
    });
  });

  describe('V14→V15 migration creates vec0 virtual tables', () => {
    it('initializeSchema creates all 5 vec_* virtual tables', () => {
      const db = createTestDb();

      // Filter by sql LIKE '%VIRTUAL TABLE%' to exclude sqlite-vec's
      // auxiliary shadow tables (each vec0 virtual table creates ~5 hidden
      // tables for chunk storage, rowid index, etc.).
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'vec_%' AND sql LIKE '%VIRTUAL TABLE%'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      const names = tables.map(t => t.name);
      expect(names).toContain('vec_artifacts');
      expect(names).toContain('vec_patterns');
      expect(names).toContain('vec_threads');
      expect(names).toContain('vec_journal');
      expect(names).toContain('vec_conversations');

      db.close();
    });

    it('sets user_version to current TARGET_VERSION (21 after Phase 6.5) after initializeSchema', () => {
      const db = createTestDb();
      const row = (db.pragma('user_version') as Array<{ user_version: number }>)[0];
      expect(row.user_version).toBe(24);
      db.close();
    });

    it('running migrations twice is idempotent', () => {
      const db = createTestDb();
      // Run migrations again — should not throw
      expect(() => runMigrations(db)).not.toThrow();

      // All 5 virtual tables should still exist and be queryable.
      const tables = ['vec_artifacts', 'vec_patterns', 'vec_threads', 'vec_journal', 'vec_conversations'];
      for (const table of tables) {
        expect(() => db.prepare(`SELECT COUNT(*) FROM ${table}`).get()).not.toThrow();
      }

      db.close();
    });
  });

  describe('vec0 virtual table functionality', () => {
    it('can insert and KNN-query a 1024-dim vector in vec_artifacts', () => {
      const db = createTestDb();

      // Insert 3 vectors with distinct fill values — closest to query should rank first.
      const insert = db.prepare('INSERT INTO vec_artifacts (rowid, embedding) VALUES (?, ?)');
      insert.run(BigInt(1), encodeVector(new Float32Array(1024).fill(0.1)));
      insert.run(BigInt(2), encodeVector(new Float32Array(1024).fill(0.9)));
      insert.run(BigInt(3), encodeVector(new Float32Array(1024).fill(0.15)));

      // Query close to 0.12 — rowid 1 (fill 0.10) should win, then rowid 3 (fill 0.15).
      const queryVec = encodeVector(new Float32Array(1024).fill(0.12));
      const results = db.prepare(`
        SELECT rowid, distance
        FROM vec_artifacts
        WHERE embedding MATCH ?
          AND k = 3
        ORDER BY distance
      `).all(queryVec) as Array<{ rowid: number; distance: number }>;

      expect(results).toHaveLength(3);
      expect(results[0].rowid).toBe(1); // closest
      expect(results[1].rowid).toBe(3); // second
      expect(results[2].rowid).toBe(2); // furthest
      expect(results[0].distance).toBeLessThan(results[1].distance);
      expect(results[1].distance).toBeLessThan(results[2].distance);

      db.close();
    });

    it('rejects JavaScript Number as rowid (documented gotcha)', () => {
      const db = createTestDb();
      const insert = db.prepare('INSERT INTO vec_artifacts (rowid, embedding) VALUES (?, ?)');
      const vec = encodeVector(new Float32Array(1024).fill(0.5));

      // Plain Number — this is the trap: better-sqlite3 binds as REAL, vec0 rejects.
      expect(() => insert.run(1, vec)).toThrow(/Only integers/);

      // BigInt — this is the correct binding.
      expect(() => insert.run(BigInt(42), vec)).not.toThrow();

      db.close();
    });

    it('can insert into all 5 vec_* tables without errors', () => {
      const db = createTestDb();
      const tables = ['vec_artifacts', 'vec_patterns', 'vec_threads', 'vec_journal', 'vec_conversations'];
      const vec = encodeVector(new Float32Array(1024).fill(0.5));

      for (const table of tables) {
        const insert = db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`);
        expect(() => insert.run(BigInt(1), vec)).not.toThrow();

        const count = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        expect(count).toBe(1);
      }

      db.close();
    });
  });
});
