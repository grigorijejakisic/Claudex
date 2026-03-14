/**
 * SQLite connection lifecycle — open, close, and Database type re-export.
 * Plain functions with `db: Database` as first param (no class wrapper).
 */

import Database from 'better-sqlite3';
import { initializeSchema } from './migrations.js';

export type { Database } from 'better-sqlite3';

/**
 * Opens a SQLite database at the given path with production PRAGMAs.
 * Sets WAL mode, NORMAL synchronous, 10k cache, and foreign keys ON.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = 10000');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  initializeSchema(db);

  return db;
}

/**
 * Closes the database connection. Non-throwing — wraps in try/catch.
 */
export function closeDatabase(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // Intentionally swallowed — non-throwing per spec
  }
}
