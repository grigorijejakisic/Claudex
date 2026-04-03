/**
 * ElicitationResult hook (H7b) — when user responds to an MCP elicitation.
 * Records elicitation_result event to session_events. Record-only.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('ElicitationResult', async (input, ctx) => {
  const mcpServerName = (input.mcp_server_name as string) || '';
  const action = (input.action as string) || '';
  const elicitationId = input.elicitation_id as string | undefined;
  const mode = input.mode as string | undefined;

  const detail = JSON.stringify({
    elicitation_id: elicitationId,
    mode,
  });

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'elicitation_result',
    mcpServerName,
    action,
    detail,
  );

  return {};
});

main();
