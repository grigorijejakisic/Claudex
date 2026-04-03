/**
 * StopFailure hook (H14b) — when a stop event fails (rate_limit, auth, etc.).
 * Records stop_failure event to session_events. Fire-and-forget: CC ignores
 * ALL output and exit codes for this hook. Returns {} via wrapHook for
 * codebase consistency.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('StopFailure', async (input, ctx) => {
  const error = (input.error as string) || 'unknown';
  const errorDetails = ((input.error_details as string) || '').slice(0, 200);

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'stop_failure',
    error,
    errorDetails,
  );

  return {};
});

main();
