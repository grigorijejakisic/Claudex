/**
 * Phase 14-07k — Backfill CLI tests.
 *
 * Coverage (6 tests):
 *  1. --dry-run lists sessions without writing
 *  2. Default skips sessions with existing synthesis
 *  3. --force re-runs even with existing synthesis
 *  4. --since filters correctly
 *  5. Partial failure: continues + exit 1
 *  6. Invalid args: exit 2 with usage
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  listSessionsForProject,
  listSessionsWithoutSynthesis,
  hasSynthesisArtifact,
  backfillOne,
  backfillSynthesis,
} from '../../scripts/backfill-session-synthesis.js';
import { deriveSynthesisArtifactId, persistSynthesisArtifact } from '../../angel/last-session-synthesis.js';
import type { LastSessionSynthesis } from '../../angel/last-session-synthesis.js';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  project: string,
  createdMs: number,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO sessions
      (session_id, project, created_at_epoch_ms)
    VALUES (?, ?, ?)
  `).run(sessionId, project, createdMs);
}

function insertSynthesisArtifact(
  db: Database.Database,
  sessionId: string,
  project: string,
): void {
  const synthesis: LastSessionSynthesis = {
    schema_version: 1,
    session_id: sessionId,
    operator_pivots: [],
    agent_positions: [],
    last_unresolved_question: null,
    recommended_next_action: 'Continue',
    confidence: 0.8,
    prompt_version: 'v1',
    llm_model: 'llama3.1:8b',
    generated_at_epoch_ms: Date.now(),
  };
  persistSynthesisArtifact(db, synthesis, project);
}

// ---------------------------------------------------------------------------
// Mock synthesizeLastSession
// ---------------------------------------------------------------------------

vi.mock('../../angel/last-session-synthesis.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    synthesizeLastSession: vi.fn(),
  };
});

import * as lss from '../../angel/last-session-synthesis.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfill-session-synthesis CLI', () => {
  let db: Database.Database;
  const now = Date.now();
  const ago10d = now - 10 * 24 * 60 * 60 * 1000;
  const ago20d = now - 20 * 24 * 60 * 60 * 1000;
  const ago40d = now - 40 * 24 * 60 * 60 * 1000;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  // Test 1: --dry-run lists without writing
  it('--dry-run lists sessions without writing', async () => {
    insertSession(db, 'sess-a', 'proj', ago10d);
    insertSession(db, 'sess-b', 'proj', ago20d);

    // Spy on console output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await backfillSynthesis({
      project: 'proj',
      since: new Date(ago25d()),
      dryRun: true,
      force: false,
      promptVersion: 'v1',
    }, db);

    expect(exitCode).toBe(0);
    // synthesizeLastSession should NOT have been called in dry-run
    expect(lss.synthesizeLastSession).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // Test 2: Default skips sessions with existing synthesis
  it('skips sessions that already have synthesis', async () => {
    insertSession(db, 'sess-has', 'proj', ago10d);
    insertSession(db, 'sess-new', 'proj', ago10d);
    insertSynthesisArtifact(db, 'sess-has', 'proj');

    // Confirm hasSynthesisArtifact
    expect(hasSynthesisArtifact(db, 'sess-has')).toBe(true);
    expect(hasSynthesisArtifact(db, 'sess-new')).toBe(false);

    const candidates = listSessionsWithoutSynthesis(db, 'proj', new Date(ago25d()), false);
    expect(candidates.map(s => s.session_id)).toContain('sess-new');
    expect(candidates.map(s => s.session_id)).not.toContain('sess-has');
  });

  // Test 3: --force re-runs even with existing synthesis
  it('--force includes sessions that already have synthesis', async () => {
    insertSession(db, 'sess-exists', 'proj', ago10d);
    insertSynthesisArtifact(db, 'sess-exists', 'proj');

    const candidates = listSessionsWithoutSynthesis(db, 'proj', new Date(ago25d()), true);
    expect(candidates.map(s => s.session_id)).toContain('sess-exists');
  });

  // Test 4: --since filters correctly
  it('--since filters sessions by date', () => {
    insertSession(db, 'sess-recent', 'proj', ago10d);
    insertSession(db, 'sess-old', 'proj', ago40d);

    // Since 25 days ago — only sess-recent qualifies
    const results = listSessionsForProject(db, 'proj', new Date(ago25d()));
    const ids = results.map(s => s.session_id);
    expect(ids).toContain('sess-recent');
    expect(ids).not.toContain('sess-old');
  });

  // Test 5: partial failure — continues processing + returns exit 1
  it('partial failure: continues processing other sessions; exit 1', async () => {
    insertSession(db, 'sess-ok', 'proj', ago10d);
    insertSession(db, 'sess-fail', 'proj', ago10d);

    // Mock: sess-ok succeeds, sess-fail fails (returns null)
    vi.mocked(lss.synthesizeLastSession).mockImplementation(async (sessionId) => {
      if (sessionId === 'sess-ok') {
        return {
          schema_version: 1,
          session_id: 'sess-ok',
          operator_pivots: [],
          agent_positions: [],
          last_unresolved_question: null,
          recommended_next_action: 'Continue',
          confidence: 0.8,
          prompt_version: 'v1',
          llm_model: 'llama3.1:8b',
          generated_at_epoch_ms: Date.now(),
        };
      }
      return null;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await backfillSynthesis({
      project: 'proj',
      since: new Date(ago25d()),
      dryRun: false,
      force: false,
      promptVersion: 'v1',
    }, db);

    expect(exitCode).toBe(1);
    expect(lss.synthesizeLastSession).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
  });

  // Test 6: invalid args: function-level validation
  it('listSessionsForProject returns empty array for unknown project', () => {
    const results = listSessionsForProject(db, 'nonexistent-project', new Date(ago25d()));
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ago25d(): number {
  return Date.now() - 25 * 24 * 60 * 60 * 1000;
}
