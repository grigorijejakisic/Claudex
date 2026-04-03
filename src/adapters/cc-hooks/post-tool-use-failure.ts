/**
 * PostToolUseFailure hook (H14a) — when a tool call fails.
 * Records tool_error event to session_events. Record-only, no additionalContext.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';

const main = wrapHook('PostToolUseFailure', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const error = ((input.error as string) || '').slice(0, 200);
  const toolUseId = (input.tool_use_id as string) || '';
  const isInterrupt = input.is_interrupt as boolean | undefined;
  const toolInput = input.tool_input as unknown;

  const detail = JSON.stringify({
    tool_use_id: toolUseId,
    is_interrupt: isInterrupt,
    tool_input_summary: JSON.stringify(toolInput ?? '').slice(0, 200),
  });

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'tool_error',
    toolName,
    error,
    detail,
  );

  return {};
});

main();
