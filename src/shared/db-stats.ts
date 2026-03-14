/**
 * Shared database stats helper — used by both migrate and setup CLIs.
 * Gathers row counts from a database (v2 or v3) for display and verification.
 * Non-throwing — returns zeroed stats on any error.
 */

import Database from 'better-sqlite3';

export interface DbStats {
  observationCount: number;
  sessionCount: number;
  pressureCount: number;
}

/**
 * Gathers row counts from a database (v2 or v3) for display and verification.
 * Non-throwing — returns zeroed stats on any error.
 */
export function getDbStats(dbPath: string): DbStats {
  const stats: DbStats = { observationCount: 0, sessionCount: 0, pressureCount: 0 };
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      try {
        const obs = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
        stats.observationCount = obs.count;
      } catch { /* Non-throwing: table may not exist in v2 DBs — caller handles zero count */ }
      try {
        const sess = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
        stats.sessionCount = sess.count;
      } catch { /* Non-throwing: table may not exist in v2 DBs — caller handles zero count */ }
      try {
        const press = db.prepare('SELECT COUNT(*) as count FROM pressure_scores').get() as { count: number };
        stats.pressureCount = press.count;
      } catch { /* Non-throwing: table may not exist in v2 DBs — caller handles zero count */ }
    } finally {
      try { db.close(); } catch { /* Non-throwing: close failure is harmless — process exits shortly */ }
    }
  } catch { /* Non-throwing: no DB access (standalone utility) — caller handles zeroed stats */ }
  return stats;
}
