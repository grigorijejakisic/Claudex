/**
 * PreCompact hook -> before_compact event.
 * Writes checkpoint, promotes learnings, marks post-compact-pending.
 * @see Architecture Section 3.2
 */

import { wrapHook, getTranscriptPath } from './infrastructure.js';
import { getTokenGauge } from '../../gauge/token-gauge.js';
import { CC_CAPABILITIES } from '../../shared/constants.js';
import { readGsdState } from '../../gsd/state-reader.js';
import { runCompactionSequence } from '../shared/lifecycle.js';

const main = wrapHook('PreCompact', async (input, ctx) => {
  const gauge = getTokenGauge({
    capabilities: CC_CAPABILITIES,
    transcriptPath: getTranscriptPath(input),
  });
  const gsd = readGsdState(input.cwd);

  await runCompactionSequence({
    db: ctx.db,
    sessionId: input.session_id,
    project: ctx.project,
    cwd: input.cwd,
    scope: ctx.scope ?? undefined,
    gauge: gauge ?? undefined,
    gsd: gsd ?? undefined,
  });

  // Upgrade 13: Custom compaction instructions
  const instructions = ctx.config.checkpoint.compaction_instructions;
  if (instructions) {
    return { customInstructions: instructions };
  }

  return {};
});

main();
