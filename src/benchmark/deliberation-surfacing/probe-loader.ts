import { loadAllProbes, PROBES_DIR, type Probe } from './probe-schema.js';

/** Loads all 30 fixtures from the locked probe directory. Throws on missing or malformed fixture. */
export function loadProbes(dir: string = PROBES_DIR): Probe[] {
  const probes = loadAllProbes(dir);
  if (probes.length !== 30) {
    throw new Error(
      `Expected 30 probes, found ${probes.length}. Re-check fixture directory at ${dir}.`,
    );
  }
  return probes;
}

export { PROBES_DIR };
