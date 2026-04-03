/**
 * WorktreeRemove hook (H16b-b) — when a git worktree is removed.
 * Pure event logger — records worktree_remove event to session_events.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('WorktreeRemove', async (input, ctx) => {
  const worktreePath = (input.worktree_path as string) || '';

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'worktree_remove',
    worktreePath,
    'removed',
  );

  return {};
});

main();
