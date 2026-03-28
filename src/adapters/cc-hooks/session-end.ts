/**
 * SessionEnd hook -> session_end event.
 * Writes final checkpoint, runs decay, ends session, prunes telemetry.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import { runSessionEndCleanup } from '../shared/lifecycle.js';
import { clearSessionSignals, sweepExpiredSignals } from '../../core/session-signals.js';

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

  // Clear this session's signals + sweep expired signals globally
  try {
    clearSessionSignals(ctx.db, input.session_id);
    sweepExpiredSignals(ctx.db);
  } catch { /* non-critical */ }

  return {};
});

main();
