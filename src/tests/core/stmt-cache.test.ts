import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { cachedPrepare } from '../../core/stmt-cache.js';

describe('cachedPrepare', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns a working prepared statement', () => {
    const stmt = cachedPrepare(db, 'SELECT COUNT(*) as cnt FROM observations');
    const row = stmt.get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  it('returns the same Statement object on repeated calls with same SQL', () => {
    const sql = 'SELECT COUNT(*) as cnt FROM observations';
    const stmt1 = cachedPrepare(db, sql);
    const stmt2 = cachedPrepare(db, sql);
    expect(stmt1).toBe(stmt2);
  });

  it('returns different Statement objects for different SQL', () => {
    const stmt1 = cachedPrepare(db, 'SELECT * FROM observations WHERE id = ?');
    const stmt2 = cachedPrepare(db, 'SELECT * FROM sessions WHERE session_id = ?');
    expect(stmt1).not.toBe(stmt2);
  });

  it('handles multiple DB instances independently', () => {
    const db2 = createTestDb();

    const sql = 'SELECT COUNT(*) as cnt FROM observations';
    const stmt1 = cachedPrepare(db, sql);
    const stmt2 = cachedPrepare(db2, sql);

    // Different DB instances produce different Statement objects
    expect(stmt1).not.toBe(stmt2);

    // Both still work
    expect((stmt1.get() as { cnt: number }).cnt).toBe(0);
    expect((stmt2.get() as { cnt: number }).cnt).toBe(0);

    db2.close();
  });

  it('cached statements work correctly for INSERT + SELECT', () => {
    const insertSql = `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;
    const selectSql = 'SELECT * FROM observations WHERE id = ?';

    // First use
    const result1 = cachedPrepare(db, insertSql).run('s1', 'proj', 'Read', 'code', 'title1', 'content1', 3);
    expect(Number(result1.lastInsertRowid)).toBeGreaterThan(0);

    // Second use — same cached statement
    const result2 = cachedPrepare(db, insertSql).run('s1', 'proj', 'Edit', 'code', 'title2', 'content2', 4);
    expect(Number(result2.lastInsertRowid)).toBeGreaterThan(Number(result1.lastInsertRowid));

    // Verify both rows exist
    const row1 = cachedPrepare(db, selectSql).get(Number(result1.lastInsertRowid)) as Record<string, unknown>;
    const row2 = cachedPrepare(db, selectSql).get(Number(result2.lastInsertRowid)) as Record<string, unknown>;
    expect(row1.title).toBe('title1');
    expect(row2.title).toBe('title2');
  });

});
