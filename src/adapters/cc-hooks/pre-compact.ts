/**
 * PreCompact hook -> before_compact event.
 * Writes checkpoint, promotes learnings, marks post-compact-pending.
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { emitTelemetry, sanitizeErrorForTelemetry } from '../../observability/telemetry.js';
import { readGsdState } from '../../gsd/state-reader.js';
import { runCompactionSequence } from '../shared/lifecycle.js';

const main = wrapHook('PreCompact', async (input, ctx) => {
  const gauge = getTokenGauge({
    capabilities: CC_CAPABILITIES,
    transcriptPath: getTranscriptPath(input),
  });
  const gsd = readGsdState(input.cwd);

  // Isolated — compaction failure must not prevent returning custom instructions
  try {
    await runCompactionSequence({
      db: ctx.db,
      sessionId: input.session_id,
      project: ctx.project,
      cwd: input.cwd,
      scope: ctx.scope ?? undefined,
      gauge: gauge ?? undefined,
      gsd: gsd ?? undefined,
    });
  } catch (e) {
    try { emitTelemetry(ctx.db, input.session_id, 'error', { subsystem: 'pre_compact/sequence', error: sanitizeErrorForTelemetry(e) }); } catch {}
  }

  // Return custom compaction instructions if configured
  const instructions = ctx.config.checkpoint.compaction_instructions;
  if (instructions) {
    return { customInstructions: instructions };
  }

  return {};
});

main();
