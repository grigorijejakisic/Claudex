/**
 * Setup hook (H16) — when CC runs setup or maintenance.
 * Pure event logger — records setup event to session_events.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('Setup', async (input, ctx) => {
  const trigger = (input.trigger as string) || 'unknown';

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'setup',
    trigger,
    'hook_fired',
  );

  return {};
});

main();
