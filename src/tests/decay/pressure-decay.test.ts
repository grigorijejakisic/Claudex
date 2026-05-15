import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { decayPressureStratified } from '../../decay/pressure-decay.js';

let db: TestDatabase;

beforeEach(() => {
  db = createTestDb();
});

function seedPressure(filePath: string, rawPressure: number, temperature: string, project = 'proj-1'): void {
  db.prepare(
    `INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature, last_touched_epoch_ms)
     VALUES (?, ?, ?, ?, (unixepoch() * 1000))`
  ).run(filePath, project, rawPressure, temperature);
}

function getPressure(filePath: string, project = 'proj-1'): { raw_pressure: number; temperature: string } | undefined {
  return db.prepare(
    'SELECT raw_pressure, temperature FROM pressure_scores WHERE file_path = ? AND project = ?'
  ).get(filePath, project) as { raw_pressure: number; temperature: string } | undefined;
}

describe('decayPressureStratified', () => {
  it('decays HOT files with 7-day half-life', () => {
    seedPressure('hot.ts', 1.0, 'HOT');
    decayPressureStratified(db);

    const result = getPressure('hot.ts');
    // 1.0 * 2^(-1/7) ~= 0.9057
    expect(result!.raw_pressure).toBeCloseTo(0.9057, 3);
  });

  it('decays COLD files with 3-day half-life', () => {
    seedPressure('cold.ts', 0.4, 'COLD');
    decayPressureStratified(db);

    const result = getPressure('cold.ts');
    // 0.4 * 2^(-1/3) ~= 0.3175
    expect(result!.raw_pressure).toBeCloseTo(0.3175, 3);
  });

  it('reclassifies HOT to COLD when decayed below 0.851', () => {
    seedPressure('demote.ts', 0.86, 'HOT');
    decayPressureStratified(db);

    const result = getPressure('demote.ts');
    // 0.86 * 2^(-1/7) ~= 0.7789 < 0.851
    expect(result!.temperature).toBe('COLD');
  });

  it('keeps HOT classification when still above 0.851', () => {
    seedPressure('stayhot.ts', 2.0, 'HOT');
    decayPressureStratified(db);

    const result = getPressure('stayhot.ts');
    // 2.0 * 2^(-1/7) ~= 1.8114 >= 0.851
    expect(result!.temperature).toBe('HOT');
  });

  it('deletes entries below 0.01 after decay', () => {
    // 0.011 * 2^(-1/3) ~= 0.00873 < 0.01
    seedPressure('tiny.ts', 0.011, 'COLD');
    decayPressureStratified(db);

    const result = getPressure('tiny.ts');
    expect(result).toBeUndefined();
  });

  it('returns total rows affected', () => {
    seedPressure('a.ts', 1.0, 'HOT');
    seedPressure('b.ts', 0.5, 'COLD');
    seedPressure('c.ts', 0.3, 'COLD');

    const affected = decayPressureStratified(db);
    expect(affected).toBe(3); // 3 updated, 0 deleted
  });

  it('is non-throwing on error', () => {
    const closedDb = createTestDb();
    closedDb.close();
    expect(decayPressureStratified(closedDb)).toBe(0);
  });

  it('only decays scores for the specified project', () => {
    seedPressure('a.ts', 1.0, 'HOT', 'proj-A');
    seedPressure('b.ts', 0.5, 'COLD', 'proj-B');

    // Decay only proj-A
    decayPressureStratified(db, 'proj-A');

    const resultA = getPressure('a.ts', 'proj-A');
    expect(resultA!.raw_pressure).toBeCloseTo(0.9057, 3); // decayed

    const resultB = getPressure('b.ts', 'proj-B');
    expect(resultB!.raw_pressure).toBe(0.5); // untouched
  });

  it('decays all projects when project is omitted', () => {
    seedPressure('a.ts', 1.0, 'HOT', 'proj-A');
    seedPressure('b.ts', 0.5, 'COLD', 'proj-B');

    decayPressureStratified(db);

    const resultA = getPressure('a.ts', 'proj-A');
    expect(resultA!.raw_pressure).toBeCloseTo(0.9057, 3);

    const resultB = getPressure('b.ts', 'proj-B');
    // 0.5 * 2^(-1/3) ~= 0.3969
    expect(resultB!.raw_pressure).toBeCloseTo(0.3969, 3);
  });

  it('only deletes sub-threshold entries for specified project', () => {
    seedPressure('tiny-a.ts', 0.005, 'COLD', 'proj-A');
    seedPressure('tiny-b.ts', 0.005, 'COLD', 'proj-B');

    decayPressureStratified(db, 'proj-A');

    // proj-A entry should be deleted (decayed below 0.01)
    expect(getPressure('tiny-a.ts', 'proj-A')).toBeUndefined();
    // proj-B entry should remain untouched
    expect(getPressure('tiny-b.ts', 'proj-B')).toBeDefined();
  });
});
