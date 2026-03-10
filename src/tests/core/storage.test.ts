import Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../core/storage.js';
import { initializeSchema } from '../../core/migrations.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('openDatabase', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates database with WAL mode', () => {
    const db = openDatabase(dbPath);
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
    db.close();
  });

  it('sets synchronous to NORMAL', () => {
    const db = openDatabase(dbPath);
    const result = db.pragma('synchronous') as Array<{ synchronous: number }>;
    expect(result[0].synchronous).toBe(1); // 1 = NORMAL
    db.close();
  });

  it('sets cache_size to 10000', () => {
    const db = openDatabase(dbPath);
    const result = db.pragma('cache_size') as Array<{ cache_size: number }>;
    expect(result[0].cache_size).toBe(10000);
    db.close();
  });

  it('enables foreign keys', () => {
    const db = openDatabase(dbPath);
    const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(result[0].foreign_keys).toBe(1);
    db.close();
  });
});

describe('closeDatabase', () => {
  it('closes without error', () => {
    const db = new Database(':memory:');
    closeDatabase(db);
    // Verify closed: attempting a query should throw
    expect(() => db.prepare('SELECT 1')).toThrow();
  });

  it('is non-throwing on already-closed db', () => {
    const db = new Database(':memory:');
    db.close();
    // Second close via closeDatabase should not throw
    expect(() => closeDatabase(db)).not.toThrow();
  });
});

describe('transaction rollback', () => {
  it('rolls back on error', () => {
    const db = new Database(':memory:');
    initializeSchema(db);

    // Attempt a transaction that inserts then throws
    try {
      const txn = db.transaction(() => {
        db.prepare(`
          INSERT INTO observations (session_id, tool_name, category, title, content, importance)
          VALUES ('s1', 'test', 'code', 'test title', 'test content', 3)
        `).run();

        // Force an error mid-transaction
        throw new Error('Simulated failure');
      });
      txn();
    } catch {
      // Expected
    }

    // Verify no rows were inserted (transaction rolled back)
    const count = db.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number };
    expect(count.cnt).toBe(0);

    db.close();
  });
});
