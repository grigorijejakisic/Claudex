/**
 * Tests for claudex projects-touched CLI.
 * Uses in-memory SQLite with the v3 schema.
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  findLatestSessionId,
  sessionExists,
  queryObservationsByProject,
  queryDecisionsByProject,
  queryFilesForProject,
  queryProjectsTouched,
} from '../../cli/projects-touched.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Creates a fully-initialized in-memory DB with v3 schema. */
function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

/** Inserts a minimal session row. */
function insertSession(
  db: Database.Database,
  sessionId: string,
  createdAtEpoch: number = Math.floor(Date.now() / 1000)
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, status, observation_count, created_at_epoch_ms)
     VALUES (?, 'active', 0, ?)`
  ).run(sessionId, createdAtEpoch);
}

/** Inserts a minimal observation row. */
function insertObservation(
  db: Database.Database,
  sessionId: string,
  project: string,
  filesModified: string = '[]'
): void {
  db.prepare(
    `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, consumed)
     VALUES (?, ?, 'Bash', 'code', 'test title', 'test content', 3, ?, 0)`
  ).run(sessionId, project, filesModified);
}

/** Inserts a minimal decision row. */
function insertDecision(
  db: Database.Database,
  sessionId: string,
  project: string,
  fingerprint: string = Math.random().toString(36).slice(2)
): void {
  db.prepare(
    `INSERT INTO decisions (session_id, project, content, source, fingerprint)
     VALUES (?, ?, 'test decision', 'explicit', ?)`
  ).run(sessionId, project, fingerprint);
}

// ── findLatestSessionId ──────────────────────────────────────────────

describe('findLatestSessionId', () => {
  it('returns null when no sessions exist', () => {
    const db = createDb();
    try {
      const result = findLatestSessionId(db);
      expect(result).toBeNull();
    } finally {
      db.close();
    }
  });

  it('returns the most recent session by created_at_epoch_ms', () => {
    const db = createDb();
    try {
      const now = Math.floor(Date.now() / 1000);
      insertSession(db, 'session-old', now - 1000);
      insertSession(db, 'session-new', now);
      insertSession(db, 'session-mid', now - 500);

      const result = findLatestSessionId(db);
      expect(result).toBe('session-new');
    } finally {
      db.close();
    }
  });

  it('returns the only session when one exists', () => {
    const db = createDb();
    try {
      insertSession(db, 'only-session');
      const result = findLatestSessionId(db);
      expect(result).toBe('only-session');
    } finally {
      db.close();
    }
  });
});

// ── sessionExists ────────────────────────────────────────────────────

describe('sessionExists', () => {
  it('returns false for a non-existent session', () => {
    const db = createDb();
    try {
      expect(sessionExists(db, 'does-not-exist')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns true for an existing session', () => {
    const db = createDb();
    try {
      insertSession(db, 'real-session');
      expect(sessionExists(db, 'real-session')).toBe(true);
    } finally {
      db.close();
    }
  });
});

// ── queryObservationsByProject ───────────────────────────────────────

describe('queryObservationsByProject', () => {
  it('returns empty map when no observations', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      const result = queryObservationsByProject(db, 'sess-1');
      expect(result.size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('counts observations per project', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      insertObservation(db, 'sess-1', 'project-a');
      insertObservation(db, 'sess-1', 'project-a');
      insertObservation(db, 'sess-1', 'project-b');

      const result = queryObservationsByProject(db, 'sess-1');
      expect(result.get('project-a')).toBe(2);
      expect(result.get('project-b')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('does not count observations from other sessions', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      insertSession(db, 'sess-2');
      insertObservation(db, 'sess-1', 'project-a');
      insertObservation(db, 'sess-2', 'project-a');

      const result = queryObservationsByProject(db, 'sess-1');
      expect(result.get('project-a')).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ── queryDecisionsByProject ──────────────────────────────────────────

describe('queryDecisionsByProject', () => {
  it('returns empty map when no decisions', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      const result = queryDecisionsByProject(db, 'sess-1');
      expect(result.size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('counts decisions per project', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      insertDecision(db, 'sess-1', 'project-a', 'fp-1');
      insertDecision(db, 'sess-1', 'project-a', 'fp-2');
      insertDecision(db, 'sess-1', 'project-b', 'fp-3');

      const result = queryDecisionsByProject(db, 'sess-1');
      expect(result.get('project-a')).toBe(2);
      expect(result.get('project-b')).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ── queryFilesForProject ─────────────────────────────────────────────

describe('queryFilesForProject', () => {
  it('returns empty array when no observations', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      const result = queryFilesForProject(db, 'sess-1', 'project-a');
      expect(result).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('parses and deduplicates files from JSON arrays', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      insertObservation(db, 'sess-1', 'project-a', '["src/foo.ts", "src/bar.ts"]');
      insertObservation(db, 'sess-1', 'project-a', '["src/bar.ts", "src/baz.ts"]');

      const result = queryFilesForProject(db, 'sess-1', 'project-a');
      expect(result).toContain('src/foo.ts');
      expect(result).toContain('src/bar.ts');
      expect(result).toContain('src/baz.ts');
      // Deduplicated
      expect(result.filter(f => f === 'src/bar.ts').length).toBe(1);
      expect(result.length).toBe(3);
    } finally {
      db.close();
    }
  });

  it('handles empty files_modified arrays', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      insertObservation(db, 'sess-1', 'project-a', '[]');

      const result = queryFilesForProject(db, 'sess-1', 'project-a');
      expect(result).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('handles JSON object (non-array) gracefully — skips non-array values', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      // json_valid accepts objects; our parser checks Array.isArray and skips non-arrays
      insertObservation(db, 'sess-1', 'project-a', '{"key":"value"}');
      insertObservation(db, 'sess-1', 'project-a', '["src/valid.ts"]');

      const result = queryFilesForProject(db, 'sess-1', 'project-a');
      // Object row is skipped (not an array), valid array row is parsed
      expect(result).toContain('src/valid.ts');
      expect(result.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('handles JSON null gracefully — skips null values', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      // json_valid accepts null; our parser checks Array.isArray and skips it
      insertObservation(db, 'sess-1', 'project-a', 'null');
      insertObservation(db, 'sess-1', 'project-a', '["src/valid.ts"]');

      const result = queryFilesForProject(db, 'sess-1', 'project-a');
      expect(result).toContain('src/valid.ts');
      expect(result.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('only returns files for the requested project', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      insertObservation(db, 'sess-1', 'project-a', '["src/foo.ts"]');
      insertObservation(db, 'sess-1', 'project-b', '["src/bar.ts"]');

      const result = queryFilesForProject(db, 'sess-1', 'project-a');
      expect(result).toContain('src/foo.ts');
      expect(result).not.toContain('src/bar.ts');
    } finally {
      db.close();
    }
  });

  it('returns files sorted alphabetically', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      insertObservation(db, 'sess-1', 'project-a', '["src/z.ts", "src/a.ts", "src/m.ts"]');

      const result = queryFilesForProject(db, 'sess-1', 'project-a');
      expect(result).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
    } finally {
      db.close();
    }
  });
});

// ── queryProjectsTouched ─────────────────────────────────────────────

describe('queryProjectsTouched', () => {
  it('returns empty projects array for a session with no activity', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-empty');
      const result = queryProjectsTouched(db, 'sess-empty');
      expect(result.session_id).toBe('sess-empty');
      expect(result.projects).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('returns one project for a single-project session', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-single');
      insertObservation(db, 'sess-single', 'project-a', '["src/foo.ts"]');
      insertObservation(db, 'sess-single', 'project-a', '["src/bar.ts"]');
      insertDecision(db, 'sess-single', 'project-a', 'fp-1');

      const result = queryProjectsTouched(db, 'sess-single');
      expect(result.session_id).toBe('sess-single');
      expect(result.projects.length).toBe(1);
      expect(result.projects[0].id).toBe('project-a');
      expect(result.projects[0].observation_count).toBe(2);
      expect(result.projects[0].decision_count).toBe(1);
      expect(result.projects[0].files).toContain('src/foo.ts');
      expect(result.projects[0].files).toContain('src/bar.ts');
    } finally {
      db.close();
    }
  });

  it('returns multiple projects for a multi-project session', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-multi');
      insertObservation(db, 'sess-multi', 'project-a', '["src/a.ts"]');
      insertObservation(db, 'sess-multi', 'project-b', '["src/b.ts"]');
      insertObservation(db, 'sess-multi', 'project-b', '["src/b2.ts"]');
      insertDecision(db, 'sess-multi', 'project-a', 'fp-1');
      insertDecision(db, 'sess-multi', 'project-b', 'fp-2');
      insertDecision(db, 'sess-multi', 'project-b', 'fp-3');

      const result = queryProjectsTouched(db, 'sess-multi');
      expect(result.session_id).toBe('sess-multi');
      expect(result.projects.length).toBe(2);

      const pa = result.projects.find(p => p.id === 'project-a')!;
      const pb = result.projects.find(p => p.id === 'project-b')!;

      expect(pa.observation_count).toBe(1);
      expect(pa.decision_count).toBe(1);
      expect(pa.files).toEqual(['src/a.ts']);

      expect(pb.observation_count).toBe(2);
      expect(pb.decision_count).toBe(2);
      expect(pb.files).toContain('src/b.ts');
      expect(pb.files).toContain('src/b2.ts');
    } finally {
      db.close();
    }
  });

  it('includes projects that only have decisions (no observations)', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-dec-only');
      insertDecision(db, 'sess-dec-only', 'project-decisions-only', 'fp-1');

      const result = queryProjectsTouched(db, 'sess-dec-only');
      expect(result.projects.length).toBe(1);
      const p = result.projects[0];
      expect(p.id).toBe('project-decisions-only');
      expect(p.observation_count).toBe(0);
      expect(p.decision_count).toBe(1);
      expect(p.files).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not mix data from other sessions', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-a');
      insertSession(db, 'sess-b');
      insertObservation(db, 'sess-a', 'project-x', '["src/x.ts"]');
      insertObservation(db, 'sess-b', 'project-y', '["src/y.ts"]');

      const result = queryProjectsTouched(db, 'sess-a');
      expect(result.projects.length).toBe(1);
      expect(result.projects[0].id).toBe('project-x');
    } finally {
      db.close();
    }
  });

  it('returns correct counts for session with only observations (no decisions)', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-obs-only');
      insertObservation(db, 'sess-obs-only', 'project-z', '["src/z.ts"]');

      const result = queryProjectsTouched(db, 'sess-obs-only');
      expect(result.projects.length).toBe(1);
      expect(result.projects[0].decision_count).toBe(0);
    } finally {
      db.close();
    }
  });
});
