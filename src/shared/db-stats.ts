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
      } catch { /* table may not exist */ }
      try {
        const sess = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
        stats.sessionCount = sess.count;
      } catch { /* table may not exist */ }
      try {
        const press = db.prepare('SELECT COUNT(*) as count FROM pressure_scores').get() as { count: number };
        stats.pressureCount = press.count;
      } catch { /* table may not exist */ }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch { /* non-throwing */ }
  return stats;
}
