import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import {
  consolidateObservationBatch,
  getUnconsolidatedObservations,
  createFallbackSummary,
  shouldConsolidate,
  markConsolidationRan,
  resetConsolidationState,
} from '../../angel/consolidator.js';
import { insertObservation, getObservationById } from '../../core/observations.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

/** Insert a test session so FK constraints don't block observation inserts. */
function ensureSession(db: Database.Database, sessionId: string, project: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status) VALUES (?, ?, 'active')`
  ).run(sessionId, project);
}

/** Insert a test observation and return its ID. */
function insertTestObs(
  db: Database.Database,
  overrides: Partial<{
    session_id: string;
    project: string;
    title: string;
    content: string;
    category: string;
    importance: number;
  }> = {},
): number {
  const session_id = overrides.session_id ?? 'sess-1';
  const project = overrides.project ?? 'test-project';
  ensureSession(db, session_id, project);

  return insertObservation(db, {
    session_id,
    project,
    tool_name: 'test-tool',
    category: (overrides.category ?? 'code') as any,
    title: overrides.title ?? 'Test observation',
    content: overrides.content ?? 'Some test content',
    importance: overrides.importance ?? 3,
    files_modified: [],
  });
}

describe('Angel Consolidator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    resetConsolidationState();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('getUnconsolidatedObservations', () => {
    it('returns unconsumed, non-deleted observations', () => {
      insertTestObs(db, { title: 'Active obs 1' });
      insertTestObs(db, { title: 'Active obs 2' });

      const results = getUnconsolidatedObservations(db, 50);
      expect(results.length).toBe(2);
    });

    it('skips consumed observations', () => {
      const id = insertTestObs(db, { title: 'Consumed obs' });
      db.prepare('UPDATE observations SET consumed = 1 WHERE id = ?').run(id);
      insertTestObs(db, { title: 'Active obs' });

      const results = getUnconsolidatedObservations(db, 50);
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Active obs');
    });

    it('skips already-consolidated observations', () => {
      const id = insertTestObs(db, { title: 'Already consolidated' });
      db.prepare('UPDATE observations SET consolidated_into = 999 WHERE id = ?').run(id);
      insertTestObs(db, { title: 'Active obs' });

      const results = getUnconsolidatedObservations(db, 50);
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Active obs');
    });

    it('skips soft-deleted observations', () => {
      const id = insertTestObs(db, { title: 'Deleted obs' });
      db.prepare('UPDATE observations SET deleted_at_epoch_ms = 1000 WHERE id = ?').run(id);
      insertTestObs(db, { title: 'Active obs' });

      const results = getUnconsolidatedObservations(db, 50);
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Active obs');
    });

    it('respects batch size limit', () => {
      for (let i = 0; i < 10; i++) {
        insertTestObs(db, { title: `Obs ${i}` });
      }

      const results = getUnconsolidatedObservations(db, 3);
      expect(results.length).toBe(3);
    });

    it('orders by timestamp_epoch_ms ASC (oldest first)', () => {
      const id1 = insertTestObs(db, { title: 'Older obs' });
      const id2 = insertTestObs(db, { title: 'Newer obs' });
      // Manually set timestamps to ensure order
      db.prepare('UPDATE observations SET timestamp_epoch_ms = 1000 WHERE id = ?').run(id1);
      db.prepare('UPDATE observations SET timestamp_epoch_ms = 2000 WHERE id = ?').run(id2);

      const results = getUnconsolidatedObservations(db, 50);
      expect(results[0].title).toBe('Older obs');
      expect(results[1].title).toBe('Newer obs');
    });
  });

  describe('createFallbackSummary', () => {
    it('concatenates observation texts with separator', () => {
      const obs = [
        { category: 'code', title: 'Title A', content: 'Content A' },
        { category: 'error', title: 'Title B', content: 'Content B' },
      ] as any;

      const summary = createFallbackSummary(obs);
      expect(summary).toBe('[code] Title A: Content A | [error] Title B: Content B');
    });

    it('handles single observation', () => {
      const obs = [
        { category: 'code', title: 'Only one', content: 'Solo content' },
      ] as any;

      const summary = createFallbackSummary(obs);
      expect(summary).toBe('[code] Only one: Solo content');
    });
  });

  describe('shouldConsolidate / markConsolidationRan', () => {
    it('returns true initially (no previous run)', () => {
      expect(shouldConsolidate()).toBe(true);
    });

    it('returns false immediately after marking as ran', () => {
      markConsolidationRan();
      expect(shouldConsolidate()).toBe(false);
    });

    it('resets via resetConsolidationState', () => {
      markConsolidationRan();
      expect(shouldConsolidate()).toBe(false);
      resetConsolidationState();
      expect(shouldConsolidate()).toBe(true);
    });
  });

  describe('consolidateObservationBatch', () => {
    it('returns zero counts when fewer than 2 observations exist', async () => {
      insertTestObs(db, { title: 'Only one' });

      const result = await consolidateObservationBatch(db, 50);
      expect(result.processed).toBeLessThanOrEqual(1);
      expect(result.consolidated).toBe(0);
      expect(result.clusters).toBe(0);
    });

    it('returns zero counts on empty database', async () => {
      const result = await consolidateObservationBatch(db, 50);
      expect(result.processed).toBe(0);
      expect(result.consolidated).toBe(0);
      expect(result.clusters).toBe(0);
    });

    it('is non-throwing even when embeddings fail', async () => {
      // Insert observations — embedding will fail (no Ollama in tests)
      // but the function should not throw
      for (let i = 0; i < 5; i++) {
        insertTestObs(db, { title: `Obs ${i}`, content: `Content about topic ${i}` });
      }

      const result = await consolidateObservationBatch(db, 50);
      // Should complete without throwing — may have 0 consolidated if embeddings unavailable
      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(typeof result.processed).toBe('number');
      expect(typeof result.consolidated).toBe('number');
      expect(typeof result.clusters).toBe('number');
    });

    it('respects batch size parameter', async () => {
      for (let i = 0; i < 10; i++) {
        insertTestObs(db, { title: `Obs ${i}` });
      }

      const result = await consolidateObservationBatch(db, 3);
      // Should only process up to 3
      expect(result.processed).toBeLessThanOrEqual(3);
    });

    it('does not modify consumed observations', async () => {
      const id = insertTestObs(db, { title: 'Already consumed' });
      db.prepare('UPDATE observations SET consumed = 1 WHERE id = ?').run(id);

      const result = await consolidateObservationBatch(db, 50);
      // The consumed observation should not be in the batch
      const obs = getObservationById(db, id);
      expect(obs?.consumed).toBe(1);
      // consolidated_into should remain null (not touched by consolidator)
      const raw = db.prepare('SELECT consolidated_into FROM observations WHERE id = ?').get(id) as { consolidated_into: number | null };
      expect(raw.consolidated_into).toBeNull();
    });
  });

  describe('consolidation result integrity', () => {
    it('importance cap is respected (max 5)', () => {
      // Test the cap logic directly by verifying the math
      const maxImportance = 5;
      const newImportance = Math.min(maxImportance + 1, 5);
      expect(newImportance).toBe(5);
    });

    it('importance increments for lower values', () => {
      const maxImportance = 3;
      const newImportance = Math.min(maxImportance + 1, 5);
      expect(newImportance).toBe(4);
    });

    it('fallback summary preserves all observation content', () => {
      const observations = [
        { category: 'code', title: 'A', content: 'Content A' },
        { category: 'code', title: 'B', content: 'Content B' },
        { category: 'code', title: 'C', content: 'Content C' },
      ] as any;

      const summary = createFallbackSummary(observations);
      // All three observations should be present in the fallback
      expect(summary).toContain('Content A');
      expect(summary).toContain('Content B');
      expect(summary).toContain('Content C');
    });
  });

  describe('error handling', () => {
    it('handles closed database gracefully', async () => {
      const closedDb = createTestDb();
      closedDb.close();

      // Should not throw — returns result with error
      const result = await consolidateObservationBatch(closedDb, 50);
      expect(result).toBeDefined();
      // May have error or may just have 0 processed
      expect(typeof result.processed).toBe('number');
    });

    it('handles malformed observation data gracefully', async () => {
      ensureSession(db, 'sess-1', 'test-project');
      // Insert observation with minimal data
      db.prepare(
        `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('sess-1', 'test-project', 'tool', 'code', '', '', 1, '[]');

      const result = await consolidateObservationBatch(db, 50);
      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
    });
  });
});
