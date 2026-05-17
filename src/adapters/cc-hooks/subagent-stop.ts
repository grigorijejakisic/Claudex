/**
 * SubagentStop hook (H2) — when a subagent completes.
 * Records subagent_stop event with duration computed from matching start event.
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';
import { cachedPrepare } from '../../core/stmt-cache.js';

const main = wrapHook('SubagentStop', async (input, ctx) => {
  const agentId = (input.agent_id as string) || '';
  const agentType = (input.agent_type as string) || '';
  const transcriptPath = (input.agent_transcript_path as string) || '';
  const lastMessage = (input.last_assistant_message as string) || '';

  // Compute duration from matching subagent_start event
  let durationMs: number | null = null;
  try {
    const startRow = cachedPrepare(ctx.db,
      `SELECT timestamp_epoch_ms FROM session_events
       WHERE session_id = ? AND event_type = 'subagent_start' AND entity = ?
       ORDER BY timestamp_epoch_ms DESC LIMIT 1`
    ).get(input.session_id, agentId) as { timestamp_epoch_ms: number } | undefined;

    if (startRow) {
      durationMs = Math.floor((Date.now() - startRow.timestamp_epoch_ms) / 1000);
    }
  } catch { /* graceful fallback: null duration */ }

  // Record subagent_stop event
  const detail = JSON.stringify({
    agent_type: agentType,
    transcript_path: transcriptPath,
    last_message: lastMessage.slice(0, 500),
    duration_s: durationMs,
  });

  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'subagent_stop',
    agentId,
    agentType,
    detail,
  );

  return {};
});

main();
