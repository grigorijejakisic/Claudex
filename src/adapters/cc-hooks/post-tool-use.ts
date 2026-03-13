/**
 * PostToolUse hook -> after_tool event.
 * Extracts observations, updates pressure, tracks thread, checks checkpoint threshold.
 * @see Architecture Section 3.2
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import {
  processToolAndPressure,
  trackAfterTool,
  checkpointIfThresholdMet,
} from '../shared/lifecycle.js';

const main = wrapHook('PostToolUse', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const toolInput = (input.tool_input as Record<string, unknown>) || {};
  const toolOutput = (input.tool_output as Record<string, unknown>) || undefined;

  processToolAndPressure({
    db: ctx.db,
    sessionId: input.session_id,
    project: ctx.project,
    cwd: input.cwd,
    toolName,
    toolInput,
    toolOutput,
  });

  // Thread tracking
  //
  // DESIGN LIMITATION (ephemeral CC hook process):
  // ThreadTracker.onAfterTool() accumulates pending exchanges in memory, but the
  // CC hook process exits immediately after each invocation. This means in-memory
  // pending exchange data is lost between hook calls. Thread tracking only works
  // fully in the persistent OpenClaw bridge, where the process stays alive across
  // multiple tool calls within a turn. In the CC hooks adapter, only the DB-persisted
  // state (via tracker.persist()) survives between invocations — the pending exchange
  // count and any volatile accumulation are reset on each hook call.
  trackAfterTool(
    ctx.db,
    input.session_id,
    (input.user_prompt as string) ?? undefined,
    toolName,
    toolInput,
  );

  // Checkpoint threshold check
  const gauge = getTokenGauge({
    capabilities: CC_CAPABILITIES,
    transcriptPath: getTranscriptPath(input),
  });

  await checkpointIfThresholdMet({
    db: ctx.db,
    sessionId: input.session_id,
    project: ctx.project,
    cwd: input.cwd,
    scope: ctx.scope ?? undefined,
    config: ctx.config,
    gauge,
  });

  return {};
});

main();
