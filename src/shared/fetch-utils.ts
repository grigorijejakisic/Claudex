/**
 * Shared fetch helper with abort timeout and non-throwing semantics.
 * @see Architecture Section 6.1, 6.4
 */

/** Maximum response body size in bytes (10 MB). R34. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Fetch JSON with abort timeout and optional response size limit.
 * Returns parsed JSON or null on error/timeout/size-exceeded.
 * Non-throwing — catches network errors, abort, non-2xx responses, and JSON parse failures.
 * R33: Composes caller signal with internal timeout signal.
 * R34: Timeout covers body read; rejects responses exceeding MAX_RESPONSE_BYTES.
 * CRIT-05: Enforces size limit on actual body text, not just content-length header.
 */
export async function fetchJsonWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number; maxResponseBytes?: number } = {}
): Promise<unknown | null> {
  const { timeoutMs = 5000, maxResponseBytes = MAX_RESPONSE_BYTES, ...fetchOpts } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // R33: Compose caller's signal with our timeout signal
  const callerSignal = fetchOpts.signal;
  let composedSignal: AbortSignal;
  if (callerSignal) {
    // AbortSignal.any is available in modern runtimes (Node 20+, Bun)
    if (typeof AbortSignal.any === 'function') {
      composedSignal = AbortSignal.any([callerSignal, controller.signal]);
    } else {
      // Fallback: listen on caller signal to abort our controller
      composedSignal = controller.signal;
      if (!callerSignal.aborted) {
        callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
      } else {
        controller.abort();
      }
    }
  } else {
    composedSignal = controller.signal;
  }

  try {
    const resp = await fetch(url, { ...fetchOpts, signal: composedSignal });
    if (!resp.ok) {
      clearTimeout(timeout);
      return null;
    }

    // R34: Check content-length before reading body
    const contentLength = resp.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
      clearTimeout(timeout);
      return null;
    }

    // R34/CRIT-05: Read as text to enforce size limit on actual body (not just content-length header)
    const text = await resp.text();
    clearTimeout(timeout);

    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      return null;
    }

    return JSON.parse(text);
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
