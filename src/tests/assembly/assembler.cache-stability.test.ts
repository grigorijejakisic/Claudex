/**
 * 3-layer cache-stability test harness (Phase 5 Plan 02 — SC#2).
 *
 * Layer 1 (TOK-01): session-start tokenEstimate ≤500 via cl100k_base tokenizer.
 *   PRE-DELETION: expected to OVERRUN until Plan 05 closes Tier C. Warn-and-continue
 *   unless CLAUDEX_P5_TOKEN_GATE_STRICT=1. Plan 09 flips strict mode default.
 *
 * Layer 2 (CACH-01): SHA-256 of `content` byte-identical across two consecutive
 *   `assembleFullContext` runs with identical inputs.
 *
 * Layer 3 (CACH-02): SHA-256 unchanged after mutating volatile state between runs:
 *   nowEpoch += 100s, sessionId flipped to a different UUID, projectDir slash-style
 *   normalized to forward-slash form, vi.useFakeTimers() pegging system clock.
 *
 * Scenarios: cold-start, warm-start-with-memory-md, handoff-start, gsd-active-start.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { encode } from 'gpt-tokenizer';
import { createHash } from 'node:crypto';
import {
  makeColdStart, makeWarmStart, makeHandoffStart, makeGsdActiveStart,
  cleanupFixture, type CacheStabilityFixture,
} from './assembler-cache-fixtures.js';

const SCENARIOS = [
  { name: 'cold-start', build: makeColdStart },
  { name: 'warm-start-with-memory-md', build: makeWarmStart },
  { name: 'handoff-start', build: makeHandoffStart },
  { name: 'gsd-active-start', build: makeGsdActiveStart },
] as const;

const TOKEN_BUDGET = 500;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

for (const sc of SCENARIOS) {
  describe(`cache-stability: ${sc.name}`, () => {
    let fx: CacheStabilityFixture | null = null;

    afterEach(() => {
      if (fx) {
        cleanupFixture(fx);
        fx = null;
      }
      vi.useRealTimers();
    });

    test('layer 1 — token budget ≤500 (cl100k_base, gpt-tokenizer)', () => {
      fx = sc.build();
      const out = fx.run();
      const tokens = encode(out.content).length;

      // eslint-disable-next-line no-console
      console.log(`[cache-stability:${sc.name}] tokens=${tokens} (budget=${TOKEN_BUDGET})`);

      const strict = process.env.CLAUDEX_P5_TOKEN_GATE_STRICT === '1';
      if (tokens > TOKEN_BUDGET && !strict) {
        // Pre-deletion observed-overrun mode. Plan 05 closes Tier C; Plan 09 flips
        // the default to strict — at that point this branch goes away and the
        // hard expect below is the only assert.
        // eslint-disable-next-line no-console
        console.warn(`[cache-stability:${sc.name}] OVERRUN by ${tokens - TOKEN_BUDGET} (expected pre-deletion)`);
        expect.soft(tokens).toBeLessThanOrEqual(TOKEN_BUDGET);
        return;
      }
      expect(tokens).toBeLessThanOrEqual(TOKEN_BUDGET);
    });

    test('layer 2 — byte-identical across consecutive runs (CACH-01)', () => {
      fx = sc.build();
      const a = fx.run();
      const b = fx.run();
      const aHash = sha(a.content);
      const bHash = sha(b.content);
      if (aHash !== bHash) {
        // Print prefix diff for diagnosis
        // eslint-disable-next-line no-console
        console.error(`[cache-stability:${sc.name}] LAYER 2 DIFF\n--- A (${aHash})\n${a.content.slice(0, 400)}\n--- B (${bHash})\n${b.content.slice(0, 400)}`);
      }
      expect(aHash).toBe(bHash);
    });

    test('layer 3 — invariant under clock/session-ID/host-env mutation (CACH-02)', () => {
      fx = sc.build();
      const baseline = fx.run();
      const baselineHash = sha(baseline.content);

      // Mutate clock by +100s, peg system clock to match for any unguarded paths
      const originalNowEpoch = fx.nowEpoch;
      fx.nowEpoch = originalNowEpoch + 100;
      vi.useFakeTimers();
      vi.setSystemTime((originalNowEpoch + 100) * 1000);

      // Mutate session-ID
      fx.sessionId = '11111111-1111-1111-1111-111111111111';

      // Mutate host-env: backslash → forward-slash style on the projectDir token.
      // CACH-03 hardening normalizes this, so emitted bytes must not change.
      fx.projectDir = fx.projectDir.replace(/\\/g, '/');

      const mutated = fx.run();
      vi.useRealTimers();

      const mutatedHash = sha(mutated.content);
      if (mutatedHash !== baselineHash) {
        // eslint-disable-next-line no-console
        console.error(`[cache-stability:${sc.name}] LAYER 3 DIFF\n--- baseline (${baselineHash})\n${baseline.content.slice(0, 400)}\n--- mutated (${mutatedHash})\n${mutated.content.slice(0, 400)}`);
      }
      expect(mutatedHash).toBe(baselineHash);
    });
  });
}
