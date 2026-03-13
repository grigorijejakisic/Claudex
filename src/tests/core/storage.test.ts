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

describe('busy_timeout pragma', () => {
  it('sets busy_timeout to 5000ms', () => {
    const db = openDatabase(':memory:');
    const result = db.pragma('busy_timeout') as Array<{ timeout: number }>;
    expect(result[0].timeout).toBe(5000);
    db.close();
  });
});

describe('concurrent SQLite access (WAL + busy_timeout)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-concurrent-test-'));
    dbPath = path.join(tmpDir, 'concurrent.db');
    // Initialize schema via first connection
    const db = openDatabase(dbPath);
    initializeSchema(db);
    closeDatabase(db);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two connections can write concurrently without SQLITE_BUSY', () => {
    const db1 = openDatabase(dbPath);
    const db2 = openDatabase(dbPath);

    // Both connections insert rows — WAL + busy_timeout should prevent SQLITE_BUSY
    const insert1 = db1.prepare(`
      INSERT INTO observations (session_id, tool_name, category, title, content, importance)
      VALUES (?, 'tool1', 'code', ?, 'content from db1', 3)
    `);

    const insert2 = db2.prepare(`
      INSERT INTO observations (session_id, tool_name, category, title, content, importance)
      VALUES (?, 'tool2', 'architecture', ?, 'content from db2', 4)
    `);

    // Interleave writes from both connections
    for (let i = 0; i < 20; i++) {
      insert1.run(`session-1`, `title-db1-${i}`);
      insert2.run(`session-2`, `title-db2-${i}`);
    }

    // Verify all 40 rows committed
    const count1 = db1.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number };
    expect(count1.cnt).toBe(40);

    const count2 = db2.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number };
    expect(count2.cnt).toBe(40);

    closeDatabase(db1);
    closeDatabase(db2);
  });

  it('concurrent transactions from multiple connections succeed', () => {
    const db1 = openDatabase(dbPath);
    const db2 = openDatabase(dbPath);

    const txn1 = db1.transaction(() => {
      for (let i = 0; i < 10; i++) {
        db1.prepare(`
          INSERT INTO observations (session_id, tool_name, category, title, content, importance)
          VALUES ('txn-s1', 'tool1', 'code', 'txn1-title-${i}', 'txn1 content', 3)
        `).run();
      }
    });

    const txn2 = db2.transaction(() => {
      for (let i = 0; i < 10; i++) {
        db2.prepare(`
          INSERT INTO observations (session_id, tool_name, category, title, content, importance)
          VALUES ('txn-s2', 'tool2', 'error', 'txn2-title-${i}', 'txn2 content', 5)
        `).run();
      }
    });

    // Execute transactions — WAL allows concurrent readers, and busy_timeout
    // ensures the second writer waits rather than throwing SQLITE_BUSY
    txn1();
    txn2();

    // Verify all rows from both transactions committed
    const count = db1.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number };
    expect(count.cnt).toBe(20);

    // Verify data integrity — correct session IDs
    const s1Count = db1.prepare("SELECT COUNT(*) as cnt FROM observations WHERE session_id = 'txn-s1'").get() as { cnt: number };
    expect(s1Count.cnt).toBe(10);

    const s2Count = db1.prepare("SELECT COUNT(*) as cnt FROM observations WHERE session_id = 'txn-s2'").get() as { cnt: number };
    expect(s2Count.cnt).toBe(10);

    closeDatabase(db1);
    closeDatabase(db2);
  });

  it('reads from one connection see writes from another after commit', () => {
    const db1 = openDatabase(dbPath);
    const db2 = openDatabase(dbPath);

    // Write from db1
    db1.prepare(`
      INSERT INTO observations (session_id, tool_name, category, title, content, importance)
      VALUES ('vis-s1', 'tool1', 'code', 'visible-title', 'visible content', 3)
    `).run();

    // Read from db2 — should see db1's write (WAL allows concurrent read/write)
    const row = db2.prepare("SELECT title FROM observations WHERE session_id = 'vis-s1'").get() as { title: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe('visible-title');

    closeDatabase(db1);
    closeDatabase(db2);
  });

  it('three concurrent connections all write successfully', () => {
    const db1 = openDatabase(dbPath);
    const db2 = openDatabase(dbPath);
    const db3 = openDatabase(dbPath);

    const connections = [
      { db: db1, session: 'triple-s1' },
      { db: db2, session: 'triple-s2' },
      { db: db3, session: 'triple-s3' },
    ];

    for (const { db, session } of connections) {
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO observations (session_id, tool_name, category, title, content, importance)
          VALUES (?, 'tool', 'code', ?, 'content', 3)
        `).run(session, `title-${i}`);
      }
    }

    // Verify total: 30 rows (10 from each connection)
    const count = db1.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number };
    expect(count.cnt).toBe(30);

    // Verify each session has exactly 10
    for (const { session } of connections) {
      const sessionCount = db1.prepare('SELECT COUNT(*) as cnt FROM observations WHERE session_id = ?').get(session) as { cnt: number };
      expect(sessionCount.cnt).toBe(10);
    }

    closeDatabase(db1);
    closeDatabase(db2);
    closeDatabase(db3);
  });
});
