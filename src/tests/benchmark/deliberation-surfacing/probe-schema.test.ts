import { describe, it, expect } from 'vitest';
import {
  loadAllProbes,
  ProbeSchema,
  type DriftKind,
} from '../../../benchmark/deliberation-surfacing/probe-schema.js';

describe('probe-schema', () => {
  it('loads all 30 fixtures', () => {
    const probes = loadAllProbes();
    expect(probes).toHaveLength(30);
  });

  it('covers all 5 kinds with exactly 6 fixtures each', () => {
    const probes = loadAllProbes();
    const counts: Record<DriftKind, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 };
    for (const p of probes) counts[p.kind]++;
    for (const k of ['a', 'b', 'c', 'd', 'e'] as const) {
      expect(counts[k]).toBe(6);
    }
  });

  it('keeps real ≥70% (≥4/6) per kind, synthetic ≤30% (≤2/6) per kind', () => {
    const probes = loadAllProbes();
    for (const k of ['a', 'b', 'c', 'd', 'e'] as const) {
      const inKind = probes.filter((p) => p.kind === k);
      const real = inKind.filter((p) => p.source === 'real').length;
      const synth = inKind.filter((p) => p.source === 'synthetic').length;
      expect(real).toBeGreaterThanOrEqual(4);
      expect(synth).toBeLessThanOrEqual(2);
      expect(real + synth).toBe(6);
    }
  });

  it('every transcript_anchor has a non-empty session_id and a sane turn_index_range', () => {
    const probes = loadAllProbes();
    for (const p of probes) {
      expect(p.transcript_anchor.session_id.length).toBeGreaterThan(0);
      const [lo, hi] = p.transcript_anchor.turn_index_range;
      expect(hi).toBeGreaterThanOrEqual(lo);
    }
  });

  it('rejects malformed fixture (negative test on ProbeSchema.parse)', () => {
    expect(() => ProbeSchema.parse({ id: 'wrong-format', kind: 'z' })).toThrow();
  });
});
