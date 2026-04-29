/**
 * Tests for src/core/curated-context.ts — Phase 1 CRUD.
 *
 * Covers: schema roundtrip, writeEntry defaults and validation, listEntries
 * with scope/status/type filters, confirmEntry / archiveEntry / promoteEntry
 * state transitions, supersedeEntry chain-of-revisions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  writeEntry,
  listEntries,
  confirmEntry,
  archiveEntry,
  promoteEntry,
  supersedeEntry,
  type CuratedEntry,
} from '../../core/curated-context.js';
import { GLOBAL_PROJECT_SCOPE } from '../../shared/constants.js';

describe('curated-context', () => {
  let db: TestDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  describe('schema', () => {
    it('creates project_curated_context table with correct columns', () => {
      const cols = db.pragma('table_info(project_curated_context)') as Array<{ name: string }>;
      const names = new Set(cols.map(c => c.name));
      expect(names.has('id')).toBe(true);
      expect(names.has('project')).toBe(true);
      expect(names.has('type')).toBe(true);
      expect(names.has('content')).toBe(true);
      expect(names.has('supersedes_id')).toBe(true);
      expect(names.has('curator')).toBe(true);
      expect(names.has('trust_tier')).toBe(true);
      expect(names.has('status')).toBe(true);
      expect(names.has('source_session_id')).toBe(true);
      expect(names.has('created_at_epoch')).toBe(true);
    });

    it('bumps user_version to current TARGET_VERSION (21 after Phase 6.5)', () => {
      const row = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(row[0]?.user_version).toBe(22);
    });

    it('has idx_pcc_project_status index', () => {
      const idx = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pcc_project_status'",
      ).get() as { name: string } | undefined;
      expect(idx?.name).toBe('idx_pcc_project_status');
    });
  });

  describe('writeEntry', () => {
    it('inserts an agent-written entry with tier 2 and active status', () => {
      const id = writeEntry(db, {
        project: 'proj-a',
        type: 'mental_model',
        content: 'We are racing the stale feed, not courtsiding.',
        curator: 'agent',
      });
      expect(id).toBeGreaterThan(0);

      const entries = listEntries(db, 'proj-a');
      expect(entries.length).toBe(1);
      expect(entries[0].trust_tier).toBe(2);
      expect(entries[0].status).toBe('active');
      expect(entries[0].curator).toBe('agent');
    });

    it('angel-written entries default to tier 1 and status proposed', () => {
      writeEntry(db, {
        project: 'proj-a',
        type: 'mental_model',
        content: 'Angel-proposed reframe.',
        curator: 'angel',
      });
      const entries = listEntries(db, 'proj-a', { statuses: ['proposed'] });
      expect(entries.length).toBe(1);
      expect(entries[0].trust_tier).toBe(1);
      expect(entries[0].status).toBe('proposed');
    });

    it('allows global-scope mental_model, preference, constraint, reframe', () => {
      const types = ['mental_model', 'preference', 'constraint', 'reframe'] as const;
      for (const t of types) {
        writeEntry(db, {
          project: GLOBAL_PROJECT_SCOPE,
          type: t,
          content: `global ${t}`,
          curator: 'agent',
        });
      }
      const entries = listEntries(db, GLOBAL_PROJECT_SCOPE, { includeGlobal: false });
      expect(entries.length).toBe(4);
    });

    it('rejects workspace_map at __global__ scope', () => {
      expect(() => writeEntry(db, {
        project: GLOBAL_PROJECT_SCOPE,
        type: 'workspace_map',
        content: 'should not be allowed',
        curator: 'agent',
      })).toThrow(/not valid at __global__ scope/);
    });

    it('rejects shipped at __global__ scope', () => {
      expect(() => writeEntry(db, {
        project: GLOBAL_PROJECT_SCOPE,
        type: 'shipped',
        content: 'should not be allowed',
        curator: 'agent',
      })).toThrow(/not valid at __global__ scope/);
    });

    it('rejects empty content', () => {
      expect(() => writeEntry(db, {
        project: 'proj-a',
        type: 'mental_model',
        content: '   ',
        curator: 'agent',
      })).toThrow(/content must be non-empty/);
    });

    it('stores tags as JSON array', () => {
      writeEntry(db, {
        project: 'proj-a',
        type: 'constraint',
        content: 'never touch the verifier',
        curator: 'agent',
        tags: ['safety', 'shipped'],
      });
      const entries = listEntries(db, 'proj-a');
      expect(entries[0].tags).toBe('["safety","shipped"]');
    });
  });

  describe('listEntries', () => {
    beforeEach(() => {
      writeEntry(db, {
        project: GLOBAL_PROJECT_SCOPE,
        type: 'preference',
        content: 'prefer Sonnet for workers',
        curator: 'agent',
      });
      writeEntry(db, {
        project: 'proj-a',
        type: 'mental_model',
        content: 'theory A',
        curator: 'agent',
      });
      writeEntry(db, {
        project: 'proj-a',
        type: 'shipped',
        content: 'feature X @ src/x.ts',
        curator: 'agent',
      });
      writeEntry(db, {
        project: 'proj-b',
        type: 'mental_model',
        content: 'unrelated',
        curator: 'agent',
      });
    });

    it('includes global entries by default', () => {
      const entries = listEntries(db, 'proj-a');
      expect(entries.length).toBe(3); // 1 global + 2 proj-a
      expect(entries.some(e => e.project === GLOBAL_PROJECT_SCOPE)).toBe(true);
    });

    it('excludes global when includeGlobal=false', () => {
      const entries = listEntries(db, 'proj-a', { includeGlobal: false });
      expect(entries.length).toBe(2);
      expect(entries.every(e => e.project === 'proj-a')).toBe(true);
    });

    it('does not leak entries from other projects', () => {
      const entries = listEntries(db, 'proj-a', { includeGlobal: false });
      expect(entries.every(e => e.project !== 'proj-b')).toBe(true);
    });

    it('filters by type', () => {
      const entries = listEntries(db, 'proj-a', {
        includeGlobal: false,
        types: ['shipped'],
      });
      expect(entries.length).toBe(1);
      expect(entries[0].type).toBe('shipped');
    });

    it('renders global entries first in ORDER BY', () => {
      const entries = listEntries(db, 'proj-a');
      // Global scope gets CASE 0, project gets CASE 1.
      expect(entries[0].project).toBe(GLOBAL_PROJECT_SCOPE);
    });

    it('respects status filter', () => {
      writeEntry(db, {
        project: 'proj-a',
        type: 'mental_model',
        content: 'proposed thing',
        curator: 'angel',
      });
      const active = listEntries(db, 'proj-a', { includeGlobal: false, statuses: ['active'] });
      const proposed = listEntries(db, 'proj-a', { includeGlobal: false, statuses: ['proposed'] });
      expect(active.length).toBe(2);
      expect(proposed.length).toBe(1);
    });
  });

  describe('state transitions', () => {
    it('confirmEntry promotes proposed → active with tier 2', () => {
      const id = writeEntry(db, {
        project: 'proj-a',
        type: 'mental_model',
        content: 'angel proposal',
        curator: 'angel',
      });
      const ok = confirmEntry(db, id);
      expect(ok).toBe(true);

      const row = db.prepare(
        'SELECT status, trust_tier FROM project_curated_context WHERE id = ?',
      ).get(id) as { status: string; trust_tier: number };
      expect(row.status).toBe('active');
      expect(row.trust_tier).toBe(2);
    });

    it('confirmEntry is a no-op on already-active entries', () => {
      const id = writeEntry(db, {
        project: 'proj-a',
        type: 'mental_model',
        content: 'already active',
        curator: 'agent',
      });
      const ok = confirmEntry(db, id);
      expect(ok).toBe(false);
    });

    it('archiveEntry moves status → archived', () => {
      const id = writeEntry(db, {
        project: 'proj-a',
        type: 'constraint',
        content: 'x',
        curator: 'agent',
      });
      const ok = archiveEntry(db, id);
      expect(ok).toBe(true);

      const entries = listEntries(db, 'proj-a');
      expect(entries.length).toBe(0);
    });

    it('promoteEntry bumps tier to 3', () => {
      const id = writeEntry(db, {
        project: GLOBAL_PROJECT_SCOPE,
        type: 'preference',
        content: 'permanent rule',
        curator: 'agent',
      });
      const ok = promoteEntry(db, id);
      expect(ok).toBe(true);

      const entries = listEntries(db, GLOBAL_PROJECT_SCOPE, { includeGlobal: false });
      expect(entries[0].trust_tier).toBe(3);
    });
  });

  describe('supersedeEntry', () => {
    it('inserts new entry and marks old one as superseded', () => {
      const oldId = writeEntry(db, {
        project: 'proj-a',
        type: 'mental_model',
        content: 'old theory',
        curator: 'agent',
      });
      const newId = supersedeEntry(db, oldId, {
        project: 'proj-a',
        type: 'mental_model',
        content: 'new theory',
        curator: 'agent',
      });

      expect(newId).toBeGreaterThan(oldId);

      // Old entry should be superseded, not listed as active
      const active = listEntries(db, 'proj-a');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe(newId);
      expect(active[0].content).toBe('new theory');

      // Old entry still exists with status=superseded
      const oldRow = db.prepare(
        'SELECT status, id FROM project_curated_context WHERE id = ?',
      ).get(oldId) as { status: string; id: number };
      expect(oldRow.status).toBe('superseded');

      // Supersession pointer preserved
      const newRow = db.prepare(
        'SELECT supersedes_id FROM project_curated_context WHERE id = ?',
      ).get(newId) as { supersedes_id: number };
      expect(newRow.supersedes_id).toBe(oldId);
    });
  });

  describe('writeEntry type exhaustiveness', () => {
    it('accepts all six curated types at project scope', () => {
      const types: CuratedEntry['type'][] = [
        'mental_model',
        'workspace_map',
        'shipped',
        'reframe',
        'constraint',
        'preference',
      ];
      for (const t of types) {
        const id = writeEntry(db, {
          project: 'proj-a',
          type: t,
          content: `test ${t}`,
          curator: 'agent',
        });
        expect(id).toBeGreaterThan(0);
      }
      const entries = listEntries(db, 'proj-a', { includeGlobal: false });
      expect(entries.length).toBe(6);
    });
  });
});
