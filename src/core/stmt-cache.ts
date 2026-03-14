/**
 * Prepared statement cache — avoids re-parsing SQL on every invocation.
 * Uses WeakMap keyed by Database instance so cache is GC'd when DB is closed.
 * @see Architecture Section 4.1
 */

import type { Database, Statement } from 'better-sqlite3';

/**
 * Cache: WeakMap<Database, Map<sql_string, Statement>>.
 * WeakMap ensures cache entries are garbage-collected when DB instance is released.
 * Inner Map keys by exact SQL string.
 */
const stmtCache = new WeakMap<Database, Map<string, Statement>>();

/**
 * Returns a cached prepared statement for the given SQL, or prepares and caches it.
 * Thread-safe for single-threaded Node.js. Handles multiple DB instances (tests
 * create fresh :memory: DBs) via WeakMap keying.
 *
 * If the DB has been closed and a stale cache entry exists, the Statement will
 * throw on .run()/.get()/.all() — same behavior as calling db.prepare() on a
 * closed DB, so no special handling needed.
 */
export function cachedPrepare(db: Database, sql: string): Statement {
  let map = stmtCache.get(db);
  if (!map) {
    map = new Map();
    stmtCache.set(db, map);
  }

  let stmt = map.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    map.set(sql, stmt);
  }

  return stmt;
}