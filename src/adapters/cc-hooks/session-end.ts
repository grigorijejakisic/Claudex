/**
 * SessionEnd hook -> session_end event.
 * Writes final checkpoint, runs decay, ends session, prunes telemetry.
 * @see Architecture Section 3.2
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { runSessionEndCleanup } from '../shared/lifecycle.js';

const main = wrapHook('SessionEnd', async (input, ctx) => {
  const gauge = getTokenGauge({
    capabilities: CC_CAPABILITIES,
    transcriptPath: getTranscriptPath(input),
  });

  await runSessionEndCleanup({
    db: ctx.db,
    sessionId: input.session_id,
    project: ctx.project,
    cwd: input.cwd,
    scope: ctx.scope ?? undefined,
    config: ctx.config,
    gauge: gauge ?? undefined,
  });

  return {};
});

main();
