/**
 * Tests for the trigger engine (task-aware assembly + predictive patterns).
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { matchTriggers, matchGlob } from '../../intelligence/trigger-engine.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

describe('matchGlob', () => {
  it('matches exact file paths', () => {
    expect(matchGlob('src/core/migrations.ts', 'src/core/migrations.ts')).toBe(true);
  });

  it('matches wildcard *', () => {
    expect(matchGlob('src/core/migrations.ts', 'src/core/*.ts')).toBe(true);
    expect(matchGlob('src/core/deep/file.ts', 'src/core/*.ts')).toBe(false);
  });

  it('matches double wildcard **', () => {
    expect(matchGlob('src/core/deep/nested/file.ts', 'src/**/*.ts')).toBe(true);
    expect(matchGlob('src/core/file.ts', 'src/**/*.ts')).toBe(true);
  });

  it('matches question mark ?', () => {
    expect(matchGlob('src/a.ts', 'src/?.ts')).toBe(true);
    expect(matchGlob('src/ab.ts', 'src/?.ts')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchGlob('SRC/Core/File.ts', 'src/core/*.ts')).toBe(true);
  });

  it('normalizes backslashes', () => {
    expect(matchGlob('src\\core\\file.ts', 'src/core/*.ts')).toBe(true);
  });

  it('returns false for non-matching paths', () => {
    expect(matchGlob('src/other/file.ts', 'src/core/*.ts')).toBe(false);
  });
});

describe('matchTriggers', () => {
  it('returns empty when no triggers exist', () => {
    const db = createDb();
    try {
      const result = matchTriggers(db, 'test-project', 'Edit', { file_path: 'src/foo.ts' });
      expect(result.domains).toEqual([]);
      expect(result.patternIds).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('matches context triggers by glob pattern', () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO context_triggers (glob_pattern, knowledge_domain, project)
         VALUES (?, ?, ?)`
      ).run('src/core/migrations*', 'schema-migration', 'test-project');

      const result = matchTriggers(db, 'test-project', 'Edit', {
        file_path: 'src/core/migrations.ts',
      });
      expect(result.domains).toContain('schema-migration');
    } finally {
      db.close();
    }
  });

  it('matches context triggers by command pattern', () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO context_triggers (command_pattern, knowledge_domain, project)
         VALUES (?, ?, ?)`
      ).run('bun test', 'testing', '__global__');

      const result = matchTriggers(db, 'test-project', 'Bash', {
        command: 'bun test src/foo.test.ts',
      });
      expect(result.domains).toContain('testing');
    } finally {
      db.close();
    }
  });

  it('matches experience patterns by trigger_glob', () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO sessions (session_id, status, observation_count, created_at_epoch)
         VALUES ('s1', 'active', 0, 1000)`
      ).run();

      db.prepare(
        `INSERT INTO experience_patterns
         (id, pattern_type, trigger_context, lesson, severity, score, times_triggered, times_useful,
          source_session, source_project, created_at_epoch, trigger_glob)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 's1', ?, 1000, ?)`
      ).run('pat-1', 'correction', 'migration issue', 'Always write migration tests', 'important', 3,
        'test-project', 'src/core/migrations*');

      const result = matchTriggers(db, 'test-project', 'Edit', {
        file_path: 'src/core/migrations.ts',
      });
      expect(result.patternIds).toContain('pat-1');
    } finally {
      db.close();
    }
  });

  it('does not match patterns with score < 2', () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO sessions (session_id, status, observation_count, created_at_epoch)
         VALUES ('s1', 'active', 0, 1000)`
      ).run();

      db.prepare(
        `INSERT INTO experience_patterns
         (id, pattern_type, trigger_context, lesson, severity, score, times_triggered, times_useful,
          source_session, source_project, created_at_epoch, trigger_glob)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 's1', ?, 1000, ?)`
      ).run('pat-dead', 'correction', 'dead pattern', 'lesson', 'minor', 1,
        'test-project', 'src/**');

      const result = matchTriggers(db, 'test-project', 'Edit', {
        file_path: 'src/foo.ts',
      });
      expect(result.patternIds).not.toContain('pat-dead');
    } finally {
      db.close();
    }
  });

  it('deduplicates matched domains', () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO context_triggers (glob_pattern, knowledge_domain, project)
         VALUES (?, ?, ?)`
      ).run('src/**', 'general', 'test-project');
      db.prepare(
        `INSERT INTO context_triggers (glob_pattern, knowledge_domain, project)
         VALUES (?, ?, ?)`
      ).run('src/core/**', 'general', 'test-project');

      const result = matchTriggers(db, 'test-project', 'Edit', {
        file_path: 'src/core/foo.ts',
      });
      // Both globs match but domain appears once
      expect(result.domains.filter(d => d === 'general').length).toBe(1);
    } finally {
      db.close();
    }
  });
});
