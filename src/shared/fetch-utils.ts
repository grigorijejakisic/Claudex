/**
 * Shared fetch helper with abort timeout and non-throwing semantics.
 * @see Architecture Section 6.1, 6.4
 */

/**
 * Fetch JSON with abort timeout and optional response size limit.
 * Returns parsed JSON or null on error/timeout/size-exceeded.
 * Non-throwing — catches network errors, abort, non-2xx responses, and JSON parse failures.
 * When maxResponseBytes is set, enforces the limit on the actual body text,
 * not just the content-length header, preventing chunked transfer bypass.
 */
export async function fetchJsonWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number; maxResponseBytes?: number } = {}
): Promise<unknown | null> {
  const { timeoutMs = 5000, maxResponseBytes, ...fetchOpts } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...fetchOpts, signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;

    // Read body as text for size enforcement
    const text = await resp.text();

    // Enforce size limit on actual body (not just content-length header)
    if (maxResponseBytes !== undefined && text.length > maxResponseBytes) {
      return null;
    }

    return JSON.parse(text);
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
