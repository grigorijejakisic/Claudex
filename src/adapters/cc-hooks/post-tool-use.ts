/**
 * PostToolUse hook -> after_tool event.
 * Extracts observations, updates pressure, tracks thread, checks checkpoint threshold.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import {
  processToolAndPressure,
  trackAfterTool,
  checkpointIfThresholdMet,
} from '../shared/lifecycle.js';
import { routeByContent, extractRoutingContent, buildProjectIndex } from '../../shared/content-router.js';

const main = wrapHook('PostToolUse', async (input, ctx) => {
  const toolName = (input.tool_name as string) || '';
  const toolInput = (input.tool_input as Record<string, unknown>) || {};
  const toolOutput = (input.tool_response as Record<string, unknown>) || undefined;

  // Content-aware routing — route to the project the content belongs to
  const routingContent = extractRoutingContent(toolInput, toolOutput);
  const projectIndex = buildProjectIndex();
  const routedProject = routeByContent(routingContent, ctx.project, projectIndex);

  // Each operation isolated — if A fails, B and C still run

  try {
    processToolAndPressure({
      db: ctx.db,
      sessionId: input.session_id,
      project: routedProject,
      cwd: input.cwd,
      toolName,
      toolInput,
      toolOutput,
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/process', e);
  }

  // Note: observation artifact creation and milestone detection happen in
  // lifecycle.ts processToolAndPressure, not here — avoids duplication and
  // ensures both CC hooks and OpenClaw bridge get milestones (ARCH-006).

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
  try {
    trackAfterTool(
      ctx.db,
      input.session_id,
      (input.prompt as string) ?? (input.user_prompt as string) ?? undefined,
      toolName,
      toolInput,
    );
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/track', e);
  }

  // Checkpoint threshold check
  try {
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
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'post_tool_use/checkpoint', e);
  }

  return {};
});

main();
