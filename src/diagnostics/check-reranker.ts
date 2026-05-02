/**
 * DIAG-04: Reranker check.
 *
 * Probes http://localhost:7439/health within 2s. Failures map to `warn`
 * (not `fail`) — bi-encoder fallback covers reranker downtime; doctor
 * surfaces the degraded state but doesn't block exit 0.
 */

import type { CheckFn } from './types.js';

const RERANKER_URL = 'http://localhost:7439/health';
const TIMEOUT_MS = 2000;

export interface CheckRerankerOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function makeCheckReranker(opts: CheckRerankerOptions = {}): CheckFn {
  const f = opts.fetchFn ?? fetch;
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;

  return async () => {
    let response: Response;
    try {
      response = await f(RERANKER_URL, { signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError';
      const reason = isAbort ? 'timeout' : 'unreachable';
      return {
        name: 'Reranker',
        status: 'warn',
        detail: `port 7439 ${reason}`,
        remediation:
          "Reranker on port 7439 unavailable; bi-encoder fallback active. Run 'bun run setup' or restart Angel to bring it back.",
      };
    }

    if (!response.ok) {
      return {
        name: 'Reranker',
        status: 'warn',
        detail: `port 7439 HTTP ${response.status}`,
        remediation:
          'Reranker is reachable but unhealthy. Restart Angel to recycle the supervised reranker process.',
      };
    }

    return {
      name: 'Reranker',
      status: 'pass',
      detail: 'port 7439 healthy',
    };
  };
}

export const checkReranker: CheckFn = makeCheckReranker();
