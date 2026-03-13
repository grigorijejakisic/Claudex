/**
 * Stratified half-life pressure score decay.
 * Replaces Phase 1's decayPressure placeholder.
 * Non-throwing.
 * @see Architecture Section 9.3
 */

import type { Database } from 'better-sqlite3';

/**
 * Decays all pressure scores using stratified half-lives:
 * - HOT: 7-day half-life
 * - COLD: 3-day half-life
 *
 * Reclassifies temperature after decay (HOT if >= 0.851, else COLD).
 * Deletes entries below 0.01.
 * Returns total rows affected (updated + deleted).
 * Non-throwing (returns 0 on error).
 */
export function decayPressureStratified(db: Database, project?: string): number {
  try {
    // SQLite evaluates SET expressions using OLD row values, so we re-compute the decayed value inline
    const updateResult = project != null
      ? db
          .prepare(
            `UPDATE pressure_scores
             SET raw_pressure = raw_pressure * POWER(2, -1.0 / (CASE
               WHEN temperature = 'HOT' THEN 7
               ELSE 3
             END)),
             temperature = CASE
               WHEN raw_pressure * POWER(2, -1.0 / (CASE WHEN temperature = 'HOT' THEN 7 ELSE 3 END)) >= 0.851 THEN 'HOT'
               ELSE 'COLD'
             END
             WHERE project = ?`
          )
          .run(project)
      : db
          .prepare(
            `UPDATE pressure_scores
             SET raw_pressure = raw_pressure * POWER(2, -1.0 / (CASE
               WHEN temperature = 'HOT' THEN 7
               ELSE 3
             END)),
             temperature = CASE
               WHEN raw_pressure * POWER(2, -1.0 / (CASE WHEN temperature = 'HOT' THEN 7 ELSE 3 END)) >= 0.851 THEN 'HOT'
               ELSE 'COLD'
             END`
          )
          .run();

    const deleteResult = project != null
      ? db
          .prepare('DELETE FROM pressure_scores WHERE raw_pressure < 0.01 AND project = ?')
          .run(project)
      : db
          .prepare('DELETE FROM pressure_scores WHERE raw_pressure < 0.01')
          .run();

    return updateResult.changes + deleteResult.changes;
  } catch {
    return 0;
  }
}
