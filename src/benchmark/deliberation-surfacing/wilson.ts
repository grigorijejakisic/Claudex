/**
 * P9 — Wilson/Newcombe CI re-export.
 *
 * CONTEXT additional_locks: this file is a re-export, NOT a copy. The single
 * source of truth for binomial CI math across all v4-v6 empirical phases is
 * src/benchmark/episodic-density/wilson.ts. Drift here would create silent
 * methodology divergence between P9 and prior bound experiences.
 */
export { wilsonCI, wilsonDeltaCI, WILSON_Z_95 } from '../episodic-density/wilson.js';
export type { CI } from '../episodic-density/wilson.js';
