/**
 * Pressure score accumulation, temperature transitions, and decay.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 4.2 (pressure_scores table)
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export interface PressureRow {
  file_path: string;
  project: string;
  raw_pressure: number;
  temperature: string;
  last_touched_epoch: number;
  decay_rate: number;
}

/** Threshold above which a file is considered HOT. */
const HOT_THRESHOLD = 0.5;

/** Threshold below which a file is demoted to COLD during decay. */
const COLD_THRESHOLD = 0.1;

/**
 * Accumulates pressure for a file within a project.
 * On conflict, adds the increment to raw_pressure.
 * Sets temperature to HOT if raw_pressure exceeds threshold, else COLD.
 * QUAL-04: Scoped by (file_path, project) composite key.
 */
export function updatePressureScore(
  db: Database,
  filePath: string,
  project: string,
  rawPressureIncrement: number
): void {
  cachedPrepare(db,
    `INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature, last_touched_epoch)
     VALUES (?, ?, ?, CASE WHEN ? > ${HOT_THRESHOLD} THEN 'HOT' ELSE 'COLD' END, unixepoch())
     ON CONFLICT(file_path, project) DO UPDATE SET
       raw_pressure = raw_pressure + ?,
       temperature = CASE WHEN raw_pressure + ? > ${HOT_THRESHOLD} THEN 'HOT' ELSE 'COLD' END,
       last_touched_epoch = unixepoch()`
  ).run(
    filePath,
    project,
    rawPressureIncrement,
    rawPressureIncrement,
    rawPressureIncrement,
    rawPressureIncrement
  );
}

/**
 * Returns all pressure scores for a project, ordered by raw_pressure DESC.
 * QUAL-04: Scoped by project.
 */
export function getPressureByProject(
  db: Database,
  project: string
): PressureRow[] {
  return cachedPrepare(db,
      `SELECT * FROM pressure_scores WHERE project = ?
       ORDER BY raw_pressure DESC`
    )
    .all(project) as PressureRow[];
}

/**
 * Returns HOT files for a project, ordered by raw_pressure DESC.
 * QUAL-04: Scoped by project and temperature.
 */
export function getHotFiles(
  db: Database,
  project: string,
  limit?: number
): PressureRow[] {
  return cachedPrepare(db,
      `SELECT * FROM pressure_scores
       WHERE project = ? AND temperature = 'HOT'
       ORDER BY raw_pressure DESC
       LIMIT ?`
    )
    .all(project, limit ?? 100) as PressureRow[];
}

/**
 * Decays all pressure scores for a project by the given rate.
 * Demotes to COLD where raw_pressure drops below threshold.
 * Returns total rows affected (decay + demotion).
 * QUAL-04: Scoped by project.
 */
export function decayPressure(
  db: Database,
  project: string,
  decayRate?: number
): number {
  const rate = decayRate ?? 0.1;

  const doBatchDecay = db.transaction(() => {
    const decayResult = cachedPrepare(db,
      `UPDATE pressure_scores
       SET raw_pressure = raw_pressure * (1 - ?)
       WHERE project = ?`
    ).run(rate, project);

    cachedPrepare(db,
      `UPDATE pressure_scores
       SET temperature = 'COLD'
       WHERE project = ? AND raw_pressure < ${COLD_THRESHOLD}`
    ).run(project);

    return decayResult.changes;
  });

  return doBatchDecay();
}
