/**
 * P9 — Wilson/Newcombe CI re-export.
 *
 * CONTEXT additional_locks: this file is a re-export, NOT a copy. The single
 * source of truth for binomial CI math across all v4-v6 empirical phases is
 * src/benchmark/episodic-density/wilson.ts. Drift here would create silent
 * methodology divergence between P9 and prior bound experiences.
 *
 * POLISH-09 / 11-CONTEXT.md § Methodology critique #2 — Wilson is correct for
 * a SINGLE-PROPORTION CI. Do NOT use Wilson on a pooled cross-replication
 * sample (r1 + r2 of the same 30 probes is pseudoreplication, not n=60
 * independent samples). Cross-replication binding is paired-McNemar — see
 * `pairedMcNemar` in `verdict.ts`. Wilson here remains useful for
 * per-replication CI rendering.
 */
export { wilsonCI, wilsonDeltaCI, WILSON_Z_95 } from '../episodic-density/wilson.js';
export type { CI } from '../episodic-density/wilson.js';
