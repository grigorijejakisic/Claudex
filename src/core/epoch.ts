/**
 * epoch.ts — Typed helpers for millisecond-precision epoch timestamps.
 *
 * All DB columns in Claudex V35+ store epochs as **milliseconds** (integer).
 * This module is the single source of truth for epoch arithmetic; production
 * code should call these helpers instead of raw `Math.floor(Date.now()/1000)`
 * or ad-hoc `value * 1000` idioms.
 *
 * Design invariants:
 *  - Every function throws on invalid input (NaN, Infinity, negative, non-finite).
 *  - `nowMs()` and `nowSec()` are the only "current time" entry points.
 *  - `isMs` / `isSec` heuristics are not enforced at write time — they exist
 *    to guard callers that may consume mixed-precision data during the V34→V35
 *    migration window.
 *
 * Precision note for `last_heartbeat_ts` / `last_jsonl_write_ts`:
 *  These two session columns do NOT carry a `_ms` or `_sec` suffix because they
 *  were introduced as unit-agnostic names. As of V35 they store **milliseconds**
 *  — callers should treat them identically to `*_epoch_ms` columns.
 */

// ---------------------------------------------------------------------------
// Internal guard
// ---------------------------------------------------------------------------

function assertFinitePositive(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `epoch.${label}: expected a non-negative finite number, got ${String(value)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Current-time entry points
// ---------------------------------------------------------------------------

/**
 * Returns the current time in **milliseconds** since the Unix epoch.
 * Equivalent to `Date.now()`.
 *
 * @example
 * const ts = nowMs(); // e.g. 1715700000000
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * Returns the current time in **seconds** since the Unix epoch (floor).
 * Use this only when interfacing with systems that require second-precision
 * (e.g., JWT `exp` claims, external APIs). Claudex DB columns use ms.
 *
 * @example
 * const ts = nowSec(); // e.g. 1715700000
 */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

/**
 * Converts a value to **milliseconds**.
 *
 * - `fromUnit = 'ms'`: identity — returns value unchanged.
 * - `fromUnit = 'sec'`: multiplies by 1000.
 *
 * @throws {RangeError} if value is NaN, Infinity, or negative.
 *
 * @example
 * toMs(1715700000, 'sec');  // 1715700000000
 * toMs(1715700000000, 'ms'); // 1715700000000
 */
export function toMs(value: number, fromUnit: 'ms' | 'sec'): number {
  assertFinitePositive(value, 'toMs');
  return fromUnit === 'sec' ? value * 1000 : value;
}

/**
 * Converts a value to **seconds** (floor).
 *
 * - `fromUnit = 'sec'`: identity — returns value unchanged.
 * - `fromUnit = 'ms'`: divides by 1000 and floors.
 *
 * Sub-millisecond precision is lost when converting ms → sec.
 *
 * @throws {RangeError} if value is NaN, Infinity, or negative.
 *
 * @example
 * toSec(1715700000000, 'ms'); // 1715700000
 * toSec(1715700000, 'sec');   // 1715700000
 */
export function toSec(value: number, fromUnit: 'ms' | 'sec'): number {
  assertFinitePositive(value, 'toSec');
  return fromUnit === 'ms' ? Math.floor(value / 1000) : value;
}

// ---------------------------------------------------------------------------
// ISO 8601 interop
// ---------------------------------------------------------------------------

/**
 * Parses an ISO 8601 string and returns the epoch in **milliseconds**.
 *
 * @throws {TypeError}  if `iso` is not a string.
 * @throws {RangeError} if `iso` does not parse to a finite date.
 *
 * @example
 * fromIso('2025-05-14T12:00:00.000Z'); // 1715688000000
 */
export function fromIso(iso: string): number {
  if (typeof iso !== 'string') {
    throw new TypeError(
      `epoch.fromIso: expected a string, got ${typeof iso}`
    );
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `epoch.fromIso: could not parse "${iso}" as an ISO 8601 date`
    );
  }
  return ms;
}

/**
 * Converts an epoch in **milliseconds** to an ISO 8601 string with UTC offset.
 *
 * @throws {RangeError} if `ms` is NaN, Infinity, or negative.
 *
 * @example
 * toIso(1715688000000); // '2025-05-14T12:00:00.000Z'
 */
export function toIso(ms: number): string {
  assertFinitePositive(ms, 'toIso');
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Heuristic guards (migration-window helpers)
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `value` looks like a millisecond-precision epoch
 * (>= 1e12, i.e., year 2001+).
 *
 * This is a **heuristic** — use it to guard callers that may encounter
 * mixed-precision data during the V34→V35 migration window. Not a hard
 * contract.
 *
 * @throws {RangeError} if value < 1e9 (pre-2001 — no production data is that old).
 *
 * @example
 * isMs(1715700000000); // true
 * isMs(1715700000);    // false
 */
export function isMs(value: number): boolean {
  if (value < 1e9) {
    throw new RangeError(
      `epoch.isMs: value ${value} is below 1e9 (pre-2001); no production data should be this old`
    );
  }
  return value >= 1e12;
}

/**
 * Returns `true` if `value` looks like a second-precision epoch
 * (1e9 <= value < 1e12).
 *
 * @throws {RangeError} if value < 1e9 (pre-2001 — no production data is that old).
 *
 * @example
 * isSec(1715700000);    // true
 * isSec(1715700000000); // false
 */
export function isSec(value: number): boolean {
  if (value < 1e9) {
    throw new RangeError(
      `epoch.isSec: value ${value} is below 1e9 (pre-2001); no production data should be this old`
    );
  }
  return value >= 1e9 && value < 1e12;
}
