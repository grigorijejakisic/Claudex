/**
 * Shared fetch helper with abort timeout and non-throwing semantics.
 * @see Architecture Section 6.1, 6.4
 */

/**
 * Fetch JSON with abort timeout. Returns parsed JSON or null on error/timeout.
 * Non-throwing — catches network errors, abort, non-2xx responses, and JSON parse failures.
 */
export async function fetchJsonWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<unknown | null> {
  const { timeoutMs = 5000, ...fetchOpts } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...fetchOpts, signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
