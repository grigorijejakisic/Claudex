/**
 * PermissionRequest hook (H5) — when CC is about to ask user for tool permission.
 * Records permission_request event to session_events. Record-only, no auto-allow.
 * D1: Auto-allow deferred. Data collection first, Angel analysis second.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('PermissionRequest', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const toolInput = input.tool_input as unknown;

  const detail = JSON.stringify(toolInput ?? '').slice(0, 200);

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'permission_request',
    toolName,
    'requested',
    detail,
  );

  return {};
});

main();
