/**
 * Pressure score accumulation, temperature transitions, and decay.
 * Plain functions with `db: Database` as first param.
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

/**
 * Accumulates pressure for a file within a project.
 * On conflict, adds the increment to raw_pressure.
 * Sets temperature to HOT if raw_pressure exceeds threshold, else COLD.
 * Scoped by (file_path, project) composite key.
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
 * Returns HOT files for a project, ordered by raw_pressure DESC.
 * Scoped by project and temperature.
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

