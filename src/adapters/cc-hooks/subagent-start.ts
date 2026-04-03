/**
 * SubagentStart hook (H1) — when a subagent starts.
 * Records subagent_start event, injects minimal context (<200 tokens).
 */

import { wrapHook } from './infrastructure.js';
import { recordEvent } from '../../core/session-events.js';
import { getActiveSignals } from '../../core/session-signals.js';

const main = wrapHook('SubagentStart', async (input, ctx) => {
  const agentId = (input.agent_id as string) || '';
  const agentType = (input.agent_type as string) || '';

  // Record subagent_start event
  recordEvent(
    ctx.db,
    input.session_id,
    ctx.project,
    'subagent_start',
    agentId,
    agentType,
  );

  // Build minimal context (<200 tokens): project name + active signals
  const parts: string[] = [`Project: ${ctx.project}`];

  try {
    const signals = getActiveSignals(ctx.db, ctx.project, input.session_id);
    if (signals.length > 0) {
      const signalLines = signals
        .slice(0, 3)
        .map(s => `[${s.signal_type}] ${`${s.target}${s.detail ? ': ' + s.detail : ''}`.slice(0, 60)}`);
      parts.push('Signals: ' + signalLines.join('; '));
    }
  } catch { /* non-critical */ }

  const additionalContext = parts.join('\n');

  return {
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext,
    },
  };
});

main();
