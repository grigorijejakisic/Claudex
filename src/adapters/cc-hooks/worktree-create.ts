/**
 * WorktreeCreate hook (H16b-a) — when CC creates a git worktree.
 * Pure event logger — records worktree_create event to session_events.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('WorktreeCreate', async (input, ctx) => {
  const name = (input.name as string) || '';

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'worktree_create',
    name,
    'created',
  );

  return {};
});

main();
