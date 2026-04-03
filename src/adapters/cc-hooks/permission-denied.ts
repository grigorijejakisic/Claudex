/**
 * PermissionDenied hook (H6) — when user denies a tool permission request.
 * Records permission_denied event to session_events. Record-only, no retry.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('PermissionDenied', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const reason = ((input.reason as string) || '').slice(0, 200);
  const toolUseId = (input.tool_use_id as string) || '';
  const toolInput = input.tool_input as unknown;

  const detail = JSON.stringify({
    tool_use_id: toolUseId,
    tool_input_summary: JSON.stringify(toolInput ?? '').slice(0, 200),
  });

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'permission_denied',
    toolName,
    reason,
    detail,
  );

  return {};
});

main();
