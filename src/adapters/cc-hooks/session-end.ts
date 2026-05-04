/**
 * SessionEnd hook -> session_end event.
 * Writes final checkpoint, runs decay, ends session, prunes telemetry.
 *
 * B7: Must use command-type (wrapHook), NOT agent-type.
 * Agent-type hooks silently fail on SessionEnd events (CC #40010).
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import { runSessionEndCleanup } from '../shared/lifecycle.js';
import { clearSessionSignals, sweepExpiredSignals } from '../../core/session-signals.js';
import { recordEvent } from '../../core/session-events.js';
import { writeEnvironmentalEvent } from '../../core/episodic-events.js';

const main = wrapHook('SessionEnd', async (input, ctx) => {
  const gauge = getTokenGauge({
    capabilities: CC_CAPABILITIES,
    transcriptPath: getTranscriptPath(input),
  });

  // Isolated — W1 handles internal isolation within runSessionEndCleanup,
  // this wraps the hook-level call so gauge errors don't prevent cleanup
  try {
    await runSessionEndCleanup({
      db: ctx.db,
      sessionId: input.session_id,
      project: ctx.project,
      cwd: input.cwd,
      scope: ctx.scope ?? undefined,
      config: ctx.config,
      gauge: gauge ?? undefined,
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_end/cleanup', e);
  }

  // Enqueue MEMORY.md curation — Angel's heartbeat consumes this on its next
  // tick (Phase 5b). Sync work is delegated so the hook returns promptly;
  // hooks deadlock on heavy LLM work. See plan 04-04.
  try {
    recordEvent(
      ctx.db,
      input.session_id,
      ctx.project,
      'memory_curation_pending',
      'angel',
      'enqueue',
      JSON.stringify({ project: ctx.project, session_id: input.session_id }),
    );
  } catch { /* telemetry-style; non-fatal */ }

  // Clear this session's signals + sweep expired signals globally
  try {
    clearSessionSignals(ctx.db, input.session_id);
    sweepExpiredSignals(ctx.db);
  } catch { /* non-critical */ }

  // V5 Plan 01-03 (EPI-03): episode-substrate session_boundary marker
  // (paired with the session-start row from cc-hooks/session-start).
  try {
    writeEnvironmentalEvent({
      db: ctx.db,
      sessionId: input.session_id,
      project: ctx.project,
      type: 'session_boundary',
      source: 'cc-hooks/session-end',
      content: `Session closed: ${input.session_id}`,
      metadata: {
        session_id: input.session_id,
        project: ctx.project,
      },
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_end/episodic_boundary', e);
  }

  return {};
});

main();
