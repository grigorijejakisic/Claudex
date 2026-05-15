/**
 * Integration tests for the extraction dispatcher pipeline.
 * Uses in-memory SQLite DB via shared test harness.
 */

import Database from 'better-sqlite3';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { processToolObservation } from '../../extraction/extractor.js';
import type { ProcessToolObservationInput } from '../../extraction/extractor.js';

describe('processToolObservation', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeInput(overrides: Partial<ProcessToolObservationInput> & { toolName: string; toolInput: Record<string, unknown> }): ProcessToolObservationInput {
    return {
      db,
      sessionId: 'test-session',
      project: 'test-project',
      toolOutput: undefined,
      ...overrides,
    };
  }

  // --- Routing tests ---

  it('routes Edit tool to extractEdit and stores observation', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/auth.ts', old_string: 'foo', new_string: 'bar' },
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id!) as Record<string, unknown>;
    expect(row.tool_name).toBe('Edit');
    expect(row.title).toContain('Edit: auth.ts');
  });

  it('routes Read tool to extractRead and stores observation', () => {
    const structuralContent = 'export function authenticate(user: string) {\n  return true;\n}\n' + 'x'.repeat(100);
    const id = processToolObservation(makeInput({
      toolName: 'Read',
      toolInput: { file_path: '/src/auth.ts' },
      toolOutput: { content: structuralContent },
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id!) as Record<string, unknown>;
    expect(row.tool_name).toBe('Read');
    expect(row.title).toContain('Read: auth.ts');
  });

  it('routes Bash tool to extractBash and stores observation', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run build --production' },
      toolOutput: { output: 'Build completed successfully. Output written to dist/', exitCode: 0 },
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id!) as Record<string, unknown>;
    expect(row.tool_name).toBe('Bash');
    expect(row.title).toContain('Bash:');
  });

  // --- Redaction tests ---

  it('applies redaction to stored content (secret is replaced)', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: {
        file_path: '/src/config.ts',
        old_string: 'const key = "sk-oldkey1234567890abcdef";',
        new_string: 'const key = process.env.API_KEY;',
      },
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT content FROM observations WHERE id = ?').get(id!) as { content: string };
    expect(row.content).not.toContain('sk-oldkey1234567890abcdef');
    // Stored content uses generic [REDACTED] (typed markers stripped for FTS hygiene)
    expect(row.content).toContain('[REDACTED]');
    expect(row.content).not.toContain('[REDACTED_SECRET]');
  });

  it('applies path sanitization to files_modified', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: {
        file_path: '/home/alice/project/src/main.ts',
        old_string: 'a',
        new_string: 'b',
      },
      projectRoot: '/home/alice/project',
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT files_modified FROM observations WHERE id = ?').get(id!) as { files_modified: string };
    const files = JSON.parse(row.files_modified);
    expect(files[0]).toBe('<project>/src/main.ts');
  });

  // --- Quality gate tests ---

  it('rejects observation when quality gate fails (trivial bash)', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolOutput: { output: 'file1.ts' },
    }));
    expect(id).toBeNull();
  });

  it('rejects observation when quality gate fails (empty grep)', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Grep',
      toolInput: { pattern: 'nonexistent' },
      toolOutput: { matchCount: 0, files: [] },
    }));
    expect(id).toBeNull();
  });

  // --- Unknown tool ---

  it('returns null for unknown tool', () => {
    const id = processToolObservation(makeInput({
      toolName: 'UnknownTool',
      toolInput: { foo: 'bar' },
    }));
    expect(id).toBeNull();
  });

  // --- Classification & scoring ---

  it('assigns correct category via classification', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: {
        file_path: '/src/auth.ts',
        old_string: 'const token = getToken();',
        new_string: 'const credential = getSecureToken();',
      },
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT category FROM observations WHERE id = ?').get(id!) as { category: string };
    // "token" and "credential" match security keywords
    expect(row.category).toBe('security');
  });

  it('assigns correct importance score', () => {
    // Edit tool with security category should score 5 (security = 5)
    const id = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: {
        file_path: '/src/auth.ts',
        old_string: 'const token = getToken();',
        new_string: 'const credential = getSecureToken();',
      },
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT importance FROM observations WHERE id = ?').get(id!) as { importance: number };
    // Base importance 5 (security category) * 0.8 (routine type prior) = 4
    expect(row.importance).toBe(4);
  });

  // --- files_modified JSON ---

  it('files_modified stored as valid JSON array (parseable via JSON.parse)', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Write',
      toolInput: { file_path: '/src/new.ts', content: 'export const x = 1;' },
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT files_modified FROM observations WHERE id = ?').get(id!) as { files_modified: string };
    const parsed = JSON.parse(row.files_modified);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  // --- Dedup tests ---

  it('dedup skips same tool+file+category within 5 minutes', () => {
    const first = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/main.ts', old_string: 'a', new_string: 'b' },
    }));
    expect(first).not.toBeNull();

    // Same tool, same file, same category — should be deduped
    const second = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/main.ts', old_string: 'c', new_string: 'd' },
    }));
    expect(second).toBeNull();
  });

  it('dedup allows same tool+file+category after 5 minutes', () => {
    const first = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/old.ts', old_string: 'a', new_string: 'b' },
    }));
    expect(first).not.toBeNull();

    // Manually backdate the timestamp by 6 minutes (360 000 ms)
    db.prepare(
      'UPDATE observations SET timestamp_epoch_ms = timestamp_epoch_ms - 360000 WHERE id = ?'
    ).run(first!);

    // Same tool+file+category but now outside 5-minute window
    const second = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/old.ts', old_string: 'c', new_string: 'd' },
    }));
    expect(second).not.toBeNull();
  });

  // --- Dedup: empty files_modified ---

  it('dedup does NOT match across different tools with empty files_modified', () => {
    const first = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run build --production' },
      toolOutput: { output: 'Build completed successfully. Output written to dist/' },
    }));
    expect(first).not.toBeNull();

    // Different tool, also empty files_modified — should NOT be deduped
    const second = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run test -- --coverage' },
      toolOutput: { output: 'All 42 tests passed with 98% coverage' },
    }));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('dedup does NOT match same tool with different content but empty files_modified', () => {
    const first = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run build --production' },
      toolOutput: { output: 'Build completed successfully in 3.2 seconds' },
    }));
    expect(first).not.toBeNull();

    // Same tool, empty files, but different content — should NOT be deduped
    const second = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run lint --fix' },
      toolOutput: { output: 'Linting completed with 0 errors and 0 warnings' },
    }));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('dedup does NOT collapse different commands with identical output (title dedup)', () => {
    // Two Bash commands with identical output but different titles
    // should NOT be deduped — the title differentiates them
    const first = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run build --production' },
      toolOutput: { output: 'Completed successfully in 2.3 seconds with no errors' },
    }));
    expect(first).not.toBeNull();

    // Same output but different command (different title)
    const second = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run test --coverage' },
      toolOutput: { output: 'Completed successfully in 2.3 seconds with no errors' },
    }));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('dedup DOES collapse identical empty-file observations (same title+content)', () => {
    const first = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run build --production' },
      toolOutput: { output: 'Build completed successfully. Output written to dist/' },
    }));
    expect(first).not.toBeNull();

    // Exact same command and output — should be deduped
    const second = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'npm run build --production' },
      toolOutput: { output: 'Build completed successfully. Output written to dist/' },
    }));
    expect(second).toBeNull();
  });

  it('dedup does NOT match across different projects', () => {
    const first = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/main.ts', old_string: 'a', new_string: 'b' },
      project: 'project-alpha',
    }));
    expect(first).not.toBeNull();

    // Same tool+file+category but different project — should NOT be deduped
    const second = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/main.ts', old_string: 'a', new_string: 'b' },
      project: 'project-beta',
    }));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('dedup does NOT match across different sessions', () => {
    const first = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/main.ts', old_string: 'a', new_string: 'b' },
      sessionId: 'session-1',
    }));
    expect(first).not.toBeNull();

    // Same tool+file+category+project but different session — should NOT be deduped
    const second = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/main.ts', old_string: 'a', new_string: 'b' },
      sessionId: 'session-2',
    }));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  // --- Title redaction ---

  it('applies redaction to title (secret in title is replaced)', () => {
    const id = processToolObservation(makeInput({
      toolName: 'Bash',
      toolInput: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://api.example.com' },
      toolOutput: { output: 'HTTP/1.1 200 OK response body here' },
    }));
    expect(id).not.toBeNull();

    const row = db.prepare('SELECT title FROM observations WHERE id = ?').get(id!) as { title: string };
    expect(row.title).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz123456');
    // Stored title uses generic [REDACTED] (typed markers stripped for FTS hygiene)
    expect(row.title).toContain('[REDACTED]');
    expect(row.title).not.toContain('[REDACTED_SECRET]');
  });

  // --- Non-throwing ---

  it('is non-throwing (returns null on error)', () => {
    // Pass a closed DB — should not throw, should return null
    const closedDb = new Database(':memory:');
    closedDb.close();

    const result = processToolObservation({
      db: closedDb,
      sessionId: 'test',
      project: 'test',
      toolName: 'Edit',
      toolInput: { file_path: '/src/x.ts', old_string: 'a', new_string: 'b' },
    });
    expect(result).toBeNull();
  });
});
