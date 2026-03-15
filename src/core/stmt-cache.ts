/**
 * Prepared statement cache — avoids re-parsing SQL on every invocation.
 * Uses WeakMap keyed by Database instance so cache is GC'd when DB is closed.
 * LRU eviction at MAX_CACHE_SIZE prevents unbounded growth in long-lived processes.
 */

import type { Database, Statement } from 'better-sqlite3';

/** Max cached statements per DB instance. 256 covers all production SQL with headroom. */
const MAX_CACHE_SIZE = 256;

/**
 * Cache: WeakMap<Database, Map<sql_string, Statement>>.
 * WeakMap ensures cache entries are garbage-collected when DB instance is released.
 * Inner Map keys by exact SQL string. Map iteration order = insertion order (LRU basis).
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
 *
 * Evicts oldest entries when cache exceeds MAX_CACHE_SIZE, preventing unbounded
 * memory growth in long-lived processes (e.g. OpenClaw bridge).
 */
export function cachedPrepare(db: Database, sql: string): Statement {
  let map = stmtCache.get(db);
  if (!map) {
    map = new Map();
    stmtCache.set(db, map);
  }

  let stmt = map.get(sql);
  if (stmt) {
    // Move to end for LRU freshness (delete + re-set preserves Map ordering)
    map.delete(sql);
    map.set(sql, stmt);
    return stmt;
  }

  // Evict oldest entries if at capacity
  if (map.size >= MAX_CACHE_SIZE) {
    const firstKey = map.keys().next().value as string;
    map.delete(firstKey);
  }

  stmt = db.prepare(sql);
  map.set(sql, stmt);
  return stmt;
}