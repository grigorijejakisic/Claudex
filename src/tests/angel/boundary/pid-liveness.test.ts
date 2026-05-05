/**
 * Tests for src/angel/boundary/pid-liveness.ts.
 */

import { describe, it, expect } from 'vitest';
import { isPidAlive } from '../../../angel/boundary/pid-liveness.js';

describe('isPidAlive', () => {
  it('returns true for current process PID', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for an obviously-dead PID', () => {
    expect(isPidAlive(99999999)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isPidAlive(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isPidAlive(undefined)).toBe(false);
  });

  it('returns false for 0', () => {
    expect(isPidAlive(0)).toBe(false);
  });

  it('returns false for negative PID', () => {
    expect(isPidAlive(-1)).toBe(false);
  });

  it('returns false for fractional PID', () => {
    expect(isPidAlive(0.5)).toBe(false);
  });

  it('returns false for NaN', () => {
    expect(isPidAlive(NaN)).toBe(false);
  });
});
