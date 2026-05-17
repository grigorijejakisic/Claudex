/**
 * StopFailure hook (H14b) — when a stop event fails (rate_limit, auth, etc.).
 * Records stop_failure event to session_events. Fire-and-forget: CC ignores
 * ALL output and exit codes for this hook. Returns {} via wrapHook for
 * codebase consistency.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';
import { recordSessionTermination, readLastTurnTexts } from '../../core/session-termination.js';

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

  // Phase 14-09: deterministic termination row marked 'crash'. StopFailure
  // fires when CC's API call fails mid-turn (rate limit, auth, overload).
  // The session may continue afterward, in which case session-end's later
  // 'endsession' write supersedes this — that's the intended last-write-wins.
  try {
    const { last_user_directive, last_assistant_text } = readLastTurnTexts(ctx.db, input.session_id);
    recordSessionTermination(ctx.db, {
      session_id: input.session_id,
      project: ctx.project,
      end_reason: 'crash',
      last_user_directive,
      last_assistant_text,
    });
  } catch { /* non-blocking */ }

  return {};
});

main();
