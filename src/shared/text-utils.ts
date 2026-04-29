/**
 * Text utilities with defensive non-throwing pattern.
 */

import { encode } from 'gpt-tokenizer';

/**
 * Truncates text at maxLength, appending "..." if truncated.
 * Returns empty string if input is falsy. Never throws.
 */
export function truncateText(text: string, maxLength: number): string {
  try {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  } catch {
    // Non-throwing: no DB access — caller handles empty string as safe default
    return '';
  }
}

/**
 * Lowercases, trims, and collapses whitespace.
 * Returns empty string if input is falsy. Never throws.
 */
export function normalize(text: string): string {
  try {
    if (!text) return '';
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  } catch {
    // Non-throwing: no DB access — caller handles empty string as safe default
    return '';
  }
}

/**
 * Strips UTF-8 BOM and normalizes line endings to LF.
 *
 * CACH-03: Windows-checkout files arrive with CRLF (and sometimes BOM); cache
 * prefix bytes flip when the same content reads differently on POSIX vs
 * Windows. Apply at all section-emitter file-read sites.
 */
export function normalizeText(s: string): string {
  if (!s) return '';
  // Strip UTF-8 BOM
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  // Normalize CRLF/CR to LF
  return s.replace(/\r\n?/g, '\n');
}

/**
 * Rough token count estimate (chars / 4).
 * Returns 0 on error. Never throws.
 */
export function estimateTokens(text: string): number {
  try {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  } catch {
    // Non-throwing: no DB access — caller handles 0 as safe default (zero-token estimate)
    return 0;
  }
}

/**
 * Real cl100k_base token count via gpt-tokenizer.
 *
 * Use ONLY at observability surfaces (retrieval_log, /endsession,
 * /claudex-why) — Claudex hot paths still use estimateTokens (chars/4) for
 * budget math because the real tokenizer adds ~10-50ms per call. The
 * surfaces above invoke this once per retrieval / once at session close,
 * which is acceptable.
 *
 * Returns 0 on null/undefined/empty input. Never throws.
 */
export function countTokensCl100k(text: string | null | undefined): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return 0;
  }
}
