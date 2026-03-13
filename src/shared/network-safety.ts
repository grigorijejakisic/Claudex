/**
 * Shared private/loopback IPv4 check.
 * Used by both the redaction engine (PII IP filtering) and
 * the embedding provider (URL safety validation).
 * Pure function. Non-throwing.
 */

/**
 * Returns true if the first two octets of an IPv4 address fall within
 * a private (RFC 1918) or loopback (127.x) range.
 *
 * Covered ranges:
 * - 10.0.0.0/8
 * - 172.16.0.0/12 (172.16–172.31)
 * - 192.168.0.0/16
 * - 127.0.0.0/8 (loopback)
 */
export function isPrivateIPv4(a: number, b: number): boolean {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}
