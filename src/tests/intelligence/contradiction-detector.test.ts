import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { detectContradiction } from '../../intelligence/contradiction-detector.js';
import { insertDecision } from '../../core/decisions.js';

describe('contradiction-detector', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns null for short content', () => {
    expect(detectContradiction(db, 'hi', 'proj', 'sess')).toBeNull();
  });

  it('returns null when no decisions exist', () => {
    const result = detectContradiction(db, 'We should always use SQLite for local storage because it is reliable', 'proj', 'sess');
    expect(result).toBeNull();
  });

  it('detects contradiction when new content negates an existing decision', () => {
    insertDecision(db, {
      session_id: 'sess-1',
      project: 'proj',
      content: 'Always use PostgreSQL for the database backend',
      source: 'explicit',
      fingerprint: 'db-choice',
    });

    const result = detectContradiction(db,
      'We should never use PostgreSQL for the database backend',
      'proj', 'sess-2');

    expect(result).not.toBeNull();
    expect(result!.type).toBe('decision');
  });

  it('does not flag non-contradicting content', () => {
    insertDecision(db, {
      session_id: 'sess-1',
      project: 'proj',
      content: 'Use SQLite for local storage',
      source: 'explicit',
      fingerprint: 'db-local',
    });

    const result = detectContradiction(db,
      'The authentication system should use JWT tokens for session management',
      'proj', 'sess-2');

    expect(result).toBeNull();
  });
});
