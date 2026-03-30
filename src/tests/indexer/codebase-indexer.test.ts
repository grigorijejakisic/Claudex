/**
 * Regression tests for codebase indexer brace depth tracking.
 *
 * Bug: nested blocks (if/for/while) used to reset currentFunction because the
 * old code checked for `^}` line start instead of tracking brace depth.
 * The fix uses braceDepth / functionStartDepth to accurately detect when a
 * function's closing brace is reached.
 *
 * Also tests Allman-style braces (opening brace on its own line).
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { indexFile } from '../../indexer/codebase-indexer.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  // code_index is created by migrateV11toV12, which doesn't run on fresh DBs
  // (initializeSchema returns early for fresh DBs with no tables to migrate).
  // Create it explicitly for testing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_index (
      project TEXT NOT NULL,
      file_path TEXT NOT NULL,
      last_indexed_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      ast_hash TEXT,
      symbols TEXT,
      call_graph TEXT,
      imports TEXT,
      exports TEXT,
      embedding BLOB,
      PRIMARY KEY (project, file_path)
    )
  `);
  return db;
}

/** Write a temp .ts file and return its path. Caller should clean up. */
function writeTempFile(content: string): string {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `claudex-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('Brace depth tracking (regression)', () => {
  const tempFiles: string[] = [];
  let db: Database.Database;

  afterEach(() => {
    try { db?.close(); } catch { /* */ }
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* */ }
    }
    tempFiles.length = 0;
  });

  it('nested if/for/while blocks do NOT reset currentFunction', () => {
    db = createTestDb();
    const content = `
export function processItems(items: string[]) {
  for (const item of items) {
    if (item.length > 0) {
      doSomething(item);
      while (item.length > 10) {
        trimItem(item);
      }
    }
  }
  finalizeProcessing();
}
`;
    const filePath = writeTempFile(content);
    tempFiles.push(filePath);

    indexFile(db, 'test-project', filePath);

    const row = db.prepare(
      `SELECT call_graph FROM code_index WHERE file_path = ?`
    ).get(filePath) as { call_graph: string } | undefined;

    expect(row).not.toBeUndefined();
    const callGraph = JSON.parse(row!.call_graph) as Array<{ caller: string; callee: string }>;

    // ALL function calls should have processItems as caller
    // (not null, which would happen if nested blocks reset currentFunction)
    const callers = callGraph.map(c => c.caller);
    const callees = callGraph.map(c => c.callee);

    expect(callees).toContain('doSomething');
    expect(callees).toContain('trimItem');
    expect(callees).toContain('finalizeProcessing');

    // Every caller should be processItems — not null or undefined
    for (const caller of callers) {
      expect(caller).toBe('processItems');
    }
  });

  it('handles Allman-style braces (opening brace on separate line)', () => {
    db = createTestDb();
    const content = `
export function allmanStyle(x: number)
{
  doWork(x);
  if (x > 0)
  {
    handlePositive(x);
  }
  cleanup();
}
`;
    const filePath = writeTempFile(content);
    tempFiles.push(filePath);

    indexFile(db, 'test-project', filePath);

    const row = db.prepare(
      `SELECT call_graph FROM code_index WHERE file_path = ?`
    ).get(filePath) as { call_graph: string } | undefined;

    expect(row).not.toBeUndefined();
    const callGraph = JSON.parse(row!.call_graph) as Array<{ caller: string; callee: string }>;

    const callees = callGraph.map(c => c.callee);
    expect(callees).toContain('doWork');
    expect(callees).toContain('handlePositive');
    expect(callees).toContain('cleanup');

    // All calls attributed to allmanStyle
    for (const edge of callGraph) {
      expect(edge.caller).toBe('allmanStyle');
    }
  });

  it('correctly exits function scope at closing brace (not prematurely)', () => {
    db = createTestDb();
    const content = `
export function firstFunc() {
  callA();
}

export function secondFunc() {
  callB();
}
`;
    const filePath = writeTempFile(content);
    tempFiles.push(filePath);

    indexFile(db, 'test-project', filePath);

    const row = db.prepare(
      `SELECT call_graph, symbols FROM code_index WHERE file_path = ?`
    ).get(filePath) as { call_graph: string; symbols: string } | undefined;

    expect(row).not.toBeUndefined();
    const callGraph = JSON.parse(row!.call_graph) as Array<{ caller: string; callee: string }>;

    const callAEdge = callGraph.find(c => c.callee === 'callA');
    const callBEdge = callGraph.find(c => c.callee === 'callB');

    expect(callAEdge).not.toBeUndefined();
    expect(callBEdge).not.toBeUndefined();
    expect(callAEdge!.caller).toBe('firstFunc');
    expect(callBEdge!.caller).toBe('secondFunc');
  });

  it('deeply nested blocks do not confuse scope tracking', () => {
    db = createTestDb();
    const content = `
function deepNesting() {
  if (true) {
    for (let i = 0; i < 10; i++) {
      while (true) {
        if (false) {
          innerCall();
        }
        break;
      }
    }
  }
  outerCall();
}
`;
    const filePath = writeTempFile(content);
    tempFiles.push(filePath);

    indexFile(db, 'test-project', filePath);

    const row = db.prepare(
      `SELECT call_graph FROM code_index WHERE file_path = ?`
    ).get(filePath) as { call_graph: string } | undefined;

    expect(row).not.toBeUndefined();
    const callGraph = JSON.parse(row!.call_graph) as Array<{ caller: string; callee: string }>;

    // Both innerCall and outerCall should be attributed to deepNesting
    const innerEdge = callGraph.find(c => c.callee === 'innerCall');
    const outerEdge = callGraph.find(c => c.callee === 'outerCall');

    expect(innerEdge).not.toBeUndefined();
    expect(outerEdge).not.toBeUndefined();
    expect(innerEdge!.caller).toBe('deepNesting');
    expect(outerEdge!.caller).toBe('deepNesting');
  });
});
