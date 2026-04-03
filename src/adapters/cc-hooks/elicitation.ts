/**
 * Elicitation hook (H7a) — when an MCP tool requests structured user input.
 * Records elicitation event to session_events. Record-only, no auto-response.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('Elicitation', async (input, ctx) => {
  const mcpServerName = (input.mcp_server_name as string) || '';
  const message = ((input.message as string) || '').slice(0, 200);
  const mode = input.mode as string | undefined;
  const elicitationId = input.elicitation_id as string | undefined;

  const detail = JSON.stringify({
    mode,
    elicitation_id: elicitationId,
  });

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'elicitation',
    mcpServerName,
    message,
    detail,
  );

  return {};
});

main();
