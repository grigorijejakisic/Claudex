/**
 * Read-time normalization for `created_at_epoch` / `updated_at_epoch` columns
 * across mixed-precision rows.
 *
 * Phase 4.1 locks epoch-ms (Date.now() output, 13-digit) as the canonical unit.
 * Legacy rows from `transcript_chunk` (and possibly other writers prior to the
 * Phase 4.1 fix) carry epoch-seconds (10-digit). Read paths that compare or
 * order across mixed kinds must normalize on read. This is the only allowed
 * normalization site — write paths must produce ms directly.
 *
 * Threshold: any value below 1e12 is treated as seconds and multiplied by 1000.
 * 1e12 ms = 2001-09-09; any real ms-precision Claudex epoch is well above this.
 * 1e12 s = year 33658; no real seconds-precision epoch reaches this.
 */
export function normalizeEpochMs(value: number | null | undefined): number {
  if (value == null) return 0;
  if (!Number.isFinite(value)) return 0;
  if (value < 1e12) return value * 1000;
  return value;
}
