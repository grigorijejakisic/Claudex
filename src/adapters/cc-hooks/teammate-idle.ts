/**
 * TeammateIdle hook (H12) — when a teammate in team mode goes idle.
 * Pure event logger — records teammate_idle event to session_events.
 *
 * Payload fields (from CC source):
 * - teammate_name: display name of the idle teammate
 * - session_id: the idle teammate's session ID
 * - cwd: working directory
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('TeammateIdle', async (input, ctx) => {
  const teammateName = (input.teammate_name as string) || 'unknown';
  const teamName = (input.team_name as string) || undefined;

  const detail = JSON.stringify({
    teammate_name: teammateName,
    team_name: teamName,
  });

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'teammate_idle',
    teammateName,
    'idle',
    detail,
  );

  return {};
});

main();
