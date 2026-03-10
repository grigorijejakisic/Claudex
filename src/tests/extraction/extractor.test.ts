/**
 * Integration tests for the extraction dispatcher pipeline.
 * Uses in-memory SQLite DB via better-sqlite3 + initializeSchema.
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { processToolObservation } from '../../extraction/extractor.js';
import type { ProcessToolObservationInput } from '../../extraction/extractor.js';

describe('processToolObservation', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
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
    expect(typeof id).toBe('number');

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
    expect(row.content).toContain('[REDACTED_SECRET]');
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
    expect(row.importance).toBe(5);
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

    // Manually backdate the timestamp by 6 minutes (360 seconds)
    db.prepare(
      'UPDATE observations SET timestamp_epoch = timestamp_epoch - 360 WHERE id = ?'
    ).run(first!);

    // Same tool+file+category but now outside 5-minute window
    const second = processToolObservation(makeInput({
      toolName: 'Edit',
      toolInput: { file_path: '/src/old.ts', old_string: 'c', new_string: 'd' },
    }));
    expect(second).not.toBeNull();
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
